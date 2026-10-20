// r31: nativePipeState decides whether the configured native pipe exists without opening or
// connecting to it; the Windows branch matches the pipe listing case-insensitively.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { nativePipeState } from '../lib/native-pipe.js'

const PIPE_PATH = '\\\\.\\pipe\\Codex-Computer-Use-ABC'

/** A statPath that records calls and fails the test if the Windows branch uses it. O(1). */
function statWatchdog() {
  const calls = []
  const statPath = (path) => {
    calls.push(path)
    throw new Error('statPath must not be called for a Windows named pipe')
  }
  return { statPath, calls }
}

test('a missing path value is null', () => {
  assert.equal(nativePipeState(), null)
  assert.equal(nativePipeState(null), null)
  assert.equal(nativePipeState(''), null)
  assert.equal(nativePipeState(42), null)
})

test('a Windows pipe name present in the listing is present, compared case-insensitively', () => {
  const watch = statWatchdog()
  const state = nativePipeState(PIPE_PATH, {
    readPipeNames: () => ['other', 'codex-computer-use-abc'],
    statPath: watch.statPath,
  })
  assert.equal(state, 'present')
  assert.equal(watch.calls.length, 0)
})

test('a Windows pipe name absent from the listing is missing', () => {
  const watch = statWatchdog()
  const state = nativePipeState(PIPE_PATH, {
    readPipeNames: () => ['other'],
    statPath: watch.statPath,
  })
  assert.equal(state, 'missing')
  assert.equal(watch.calls.length, 0)
})

test('a failing or malformed pipe listing is check failed', () => {
  const watch = statWatchdog()
  const throwing = nativePipeState(PIPE_PATH, {
    readPipeNames: () => {
      throw new Error('listing failed')
    },
    statPath: watch.statPath,
  })
  assert.equal(throwing, 'check failed')
  assert.equal(nativePipeState(PIPE_PATH, {
    readPipeNames: () => 'not an array',
    statPath: watch.statPath,
  }), 'check failed')
  assert.equal(watch.calls.length, 0)
})

test('other paths use statPath and map its errors', () => {
  const socket = join('tmp', 'native.sock')
  assert.equal(nativePipeState(socket, { statPath: () => ({}) }), 'present')
  assert.equal(nativePipeState(socket, {
    statPath: () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    },
  }), 'missing')
  assert.equal(nativePipeState(socket, {
    statPath: () => {
      throw Object.assign(new Error('not a dir'), { code: 'ENOTDIR' })
    },
  }), 'missing')
  assert.equal(nativePipeState(socket, {
    statPath: () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    },
  }), 'check failed')
})

test('the default implementation sees a temp file and a missing name', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pc-use-pipe-'))
  try {
    const file = join(directory, 'native.sock')
    writeFileSync(file, 'socket placeholder')
    assert.equal(nativePipeState(file), 'present')
    assert.equal(nativePipeState(join(directory, 'missing.sock')), 'missing')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the default implementation sees a self-created Windows pipe', async (t) => {
  if (process.platform !== 'win32') {
    return t.skip('named pipes exist only on Windows')
  }
  const name = `dsh-pc-use-r31-${process.pid}-${randomUUID()}`
  const path = `\\\\.\\pipe\\${name}`
  const server = createServer((socket) => socket.end())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  try {
    assert.equal(nativePipeState(path), 'present')
    // The name comparison is case-insensitive, as on Windows itself.
    assert.equal(nativePipeState(`\\\\.\\PIPE\\${name.toUpperCase()}`), 'present')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  const deadline = Date.now() + 2000
  let state = nativePipeState(path)
  while (state !== 'missing' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    state = nativePipeState(path)
  }
  assert.equal(state, 'missing')
})
