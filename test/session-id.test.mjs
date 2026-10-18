// E2: the bridge-level session id lives only in memory. Calls without an agent use it,
// a new bridge (or a new plugin instance) gets a new one, and no state file is touched.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

// The turn-ended fake server records `call <tool> <session_id> <turn_id>` per call.
const SERVER = process.env.CODEX_CU_TURN_SERVER
  ?? fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))

function setup(home, config = {}) {
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, serverArgs(home))
  return registerPlugin({
    codexHome,
    logFile: join(home, 'bridge.log'),
    ...config,
  })
}

/** The fake server launch args; `extra` forces a launch-spec change. O(1). */
function serverArgs(home, extra = null) {
  const args = [SERVER, 'turn-ended', join(home, 'server.log')]
  return extra === null ? args : [...args, extra]
}

function callLines(home) {
  try {
    return readFileSync(join(home, 'server.log'), 'utf8').split('\n')
      .filter((line) => line.startsWith('call '))
  } catch {
    return []
  }
}

/** Split one recorded `call <name> <session> <turn>` line. O(1). */
function callParts(line) {
  const [, name, sessionId, turnId] = line.split(' ')
  return { name, sessionId, turnId }
}

function reset(plugin) {
  return plugin.tools.get('pc_codex_js_reset').execute({}, {})
}

function runJs(plugin) {
  return plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'session id' }, {})
}

test(
  'calls without an agent use a dsh-pc- bridge id, renewed per bridge and per plugin',
  async () => {
  const home = tempDir('pc-use-session-id-')
  const restore = useHome(home)
  const plugin = setup(home)
  const second = setup(home)
  try {
    await reset(plugin)
    assert.equal(await waitFor(() => callLines(home).length === 1), true)
    const first = callParts(callLines(home)[0])
    assert.equal(first.name, 'js_reset')
    assert.equal(first.sessionId.startsWith('dsh-pc-'), true, first.sessionId)
    // Changing the browser launch args rebuilds the bridge, and `_meta` gets a fresh id.
    writeCodexHome(join(home, 'codex'), serverArgs(home, 'rebuilt'))
    await reset(plugin)
    assert.equal(await waitFor(() => callLines(home).length === 2), true)
    const rebuilt = callParts(callLines(home)[1])
    assert.equal(rebuilt.sessionId.startsWith('dsh-pc-'), true, rebuilt.sessionId)
    assert.notEqual(rebuilt.sessionId, first.sessionId)
    // A second plugin instance must not reuse the first instance's id.
    await reset(second)
    assert.equal(await waitFor(() => callLines(home).length === 3), true)
    const separate = callParts(callLines(home)[2])
    assert.equal(separate.sessionId.startsWith('dsh-pc-'), true, separate.sessionId)
    assert.notEqual(separate.sessionId, first.sessionId)
    assert.notEqual(separate.sessionId, rebuilt.sessionId)
  } finally {
    plugin.dispose()
    second.dispose()
    restore()
  }
})

test('the plugin creates no state files under ~/.dsh', async () => {
  const home = tempDir('pc-use-no-state-')
  const restore = useHome(home)
  const plugin = setup(home)
  try {
    await runJs(plugin)
    await reset(plugin)
    assert.equal(await waitFor(() => callLines(home).length === 2), true)
    assert.equal(existsSync(join(home, '.dsh', 'pc-use-state.json')), false)
    assert.equal(existsSync(join(home, '.dsh', 'codex-cu-state.json')), false)
  } finally {
    plugin.dispose()
    restore()
  }
})

test('existing old state files are not read, migrated or deleted', async () => {
  const home = tempDir('pc-use-old-state-')
  const restore = useHome(home)
  const stateDir = join(home, '.dsh')
  mkdirSync(stateDir, { recursive: true })
  const newFile = join(stateDir, 'pc-use-state.json')
  const oldFile = join(stateDir, 'codex-cu-state.json')
  writeFileSync(newFile, `${JSON.stringify({ session_id: 'new-legacy' })}\n`)
  writeFileSync(oldFile, `${JSON.stringify({ session_id: 'old-legacy' })}\n`)
  const before = { newFile: readFileSync(newFile, 'utf8'), oldFile: readFileSync(oldFile, 'utf8') }
  const plugin = setup(home)
  try {
    await reset(plugin)
    assert.equal(await waitFor(() => callLines(home).length === 1), true)
    const { sessionId } = callParts(callLines(home)[0])
    assert.equal(sessionId.startsWith('dsh-pc-'), true, sessionId)
    assert.notEqual(sessionId, 'new-legacy')
    assert.notEqual(sessionId, 'old-legacy')
    assert.equal(readFileSync(newFile, 'utf8'), before.newFile)
    assert.equal(readFileSync(oldFile, 'utf8'), before.oldFile)
  } finally {
    plugin.dispose()
    restore()
  }
})
