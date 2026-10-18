// F2: desktop approvals go through the DSH approval service, never through autoApprove,
// and are attributed only to running `pc_codex_desktop_js` calls on the desktop server.
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
    name: 'pc_codex_desktop_js',
    callId,
    signal: new AbortController().signal,
  }
}

function setup(options = {}) {
  const home = tempDir('pc-use-desktop-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  const pidFile = join(home, 'pids.txt')
  writeFileSync(serverLog, '')
  writeFileSync(pidFile, '')
  const codexHome = join(home, 'codex')
  // The desktop server comes from [mcp_servers.node_repl]; the browser source is unused.
  writeCodexHome(
    codexHome,
    [DESKTOP_SERVER, options.mode ?? 'computer', serverLog, pidFile],
    {},
    { desktop: true },
  )
  const logFile = join(home, 'bridge.log')
  const plugin = registerPlugin({
    codexHome,
    computer: options.computer ?? true,
    autoApprove: options.autoApprove ?? false,
    logFile,
  }, { services: options.services ?? {} })
  return {
    home,
    restore,
    serverLog,
    pidFile,
    logFile,
    plugin,
    exec: options.exec ?? execFixture(),
  }
}

function approvalLines(logFile) {
  return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.includes('approval "'))
}

function runDesktopCall(context) {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '1', title: 'desktop approval' }, context.exec)
}

function readPids(file) {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number)
}

function finish(context) {
  context.plugin.dispose()
  context.restore()
}

test('computer:false rejects the desktop tool before any server starts', async () => {
  const requests = []
  const context = setup({
    computer: false,
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    await assert.rejects(() => runDesktopCall(context), /computer use is off/)
    assert.equal(requests.length, 0)
    assert.deepEqual(readPids(context.pidFile), [])
    assert.equal(readFileSync(context.serverLog, 'utf8').trim(), '')
  } finally {
    finish(context)
  }
})

test('computer:true asks DSH and accepts allowed-once', async () => {
  const requests = []
  const exec = execFixture()
  const context = setup({
    exec,
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const result = await runDesktopCall(context)
    assert.match(result, /decision accept/)
    assert.equal(requests.length, 1)
    const request = requests[0]
    assert.equal(request.agent, exec.agent)
    assert.equal(request.toolName, 'pc_codex_desktop_js')
    assert.equal(request.callId, 'call-42')
    // The signal handed to DSH is derived from exec.signal and the call lifetime, so it
    // is already aborted once the call has returned.
    assert.equal(typeof request.signal?.addEventListener, 'function')
    assert.equal(request.signal.aborted, true)
    assert.deepEqual(request.displayReason, {
      en: 'Allow Codex Computer Use to operate “记事本”?',
      zh: '允许 Codex Computer Use 操作“记事本”？',
    })
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
  const context = setup()
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

test('a desktop approval without an active desktop call is declined', async () => {
  const requests = []
  const context = setup({
    mode: 'spontaneous',
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    // The reset is a desktop call but it is not registered for approval attribution.
    await context.plugin.tools.get('pc_codex_desktop_js_reset')
      .execute({}, { name: 'pc_codex_desktop_js_reset' })
    const declined = await waitFor(
      () => readFileSync(context.serverLog, 'utf8').includes('answer decline'),
    )
    assert.equal(declined, true)
    assert.equal(requests.length, 0)
    const lines = approvalLines(context.logFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(no active pc_codex_desktop_js call\)/)
  } finally {
    finish(context)
  }
})

test('the Allow Codex to use form asks DSH with the app name', async () => {
  const requests = []
  const context = setup({
    mode: 'computer-codex',
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const result = await runDesktopCall(context)
    assert.match(result, /decision accept/)
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].displayReason, {
      en: 'Allow Codex Computer Use to operate “Notepad”?',
      zh: '允许 Codex Computer Use 操作“Notepad”？',
    })
  } finally {
    finish(context)
  }
})

test('a desktop approval goes to the earliest running desktop call', async () => {
  const { service, requests } = pendingApprovalService()
  const context = setup({ mode: 'computer', services: { approval: service } })
  try {
    const js = context.plugin.tools.get('pc_codex_desktop_js')
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

test('a desktop approval after the last desktop call ended is declined without DSH', async () => {
  const requests = []
  const context = setup({
    mode: 'spontaneous-after-call',
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const js = context.plugin.tools.get('pc_codex_desktop_js')
    const result = await js.execute({ code: '1', title: 'finish' }, execFixture('call-done'))
    assert.equal(result, 'ran js')
    const declined = await waitFor(
      () => readFileSync(context.serverLog, 'utf8').includes('answer decline'),
    )
    assert.equal(declined, true)
    assert.equal(requests.length, 0)
    const lines = approvalLines(context.logFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(no active pc_codex_desktop_js call\)/)
  } finally {
    finish(context)
  }
})

test('a desktop call without an agent is declined without asking DSH', async () => {
  const requests = []
  const context = setup({ services: { approval: approvalService('allowed-once', requests) } })
  try {
    const js = context.plugin.tools.get('pc_codex_desktop_js')
    const exec = {
      name: 'pc_codex_desktop_js',
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
