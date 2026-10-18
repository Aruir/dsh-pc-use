// R1: concurrent first calls must share one connection, and `alive` must stay false
// while the handshake is still in progress (that is what lets one connection be reused).
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { McpBridge } from '../lib/mcp-bridge.js'
import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

const PID_SERVER = process.env.CODEX_CU_PID_SERVER
  ?? fileURLToPath(new URL('./fixtures/pid-server.mjs', import.meta.url))

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

function killAll(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {}
  }
}

test('two parallel first calls start exactly one server', async () => {
  const home = tempDir('pc-use-race-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  const pidFile = join(home, 'pids.txt')
  writeFileSync(serverLog, '')
  writeFileSync(pidFile, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [PID_SERVER, pidFile, 'ok', serverLog])
  const plugin = registerPlugin({
    codexHome,
    logFile: join(home, 'bridge.log'),
    stateFile: join(home, 'state.json'),
  })
  const startedPids = []
  try {
    const js = plugin.tools.get('pc_codex_js')
    const results = await Promise.all([
      js.execute({ code: '1', title: 'first' }, {}),
      js.execute({ code: '2', title: 'second' }, {}),
    ])
    assert.deepEqual(results, ['ran js', 'ran js'])
    startedPids.push(...readPids(pidFile))
    assert.equal(startedPids.length, 1, 'the first handshake must not spawn a second server')
    plugin.dispose()
    const stopped = await waitFor(() => startedPids.every((pid) => !isRunning(pid)))
    assert.equal(stopped, true, 'every server must be gone after dispose')
  } finally {
    plugin.dispose()
    killAll([...new Set([...startedPids, ...readPids(pidFile)])])
    restore()
  }
})

test('alive stays false while the handshake is in progress', async () => {
  const home = tempDir('pc-use-handshake-')
  const serverLog = join(home, 'server.log')
  const pidFile = join(home, 'pids.txt')
  writeFileSync(serverLog, '')
  writeFileSync(pidFile, '')
  const bridge = new McpBridge({
    command: process.execPath,
    args: [PID_SERVER, pidFile, 'init-hang', serverLog],
    env: process.env,
    cwd: home,
    sessionId: 'handshake-test',
    initTimeoutMs: 10_000,
    log: () => {},
  })
  const starting = bridge.start().catch((error) => error)
  try {
    await waitFor(() => readPids(pidFile).length > 0)
    assert.equal(bridge.child === null, false, 'the child must already be spawned')
    assert.equal(bridge.alive, false, 'alive must stay false until initialize completes')
  } finally {
    bridge.stop()
    await starting
    killAll(readPids(pidFile))
  }
})
