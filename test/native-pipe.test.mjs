// A (问题 11): a desktop turn must end by sending exactly one end_turn request over the Codex
// native pipe, so the cursor overlay closes. These tests cover framing and the pipe client only;
// they never touch a real Codex pipe. See FEATURE-0.6.0-fixes.md section A.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  decodeFrame,
  encodeFrame,
  endTurn,
  MAX_FRAME_BYTES,
} from '../lib/native-pipe.js'
import { startFakePipe } from './fixtures/fake-native-pipe-server.mjs'
import { tempDir } from './helpers.mjs'

const IDENTITY = { sessionId: 'session-a', turnId: 'turn-a' }

const EXPECTED_BODY = {
  jsonrpc: '2.0',
  method: 'request',
  params: {
    method: 'end_turn',
    params: {},
    codexTurnMetadata: { session_id: 'session-a', turn_id: 'turn-a' },
  },
}

function newPipePath() {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\pc-use-test-${process.pid}-${randomUUID().slice(0, 8)}`
  }
  return join(tempDir('pc-use-test-'), 'native-pipe.sock')
}

async function startPipe(t, options) {
  const path = newPipePath()
  const pipe = await startFakePipe(path, options)
  t.after(() => pipe.close())
  return { path, pipe }
}

test('MAX_FRAME_BYTES is eight mebibytes', () => {
  assert.equal(MAX_FRAME_BYTES, 8 * 1024 * 1024)
})

test('encodeFrame writes a little-endian length prefix and UTF-8 JSON', () => {
  const message = { id: 1, text: '光圈' }
  const frame = encodeFrame(message)
  const json = Buffer.from(JSON.stringify(message), 'utf8')
  assert.equal(Buffer.isBuffer(frame), true)
  assert.equal(frame.readUInt32LE(0), json.length)
  assert.deepEqual(frame.subarray(4), json)
})

test('encodeFrame accepts exactly MAX_FRAME_BYTES and rejects one byte more', () => {
  const exact = encodeFrame({ s: 'a'.repeat(MAX_FRAME_BYTES - 8) })
  assert.equal(exact.readUInt32LE(0), MAX_FRAME_BYTES)
  assert.equal(exact.length, MAX_FRAME_BYTES + 4)
  assert.throws(() => encodeFrame({ s: 'a'.repeat(MAX_FRAME_BYTES - 7) }), RangeError)
})

test('decodeFrame returns the message and rest, and waits for incomplete frames', () => {
  const first = encodeFrame({ n: 1 })
  const second = encodeFrame({ n: 2 })
  assert.equal(decodeFrame(Buffer.alloc(0)), null)
  assert.equal(decodeFrame(first.subarray(0, 3)), null)
  assert.equal(decodeFrame(first.subarray(0, first.length - 1)), null)
  const decoded = decodeFrame(Buffer.concat([first, second]))
  assert.deepEqual(decoded.message, { n: 1 })
  assert.deepEqual(decoded.rest, second)
})

test('decodeFrame throws bad frame for invalid JSON and oversized lengths', () => {
  const invalid = Buffer.alloc(4 + 5)
  invalid.writeUInt32LE(5, 0)
  invalid.write('nope!', 4, 'utf8')
  assert.throws(() => decodeFrame(invalid), /bad frame/)
  const oversized = Buffer.alloc(4)
  oversized.writeUInt32LE(MAX_FRAME_BYTES + 1, 0)
  assert.throws(() => decodeFrame(oversized), /bad frame/)
})

test('endTurn sends exactly one end_turn request and stops when answered', async (t) => {
  const { path, pipe } = await startPipe(t)
  assert.deepEqual(await endTurn(path, IDENTITY), { ok: true })
  assert.equal(pipe.connections, 1)
  assert.equal(pipe.frames.length, 1)
  const [request] = pipe.frames
  assert.equal(typeof request.id, 'number')
  const { id, ...body } = request
  assert.deepEqual(body, EXPECTED_BODY)
  const [raw] = pipe.rawFrames
  assert.equal(raw.readUInt32LE(0), raw.length - 4)
  assert.equal(pipe.frames.some((frame) => frame?.params?.method === 'close'), false)
  await pipe.waitForDisconnect()
})

test('endTurn reassembles a response split across chunks', async (t) => {
  const { path, pipe } = await startPipe(t, { mode: 'split' })
  assert.deepEqual(await endTurn(path, IDENTITY, { timeoutMs: 2000 }), { ok: true })
  assert.equal(pipe.frames.length, 1)
})

test('endTurn gives up after the timeout and reports timeout', async (t) => {
  const { path, pipe } = await startPipe(t, { mode: 'silent' })
  const started = Date.now()
  const result = await endTurn(path, IDENTITY, { timeoutMs: 200 })
  const elapsed = Date.now() - started
  assert.deepEqual(result, { ok: false, reason: 'timeout' })
  assert.ok(elapsed >= 150, `gave up too early: ${elapsed}ms`)
  assert.ok(elapsed < 2000, `gave up too late: ${elapsed}ms`)
  assert.equal(pipe.frames.length, 1)
  await pipe.waitForDisconnect()
})

test('endTurn reports no pipe when the pipe does not exist', async () => {
  const result = await endTurn(newPipePath(), IDENTITY, { timeoutMs: 1000 })
  assert.deepEqual(result, { ok: false, reason: 'no pipe' })
})

test('endTurn reports an error response from the server', async (t) => {
  const { path, pipe } = await startPipe(t, { mode: 'error' })
  assert.deepEqual(await endTurn(path, IDENTITY), { ok: false, reason: 'error response' })
  await pipe.waitForDisconnect()
})

test('endTurn reports bad frame when the answer is invalid JSON', async (t) => {
  const { path, pipe } = await startPipe(t, { mode: 'bad-frame' })
  assert.deepEqual(await endTurn(path, IDENTITY), { ok: false, reason: 'bad frame' })
  await pipe.waitForDisconnect()
})

test('endTurn maps a connection closed before the answer to error response', async (t) => {
  const { path, pipe } = await startPipe(t, { mode: 'close' })
  assert.deepEqual(await endTurn(path, IDENTITY), { ok: false, reason: 'error response' })
  await pipe.waitForDisconnect()
})
