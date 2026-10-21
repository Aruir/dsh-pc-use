// R1 meta-fields (SPEC-r1-meta-fields.md): every tools/call carries the `_meta` fields DSH
// can fill honestly, the fields DSH cannot fill stay absent, and turn_ended keeps its old
// `_meta` byte for byte. Test names map to the spec's sections.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { McpBridge } from '../lib/mcp-bridge.js'
import { registerPlugin, tempDir, useHome, writeCodexHome } from './helpers.mjs'
import {
  DUAL_SERVER, records, recordsOf, startServers, stopServers,
} from './fixtures/server-harness.mjs'

const COMPUTER_SERVER = fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))

// Every required `x-codex-turn-metadata` field: the plugin must always send these.
const REQUIRED_TURN_KEYS = [
  'session_id', 'thread_id', 'turn_id', 'turn_started_at_unix_ms',
  'auto_review_enabled', 'node_repl_auto_review_required', 'node_repl_disabled',
]
// Section 2 of the spec: never sent. Asserted one key at a time, on both levels.
const FORBIDDEN_FIELDS = [
  'codex_version', 'sandbox', 'sandbox_mode', 'forked_from_thread_id',
  'parent_thread_id', 'subagent_kind', 'thread_source', 'turn_trigger',
  'workspaces', 'user_input_requested_during_turn',
  'plugin_id', 'windowId', 'itemId', 'traceparent', 'tracestate',
  'codex_bridge_mcp_call_id', 'openai/readOnly', 'openai/entitlementContext',
  '_codex_apps', 'codex/sandbox-launcher', 'openai/confirmation_policies',
  'codex/sandbox-state', 'codex/sandbox-state-meta',
]

// The fake servers answer through real pipes; poll with performance.now so the injected
// Date clock used by the timestamp test cannot freeze a deadline.
async function until(predicate, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await predicate()) return true
    await new Promise((done) => setTimeout(done, 25))
  }
  return Boolean(await predicate())
}

/**
 * Fake `agents` service. Each session optionally exposes the request header the DSH agent
 * loop logs for its latest request (`Session.requestHeader()` -> `{ config }`).
 */
function makeAgents() {
  const byId = new Map()
  return {
    add(id, route = null) {
      const session = { id }
      if (route !== null) {
        session.requestHeader = () => ({ config: { provider: 'test-provider', ...route } })
      }
      const agent = { id, session }
      byId.set(id, agent)
      return { agent, session }
    },
    get(id) {
      return byId.get(id)
    },
  }
}

/** One DSH tool execution context (`exec`) as the host passes it to a tool. */
function execFor(agent, callId) {
  return {
    agent,
    name: 'pc_codex_js',
    ...(callId === undefined ? {} : { callId }),
    signal: new AbortController().signal,
  }
}

function toolAt(context, name) {
  return context.plugin.tools.get(name)
}

/** The `tools/call` records one fake server received. O(n). */
function calls(context, side) {
  return side === 'desktop' ? context.desktopCalls() : context.browserCalls()
}

function jsCalls(records) {
  return records.filter((record) => record.name === 'js')
}

/** The parsed `params._meta` the fake server recorded for one `tools/call`. */
function metaOf(record) {
  assert.notEqual(record.meta, null, `${record.name} carried no _meta`)
  return record.meta
}

function turnMetaOf(record) {
  const turn = metaOf(record)['x-codex-turn-metadata']
  assert.equal(typeof turn, 'object', `${record.name} has no x-codex-turn-metadata`)
  assert.notEqual(turn, null, `${record.name} has no x-codex-turn-metadata`)
  return turn
}

/**
 * Assert the required fields and the optional route fields of one recorded call.
 * `model` / `reasoningEffort` null means "the DSH agent provided no value, so the key must
 * be absent". O(1).
 */
function assertRequiredFields(record, { model = null, reasoningEffort = null } = {}) {
  const meta = metaOf(record)
  const turn = turnMetaOf(record)
  for (const key of REQUIRED_TURN_KEYS) {
    assert.equal(Object.hasOwn(turn, key), true, `missing x-codex-turn-metadata.${key}`)
  }
  assert.equal(typeof turn.session_id, 'string')
  assert.equal(turn.thread_id, turn.session_id)
  assert.equal(typeof turn.turn_id, 'string')
  assert.equal(Number.isInteger(turn.turn_started_at_unix_ms), true)
  assert.equal(turn.auto_review_enabled, false)
  assert.equal(turn.node_repl_auto_review_required, false)
  assert.equal(turn.node_repl_disabled, false)
  // Top-level camelCase identities equal the nested snake_case ones.
  assert.equal(meta.threadId, turn.session_id)
  assert.equal(meta.sessionId, turn.session_id)
  assert.equal(meta.threadId, turn.thread_id)
  assert.equal(meta.sessionId, turn.session_id)
  if (model === null) {
    assert.equal(Object.hasOwn(turn, 'model'), false, 'model must be omitted')
  } else {
    assert.equal(turn.model, model)
  }
  if (reasoningEffort === null) {
    assert.equal(Object.hasOwn(turn, 'reasoning_effort'), false, 'reasoning_effort omitted')
  } else {
    assert.equal(turn.reasoning_effort, reasoningEffort)
  }
}

function readLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
}

/** The text after `prefix` for every recorded line that has it. O(n). */
function prefixed(file, prefix) {
  return readLines(file)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
}

/** tools/call records in the order one fake server received them. O(n). */
function toolCallsInOrder(file) {
  return records(file)
    .filter((entry) => entry.type === 'call')
    .map((entry) => ({
      name: entry.name,
      callId: entry.meta?.callId ?? null,
      turnId: entry.turn_id,
      arguments: entry.arguments,
    }))
}

test('js, observe and run_plan carry every required field on both surfaces', async () => {
  const agents = makeAgents()
  const context = startServers({ config: { computer: true }, services: { agents } })
  const { agent } = agents.add('session-fields', {
    model: 'test-model',
    reasoningEffort: 'high',
  })
  try {
    await toolAt(context, 'pc_codex_js')
      .execute({ code: '1', title: 'js' }, execFor(agent, 'call-js'))
    await toolAt(context, 'pc_codex_desktop_js')
      .execute({ code: '1', title: 'desktop' }, execFor(agent, 'call-desktop'))
    await toolAt(context, 'pc_codex_observe')
      .execute({ target: 'browser', subject: 'tab' }, execFor(agent, 'call-observe-b'))
    await toolAt(context, 'pc_codex_observe')
      .execute({ target: 'desktop', subject: 'targetWindow' }, execFor(agent, 'call-observe-d'))
    const plan = toolAt(context, 'pc_codex_run_plan')
    // A checked browser step is two calls (step and check) under one DSH call id.
    assert.match(await plan.execute({
      target: 'browser',
      steps: [{ title: 'checked', code: '1', check: 'true' }],
    }, execFor(agent, 'call-plan-b')), /run_plan: 1\/1 steps ok/)
    await plan.execute({ target: 'desktop', steps: [{ title: 'one', code: '1' }] },
      execFor(agent, 'call-plan-d'))
    const recorded = [...calls(context, 'browser'), ...calls(context, 'desktop')]
    assert.equal(recorded.length, 7)
    const byCallId = (callId) => recorded.filter((record) => metaOf(record).callId === callId)
    for (const callId of [
      'call-js', 'call-desktop', 'call-observe-b', 'call-observe-d', 'call-plan-d',
    ]) {
      assert.equal(byCallId(callId).length, 1, callId)
    }
    assert.equal(byCallId('call-plan-b').length, 2)
    for (const record of recorded) {
      assertRequiredFields(record, { model: 'test-model', reasoningEffort: 'high' })
    }
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('callId equals the DSH execution call id and is omitted when there is none', async () => {
  const agents = makeAgents()
  const context = startServers({ services: { agents } })
  const { agent } = agents.add('session-call-id')
  try {
    const withId = execFor(agent, 'dsh-call-7')
    await toolAt(context, 'pc_codex_js').execute({ code: '1', title: 'with id' }, withId)
    const withoutId = { agent, name: 'pc_codex_js', signal: new AbortController().signal }
    await toolAt(context, 'pc_codex_js').execute({ code: '2', title: 'without id' }, withoutId)
    const records = jsCalls(calls(context, 'browser'))
    assert.equal(records.length, 2)
    assert.equal(metaOf(records[0]).callId, 'dsh-call-7')
    assert.equal(Object.hasOwn(metaOf(records[1]), 'callId'), false)
    // A call without an agent falls back to the bridge identity and also has no call id.
    await toolAt(context, 'pc_codex_js_reset').execute({}, {})
    const resetRecord = calls(context, 'browser').find((record) => record.name === 'js_reset')
    assert.notEqual(resetRecord, undefined)
    assert.equal(Object.hasOwn(metaOf(resetRecord), 'callId'), false)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('fields DSH cannot honestly fill stay absent, checked key by key', async () => {
  const agents = makeAgents()
  const context = startServers({ services: { agents } })
  const { agent } = agents.add('session-forbidden', {
    model: 'test-model',
    reasoningEffort: 'high',
  })
  try {
    await toolAt(context, 'pc_codex_js')
      .execute({ code: '1', title: 'fields' }, execFor(agent, 'call-fields'))
    const record = calls(context, 'browser')[0]
    const meta = metaOf(record)
    const turn = turnMetaOf(record)
    for (const key of FORBIDDEN_FIELDS) {
      assert.equal(Object.hasOwn(meta, key), false, `top level ${key}`)
      assert.equal(Object.hasOwn(turn, key), false, `x-codex-turn-metadata.${key}`)
    }
    // Exact key sets as well: an unexpected extra field also fails this test.
    const expectedTurnKeys = [...REQUIRED_TURN_KEYS, 'model', 'reasoning_effort'].sort()
    const expectedMetaKeys = ['callId', 'threadId', 'sessionId', 'x-codex-turn-metadata'].sort()
    assert.deepEqual(Object.keys(turn).sort(), expectedTurnKeys)
    assert.deepEqual(Object.keys(meta).sort(), expectedMetaKeys)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('model and reasoning_effort follow the DSH route and are omitted when unknown', async () => {
  const agents = makeAgents()
  const context = startServers({ services: { agents } })
  try {
    const full = agents.add('session-full', {
      model: 'test-model',
      reasoningEffort: 'high',
    })
    await toolAt(context, 'pc_codex_js')
      .execute({ code: '1', title: 'full' }, execFor(full.agent, 'call-full'))
    const modelOnly = agents.add('session-model', { model: 'test-model-2' })
    await toolAt(context, 'pc_codex_js')
      .execute({ code: '2', title: 'model only' }, execFor(modelOnly.agent, 'call-model'))
    const none = agents.add('session-none')
    await toolAt(context, 'pc_codex_js')
      .execute({ code: '3', title: 'none' }, execFor(none.agent, 'call-none'))
    const records = jsCalls(calls(context, 'browser'))
    assert.equal(records.length, 3)
    assertRequiredFields(records[0], { model: 'test-model', reasoningEffort: 'high' })
    assertRequiredFields(records[1], { model: 'test-model-2', reasoningEffort: null })
    assertRequiredFields(records[2], { model: null, reasoningEffort: null })
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('empty callId, model and reasoning_effort are omitted', async () => {
  const agents = makeAgents()
  const context = startServers({ services: { agents } })
  const { agent } = agents.add('session-empty', { model: '', reasoningEffort: '' })
  try {
    await toolAt(context, 'pc_codex_js')
      .execute({ code: '1', title: 'empty' }, execFor(agent, ''))
    const record = calls(context, 'browser')[0]
    assertRequiredFields(record, { model: null, reasoningEffort: null })
    assert.equal(Object.hasOwn(metaOf(record), 'callId'), false)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('turn_started_at_unix_ms is an integer fixed per turn and grows after rotation', async (t) => {
  // An injected Date clock: no real time, so the values are exact.
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const agents = makeAgents()
  const context = startServers({ services: { agents } })
  const { agent, session } = agents.add('session-clock')
  try {
    const js = toolAt(context, 'pc_codex_js')
    await js.execute({ code: '1', title: 'first' }, execFor(agent, 'call-1'))
    // Advancing the clock inside one turn must not change that turn's start time.
    t.mock.timers.setTime(1_700_000_010_000)
    await js.execute({ code: '2', title: 'second' }, execFor(agent, 'call-2'))
    const sameTurn = jsCalls(calls(context, 'browser'))
    assert.equal(sameTurn.length, 2)
    const startedAt = turnMetaOf(sameTurn[0]).turn_started_at_unix_ms
    assert.equal(startedAt, 1_700_000_000_000)
    assert.equal(turnMetaOf(sameTurn[1]).turn_started_at_unix_ms, startedAt)
    assert.equal(turnMetaOf(sameTurn[0]).turn_id, turnMetaOf(sameTurn[1]).turn_id)
    t.mock.timers.setTime(1_700_000_042_000)
    context.plugin.emit('session/event', session, {
      type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } },
    })
    await js.execute({ code: '3', title: 'third' }, execFor(agent, 'call-3'))
    const next = jsCalls(calls(context, 'browser'))[2]
    const nextStartedAt = turnMetaOf(next).turn_started_at_unix_ms
    assert.equal(Number.isInteger(nextStartedAt), true)
    assert.equal(nextStartedAt, 1_700_000_042_000)
    assert.ok(nextStartedAt > startedAt)
  } finally {
    t.mock.timers.reset()
    assert.equal(await stopServers(context), true)
  }
})

test('a call handed off during a rotation belongs to the new turn and is reported', async () => {
  const agents = makeAgents()
  const context = startServers({ services: { agents } })
  const { agent, session } = agents.add('session-order')
  try {
    const js = toolAt(context, 'pc_codex_js')
    await js.execute({ code: '1', title: 'first' }, execFor(agent, 'call-1'))
    // Hand off the second call, then rotate before it reaches the server. F1: the turn must
    // be read and marked used in the same synchronous block, so this call belongs to the
    // new turn and its turn is reported later.
    const pending = js.execute({ code: '2', title: 'second' }, execFor(agent, 'call-2'))
    context.plugin.emit('session/event', session, {
      type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } },
    })
    await pending
    assert.equal(await until(() => (
      toolCallsInOrder(context.logs.browser).filter((call) => call.name === 'turn_ended').length
        === 1
    )), true)
    // (a) No tools/call may use a turn id whose turn_ended was already sent.
    const endedTurns = new Set()
    for (const call of toolCallsInOrder(context.logs.browser)) {
      if (call.name === 'turn_ended') {
        // turn_ended now uses the native `_meta` (threadId only), so its turn id lives in
        // the call arguments, not in `x-codex-turn-metadata`.
        endedTurns.add(call.arguments?.turn_id)
        continue
      }
      assert.equal(endedTurns.has(call.turnId), false,
        `${call.name} (${call.callId}) reused turn ${call.turnId} after its turn_ended`)
    }
    // (b) The call handed off during the rotation uses the new turn.
    const first = toolCallsInOrder(context.logs.browser)
      .find((call) => call.callId === 'call-1')
    const second = toolCallsInOrder(context.logs.browser)
      .find((call) => call.callId === 'call-2')
    assert.notEqual(first, undefined)
    assert.notEqual(second, undefined)
    assert.notEqual(second.turnId, first.turnId)
    // (c) Ending the new turn reports the same turn id the second call used.
    context.plugin.emit('session/event', session, {
      type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } },
    })
    assert.equal(await until(() => (
      toolCallsInOrder(context.logs.browser).filter((call) => call.name === 'turn_ended').length
        === 2
    )), true)
    const ended = toolCallsInOrder(context.logs.browser)
      .filter((call) => call.name === 'turn_ended')
    assert.equal(
      ended.filter((call) => call.arguments?.turn_id === second.turnId).length,
      1,
    )
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('McpBridge.call fixes the identity snapshot before its first await', async () => {
  const home = tempDir('pc-use-meta-call-')
  const logFile = join(home, 'server.log')
  writeFileSync(logFile, '')
  const bridge = new McpBridge({
    command: process.execPath,
    args: [DUAL_SERVER, 'unit', 'ok', logFile],
    env: process.env,
    cwd: home,
    sessionId: 'dsh-pc-fallback',
    log: () => {},
  })
  const turn = {
    sessionId: 'session-old',
    turnId: 'turn-old',
    turnStartedAtUnixMs: 111,
    callId: 'call-old',
    model: 'model-old',
    reasoningEffort: 'high',
  }
  try {
    const pending = bridge.call('js', { code: '1', title: 'unit' }, 5000, turn)
    // Change the object after the call was handed off but before its first await resumes.
    turn.sessionId = 'session-new'
    turn.turnId = 'turn-new'
    turn.turnStartedAtUnixMs = 999
    await pending
    const record = recordsOf(logFile, 'call')[0]
    assert.notEqual(record, undefined)
    const meta = metaOf(record)
    const turnMeta = turnMetaOf(record)
    assert.equal(turnMeta.session_id, 'session-old')
    assert.equal(turnMeta.thread_id, 'session-old')
    assert.equal(turnMeta.turn_id, 'turn-old')
    assert.equal(turnMeta.turn_started_at_unix_ms, 111)
    assert.equal(meta.sessionId, 'session-old')
    assert.equal(meta.threadId, 'session-old')
    assert.equal(meta.callId, 'call-old')
    assert.equal(turnMeta.model, 'model-old')
    assert.equal(turnMeta.reasoning_effort, 'high')
  } finally {
    bridge.stop()
  }
})

test('turn_ended sends the native _meta with only threadId', async () => {
  const home = tempDir('pc-use-meta-ended-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [COMPUTER_SERVER, 'turn-ended', serverLog])
  const agents = makeAgents()
  const plugin = registerPlugin({
    codexHome,
    logFile: join(home, 'bridge.log'),
  }, { services: { agents } })
  const { agent, session } = agents.add('session-ended')
  try {
    await plugin.tools.get('pc_codex_js')
      .execute({ code: '1', title: 'turn' }, execFor(agent, 'call-1'))
    assert.equal(await until(() => prefixed(serverLog, 'call js ').length === 1), true)
    const [sessionId, turnId] = prefixed(serverLog, 'call js ')[0].split(' ')
    plugin.emit('session/event', session, {
      type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'completed' } },
    })
    assert.equal(await until(() => prefixed(serverLog, 'turn_ended-meta-raw ').length === 1), true)
    const meta = JSON.parse(prefixed(serverLog, 'turn_ended-meta-raw ')[0])
    assert.deepEqual(meta, { threadId: sessionId })
    assert.equal('x-codex-turn-metadata' in meta, false)
    const args = JSON.parse(prefixed(serverLog, 'turn_ended ')[0])
    assert.equal(args.turn_id, turnId)
    assert.equal(args.session_id, sessionId)
  } finally {
    plugin.dispose()
    restore()
  }
})
