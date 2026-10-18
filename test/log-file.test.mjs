// R2: the bridge log rotates to <file>.1 once it grows past 1 MB, keeping one old file.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { appendLogLine, MAX_LOG_BYTES, rotateLogFile } from '../lib/log-file.js'
import { FAKE_SERVER, registerPlugin, tempDir, useHome, writeCodexHome } from './helpers.mjs'

test('MAX_LOG_BYTES is one megabyte', () => {
  assert.equal(MAX_LOG_BYTES, 1024 * 1024)
})

test('rotateLogFile keeps exactly one old log file', () => {
  const directory = tempDir()
  const file = join(directory, 'bridge.log')
  writeFileSync(file, 'x'.repeat(MAX_LOG_BYTES + 1))
  rotateLogFile(file)
  assert.equal(existsSync(file), false)
  assert.equal(readFileSync(`${file}.1`, 'utf8').length, MAX_LOG_BYTES + 1)
  appendLogLine(file, 'first\n')
  writeFileSync(file, 'y'.repeat(MAX_LOG_BYTES + 1))
  appendLogLine(file, 'second\n')
  assert.equal(readFileSync(`${file}.1`, 'utf8').startsWith('y'), true)
  assert.equal(readFileSync(file, 'utf8'), 'second\n')
})

test('appendLogLine does not rotate below the limit', () => {
  const directory = tempDir()
  const file = join(directory, 'bridge.log')
  appendLogLine(file, 'hello\n')
  assert.equal(readFileSync(file, 'utf8'), 'hello\n')
  assert.equal(existsSync(`${file}.1`), false)
})

test('the plugin log rotates at the limit', async () => {
  const home = tempDir('pc-use-log-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [FAKE_SERVER, 'elicit', serverLog])
  const logFile = join(home, 'bridge.log')
  writeFileSync(logFile, 'x'.repeat(MAX_LOG_BYTES + 1))
  const plugin = registerPlugin({
    codexHome,
    autoApprove: true,
    logFile,
  })
  try {
    await plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'rotate' }, {})
    assert.equal(existsSync(`${logFile}.1`), true)
    assert.equal(readFileSync(`${logFile}.1`, 'utf8').startsWith('x'), true)
    const current = readFileSync(logFile, 'utf8')
    assert.match(current, /approval "Allow Browser use to access https:\/\/example\.com\?"/)
    assert.ok(current.length < MAX_LOG_BYTES)
  } finally {
    plugin.dispose()
    restore()
  }
})
