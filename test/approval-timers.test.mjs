// D14: a pending elicitation pauses the tools/call timeout and resumes it with the
// remaining time, so waiting for the user does not eat the call's budget. Every test also
// asserts that the fake servers it started are gone after `dispose()`: a leaked server keeps
// its pipes open and would otherwise make this test file process hang instead of failing.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  registerPlugin, stripWallTime, tempDir, useHome, waitFor, writeCodexHome,
} from './helpers.mjs'

const SERVER = process.env.CODEX_CU_DESKTOP_SERVER
  ?? fileURLToPath(new URL('./fixtures/pid-computer-server.mjs', import.meta.url))

function setup(options = {}) {
  const home = tempDir('pc-use-timers-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  const pidFile = join(home, 'pids.txt')
  writeFileSync(serverLog, '')
  writeFileSync(pidFile, '')
  const codexHome = join(home, 'codex')
  // The desktop server comes from [mcp_servers.node_repl]; the browser source is unused.
  writeCodexHome(
    codexHome,
    [SERVER, pidFile, options.mode ?? 'computer', serverLog],
    {},
    { desktop: true },
  )
  const plugin = registerPlugin({
    codexHome,
    computer: true,
    timeoutMs: options.timeoutMs,
    logFile: join(home, 'bridge.log'),
  }, { services: options.services ?? {} })
  return { home, restore, serverLog, pidFile, plugin }
}

/** Server pids recorded by pid-computer-server.mjs. O(n), n = pids. */
function readPids(file) {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Kill only the server pids this test recorded; never touches other processes. O(n). */
function killAll(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {}
  }
}

/**
 * Dispose the plugin and require every fake server it started to exit within a bounded
 * time. On a leak the assertion fails after 2 s instead of hanging the file; the leftover
 * servers are then killed so the test process can exit. O(n) plus the wait.
 */
async function finish(context) {
  context.plugin.dispose()
  const stopped = await waitFor(
    () => readPids(context.pidFile).every((pid) => !isRunning(pid)),
    2000,
  )
  killAll(readPids(context.pidFile))
  context.restore()
  assert.equal(stopped, true, 'every fake server must exit after the plugin is disposed')
}

/** The same exec shape the host hands pc_codex_desktop_js; a distinct call id per call. O(1). */
function execFor(callId) {
  return {
    agent: { id: 'agent-timers', session: { id: 'session-timers' } },
    name: 'pc_codex_desktop_js',
    callId,
    signal: new AbortController().signal,
  }
}

/** An approval answerer that answers after `ms` and remembers when it did. O(1). */
function approvalAfter(ms, outcome = 'allowed-once') {
  const state = { asked: 0, answeredAt: null }
  return {
    state,
    service: {
      async request() {
        state.asked += 1
        await new Promise((done) => setTimeout(done, ms))
        state.answeredAt = Date.now()
        return outcome
      },
    },
  }
}

async function runJs(context, callId = 'call-1') {
  const result = await context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '1', title: 'timer' }, execFor(callId))
  return stripWallTime(result)
}

test('a pending approval pauses the call timeout', async () => {
  const approval = approvalAfter(700)
  const context = setup({ timeoutMs: 300, services: { approval: approval.service } })
  try {
    const result = await runJs(context)
    assert.match(result, /decision accept/)
    assert.equal(approval.state.asked, 1)
  } finally {
    await finish(context)
  }
})

test('after an approval the call only gets its remaining time back', async () => {
  const approval = approvalAfter(600)
  const context = setup({
    timeoutMs: 500,
    mode: 'slow-ask-answer',
    services: { approval: approval.service },
  })
  try {
    const startedAt = Date.now()
    let error = null
    try {
      await runJs(context)
    } catch (caught) {
      error = caught
    }
    const rejectedAt = Date.now()
    assert.ok(error instanceof Error, 'the call must time out')
    assert.match(error.message, /timed out after 500ms/)
    assert.equal(typeof approval.state.answeredAt, 'number')
    const afterApproval = rejectedAt - approval.state.answeredAt
    assert.ok(afterApproval >= 100, `timed out only ${afterApproval}ms after the approval`)
    assert.ok(afterApproval <= 400, `timed out ${afterApproval}ms after the approval`)
    assert.ok(rejectedAt - startedAt >= 1000, 'the 300ms preamble must be honoured')
  } finally {
    await finish(context)
  }
})

test('a call without an elicitation still times out after timeoutMs', async () => {
  const context = setup({ timeoutMs: 200, mode: 'hang' })
  try {
    await assert.rejects(
      () => runJs(context),
      /timed out after 200ms/,
    )
  } finally {
    await finish(context)
  }
})

test('two concurrent calls are paused during an approval and both finish', async () => {
  const approval = approvalAfter(600)
  const context = setup({ timeoutMs: 300, services: { approval: approval.service } })
  try {
    const results = await Promise.all([runJs(context, 'call-a'), runJs(context, 'call-b')])
    assert.equal(results.length, 2)
    for (const result of results) {
      assert.match(result, /decision accept/)
    }
  } finally {
    await finish(context)
  }
})

/** An approval service the test answers manually. O(1). */
function pendingApproval() {
  const state = { resolve: null }
  return {
    state,
    service: {
      request() {
        return new Promise((resolve) => {
          state.resolve = resolve
        })
      },
    },
  }
}

test('a call started during the approval gets its full timeout after it', async () => {
  const approval = pendingApproval()
  const context = setup({
    timeoutMs: 600,
    mode: 'first-ask-then-slow',
    services: { approval: approval.service },
  })
  try {
    const first = runJs(context, 'call-first')
    assert.equal(await waitFor(() => approval.state.resolve !== null), true)
    const secondStartedAt = Date.now()
    const second = runJs(context, 'call-second')
    setTimeout(() => approval.state.resolve('allowed-once'), 900)
    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.match(firstResult, /decision accept/)
    assert.equal(secondResult, 'ran js')
    assert.ok(
      Date.now() - secondStartedAt >= 1000,
      'the second call must wait out the slow server instead of timing out',
    )
  } finally {
    await finish(context)
  }
})
