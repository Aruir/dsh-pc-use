// F6: notify Codex `turn_ended` when a DSH turn ends, with per-agent session/turn ids.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

const SERVER = process.env.CODEX_CU_TURN_SERVER
  ?? fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))

function makeAgents() {
  const byId = new Map()
  return {
    add(id) {
      const session = { id }
      const agent = { id, session }
      byId.set(id, agent)
      return { agent, session }
    },
    get(id) {
      return byId.get(id)
    },
  }
}

function setup(options = {}) {
  const home = tempDir('pc-use-turn-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  const pidFile = join(home, 'pids.txt')
  writeFileSync(serverLog, '')
  writeFileSync(pidFile, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [SERVER, options.mode ?? 'turn-ended', serverLog, pidFile])
  const logFile = join(home, 'bridge.log')
  const agents = makeAgents()
  const plugin = registerPlugin({
    codexHome,
    logFile,
    ...options.config,
  }, { services: { agents } })
  return { home, restore, serverLog, pidFile, logFile, plugin, agents }
}

function readLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
}

function callLines(file) {
  return readLines(file).filter((line) => line.startsWith('call js '))
}

/** Every recorded `call <tool> ...` line, reset included. O(n), n = log lines. */
function toolCalls(file) {
  return readLines(file).filter((line) => line.startsWith('call '))
}

function turnEnded(file) {
  const prefix = 'turn_ended '
  return readLines(file)
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)))
}

/** The complete `_meta` of every recorded turn_ended call. O(n). */
function turnEndedMeta(file) {
  const prefix = 'turn_ended-meta-raw '
  return readLines(file)
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)))
}

function execFor(agent, callId) {
  return {
    agent,
    name: 'pc_codex_js',
    callId,
    signal: new AbortController().signal,
  }
}

function runJs(context, exec, code = '1') {
  return context.plugin.tools.get('pc_codex_js').execute({ code, title: 't' }, exec)
}

function emitTurnEnd(context, session, reason = { kind: 'completed' }) {
  context.plugin.emit('session/event', session, {
    type: 'turn/end',
    seq: 7,
    data: { turn: 1, reason },
  })
}

function finish(context) {
  context.plugin.dispose()
  context.restore()
}

test('two agents get different Codex session ids', async () => {
  const context = setup()
  try {
    const first = context.agents.add('session-one')
    const second = context.agents.add('session-two')
    await runJs(context, execFor(first.agent, 'call-1'))
    await runJs(context, execFor(second.agent, 'call-2'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 2), true)
    const firstCall = callLines(context.serverLog)[0].split(' ')
    const secondCall = callLines(context.serverLog)[1].split(' ')
    assert.notEqual(firstCall[2], secondCall[2])
  } finally {
    finish(context)
  }
})

test('a normal turn end reports Stop and rotates the turn id', async () => {
  const context = setup()
  try {
    const { agent, session } = context.agents.add('session-stop')
    await runJs(context, execFor(agent, 'call-1'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 1), true)
    const [, , sessionId, turnId] = callLines(context.serverLog)[0].split(' ')
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => turnEnded(context.serverLog).length === 1), true)
    const report = turnEnded(context.serverLog)[0]
    assert.deepEqual(report, {
      hook_event_name: 'Stop',
      session_id: sessionId,
      turn_id: turnId,
    })
    await runJs(context, execFor(agent, 'call-2'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 2), true)
    const secondCall = callLines(context.serverLog)[1].split(' ')
    assert.equal(secondCall[2], sessionId)
    assert.notEqual(secondCall[3], turnId)
  } finally {
    finish(context)
  }
})

test('a cancelled turn reports Interrupt', async () => {
  const context = setup()
  try {
    const { agent, session } = context.agents.add('session-cancel')
    await runJs(context, execFor(agent, 'call-1'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 1), true)
    emitTurnEnd(context, session, { kind: 'aborted', reason: { kind: 'user' } })
    assert.equal(await waitFor(() => turnEnded(context.serverLog).length === 1), true)
    assert.equal(turnEnded(context.serverLog)[0].hook_event_name, 'Interrupt')
  } finally {
    finish(context)
  }
})

test('a subagent turn end reports SubagentStop', async () => {
  const context = setup()
  try {
    const { agent, session } = context.agents.add('session-sub')
    await runJs(context, execFor(agent, 'call-1'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 1), true)
    context.plugin.emit('session/event', session, {
      type: 'subagent/descriptor',
      seq: 6,
      data: { version: 1, mode: 'one-shot', provider: 'local' },
    })
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => turnEnded(context.serverLog).length === 1), true)
    assert.equal(turnEnded(context.serverLog)[0].hook_event_name, 'SubagentStop')
  } finally {
    finish(context)
  }
})

test('a turn that never called pc_codex_js sends nothing and spawns nothing', async () => {
  const context = setup()
  try {
    const { session } = context.agents.add('session-idle')
    emitTurnEnd(context, session)
    await new Promise((done) => setTimeout(done, 300))
    assert.deepEqual(turnEnded(context.serverLog), [])
    assert.deepEqual(readLines(context.pidFile), [])
  } finally {
    finish(context)
  }
})

test('turn_ended is not sent when the bridge disconnected, and is not reconnected', async () => {
  const context = setup()
  try {
    const { agent, session } = context.agents.add('session-gone')
    await runJs(context, execFor(agent, 'call-1'))
    assert.equal(await waitFor(() => readLines(context.pidFile).length === 1), true)
    const pid = Number(readLines(context.pidFile)[0])
    process.kill(pid)
    assert.equal(await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }), true)
    await new Promise((done) => setTimeout(done, 150))
    emitTurnEnd(context, session)
    await new Promise((done) => setTimeout(done, 300))
    assert.deepEqual(turnEnded(context.serverLog), [])
    assert.equal(readLines(context.pidFile).length, 1)
  } finally {
    finish(context)
  }
})

test('a failed turn_ended call is logged and does not throw', async () => {
  const context = setup({ mode: 'turn-ended-error' })
  try {
    const { agent, session } = context.agents.add('session-fail')
    await runJs(context, execFor(agent, 'call-1'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 1), true)
    assert.doesNotThrow(() => emitTurnEnd(context, session))
    assert.equal(
      await waitFor(() => readFileSync(context.logFile, 'utf8').includes('turn_ended failed')),
      true,
    )
  } finally {
    finish(context)
  }
})

test('a rebuilt bridge still receives the turn that ended', async () => {
  const context = setup()
  try {
    const { agent, session } = context.agents.add('session-reconnect')
    await runJs(context, execFor(agent, 'call-old'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 1), true)
    const oldCall = callLines(context.serverLog)[0].split(' ')
    const oldTurnId = oldCall[3]
    // A changed launch spec rebuilds the browser bridge; the reset has no agent, so the
    // new bridge is not marked as used in this turn.
    writeCodexHome(join(context.home, 'codex'), [
      SERVER, 'turn-ended', context.serverLog, context.pidFile, 'rebuilt',
    ])
    await context.plugin.tools.get('pc_codex_js_reset').execute({}, {})
    assert.equal(await waitFor(() => readLines(context.pidFile).length === 2), true)
    emitTurnEnd(context, session)
    // Native Codex reports to the connected server even though the bridge was replaced.
    assert.equal(await waitFor(() => turnEnded(context.serverLog).length === 1), true)
    const oldReport = turnEnded(context.serverLog)[0]
    assert.equal(oldReport.turn_id, oldTurnId)
    assert.equal(oldReport.session_id, oldCall[2])
    await runJs(context, execFor(agent, 'call-new'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 2), true)
    const nextCall = callLines(context.serverLog)[1].split(' ')
    assert.notEqual(nextCall[3], oldTurnId)
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => turnEnded(context.serverLog).length === 2), true)
    const nextReport = turnEnded(context.serverLog)[1]
    assert.equal(nextReport.turn_id, nextCall[3])
    assert.equal(nextReport.session_id, nextCall[2])
  } finally {
    finish(context)
  }
})

test('a later turn still reports on the connected server', async () => {
  const context = setup()
  try {
    const { agent, session } = context.agents.add('session-second-turn')
    await runJs(context, execFor(agent, 'call-1'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 1), true)
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => turnEnded(context.serverLog).length === 1), true)
    const first = turnEnded(context.serverLog)[0]
    // The next turn makes no tool call, but the native rule still reports it.
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => turnEnded(context.serverLog).length === 2), true)
    const second = turnEnded(context.serverLog)[1]
    assert.notEqual(second.turn_id, first.turn_id)
    assert.equal(second.session_id, first.session_id)
  } finally {
    finish(context)
  }
})

test('no turn_ended is sent after the plugin is disposed', async () => {
  const context = setup()
  const { agent, session } = context.agents.add('session-disposed')
  try {
    await runJs(context, execFor(agent, 'call-1'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 1), true)
    context.plugin.dispose()
    emitTurnEnd(context, session)
    await new Promise((done) => setTimeout(done, 300))
    assert.deepEqual(turnEnded(context.serverLog), [])
  } finally {
    context.restore()
  }
})

test('pc_codex_js_reset uses the agent session and turn ids', async () => {
  const context = setup()
  try {
    const { agent } = context.agents.add('session-reset-ids')
    await context.plugin.tools.get('pc_codex_js_reset').execute({}, execFor(agent, 'call-reset'))
    assert.equal(await waitFor(() => toolCalls(context.serverLog).length === 1), true)
    const [, , sessionId, turnId] = toolCalls(context.serverLog)[0].split(' ')
    await runJs(context, execFor(agent, 'call-js'))
    assert.equal(await waitFor(() => toolCalls(context.serverLog).length === 2), true)
    const jsCall = toolCalls(context.serverLog)[1].split(' ')
    assert.equal(jsCall[2], sessionId)
    assert.equal(jsCall[3], turnId)
  } finally {
    finish(context)
  }
})

test('a turn that only called reset still reports one turn_ended', async () => {
  const context = setup()
  try {
    const { agent, session } = context.agents.add('session-reset-turn')
    await context.plugin.tools.get('pc_codex_js_reset').execute({}, execFor(agent, 'call-only'))
    assert.equal(await waitFor(() => toolCalls(context.serverLog).length === 1), true)
    const [, , sessionId, turnId] = toolCalls(context.serverLog)[0].split(' ')
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => turnEnded(context.serverLog).length === 1), true)
    assert.deepEqual(turnEnded(context.serverLog)[0], {
      hook_event_name: 'Stop',
      session_id: sessionId,
      turn_id: turnId,
    })
  } finally {
    finish(context)
  }
})

test('turn_ended sends the native _meta with only threadId', async () => {
  const context = setup()
  try {
    const { agent, session } = context.agents.add('session-meta')
    await runJs(context, execFor(agent, 'call-js'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 1), true)
    const [, , sessionId, turnId] = callLines(context.serverLog)[0].split(' ')
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => (
      turnEnded(context.serverLog).length === 1 && turnEndedMeta(context.serverLog).length === 1
    )), true)
    const args = turnEnded(context.serverLog)[0]
    assert.deepEqual(turnEndedMeta(context.serverLog)[0], { threadId: sessionId })
    assert.equal('x-codex-turn-metadata' in turnEndedMeta(context.serverLog)[0], false)
    assert.equal(args.session_id, sessionId)
    assert.equal(args.turn_id, turnId)
    // The next turn starts from a new turn id.
    await runJs(context, execFor(agent, 'call-next'))
    assert.equal(await waitFor(() => callLines(context.serverLog).length === 2), true)
    const next = callLines(context.serverLog)[1].split(' ')
    assert.equal(next[2], sessionId)
    assert.notEqual(next[3], turnId)
  } finally {
    finish(context)
  }
})
