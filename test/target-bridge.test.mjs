// r15: one target's bridge lifecycle is pure state over injected pieces. These tests use
// in-memory fake bridges and fake spec resolution, so no process or temp directory is needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTargetBridge } from '../lib/target-bridge.js'

/** A resolved launch spec with the fields D15 compares. O(1). */
function spec(overrides = {}) {
  return {
    ok: true,
    command: 'node',
    args: ['server.mjs'],
    cwd: '/work',
    pipeDirectory: 'pipe-one',
    source: 'config',
    env: { NODE_REPL_TRUSTED_SERVICES: '{"sky":{"name":"sky"}}' },
    ...overrides,
  }
}

/** One in-memory bridge: start/stop counters, settable `alive`, optional held handshake. O(1). */
function fakeBridge(options = {}) {
  const bridge = {
    alive: false,
    serverInfo: options.serverInfo ?? null,
    startCount: 0,
    stopCount: 0,
    callCount: 0,
    start() {
      bridge.startCount += 1
      if (options.holdStart === true) {
        return new Promise((resolve, reject) => {
          bridge.release = () => {
            bridge.alive = true
            resolve()
          }
          bridge.failHandshake = (error) => reject(error)
        })
      }
      if (options.startError !== undefined) return Promise.reject(options.startError)
      bridge.alive = true
      return Promise.resolve()
    },
    stop() {
      bridge.stopCount += 1
      bridge.alive = false
    },
    async call() {
      bridge.callCount += 1
      return 'ok'
    },
  }
  return bridge
}

/** Build one target bridge over fakes and record everything a test may inspect. O(1). */
function setup(options = {}) {
  const logs = []
  const created = []
  const resolutions = []
  const state = {
    home: options.home ?? 'home-one',
    stopCalls: 0,
    spec: options.spec ?? spec(),
    resolve: null,
  }
  const makeBridge = options.makeBridge ?? (() => fakeBridge(options.bridge))
  const bridge = createTargetBridge({
    target: options.target ?? 'desktop',
    resolveSpec: (home) => {
      resolutions.push(home)
      if (state.resolve !== null) return state.resolve(home, resolutions.length)
      return state.spec
    },
    codexHome: () => state.home,
    createBridge: (resolved) => {
      const createdBridge = makeBridge(resolved)
      created.push({ spec: resolved, bridge: createdBridge })
      return createdBridge
    },
    pipeState: options.pipeState,
    onStop: () => {
      state.stopCalls += 1
    },
    log: (message) => {
      logs.push(message)
    },
  })
  return { bridge, logs, created, resolutions, state }
}

test('a new bridge has not started anything', () => {
  const { bridge } = setup()
  assert.equal(bridge.started(), false)
  assert.equal(bridge.liveBridge(), null)
  assert.equal(bridge.connectedPipe(), null)
  assert.equal(bridge.generation(), 0)
})

test('ensure creates and starts one bridge, then reuses it', async () => {
  const context = setup()
  const first = await context.bridge.ensure()
  assert.equal(context.created.length, 1)
  assert.equal(context.created[0].bridge.startCount, 1)
  assert.equal(context.bridge.generation(), 1)
  assert.equal(context.bridge.started(), true)
  assert.equal(context.bridge.liveBridge(), first)
  assert.equal(context.bridge.connectedPipe(), 'pipe-one')
  // D15 re-check resolves again, sees the same spec and keeps the bridge.
  const second = await context.bridge.ensure()
  assert.equal(second, first)
  assert.equal(context.created.length, 1)
  assert.equal(context.created[0].bridge.startCount, 1)
  assert.equal(context.bridge.generation(), 1)
})

test('a second ensure during the handshake waits for the same bridge', async () => {
  const context = setup({ bridge: { holdStart: true } })
  const first = context.bridge.ensure()
  const second = context.bridge.ensure()
  assert.equal(context.created.length, 1)
  context.created[0].bridge.release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, b)
  assert.equal(a, context.created[0].bridge)
  assert.equal(context.created.length, 1)
  assert.equal(context.created[0].bridge.startCount, 1)
})

test('a failed handshake throws, keeps generation, and the next ensure retries', async () => {
  let attempt = 0
  const context = setup({
    makeBridge: () => {
      attempt += 1
      return fakeBridge(attempt === 1 ? { startError: new Error('handshake failed') } : {})
    },
  })
  await assert.rejects(() => context.bridge.ensure(), /handshake failed/)
  assert.equal(context.bridge.started(), false)
  assert.equal(context.bridge.generation(), 0)
  const second = await context.bridge.ensure()
  assert.equal(context.created.length, 2)
  assert.equal(second, context.created[1].bridge)
  assert.equal(context.bridge.generation(), 1)
})

test('D15 reuses an unchanged spec and reconnects when a field changes', async () => {
  const changedSpec = spec({ args: ['server.mjs', 'extra'] })
  const desktopResources = [spec(), spec(), changedSpec, changedSpec]
  const desktop = setup()
  desktop.state.resolve = () => desktopResources.shift()
  const first = await desktop.bridge.ensure()
  assert.equal(await desktop.bridge.ensure(), first)
  assert.equal(desktop.created.length, 1)
  assert.equal(desktop.created[0].bridge.stopCount, 0)
  const rebuilt = await desktop.bridge.ensure()
  assert.equal(desktop.created.length, 2)
  assert.equal(rebuilt, desktop.created[1].bridge)
  assert.equal(desktop.created[0].bridge.stopCount, 1)
  assert.equal(desktop.logs.includes(
    'Codex server changed (args); reconnecting (desktop)',
  ), true)
  // Only the field names are logged, never the changed values.
  assert.equal(desktop.logs.some((line) => line.includes('extra')), false)

  const browserResources = [
    spec({ pipeDirectory: 'pipe-a' }), spec({ pipeDirectory: 'pipe-a' }),
    spec({ pipeDirectory: 'pipe-b' }), spec({ pipeDirectory: 'pipe-b' }),
  ]
  const browser = setup({ target: 'browser' })
  browser.state.resolve = () => browserResources.shift()
  await browser.bridge.ensure()
  await browser.bridge.ensure()
  await browser.bridge.ensure()
  assert.equal(browser.logs.includes(
    'Codex server changed (pipeDirectory); reconnecting (browser)',
  ), true)
})

test('a failing re-check keeps the current connection', async () => {
  const throwing = setup()
  let calls = 0
  throwing.state.resolve = () => {
    calls += 1
    if (calls === 1) return spec()
    throw new Error('bad config')
  }
  const keptAfterThrow = await throwing.bridge.ensure()
  assert.equal(await throwing.bridge.ensure(), keptAfterThrow)
  assert.equal(throwing.created.length, 1)
  assert.equal(throwing.logs.includes(
    'Codex server re-check failed; keeping the current connection',
  ), true)

  const unresolved = setup()
  let count = 0
  unresolved.state.resolve = () => {
    count += 1
    return count === 1 ? spec() : { ok: false, reason: 'missing' }
  }
  const kept = await unresolved.bridge.ensure()
  assert.equal(await unresolved.bridge.ensure(), kept)
  assert.equal(unresolved.created.length, 1)
})

test('a changed Codex home reconnects, and a failed resolve drops the old bridge', async () => {
  const context = setup()
  const first = await context.bridge.ensure()
  context.state.home = 'home-two'
  const second = await context.bridge.ensure()
  assert.notEqual(second, first)
  assert.equal(context.created.length, 2)
  assert.equal(first.stopCount, 1)
  assert.equal(context.logs.includes('Codex home changed; reconnecting (desktop)'), true)
  assert.equal(context.bridge.liveBridge(), second)

  const failing = setup()
  const old = await failing.bridge.ensure()
  failing.state.home = 'home-two'
  failing.state.resolve = () => {
    throw new Error('unreadable config')
  }
  await assert.rejects(() => failing.bridge.ensure(), /unreadable config/)
  assert.equal(old.stopCount, 1)
  assert.equal(failing.bridge.liveBridge(), null)
  assert.equal(failing.bridge.started(), false)
  assert.equal(failing.bridge.generation(), 1)
})

test('an ensure after the bridge died stops it and starts a new one', async () => {
  const context = setup()
  const first = await context.bridge.ensure()
  first.alive = false
  const second = await context.bridge.ensure()
  assert.equal(context.created.length, 2)
  assert.equal(first.stopCount, 1)
  assert.equal(second, context.created[1].bridge)
  assert.equal(context.bridge.liveBridge(), second)
})

test('stop stops the bridge and runs onStop even without one', async () => {
  const context = setup()
  const created = await context.bridge.ensure()
  context.bridge.stop()
  assert.equal(created.stopCount, 1)
  assert.equal(context.state.stopCalls, 1)
  assert.equal(context.bridge.started(), false)
  assert.equal(context.bridge.liveBridge(), null)
  // With no bridge the hook still runs (a desktop rebuild must forget remembered approvals).
  context.bridge.stop()
  assert.equal(context.state.stopCalls, 2)
  assert.equal(created.stopCount, 1)
})

test('status reports unparsed, resolved, connected and pending states', async () => {
  const context = setup()
  context.state.spec = { ok: false, reason: 'no config' }
  assert.deepEqual(context.bridge.status(), {
    resolved: false,
    reason: 'no config',
    source: null,
    command: null,
    cwd: null,
    nativePipe: null,
    connected: false,
    services: null,
    connectedPipe: null,
    reconnectPending: false,
    serverInfo: null,
    pluginVersion: null,
    nativePipeState: null,
  })

  context.state.spec = spec()
  const resolvedOnly = context.bridge.status()
  assert.equal(resolvedOnly.resolved, true)
  assert.equal(resolvedOnly.connected, false)
  assert.equal(resolvedOnly.nativePipe, 'pipe-one')
  assert.equal(resolvedOnly.connectedPipe, null)
  assert.equal(resolvedOnly.reconnectPending, false)
  assert.equal(resolvedOnly.serverInfo, null)
  assert.equal(resolvedOnly.pluginVersion, null)
  assert.equal(resolvedOnly.nativePipeState, 'missing')

  await context.bridge.ensure()
  const connected = context.bridge.status()
  assert.equal(connected.connected, true)
  assert.deepEqual(connected.services, ['sky'])
  assert.equal(connected.connectedPipe, 'pipe-one')
  assert.equal(connected.reconnectPending, false)
  assert.equal(connected.serverInfo, null)
  assert.equal(connected.pluginVersion, null)
  assert.equal(connected.nativePipeState, 'missing')

  context.state.spec = spec({ pipeDirectory: 'pipe-two' })
  const pending = context.bridge.status()
  assert.equal(pending.nativePipe, 'pipe-two')
  assert.equal(pending.connectedPipe, 'pipe-one')
  assert.equal(pending.reconnectPending, true)
})

test('status reports serverInfo only while connected and the source version', async () => {
  const context = setup({
    spec: spec({ source: '/cache/unified-computer-use/2.3.4/.mcp.json' }),
    bridge: { serverInfo: { name: 'server', version: '2.3.4' } },
  })
  const unconnected = context.bridge.status()
  assert.equal(unconnected.serverInfo, null)
  assert.equal(unconnected.pluginVersion, '2.3.4')
  await context.bridge.ensure()
  assert.deepEqual(context.bridge.status().serverInfo, { name: 'server', version: '2.3.4' })
})

test('status checks the pipe the next connection would use', async () => {
  const seen = []
  const context = setup({
    pipeState: (path) => {
      seen.push(path)
      return `state:${path}`
    },
  })
  context.state.spec = { ok: false, reason: 'none' }
  assert.equal(context.bridge.status().nativePipeState, null)
  context.state.spec = spec()
  assert.equal(context.bridge.status().nativePipeState, 'state:pipe-one')
  await context.bridge.ensure()
  seen.length = 0
  context.state.spec = spec({ pipeDirectory: 'pipe-two' })
  assert.equal(context.bridge.status().nativePipeState, 'state:pipe-two')
  assert.deepEqual(seen, ['pipe-two'])
})

test('the handshake logs a fixed pipe line without the pipe path', async () => {
  for (const [state, line] of [
    ['missing', 'native pipe not found (desktop)'],
    ['check failed', 'native pipe check failed (desktop)'],
  ]) {
    const context = setup({ pipeState: () => state })
    const created = await context.bridge.ensure()
    assert.equal(created, context.created[0].bridge)
    assert.equal(context.logs.includes(line), true, state)
    assert.equal(context.logs.some((entry) => entry.includes('pipe-one')), false, state)
  }
  for (const state of ['present', null]) {
    const context = setup({ pipeState: () => state })
    await context.bridge.ensure()
    assert.equal(context.logs.some((entry) => entry.startsWith('native pipe ')), false,
      state)
  }
})

test('a throwing pipe check does not change ensure', async () => {
  const context = setup({
    pipeState: () => {
      throw new Error('pipe check failed')
    },
  })
  const created = await context.bridge.ensure()
  assert.equal(created, context.created[0].bridge)
  assert.equal(context.bridge.generation(), 1)
  assert.equal(context.bridge.status().nativePipeState, 'check failed')
  assert.equal(context.logs.includes('native pipe check failed (desktop)'), true)
})

test('spec caches the last resolution until the Codex home changes', async () => {
  const context = setup()
  await context.bridge.ensure()
  assert.equal(context.resolutions.length, 1)
  const cached = context.bridge.spec()
  assert.equal(context.resolutions.length, 1)
  assert.equal(cached, context.state.spec)

  context.state.home = 'home-two'
  context.state.spec = spec({ command: 'node-two' })
  const fresh = context.bridge.spec()
  assert.equal(context.resolutions.length, 2)
  assert.equal(fresh.command, 'node-two')

  context.state.resolve = () => {
    throw new Error('unreadable config')
  }
  context.state.home = 'home-three'
  assert.deepEqual(context.bridge.spec(), { ok: false, reason: 'unreadable config' })
})
