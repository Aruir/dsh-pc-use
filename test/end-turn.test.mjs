// A: a finished DSH turn closes the desktop turn over Codex's native pipe (end_turn), so
// the cursor overlay can disappear. Failures are logged with fixed reasons only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor } from './helpers.mjs'
import {
  DESKTOP_ENV, DUAL_SERVER, startServers, stopServers, writeDesktopSource,
} from './fixtures/server-harness.mjs'
import { startFakePipe } from './fixtures/fake-native-pipe-server.mjs'

const WRITE = Symbol.for('cosmokit.volatile.write')

function pipePath() {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\pc-use-int-${process.pid}-${randomUUID()}`
  }
  return join(tempDir('pc-use-int-'), 'native-pipe.sock')
}

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

function execFor(agent, callId) {
  return { agent, name: 'pc_codex_desktop_js', callId, signal: new AbortController().signal }
}

function emitTurnEnd(context, session) {
  context.plugin.emit('session/event', session, {
    type: 'turn/end',
    seq: 7,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
}

function readLog(context) {
  return readFileSync(context.logFile, 'utf8')
}

test('a desktop turn reports to both servers and closes the desktop cursor', async () => {
  const pipe = pipePath()
  const fake = await startFakePipe(pipe, { mode: 'ok' })
  const agents = makeAgents()
  const context = startServers({
    desktop: { mode: 'ok', env: { ...DESKTOP_ENV, SKY_CUA_NATIVE_PIPE_DIRECTORY: pipe } },
    config: { computer: true },
    services: { agents },
  })
  const { agent, session } = agents.add('agent-a')
  try {
    // Both servers must be connected for the native "report every connected server" rule.
    await context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'browser' }, {
      agent, name: 'pc_codex_js', callId: 'call-b', signal: new AbortController().signal,
    })
    await context.plugin.tools.get('pc_codex_desktop_js')
      .execute({ code: '1', title: 'turn' }, execFor(agent, 'call-1'))
    const call = context.desktopCalls().at(-1)
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => fake.frames.length === 1), true)
    assert.equal(await waitFor(() => (
      context.browserCalls().some((item) => item.name === 'turn_ended')
      && context.desktopCalls().some((item) => item.name === 'turn_ended')
    )), true)
    const request = fake.frames[0]
    assert.equal(request.method, 'request')
    assert.equal(request.params.method, 'end_turn')
    assert.deepEqual(request.params.params, {})
    assert.deepEqual(request.params.codexTurnMetadata, {
      session_id: call.session_id,
      turn_id: call.turn_id,
    })
    await fake.waitForDisconnect()
    assert.equal(await waitFor(() => (
      readLog(context).includes('desktop turn closed (end_turn)')
    )), true)
  } finally {
    await fake.close()
    assert.equal(await stopServers(context), true)
  }
})

test('a rebuilt bridge receives turn_ended but keeps the old turn cursor', async () => {
  const pipe = pipePath()
  const fake = await startFakePipe(pipe, { mode: 'ok' })
  const agents = makeAgents()
  const home = tempDir('pc-use-gen-')
  const restore = useHome(home)
  const firstHome = join(home, 'codex-1')
  const secondHome = join(home, 'codex-2')
  const firstLog = join(home, 'one.log')
  const secondLog = join(home, 'two.log')
  const desktopEnv = { ...DESKTOP_ENV, SKY_CUA_NATIVE_PIPE_DIRECTORY: pipe }
  writeDesktopSource(firstHome, [DUAL_SERVER, 'desktop', 'ok', firstLog], desktopEnv)
  writeDesktopSource(secondHome, [DUAL_SERVER, 'desktop', 'ok', secondLog], desktopEnv)
  let current = firstHome
  const codexHome = {
    get: () => current,
    [WRITE](next) {
      current = next
    },
  }
  const plugin = registerPlugin({
    codexHome,
    computer: true,
    logFile: join(home, 'bridge.log'),
  }, { services: { agents } })
  const first = agents.add('agent-first')
  const second = agents.add('agent-second')
  try {
    await plugin.tools.get('pc_codex_desktop_js')
      .execute({ code: '1', title: 'one' }, execFor(first.agent, 'call-1'))
    codexHome[WRITE](secondHome)
    // A call on another agent reconnects the bridge, so the first turn's generation is stale.
    await plugin.tools.get('pc_codex_desktop_js')
      .execute({ code: '2', title: 'two' }, execFor(second.agent, 'call-2'))
    emitTurnEnd({ plugin }, first.session)
    // The rebuilt connection still receives the call for the turn that ended...
    assert.equal(await waitFor(() => {
      try {
        return readFileSync(secondLog, 'utf8').includes('turn_ended')
      } catch {
        return false
      }
    }), true)
    // ...but the desktop cursor is not closed for a turn from the old bridge.
    await new Promise((done) => setTimeout(done, 250))
    assert.equal(fake.frames.length, 0, 'old generation must not close the cursor')
  } finally {
    plugin.dispose()
    await fake.close()
    restore()
  }
})

test('a silent pipe times out within five seconds and does not break the next turn', async () => {
  const pipe = pipePath()
  const fake = await startFakePipe(pipe, { mode: 'silent' })
  const agents = makeAgents()
  const context = startServers({
    browser: false,
    desktop: { mode: 'ok', env: { ...DESKTOP_ENV, SKY_CUA_NATIVE_PIPE_DIRECTORY: pipe } },
    config: { computer: true },
    services: { agents },
  })
  const { agent, session } = agents.add('agent-timeout')
  try {
    await context.plugin.tools.get('pc_codex_desktop_js')
      .execute({ code: '1', title: 'timeout' }, execFor(agent, 'call-1'))
    const started = Date.now()
    emitTurnEnd(context, session)
    assert.equal(
      await waitFor(() => readLog(context).includes('end_turn failed: timeout'), 6500),
      true,
    )
    assert.equal(Date.now() - started < 6500, true)
    const next = await context.plugin.tools.get('pc_codex_desktop_js')
      .execute({ code: '2', title: 'next' }, execFor(agent, 'call-2'))
    assert.match(next, /ran js/)
  } finally {
    await fake.close()
    assert.equal(await stopServers(context), true)
  }
})

test('duplicate turn/end events send only one frame', async () => {
  const pipe = pipePath()
  const fake = await startFakePipe(pipe, { mode: 'ok' })
  const agents = makeAgents()
  const context = startServers({
    browser: false,
    desktop: { mode: 'ok', env: { ...DESKTOP_ENV, SKY_CUA_NATIVE_PIPE_DIRECTORY: pipe } },
    config: { computer: true },
    services: { agents },
  })
  const { agent, session } = agents.add('agent-dup')
  try {
    await context.plugin.tools.get('pc_codex_desktop_js')
      .execute({ code: '1', title: 'dup' }, execFor(agent, 'call-1'))
    emitTurnEnd(context, session)
    emitTurnEnd(context, session)
    assert.equal(await waitFor(() => fake.frames.length === 1), true)
    await new Promise((done) => setTimeout(done, 150))
    assert.equal(fake.frames.length, 1)
  } finally {
    await fake.close()
    assert.equal(await stopServers(context), true)
  }
})

test('an unreachable pipe logs a fixed failure and the next turn still works', async () => {
  const pipe = pipePath()
  const fake = await startFakePipe(pipe, { mode: 'ok' })
  await fake.close()
  const agents = makeAgents()
  const context = startServers({
    browser: false,
    desktop: { mode: 'ok', env: { ...DESKTOP_ENV, SKY_CUA_NATIVE_PIPE_DIRECTORY: pipe } },
    config: { computer: true },
    services: { agents },
  })
  const { agent, session } = agents.add('agent-missing')
  try {
    await context.plugin.tools.get('pc_codex_desktop_js')
      .execute({ code: '1', title: 'missing' }, execFor(agent, 'call-1'))
    emitTurnEnd(context, session)
    assert.equal(
      await waitFor(() => /end_turn failed: (no pipe|connect failed)/.test(readLog(context))),
      true,
    )
    const result = await context.plugin.tools.get('pc_codex_desktop_js')
      .execute({ code: '2', title: 'next' }, execFor(agent, 'call-2'))
    assert.match(result, /ran js/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
