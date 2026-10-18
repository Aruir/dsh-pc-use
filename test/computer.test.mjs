// F1/R10: the `computer` switch adds the computer surface and the sky trusted service to
// the child env only, is read on every ensureBridge call, and a hot change restarts the
// bridge without leaking servers.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

const SURFACE_SERVER = process.env.CODEX_CU_SURFACE_SERVER
  ?? fileURLToPath(new URL('./fake-surface-server.mjs', import.meta.url))
const WRITE = Symbol.for('cosmokit.volatile.write')
const INVALID_SERVICES = 'dsh-pc-use: NODE_REPL_TRUSTED_SERVICES is not a JSON object'

// Keep the "variable is absent" cases independent from the machine running the tests.
delete process.env.NODE_REPL_TRUSTED_SERVICES

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

/** Lines without trimming, for byte-for-byte comparisons of an env value. */
function readRawLines(file) {
  return readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')
}

function readPids(file) {
  return readLines(file).map(Number)
}

function parsedServices(file) {
  return readLines(file).map((line) => (line === '<unset>' ? null : JSON.parse(line)))
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

function setup(envSurfaces = 'browser', config = {}, trusted = { present: false }) {
  const home = tempDir('pc-use-surfaces-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  const pidFile = join(home, 'pids.txt')
  const surfacesFile = join(home, 'surfaces.txt')
  const servicesFile = join(home, 'services.txt')
  writeFileSync(serverLog, '')
  writeFileSync(pidFile, '')
  writeFileSync(surfacesFile, '')
  writeFileSync(servicesFile, '')
  const codexHome = join(home, 'codex')
  const env = { CUA_REPL_ENABLED_SURFACES: envSurfaces }
  if (trusted.present) env.NODE_REPL_TRUSTED_SERVICES = trusted.value
  writeCodexHome(
    codexHome,
    [SURFACE_SERVER, pidFile, surfacesFile, servicesFile, serverLog],
    env,
  )
  const plugin = registerPlugin({
    codexHome,
    logFile: join(home, 'bridge.log'),
    ...config,
  })
  return {
    home,
    restore,
    pidFile,
    surfacesFile,
    servicesFile,
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
    const js = context.plugin.tools.get('pc_codex_js')
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
    const js = context.plugin.tools.get('pc_codex_js')
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
    const js = context.plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'surface test' }, {})
    assert.deepEqual(readLines(context.surfacesFile), ['browser,computer'])
    startedPids.push(...context.allPids())
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('pc_status reports surfaces and service names for a computer bridge', async () => {
  const trusted = { present: true, value: '{"browser":"x"}' }
  const context = setup('browser', { computer: true }, trusted)
  const startedPids = []
  try {
    const js = context.plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'surface test' }, {})
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.backends.codex.connected, true)
    assert.equal(status.backends.codex.computer, 'browser,computer')
    assert.deepEqual(status.backends.codex.services, ['browser', 'sky'])
    assert.equal(status.backends.codex.servicesFrom, 'env')
    startedPids.push(...context.allPids())
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('pc_status reports only service names when computer is off', async () => {
  const trusted = { present: true, value: '{"browser":"x","sky":"custom"}' }
  const context = setup('browser', {}, trusted)
  const startedPids = []
  try {
    const js = context.plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'surface test' }, {})
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.backends.codex.computer, 'browser')
    assert.deepEqual(status.backends.codex.services, ['browser', 'sky'])
    assert.equal(status.backends.codex.servicesFrom, 'env')
    startedPids.push(...context.allPids())
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('pc_status reports null surfaces and services before connecting', async () => {
  const trusted = { present: true, value: '{"browser":"x"}' }
  const context = setup('browser', { computer: true }, trusted)
  try {
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.backends.codex.connected, false)
    assert.equal(status.backends.codex.computer, null)
    assert.equal(status.backends.codex.services, null)
    assert.equal(status.backends.codex.servicesFrom, null)
  } finally {
    await disposeAndFinish(context, [])
  }
})

test('enabling computer hot restarts the bridge with the new surfaces and services', async () => {
  const computer = createVolatile(false)
  const trusted = { present: true, value: '{"browser":"x"}' }
  const context = setup('browser', { computer }, trusted)
  const startedPids = []
  try {
    const js = context.plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'first' }, {})
    assert.deepEqual(readLines(context.surfacesFile), ['browser'])
    assert.deepEqual(parsedServices(context.servicesFile), [{ browser: 'x' }])
    const firstPids = context.allPids()
    assert.equal(firstPids.length, 1)
    startedPids.push(...firstPids)
    computer[WRITE](true)
    await js.execute({ code: '2', title: 'second' }, {})
    assert.deepEqual(readLines(context.surfacesFile), ['browser', 'browser,computer'])
    assert.deepEqual(parsedServices(context.servicesFile), [
      { browser: 'x' },
      { browser: 'x', sky: '@oai/sky/service' },
    ])
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
    const js = context.plugin.tools.get('pc_codex_js')
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

test('computer:true adds the sky service to an existing services object', async () => {
  const trusted = { present: true, value: '{"browser":"x"}' }
  const context = setup('browser', { computer: true }, trusted)
  const startedPids = []
  try {
    const js = context.plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'services test' }, {})
    const services = parsedServices(context.servicesFile)
    assert.equal(services.length, 1)
    assert.deepEqual(Object.keys(services[0]), ['browser', 'sky'])
    assert.equal(services[0].browser, 'x')
    assert.equal(services[0].sky, '@oai/sky/service')
    startedPids.push(...context.allPids())
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('computer:true keeps an existing sky service value', async () => {
  const trusted = {
    present: true,
    value: '{"browser":"x","sky":"custom-sky"}',
  }
  const context = setup('browser', { computer: true }, trusted)
  const startedPids = []
  try {
    const js = context.plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'services test' }, {})
    const services = parsedServices(context.servicesFile)
    assert.equal(services.length, 1)
    assert.deepEqual(Object.keys(services[0]), ['browser', 'sky'])
    assert.equal(services[0].sky, 'custom-sky')
    startedPids.push(...context.allPids())
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('computer:true leaves an absent services variable absent', async () => {
  const context = setup('browser', { computer: true }, { present: false })
  const startedPids = []
  try {
    const js = context.plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'services test' }, {})
    assert.deepEqual(readLines(context.servicesFile), ['<unset>'])
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.backends.codex.services, null)
    assert.equal(status.backends.codex.servicesFrom, 'launcher')
    startedPids.push(...context.allPids())
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('computer:false reports launcher-generated services when the variable is absent', async () => {
  const context = setup('browser', {}, { present: false })
  const startedPids = []
  try {
    const js = context.plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'services test' }, {})
    assert.deepEqual(readLines(context.servicesFile), ['<unset>'])
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.backends.codex.services, null)
    assert.equal(status.backends.codex.servicesFrom, 'launcher')
    startedPids.push(...context.allPids())
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

test('computer:false reports env source for an invalid services value', async () => {
  const raw = 'not-json'
  const trusted = { present: true, value: raw }
  const context = setup('browser', {}, trusted)
  const startedPids = []
  try {
    const js = context.plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'services test' }, {})
    assert.deepEqual(readRawLines(context.servicesFile), [raw])
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.backends.codex.services, null)
    assert.equal(status.backends.codex.servicesFrom, 'env')
    startedPids.push(...context.allPids())
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})

for (const invalid of ['not-json', '[1,2]', 'null']) {
  test(`computer:true rejects an invalid services value (${invalid})`, async () => {
    const trusted = { present: true, value: invalid }
    const context = setup('browser', { computer: true }, trusted)
    const startedPids = []
    try {
      const js = context.plugin.tools.get('pc_codex_js')
      await assert.rejects(
        () => js.execute({ code: '1', title: 'invalid services' }, {}),
        (error) => {
          assert.match(error.message, new RegExp(INVALID_SERVICES))
          assert.equal(error.message.includes(invalid), false)
          return true
        },
      )
      assert.deepEqual(context.allPids(), [])
      assert.deepEqual(readPids(context.pidFile), [])
    } finally {
      await disposeAndFinish(context, startedPids)
    }
  })
}

test('computer:false passes the services value through byte for byte', async () => {
  const raw = '  { "browser" : "x" }  '
  const trusted = { present: true, value: raw }
  const context = setup('browser', {}, trusted)
  const startedPids = []
  try {
    const js = context.plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'services test' }, {})
    assert.deepEqual(readRawLines(context.servicesFile), [raw])
    startedPids.push(...context.allPids())
    assert.equal(startedPids.length, 1)
  } finally {
    await disposeAndFinish(context, startedPids)
  }
})
