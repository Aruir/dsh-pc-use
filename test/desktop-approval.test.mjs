// F2: desktop approvals go through the DSH approval service, never through autoApprove,
// and are attributed only to running `pc_codex_desktop_js` calls on the desktop server.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  registerPlugin, stripWallTime, tempDir, useHome, waitFor, writeCodexHome,
} from './helpers.mjs'

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

async function runDesktopCall(context) {
  const result = await context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '1', title: 'desktop approval' }, context.exec)
  return stripWallTime(result)
}

function finish(context) {
  context.plugin.dispose()
  context.restore()
}

for (const [outcome, reason] of [
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

test('a desktop approval after the last desktop call ended is declined without DSH', async () => {
  const requests = []
  const context = setup({
    mode: 'spontaneous-after-call',
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const js = context.plugin.tools.get('pc_codex_desktop_js')
    const result = stripWallTime(
      await js.execute({ code: '1', title: 'finish' }, execFixture('call-done')),
    )
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
