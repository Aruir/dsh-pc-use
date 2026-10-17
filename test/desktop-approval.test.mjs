// F2: desktop approvals go through the DSH approval service, never through autoApprove.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

const DESKTOP_SERVER = process.env.CODEX_CU_DESKTOP_SERVER
  ?? fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))

function approvalService(outcome, requests) {
  return {
    async request(parameters) {
      requests.push(parameters)
      return outcome
    },
  }
}

/** An approval service that keeps every request pending until the test answers it. */
function pendingApprovalService() {
  const requests = []
  return {
    requests,
    service: {
      request(parameters) {
        return new Promise((resolve) => {
          requests.push({ parameters, resolve })
        })
      },
    },
  }
}

function execFixture(callId = 'call-42') {
  return {
    agent: { id: 'agent-test' },
    name: 'codex_js',
    callId,
    signal: new AbortController().signal,
  }
}

function setup(options = {}) {
  const home = tempDir('codex-cu-desktop-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [DESKTOP_SERVER, options.mode ?? 'computer', serverLog])
  const logFile = join(home, 'bridge.log')
  const plugin = registerPlugin({
    codexHome,
    computer: options.computer ?? false,
    autoApprove: options.autoApprove ?? false,
    logFile,
    stateFile: join(home, 'state.json'),
  }, { services: options.services ?? {} })
  return {
    home,
    restore,
    serverLog,
    logFile,
    plugin,
    exec: options.exec ?? execFixture(),
  }
}

function approvalLines(logFile) {
  return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.includes('approval '))
}

async function runDesktopCall(context) {
  const js = context.plugin.tools.get('codex_js')
  return js.execute({ code: '1', title: 'desktop approval' }, context.exec)
}

function finish(context) {
  context.plugin.dispose()
  context.restore()
}

test('computer:false declines a desktop approval without asking DSH', async () => {
  const requests = []
  const context = setup({
    computer: false,
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const result = await runDesktopCall(context)
    assert.match(result, /decision decline/)
    assert.equal(requests.length, 0)
    const lines = approvalLines(context.logFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /Allow Computer Use to use/)
    assert.match(lines[0], /记事本/)
    assert.match(lines[0], /-> decline \(computer use is off\)/)
    assert.match(readFileSync(context.serverLog, 'utf8'), /answer decline/)
  } finally {
    finish(context)
  }
})

test('computer:true asks DSH and accepts allowed-once', async () => {
  const requests = []
  const exec = execFixture()
  const context = setup({
    computer: true,
    exec,
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const result = await runDesktopCall(context)
    assert.match(result, /decision accept/)
    assert.equal(requests.length, 1)
    const request = requests[0]
    assert.equal(request.agent, exec.agent)
    assert.equal(request.toolName, 'codex_js')
    assert.equal(request.callId, 'call-42')
    // The signal handed to DSH is derived from exec.signal and the call lifetime, so it
    // is already aborted once the call has returned.
    assert.equal(typeof request.signal?.addEventListener, 'function')
    assert.equal(request.signal.aborted, true)
    assert.equal(request.displayReason, '允许 Codex Computer Use 操作“记事本”？')
    const lines = approvalLines(context.logFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> accept \(approved in DSH\)/)
    assert.equal(lines.join('').includes('call-42'), false)
    assert.equal(lines.join('').includes('agent-test'), false)
    assert.match(readFileSync(context.serverLog, 'utf8'), /answer accept/)
  } finally {
    finish(context)
  }
})

for (const [outcome, reason] of [
  ['rejected', 'rejected in DSH'],
  ['cancelled', 'approval cancelled'],
  ['unavailable', 'approval unavailable'],
]) {
  test(`computer:true declines when DSH returns ${outcome}`, async () => {
    const requests = []
    const context = setup({
      computer: true,
      services: { approval: approvalService(outcome, requests) },
    })
    try {
      const result = await runDesktopCall(context)
      assert.match(result, /decision decline/)
      assert.equal(requests.length, 1)
      const lines = approvalLines(context.logFile)
      assert.equal(lines.length, 1)
      assert.match(lines[0], new RegExp(`-> decline \\(${reason}\\)`))
      assert.match(readFileSync(context.serverLog, 'utf8'), /answer decline/)
    } finally {
      finish(context)
    }
  })
}

test('no DSH approval service declines a desktop approval', async () => {
  const context = setup({ computer: true })
  try {
    const result = await runDesktopCall(context)
    assert.match(result, /decision decline/)
    const lines = approvalLines(context.logFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(no DSH approval service\)/)
  } finally {
    finish(context)
  }
})

test('autoApprove:true does not auto-accept a desktop approval', async () => {
  const requests = []
  const context = setup({
    computer: true,
    autoApprove: true,
    services: { approval: approvalService('rejected', requests) },
  })
  try {
    const result = await runDesktopCall(context)
    assert.match(result, /decision decline/)
    assert.equal(requests.length, 1)
    const lines = approvalLines(context.logFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(rejected in DSH\)/)
    assert.equal(lines.join('').includes('browser access auto-approved'), false)
  } finally {
    finish(context)
  }
})

test('a desktop approval without an active codex_js call is declined', async () => {
  const requests = []
  const context = setup({
    mode: 'spontaneous',
    computer: true,
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const reset = context.plugin.tools.get('codex_js_reset')
    await reset.execute({}, { name: 'codex_js_reset' })
    const declined = await waitFor(
      () => readFileSync(context.serverLog, 'utf8').includes('answer decline'),
    )
    assert.equal(declined, true)
    assert.equal(requests.length, 0)
    const lines = approvalLines(context.logFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(no active codex_js call\)/)
  } finally {
    finish(context)
  }
})

test('the Allow Codex to use form asks DSH with the app name', async () => {
  const requests = []
  const context = setup({
    mode: 'computer-codex',
    computer: true,
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const result = await runDesktopCall(context)
    assert.match(result, /decision accept/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].displayReason, '允许 Codex Computer Use 操作“Notepad”？')
  } finally {
    finish(context)
  }
})

test('a desktop approval goes to the earliest running codex_js call', async () => {
  const { service, requests } = pendingApprovalService()
  const context = setup({
    mode: 'computer',
    computer: true,
    services: { approval: service },
  })
  try {
    const js = context.plugin.tools.get('codex_js')
    const first = js.execute({ code: '1', title: 'first' }, execFixture('call-first'))
    assert.equal(await waitFor(() => requests.length >= 1), true)
    const second = js.execute({ code: '2', title: 'second' }, execFixture('call-second'))
    assert.equal(await waitFor(() => requests.length >= 2), true)
    assert.equal(requests[1].parameters.callId, 'call-first')
    for (const request of requests) {
      request.resolve('rejected')
    }
    await Promise.allSettled([first, second])
  } finally {
    finish(context)
  }
})

test('a desktop approval after the last codex_js call ended is declined without DSH', async () => {
  const requests = []
  const context = setup({
    mode: 'spontaneous-after-call',
    computer: true,
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const js = context.plugin.tools.get('codex_js')
    const result = await js.execute({ code: '1', title: 'finish' }, execFixture('call-done'))
    assert.equal(result, 'ran js')
    const declined = await waitFor(
      () => readFileSync(context.serverLog, 'utf8').includes('answer decline'),
    )
    assert.equal(declined, true)
    assert.equal(requests.length, 0)
    const lines = approvalLines(context.logFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(no active codex_js call\)/)
  } finally {
    finish(context)
  }
})

test('a call without an agent is declined without asking DSH', async () => {
  const requests = []
  const context = setup({
    mode: 'computer',
    computer: true,
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const js = context.plugin.tools.get('codex_js')
    const exec = {
      name: 'codex_js',
      callId: 'call-no-agent',
      signal: new AbortController().signal,
    }
    const result = await js.execute({ code: '1', title: 'no agent' }, exec)
    assert.match(result, /decision decline/)
    assert.equal(requests.length, 0)
    const lines = approvalLines(context.logFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(no agent for this call\)/)
  } finally {
    finish(context)
  }
})
