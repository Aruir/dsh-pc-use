// r13: the turn tracker is pure per-agent state. These tests inject the clock, the id source
// and the per-server generations, so no process, temp directory or fake server is needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTurnTracker } from '../lib/turn-tracker.js'

/** One test's tracker: counter ids, a settable clock, per-kind generations. O(1). */
function makeTracker() {
  const ids = { count: 0 }
  const clock = { now: 1000 }
  const generations = { browser: 0, desktop: 0 }
  const turns = createTurnTracker({
    generationOf: (kind) => generations[kind],
    now: () => clock.now,
    newId: () => {
      ids.count += 1
      return `id-${ids.count}`
    },
  })
  return { turns, clock, generations }
}

/** One DSH tool execution: only `agent` and `callId` matter to the tracker. O(1). */
function execFor(agent, callId) {
  return { agent, callId, name: 'pc_codex_js', signal: new AbortController().signal }
}

/** A DSH agent with its session, optionally carrying the logged request header. O(1). */
function makeAgent(sessionId, config = null) {
  const session = { id: sessionId }
  if (config !== null) session.requestHeader = () => ({ config })
  const agent = { id: sessionId, session }
  return { agent, session }
}

/** The `agents` service as a Map, matching `agents.get(session.id)`. O(1). */
function agentsOf(...entries) {
  return new Map(entries.map((item) => [item.session.id, item.agent]))
}

/** One `turn/end` session event. O(1). */
function turnEnd(reason = 'completed') {
  return { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: reason } } }
}

/** Run one `turn/end` for a session. O(1). */
function end(turns, agents, session, reason = 'completed') {
  return turns.onSessionEvent(agents, session, turnEnd(reason))
}

test('one agent keeps one session and turn id across calls', () => {
  const { turns } = makeTracker()
  const first = makeAgent('session-one')
  const second = makeAgent('session-two')
  const one = turns.beginCall(execFor(first.agent, 'call-1'), 'browser')
  const two = turns.beginCall(execFor(first.agent, 'call-2'), 'desktop')
  const other = turns.beginCall(execFor(second.agent, 'call-3'), 'browser')
  assert.equal(one.callId, 'call-1')
  assert.equal(two.callId, 'call-2')
  assert.equal(two.sessionId, one.sessionId)
  assert.equal(two.turnId, one.turnId)
  assert.equal(two.turnStartedAtUnixMs, one.turnStartedAtUnixMs)
  // Another DSH agent is another Codex session with its own turn.
  assert.notEqual(other.sessionId, one.sessionId)
  assert.notEqual(other.turnId, one.turnId)
})

test('a call without an agent carries only the call id and opens no turn', () => {
  const { turns } = makeTracker()
  const idle = makeAgent('session-idle')
  const identity = turns.beginCall(execFor(null, 'call-only'), 'browser')
  assert.equal(identity.callId, 'call-only')
  assert.equal(identity.sessionId, undefined)
  assert.equal(identity.turnId, undefined)
  assert.equal(identity.turnStartedAtUnixMs, undefined)
  assert.equal(identity.model, undefined)
  assert.equal(identity.reasoningEffort, undefined)
  // No turn state was created, so this agent's turn end has nothing to report.
  assert.equal(end(turns, agentsOf(idle), idle.session), null)
})

test('model and reasoningEffort come from the request header', () => {
  const { turns } = makeTracker()
  const routed = makeAgent('session-route', { model: 'test-model', reasoningEffort: 'high' })
  const identity = turns.beginCall(execFor(routed.agent, 'call-1'), 'browser')
  assert.equal(identity.model, 'test-model')
  assert.equal(identity.reasoningEffort, 'high')
})

test('a throwing or empty request header omits model and reasoningEffort', () => {
  const { turns } = makeTracker()
  const throwing = makeAgent('session-throws')
  throwing.session.requestHeader = () => {
    throw new Error('header unavailable')
  }
  const empty = makeAgent('session-empty', { model: '', reasoningEffort: '' })
  const thrown = turns.beginCall(execFor(throwing.agent, 'call-1'), 'browser')
  const blank = turns.beginCall(execFor(empty.agent, 'call-2'), 'desktop')
  assert.equal(thrown.model, undefined)
  assert.equal(thrown.reasoningEffort, undefined)
  assert.equal(blank.model, undefined)
  assert.equal(blank.reasoningEffort, undefined)
})

test('turn/end reports used servers in browser then desktop order', () => {
  const { turns } = makeTracker()
  const both = makeAgent('session-both')
  const desktopOnly = makeAgent('session-desktop')
  const agents = agentsOf(both, desktopOnly)
  // Desktop is used first: the report order is still browser, desktop.
  turns.beginCall(execFor(both.agent, 'call-desktop'), 'desktop')
  turns.beginCall(execFor(both.agent, 'call-browser'), 'browser')
  assert.deepEqual(end(turns, agents, both.session).kinds, ['browser', 'desktop'])
  // Unused servers do not appear.
  turns.beginCall(execFor(desktopOnly.agent, 'call-3'), 'desktop')
  assert.deepEqual(end(turns, agents, desktopOnly.session).kinds, ['desktop'])
})

test('a server whose generation changed is not reported', () => {
  const { turns, generations } = makeTracker()
  const item = makeAgent('session-generation')
  const agents = agentsOf(item)
  turns.beginCall(execFor(item.agent, 'call-browser'), 'browser')
  turns.beginCall(execFor(item.agent, 'call-desktop'), 'desktop')
  // A bridge rebuilt after the call increments the generation.
  generations.browser += 1
  assert.deepEqual(end(turns, agents, item.session).kinds, ['desktop'])
})

test('turn/end rotates the turn id and start time but keeps the session id', () => {
  const { turns, clock } = makeTracker()
  const item = makeAgent('session-rotate')
  const agents = agentsOf(item)
  const first = turns.beginCall(execFor(item.agent, 'call-1'), 'browser')
  // The new turn's start time is taken when the old turn ends.
  clock.now = 2000
  const firstEnd = end(turns, agents, item.session)
  assert.deepEqual(firstEnd.identity, { sessionId: first.sessionId, turnId: first.turnId })
  const second = turns.beginCall(execFor(item.agent, 'call-2'), 'browser')
  assert.equal(second.sessionId, first.sessionId)
  assert.notEqual(second.turnId, first.turnId)
  assert.equal(second.turnStartedAtUnixMs, 2000)
  assert.ok(second.turnStartedAtUnixMs > first.turnStartedAtUnixMs)
  const secondEnd = end(turns, agents, item.session)
  assert.deepEqual(secondEnd.kinds, ['browser'])
  // A second turn/end without a new call reports no server but still rotates.
  const thirdEnd = end(turns, agents, item.session)
  assert.deepEqual(thirdEnd.kinds, [])
  assert.notEqual(thirdEnd.identity.turnId, secondEnd.identity.turnId)
})

test('hook names are Stop and Interrupt for aborted or interrupted turns', () => {
  const { turns } = makeTracker()
  const normal = makeAgent('session-normal')
  const aborted = makeAgent('session-aborted')
  const interrupted = makeAgent('session-interrupted')
  const agents = agentsOf(normal, aborted, interrupted)
  for (const item of [normal, aborted, interrupted]) {
    turns.beginCall(execFor(item.agent, `call-${item.session.id}`), 'browser')
  }
  assert.equal(end(turns, agents, normal.session).hookEventName, 'Stop')
  assert.equal(end(turns, agents, aborted.session, 'aborted').hookEventName, 'Interrupt')
  assert.equal(end(turns, agents, interrupted.session, 'interrupted').hookEventName, 'Interrupt')
})

test('a subagent session reports SubagentStop', () => {
  const { turns } = makeTracker()
  const item = makeAgent('session-sub')
  const agents = agentsOf(item)
  turns.beginCall(execFor(item.agent, 'call-1'), 'browser')
  const descriptor = { type: 'subagent/descriptor', seq: 1, data: { version: 1 } }
  assert.equal(turns.onSessionEvent(agents, item.session, descriptor), null)
  assert.equal(end(turns, agents, item.session).hookEventName, 'SubagentStop')
})

test('other events, unknown sessions and agents that never called return null', () => {
  const { turns } = makeTracker()
  const idle = makeAgent('session-idle')
  const called = makeAgent('session-called')
  const agents = agentsOf(idle, called)
  assert.equal(turns.onSessionEvent(agents, idle.session, { type: 'turn/start', seq: 1 }), null)
  // An agent that never began a call has no turn state.
  assert.equal(end(turns, agents, idle.session), null)
  assert.equal(turns.onSessionEvent(agents, { id: 'session-unknown' }, turnEnd()), null)
  assert.equal(turns.onSessionEvent(undefined, idle.session, turnEnd()), null)
  turns.beginCall(execFor(called.agent, 'call-1'), 'browser')
  // The state belongs to `called`'s agent, not to this other session.
  assert.equal(end(turns, agents, idle.session), null)
})
