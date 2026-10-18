// D9: the default state file moves to pc-use-state.json and migrates the old session id.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { FAKE_SERVER, registerPlugin, tempDir, useHome, writeCodexHome } from './helpers.mjs'

function statePath(home, name) {
  return join(home, '.dsh', name)
}

function writeState(file, sessionId) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ session_id: sessionId }, null, 2)}\n`)
}

function readState(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function setup(home, config = {}) {
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [FAKE_SERVER, 'ok', join(home, 'server.log')])
  return registerPlugin({
    codexHome,
    logFile: join(home, 'bridge.log'),
    stateFile: '',
    ...config,
  })
}

async function connect(plugin) {
  const js = plugin.tools.get('pc_codex_js')
  assert.equal(await js.execute({ code: '1', title: 'migration' }, {}), 'ran js')
}

test('only the old state file: its session id is copied into the new file and kept', async () => {
  const home = tempDir('dsh-pc-use-migrate-old-')
  const restore = useHome(home)
  const oldFile = statePath(home, 'codex-cu-state.json')
  const newFile = statePath(home, 'pc-use-state.json')
  writeState(oldFile, 'legacy-session')
  const before = readFileSync(oldFile, 'utf8')
  const plugin = setup(home)
  try {
    await connect(plugin)
    assert.equal(existsSync(newFile), true)
    assert.equal(readState(newFile).session_id, 'legacy-session')
    assert.equal(existsSync(oldFile), true)
    assert.equal(readFileSync(oldFile, 'utf8'), before)
  } finally {
    plugin.dispose()
    restore()
  }
})

test('both state files: the new file wins and is not overwritten', async () => {
  const home = tempDir('dsh-pc-use-migrate-both-')
  const restore = useHome(home)
  const oldFile = statePath(home, 'codex-cu-state.json')
  const newFile = statePath(home, 'pc-use-state.json')
  writeState(oldFile, 'old-session')
  writeState(newFile, 'new-session')
  const plugin = setup(home)
  try {
    await connect(plugin)
    assert.equal(readState(newFile).session_id, 'new-session')
    assert.equal(readState(oldFile).session_id, 'old-session')
  } finally {
    plugin.dispose()
    restore()
  }
})

test('an explicit stateFile is not migrated from the old default', async () => {
  const home = tempDir('dsh-pc-use-migrate-explicit-')
  const restore = useHome(home)
  const oldFile = statePath(home, 'codex-cu-state.json')
  const newFile = statePath(home, 'pc-use-state.json')
  const customFile = join(home, 'custom-state.json')
  writeState(oldFile, 'old-session')
  const plugin = setup(home, { stateFile: customFile })
  try {
    await connect(plugin)
    assert.equal(existsSync(customFile), true)
    assert.equal(typeof readState(customFile).session_id, 'string')
    assert.notEqual(readState(customFile).session_id, 'old-session')
    assert.equal(existsSync(newFile), false)
    assert.equal(readState(oldFile).session_id, 'old-session')
  } finally {
    plugin.dispose()
    restore()
  }
})
