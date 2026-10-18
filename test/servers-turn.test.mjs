// 0.5.0 S4: one Codex session/turn identity shared by both servers, per-server "used"
// tracking, and no turn_ended on a bridge that was rebuilt after the call.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { waitFor } from './helpers.mjs'
import {
  DUAL_SERVER, startServers, stopServers, writeDesktopSource,
} from './fixtures/server-harness.mjs'

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

function execFor(agent, callId, name) {
  return { agent, name, callId, signal: new AbortController().signal }
}

function runBrowser(context, exec) {
  return context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'browser' }, exec)
}

function runDesktop(context, exec) {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '1', title: 'desktop' }, exec)
}

function emitTurnEnd(context, session, reason = { kind: 'completed' }) {
  context.plugin.emit('session/event', session, {
    type: 'turn/end', seq: 11, data: { turn: 1, reason },
  })
}

function turnEndedCalls(context, side) {
  return context[`${side}Calls`]().filter((call) => call.name === 'turn_ended')
}

test('both servers used in one turn each receive turn_ended with the same identity', async () => {
  const agents = makeAgents()
  const context = startServers({ config: { computer: true }, services: { agents } })
  try {
    const { agent, session } = agents.add('session-both')
    await runBrowser(context, execFor(agent, 'call-browser', 'pc_codex_js'))
    await runDesktop(context, execFor(agent, 'call-desktop'))
    const browserCalls = context.browserCalls()
    const desktopCalls = context.desktopCalls()
    assert.equal(browserCalls.length, 1)
    assert.equal(desktopCalls.length, 1)
    assert.equal(browserCalls[0].session_id, desktopCalls[0].session_id)
    assert.equal(browserCalls[0].turn_id, desktopCalls[0].turn_id)
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => (
      turnEndedCalls(context, 'browser').length === 1
      && turnEndedCalls(context, 'desktop').length === 1
    )), true)
    for (const side of ['browser', 'desktop']) {
      const report = turnEndedCalls(context, side)[0]
      assert.deepEqual(report.arguments, {
        hook_event_name: 'Stop',
        session_id: browserCalls[0].session_id,
        turn_id: browserCalls[0].turn_id,
      }, side)
    }
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('only the used server receives turn_ended', async () => {
  const agents = makeAgents()
  const context = startServers({ config: { computer: true }, services: { agents } })
  try {
    const { agent, session } = agents.add('session-browser-only')
    await runBrowser(context, execFor(agent, 'call-browser', 'pc_codex_js'))
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => turnEndedCalls(context, 'browser').length === 1), true)
    assert.deepEqual(turnEndedCalls(context, 'desktop'), [])
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a rebuilt desktop bridge does not receive the previous turn', async () => {
  const agents = makeAgents()
  const context = startServers({ config: { computer: true }, services: { agents } })
  try {
    const first = agents.add('session-a')
    const second = agents.add('session-b')
    await runBrowser(context, execFor(first.agent, 'call-a-browser', 'pc_codex_js'))
    await runDesktop(context, execFor(first.agent, 'call-a-desktop'))
    assert.equal(context.desktopStart().length, 1)
    assert.equal(context.browserStart().length, 1)
    // Agent B's desktop call rebuilds the desktop bridge after the config rewrite.
    writeDesktopSource(context.codexHome, [
      DUAL_SERVER, 'desktop', 'ok', context.logs.desktop, 'extra',
    ])
    await runDesktop(context, execFor(second.agent, 'call-b-desktop'))
    assert.equal(await waitFor(() => context.desktopStart().length === 2), true)
    const rebuiltCalls = context.desktopCalls().length
    // Agent A's turn ends now: its browser bridge is the one it used, so it reports;
    // its desktop use belongs to the previous bridge, so the new bridge gets nothing.
    emitTurnEnd(context, first.session)
    assert.equal(await waitFor(() => turnEndedCalls(context, 'browser').length === 1), true)
    assert.equal(turnEndedCalls(context, 'desktop').length, 0)
    assert.equal(context.desktopCalls().length, rebuiltCalls)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('the next turn starts from a new shared turn id on both servers', async () => {
  const agents = makeAgents()
  const context = startServers({ config: { computer: true }, services: { agents } })
  try {
    const { agent, session } = agents.add('session-rotate')
    await runBrowser(context, execFor(agent, 'call-1-b', 'pc_codex_js'))
    await runDesktop(context, execFor(agent, 'call-1-d'))
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => (
      turnEndedCalls(context, 'browser').length === 1
      && turnEndedCalls(context, 'desktop').length === 1
    )), true)
    await runBrowser(context, execFor(agent, 'call-2-b', 'pc_codex_js'))
    await runDesktop(context, execFor(agent, 'call-2-d'))
    const jsCalls = (calls) => calls.filter((call) => call.name === 'js')
    const secondBrowser = jsCalls(context.browserCalls())[1]
    const secondDesktop = jsCalls(context.desktopCalls())[1]
    const firstJs = jsCalls(context.browserCalls())[0]
    assert.equal(secondBrowser.session_id, firstJs.session_id)
    assert.notEqual(secondBrowser.turn_id, firstJs.turn_id)
    assert.equal(secondDesktop.session_id, secondBrowser.session_id)
    assert.equal(secondDesktop.turn_id, secondBrowser.turn_id)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a turn that only called the desktop reset reports desktop turn_ended', async () => {
  const agents = makeAgents()
  const context = startServers({ config: { computer: true }, services: { agents } })
  try {
    const { agent, session } = agents.add('session-reset')
    await context.plugin.tools.get('pc_codex_desktop_js_reset')
      .execute({}, execFor(agent, 'call-reset', 'pc_codex_desktop_js_reset'))
    assert.equal(context.desktopCalls().filter((call) => call.name === 'js_reset').length, 1)
    emitTurnEnd(context, session, { kind: 'aborted', reason: { kind: 'user' } })
    assert.equal(await waitFor(() => turnEndedCalls(context, 'desktop').length === 1), true)
    assert.equal(turnEndedCalls(context, 'desktop')[0].arguments.hook_event_name, 'Interrupt')
    assert.deepEqual(turnEndedCalls(context, 'browser'), [])
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
