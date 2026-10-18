// D15: before each call, re-resolve the Codex launch spec and reconnect when the app
// rewrote a launch field (for example the native pipe directory after a restart).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

const PID_SERVER = process.env.CODEX_CU_PID_SERVER
  ?? fileURLToPath(new URL('./fixtures/pid-server.mjs', import.meta.url))
const UNIFIED_VERSION = '26.1013.31256'

/** The `.mcp.json` path Codex rewrites on every app start. O(1). */
function mcpJsonPath(codexHome) {
  return join(
    codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use',
    UNIFIED_VERSION, '.mcp.json',
  )
}

function setup() {
  const home = tempDir('pc-use-reconnect-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  const pidFile = join(home, 'pids.txt')
  const logFile = join(home, 'bridge.log')
  writeFileSync(serverLog, '')
  writeFileSync(pidFile, '')
  const codexHome = join(home, 'codex')
  const args = [PID_SERVER, pidFile, 'ok', serverLog]
  writeCodexHome(codexHome, args, { SKY_CUA_NATIVE_PIPE_DIRECTORY: 'pipe-old' })
  const plugin = registerPlugin({ codexHome, logFile })
  return { home, restore, serverLog, pidFile, logFile, codexHome, args, plugin, started: [] }
}

function readPids(file) {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

function envLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('server-env '))
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

function runJs(context) {
  return context.plugin.tools.get('pc_codex_js')
    .execute({ code: '1', title: 'reconnect' }, {})
}

function finish(context) {
  context.plugin.dispose()
  context.started.push(...readPids(context.pidFile))
  const stopped = context.started.every((pid) => !isRunning(pid))
  context.restore()
  killAll([...new Set(context.started)])
  return stopped
}

test('a changed native pipe directory starts a new server process', async () => {
  const context = setup()
  try {
    await runJs(context)
    assert.equal(await waitFor(() => readPids(context.pidFile).length === 1), true)
    writeCodexHome(
      context.codexHome,
      context.args,
      { SKY_CUA_NATIVE_PIPE_DIRECTORY: 'pipe-new' },
    )
    await runJs(context)
    assert.equal(await waitFor(() => readPids(context.pidFile).length === 2), true)
    assert.equal(envLines(context.serverLog).at(-1), 'server-env pipe-new')
    const log = readFileSync(context.logFile, 'utf8')
    assert.match(log, /Codex server changed \(pipeDirectory\); reconnecting/)
    assert.equal(log.includes('pipe-new'), false, 'the log must not contain the pipe value')
  } finally {
    finish(context)
  }
})

test('an unchanged config keeps one server for three calls', async () => {
  const context = setup()
  try {
    await runJs(context)
    await runJs(context)
    await runJs(context)
    assert.equal(await waitFor(() => readPids(context.pidFile).length >= 1), true)
    assert.equal(readPids(context.pidFile).length, 1)
    assert.equal(envLines(context.serverLog).length, 1)
  } finally {
    finish(context)
  }
})

test('changed args reconnect to a new server process', async () => {
  const context = setup()
  try {
    await runJs(context)
    assert.equal(await waitFor(() => readPids(context.pidFile).length === 1), true)
    writeCodexHome(
      context.codexHome,
      [...context.args, 'extra-arg'],
      { SKY_CUA_NATIVE_PIPE_DIRECTORY: 'pipe-old' },
    )
    await runJs(context)
    assert.equal(await waitFor(() => readPids(context.pidFile).length === 2), true)
    assert.equal(readFileSync(context.logFile, 'utf8').includes('(args)'), true)
  } finally {
    finish(context)
  }
})

test('a config that no longer resolves keeps the current connection', async () => {
  const context = setup()
  try {
    await runJs(context)
    assert.equal(await waitFor(() => readPids(context.pidFile).length === 1), true)
    writeFileSync(mcpJsonPath(context.codexHome), 'this is not json')
    const result = await runJs(context)
    assert.equal(result, 'ran js')
    assert.equal(readPids(context.pidFile).length, 1)
    assert.match(
      readFileSync(context.logFile, 'utf8'),
      /Codex server re-check failed; keeping the current connection/,
    )
  } finally {
    finish(context)
  }
})

/** Minimal config.toml that Codex's resolver reads when no .mcp.json exists yet. O(1). */
function configToml(args, pipe) {
  return [
    '[mcp_servers.node_repl]',
    `command = '${process.execPath}'`,
    `args = ${JSON.stringify(args)}`,
    'env_vars = []',
    '',
    '[mcp_servers.node_repl.env]',
    `SKY_CUA_NATIVE_PIPE_DIRECTORY = '${pipe}'`,
    '',
  ].join('\n')
}

/** A plugin whose server resolves from config.toml first, so `source` can change. O(1). */
function setupFromConfigToml() {
  const home = tempDir('pc-use-reconnect-source-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  const pidFile = join(home, 'pids.txt')
  const logFile = join(home, 'bridge.log')
  writeFileSync(serverLog, '')
  writeFileSync(pidFile, '')
  const codexHome = join(home, 'codex')
  const args = [PID_SERVER, pidFile, 'ok', serverLog]
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(join(codexHome, 'config.toml'), configToml(args, 'pipe-same'))
  const plugin = registerPlugin({ codexHome, logFile })
  return { home, restore, serverLog, pidFile, logFile, codexHome, args, plugin, started: [] }
}

test('a changed resolution source reconnects to a new server process', async () => {
  const context = setupFromConfigToml()
  try {
    await runJs(context)
    assert.equal(await waitFor(() => readPids(context.pidFile).length === 1), true)
    // Same command/args/cwd/pipe, now also available as .mcp.json: only `source` changes.
    writeCodexHome(context.codexHome, context.args, { SKY_CUA_NATIVE_PIPE_DIRECTORY: 'pipe-same' })
    await runJs(context)
    assert.equal(await waitFor(() => readPids(context.pidFile).length === 2), true)
    const log = readFileSync(context.logFile, 'utf8')
    assert.match(log, /Codex server changed \(source\); reconnecting/)
    assert.equal(log.includes('(pipeDirectory'), false)
  } finally {
    finish(context)
  }
})

test('a changed resolved cwd reconnects (resolver mocked in a child process)', () => {
  const child = fileURLToPath(new URL('./fixtures/cwd-reconnect.child.mjs', import.meta.url))
  // A nested `node --test` must not inherit the running runner's NODE_TEST_CONTEXT, or
  // node treats it as a recursive run and silently skips the file.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--test', child],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true, env },
  )
  assert.equal(result.status, 0, `cwd reconnect child failed:\n${result.stdout}\n${result.stderr}`)
})
