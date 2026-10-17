// F1: the `computer` switch adds the computer surface to the child env only, is read on
// every ensureBridge call, and a hot change restarts the bridge without leaking servers.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

const SURFACE_SERVER = process.env.CODEX_CU_SURFACE_SERVER
  ?? fileURLToPath(new URL('./fake-surface-server.mjs', import.meta.url))
const WRITE = Symbol.for('cosmokit.volatile.write')

function createVolatile(value) {
  let current = value
  return Object.freeze({
    get: () => current,
    [WRITE](next) {
      current = next
    },
  })
}

function readLines(file) {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
}

function readPids(file) {
  return readLines(file).map(Number)
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killAll(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {}
  }
}

function setup(envSurfaces = 'browser', config = {}) {
  const home = tempDir('codex-cu-surfaces-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  const pidFile = join(home, 'pids.txt')
  const surfacesFile = join(home, 'surfaces.txt')
  writeFileSync(serverLog, '')
  writeFileSync(pidFile, '')
  writeFileSync(surfacesFile, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(
    codexHome,
    [SURFACE_SERVER, pidFile, surfacesFile, serverLog],
    { CUA_REPL_ENABLED_SURFACES: envSurfaces },
  )
  const plugin = registerPlugin({
    codexHome,
    logFile: join(home, 'bridge.log'),
    stateFile: join(home, 'state.json'),
    ...config,
  })
  return {
    home,
    restore,
    pidFile,
    surfacesFile,
    plugin,
    allPids: () => readPids(pidFile),
  }
}

async function disposeAndFinish(context, startedPids) {
  context.plugin.dispose()
  await waitFor(() => startedPids.every((pid) => !isRunning(pid)))
  context.restore()
  killAll([...new Set([...startedPids, ...context.allPids()])])
}

test('computer:false keeps the .mcp.json surfaces', async () => {
  const context = setup('browser')
  const startedPids = []
  try {
    const js = context.plugin.tools.get('codex_js')
    const result = await js.execute({ code: '1', title: 'surface test' }, {})
    assert.equal(result, 'ran js')
    assert.deepEqual(readLines(context.surfacesFile), ['browser'])
    startedPids.push(...context.allPids())
    assert.equal(startedPids.length, 1)
    context.plugin.dispose()
    assert.equal(await waitFor(() => startedPids.every((pid) => !isRunning(pid))), true)
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('computer:true appends the computer surface', async () => {
  const context = setup('browser', { computer: true })
  const startedPids = []
  try {
    const js = context.plugin.tools.get('codex_js')
    await js.execute({ code: '1', title: 'surface test' }, {})
    assert.deepEqual(readLines(context.surfacesFile), ['browser,computer'])
    startedPids.push(...context.allPids())
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('computer:true does not duplicate an existing computer surface', async () => {
  const context = setup('browser,computer', { computer: true })
  const startedPids = []
  try {
    const js = context.plugin.tools.get('codex_js')
    await js.execute({ code: '1', title: 'surface test' }, {})
    assert.deepEqual(readLines(context.surfacesFile), ['browser,computer'])
    startedPids.push(...context.allPids())
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('codex_status reports the surfaces of the connected bridge', async () => {
  const context = setup('browser', { computer: true })
  const startedPids = []
  try {
    const js = context.plugin.tools.get('codex_js')
    await js.execute({ code: '1', title: 'surface test' }, {})
    const status = JSON.parse(await context.plugin.tools.get('codex_status').execute({}, {}))
    assert.equal(status.connected, true)
    assert.equal(status.computer, 'browser,computer')
    startedPids.push(...context.allPids())
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('enabling computer hot restarts the bridge with the new surfaces', async () => {
  const computer = createVolatile(false)
  const context = setup('browser', { computer })
  const startedPids = []
  try {
    const js = context.plugin.tools.get('codex_js')
    await js.execute({ code: '1', title: 'first' }, {})
    assert.deepEqual(readLines(context.surfacesFile), ['browser'])
    const firstPids = context.allPids()
    assert.equal(firstPids.length, 1)
    startedPids.push(...firstPids)
    computer[WRITE](true)
    await js.execute({ code: '2', title: 'second' }, {})
    assert.deepEqual(readLines(context.surfacesFile), ['browser', 'browser,computer'])
    const allPids = context.allPids()
    assert.equal(allPids.length, 2)
    startedPids.push(...allPids.filter((pid) => !startedPids.includes(pid)))
    assert.equal(await waitFor(() => !isRunning(firstPids[0])), true)
    const alive = allPids.filter((pid) => isRunning(pid))
    assert.deepEqual(alive, [allPids[1]])
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('two parallel first calls with computer enabled start one server', async () => {
  const context = setup('browser', { computer: true })
  const startedPids = []
  try {
    const js = context.plugin.tools.get('codex_js')
    const results = await Promise.all([
      js.execute({ code: '1', title: 'first' }, {}),
      js.execute({ code: '2', title: 'second' }, {}),
    ])
    assert.deepEqual(results, ['ran js', 'ran js'])
    startedPids.push(...context.allPids())
    assert.equal(startedPids.length, 1)
    assert.deepEqual(readLines(context.surfacesFile), ['browser,computer'])
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})
