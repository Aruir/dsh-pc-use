// r20: appendLogLine creates the directory only after a failed append, and rotation keeps
// working on that path.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { appendLogLine } from '../lib/log-file.js'
import { tempDir } from './helpers.mjs'

test('a missing nested directory is created on the first line', () => {
  const home = tempDir('pc-use-log-')
  const file = join(home, 'a', 'b', 'pc-use.log')
  appendLogLine(file, 'one\n')
  appendLogLine(file, 'two\n')
  assert.equal(readFileSync(file, 'utf8'), 'one\ntwo\n')
})

test('a file in the parent path makes the append throw and leaves no target file', () => {
  const home = tempDir('pc-use-log-')
  const blocker = join(home, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const file = join(blocker, 'nested', 'pc-use.log')
  assert.throws(() => appendLogLine(file, 'one\n'))
  assert.equal(existsSync(file), false)
})

test('rotation keeps one old file when the log exceeds maxBytes', () => {
  const home = tempDir('pc-use-log-')
  const file = join(home, 'pc-use.log')
  appendLogLine(file, 'first line\n', 1000)
  appendLogLine(file, 'second line\n', 5)
  assert.equal(readFileSync(file, 'utf8'), 'second line\n')
  assert.equal(readFileSync(`${file}.1`, 'utf8'), 'first line\n')
})
