// Host half of 0.4.3: settings presentation registration and a codexHome change that
// reconnects without remounting the plugin, plus the shipped browser manifest.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const PID_SERVER = fileURLToPath(new URL('./fixtures/pid-server.mjs', import.meta.url))
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

/** Kill only the server pids this test recorded; never other processes. O(n). */
function killAll(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {}
  }
}

function setupServer(home, name) {
  const serverLog = join(home, `${name}.log`)
  const pidFile = join(home, `${name}.pids`)
  writeFileSync(serverLog, '')
  writeFileSync(pidFile, '')
  const codexHome = join(home, name)
  writeCodexHome(codexHome, [PID_SERVER, pidFile, 'ok', serverLog])
  return { codexHome, serverLog, pidFile }
}

test('the settings service receives configure({ auto: false })', () => {
  const home = tempDir('pc-use-settings-host-')
  const restore = useHome(home)
  const server = setupServer(home, 'codex')
  const configured = []
  const settings = {
    configure(policy, fiber) {
      configured.push({ policy, fiber })
      return () => {}
    },
  }
  const plugin = registerPlugin(
    { codexHome: server.codexHome, logFile: join(home, 'bridge.log') },
    { services: { settings } },
  )
  try {
    assert.equal(configured.length, 1)
    assert.deepEqual(configured[0].policy, { auto: false })
    assert.equal(configured[0].fiber, plugin.fiber, 'configure must own the plugin fiber')
    assert.equal(plugin.tools.size, 7)
  } finally {
    plugin.dispose()
    restore()
  }
})

test('the plugin loads and registers its tools without a settings service', () => {
  const home = tempDir('pc-use-no-settings-')
  const restore = useHome(home)
  const server = setupServer(home, 'codex')
  const plugin = registerPlugin({ codexHome: server.codexHome, logFile: join(home, 'bridge.log') })
  try {
    assert.equal(plugin.tools.size, 7)
  } finally {
    plugin.dispose()
    restore()
  }
})

test('a changed volatile codexHome reconnects without remounting the plugin', async () => {
  const home = tempDir('pc-use-codexhome-')
  const restore = useHome(home)
  const first = setupServer(home, 'codex-a')
  const second = setupServer(home, 'codex-b')
  const codexHome = createVolatile(first.codexHome)
  const plugin = registerPlugin(
    { codexHome, logFile: join(home, 'bridge.log') },
  )
  const toolsBefore = plugin.tools.get('pc_codex_js')
  const started = []
  try {
    const js = plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'first home' }, {})
    assert.equal(await waitFor(() => readPids(first.pidFile).length === 1), true)
    codexHome[WRITE](second.codexHome)
    await js.execute({ code: '2', title: 'second home' }, {})
    assert.equal(await waitFor(() => readPids(second.pidFile).length === 1), true)
    assert.equal(readPids(first.pidFile).length, 1)
    assert.equal(plugin.tools.get('pc_codex_js'), toolsBefore, 'the plugin must not remount')
    assert.match(
      readFileSync(join(home, 'bridge.log'), 'utf8'),
      /Codex home changed; reconnecting/,
    )
  } finally {
    started.push(...readPids(first.pidFile), ...readPids(second.pidFile))
    plugin.dispose()
    const stopped = await waitFor(() => started.every((pid) => !isRunning(pid)), 2000)
    killAll(started)
    restore()
    assert.equal(stopped, true, 'every server this test started must exit')
  }
})

test('an invalid codexHome fails the call instead of keeping the stale bridge', async () => {
  const home = tempDir('pc-use-codexhome-invalid-')
  const restore = useHome(home)
  const first = setupServer(home, 'codex-a')
  const codexHome = createVolatile(first.codexHome)
  const logFile = join(home, 'bridge.log')
  const plugin = registerPlugin({ codexHome, logFile })
  const started = []
  try {
    const js = plugin.tools.get('pc_codex_js')
    await js.execute({ code: '1', title: 'first home' }, {})
    assert.equal(await waitFor(() => readPids(first.pidFile).length === 1), true)
    const missing = join(home, 'missing-home')
    codexHome[WRITE](missing)
    let error = null
    try {
      await js.execute({ code: '2', title: 'missing home' }, {})
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof Error, 'the call must fail')
    assert.match(error.message, /dsh-pc-use: /)
    assert.equal(
      await waitFor(() => readPids(first.pidFile).every((pid) => !isRunning(pid)), 3000),
      true,
      'the old server must exit',
    )
    const status = JSON.parse(await plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.backends.codex.browser.resolved, false)
    assert.equal(typeof status.backends.codex.browser.reason, 'string')
    assert.equal(status.backends.codex.desktop.resolved, false)
    assert.equal(typeof status.backends.codex.desktop.reason, 'string')
    assert.equal(status.backends.codex.codexHome, missing)
    const log = readFileSync(logFile, 'utf8')
    assert.match(log, /Codex home changed; reconnecting/)
    assert.equal(log.includes(missing), false, 'the log must not contain the path')
    // Back to a valid home: the next call starts a fresh server process.
    codexHome[WRITE](first.codexHome)
    await js.execute({ code: '3', title: 'back home' }, {})
    assert.equal(await waitFor(() => readPids(first.pidFile).length === 2), true)
  } finally {
    started.push(...readPids(first.pidFile))
    plugin.dispose()
    const stopped = await waitFor(() => started.every((pid) => !isRunning(pid)), 2000)
    killAll(started)
    restore()
    assert.equal(stopped, true, 'every server this test started must exit')
  }
})

test('the package ships the browser client and settings manifest', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '0.5.1')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual([...pkg.dsh.client.inject].sort(), [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-slots',
  ].sort())
  for (const entry of [
    'client.js', 'index.js', 'lib', 'cordis.patch.yml', 'locale/*.json',
    'icon.svg', 'README.md', 'README.zh.md',
  ]) {
    assert.ok(pkg.files.includes(entry), `files must include ${entry}`)
  }
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    shell: true,
  })
  assert.equal(result.status, 0, result.stderr)
  const start = result.stdout.indexOf('[')
  const packed = JSON.parse(result.stdout.slice(start))[0].files.map((file) => file.path)
  for (const entry of [
    'client.js', 'index.js', 'lib/text.js', 'lib/mcp-bridge.js', 'cordis.patch.yml',
    'locale/en.json', 'locale/zh.json', 'icon.svg', 'README.md', 'README.zh.md',
  ]) {
    assert.ok(packed.includes(entry), `npm pack must ship ${entry}`)
  }
})
