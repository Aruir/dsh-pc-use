// F2: a bridge whose initialize failed must not stay "alive", and the child must be gone.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import * as bridgeModule from '../lib/mcp-bridge.js'
import { FAKE_SERVER, tempDir, waitFor, waitForProcessExit } from './helpers.mjs'

const { McpBridge } = bridgeModule
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function serverLogPath(home) {
  const file = join(home, 'server.log')
  writeFileSync(file, '')
  return file
}

function bridgeFor(mode, logFile, extra = {}) {
  return new McpBridge({
    command: process.execPath,
    args: [FAKE_SERVER, mode, logFile],
    env: process.env,
    cwd: tempDir(),
    sessionId: 'test-session',
    log: () => {},
    ...extra,
  })
}

function receivedMethods(logFile) {
  return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
}

test('the MCP client version comes from package.json', () => {
  assert.equal(bridgeModule.clientVersion, packageJson.version)
  assert.equal(bridgeModule.clientVersion, '0.8.0')
})

test('init-error: start rejects, alive is false and the child is terminated', async () => {
  const logFile = serverLogPath(tempDir())
  const bridge = bridgeFor('init-error', logFile)
  const starting = bridge.start().then(() => null, (error) => error)
  const pid = bridge.child?.pid
  const error = await starting
  try {
    assert.ok(error instanceof Error)
    assert.match(error.message, /native pipe not ready/)
    assert.equal(bridge.alive, false)
    assert.equal(bridge.child, null)
    assert.ok(Number.isInteger(pid), 'the child pid must be readable after start() was called')
    assert.equal(await waitForProcessExit(pid), true)
    await assert.rejects(() => bridge.call('js', { code: '1', title: 'x' }, 2000),
      /native pipe not ready/)
    assert.equal(receivedMethods(logFile).includes('tools/call'), false)
  } finally {
    bridge.stop()
  }
})

test('call timeout sends notifications/cancelled and says the server may still run', async () => {
  const logFile = serverLogPath(tempDir())
  const bridge = bridgeFor('slow', logFile)
  try {
    await bridge.start()
    await assert.rejects(() => bridge.call('js', { code: '1', title: 'x' }, 200), (error) => {
      assert.match(error.message, /timed out after 200ms/)
      assert.match(error.message, /may still be running/)
      return true
    })
    const cancelled = await waitFor(
      () => receivedMethods(logFile).includes('notifications/cancelled'),
    )
    assert.equal(cancelled, true)
    assert.equal(receivedMethods(logFile).includes('tools/call'), true)
  } finally {
    bridge.stop()
  }
})

test('init-hang: the initialize timeout rejects and kills the child', async () => {
  const logFile = serverLogPath(tempDir())
  const bridge = bridgeFor('init-hang', logFile, { initTimeoutMs: 200 })
  const starting = bridge.start().then(() => null, (error) => error)
  const pid = bridge.child?.pid
  const error = await starting
  try {
    assert.ok(error instanceof Error)
    assert.match(error.message, /initialize timed out after 200ms/)
    assert.equal(bridge.alive, false)
    assert.ok(Number.isInteger(pid), 'the child pid must be readable after start() was called')
    assert.equal(await waitForProcessExit(pid), true)
  } finally {
    bridge.stop()
  }
})
