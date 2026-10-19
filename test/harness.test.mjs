// Self-tests for the shared test fixtures: the polling helper checks once after its deadline,
// stopServers outlasts slow exits and kills what will not stop, and temp dir removal retries
// past the Windows directory locks the diagnostics found.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { removeTempDir, waitFor } from './helpers.mjs'
import { isRunning, stopServers } from './fixtures/server-harness.mjs'

// Exits 4000 ms after the parent closes stdin: the slow server stopServers must outlast.
const EXIT_AFTER_STDIN_END = `
process.stdin.resume()
process.stdin.on('end', () => setTimeout(() => process.exit(0), 4000))
`

// Never exits on its own, so stopServers has to kill it.
const IGNORE_STDIN_END = 'setInterval(() => {}, 1000)'

function spawnChild(code, options = {}) {
  return spawn(process.execPath, ['-e', code], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    ...options,
  })
}

/** Fake plugin harness: one child pid, a dispose that closes stdin, and a restore counter. */
function fakeContext(child) {
  const calls = { restore: 0 }
  return {
    calls,
    allPids: () => [child.pid],
    plugin: { dispose: () => child.stdin.end() },
    restore: () => {
      calls.restore += 1
    },
  }
}

/** Resolve on the child's exit, including when it already exited. */
function exitOf(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', resolve))
}

/** Kill a child that may still be alive and wait for it, so the test leaves no process behind. */
async function killAndWait(child) {
  try {
    child.kill()
  } catch {}
  await exitOf(child)
}

/** A temp dir with one file, the shape helpers' `after` hook has to remove. */
function heldTempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'pc-use-test-'))
  writeFileSync(join(directory, 'held.txt'), 'held')
  return directory
}

test('waitFor checks the predicate once more after its deadline', async () => {
  let calls = 0
  const predicate = async () => {
    calls += 1
    if (calls === 1) {
      // The first call finishes after the 100 ms deadline and says "not yet".
      await new Promise((done) => setTimeout(done, 150))
      return false
    }
    return true
  }
  assert.equal(await waitFor(predicate, 100), true)
  assert.equal(calls, 2)
})

test('stopServers waits for a server that exits 4 s after dispose', async () => {
  const child = spawnChild(EXIT_AFTER_STDIN_END)
  const context = fakeContext(child)
  try {
    const startedAt = Date.now()
    assert.equal(await stopServers(context), true)
    assert.ok(Date.now() - startedAt >= 3500)
    assert.equal(context.calls.restore, 1)
    assert.equal(isRunning(child.pid), false)
  } finally {
    await killAndWait(child)
  }
})

test('stopServers returns false for a server that will not stop and kills it', async () => {
  const child = spawnChild(IGNORE_STDIN_END)
  const context = fakeContext(child)
  try {
    assert.equal(await stopServers(context, 300), false)
    assert.equal(context.calls.restore, 1)
    assert.equal(isRunning(child.pid), false)
  } finally {
    await killAndWait(child)
  }
})

test('removeTempDir removes the directory once its cwd holder exits', async () => {
  const directory = heldTempDir()
  // The child's cwd is the directory, which blocks rmSync on Windows until it exits.
  const child = spawnChild('setTimeout(() => process.exit(0), 1500)', {
    cwd: directory,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  try {
    await new Promise((done) => setTimeout(done, 200))
    const startedAt = Date.now()
    assert.equal(await removeTempDir(directory), true)
    assert.ok(Date.now() - startedAt >= 1000)
    assert.equal(existsSync(directory), false)
  } finally {
    await killAndWait(child)
    await removeTempDir(directory)
  }
})

test('removeTempDir reports once and returns false when its budget runs out', async (t) => {
  const directory = heldTempDir()
  const child = spawnChild('setTimeout(() => process.exit(0), 3000)', {
    cwd: directory,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  // A no-op implementation keeps the expected error line out of the test output.
  const errors = t.mock.method(console, 'error', () => {})
  try {
    await new Promise((done) => setTimeout(done, 200))
    assert.equal(await removeTempDir(directory, 300), false)
    assert.equal(errors.mock.calls.length, 1)
    assert.equal(errors.mock.calls[0].arguments[0].includes(directory), true)
  } finally {
    await killAndWait(child)
    await removeTempDir(directory)
  }
})
