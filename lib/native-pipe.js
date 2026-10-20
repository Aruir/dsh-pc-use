// The Codex computer-use native pipe is an internal protocol of the Codex desktop app, not a
// public API: it is the `computer-use-native-pipe-server` bundled in the app's `app.asar`. This
// module was written against Codex 26.1013, so a future Codex release may change or remove it.
// It is not MCP and it is unrelated to the `node_repl` `turn_ended` hook.
//
// A frame is a 4-byte little-endian unsigned length followed by that many bytes of UTF-8 JSON.
// We only use the request/end_turn exchange, which asks the helper (the cursor overlay) to close
// the active turn. We never send `close`: that request stops the whole helper for every turn.

import { readdirSync, statSync } from 'node:fs'
import { connect } from 'node:net'

export const MAX_FRAME_BYTES = 8 * 1024 * 1024

const REQUEST_ID = 1

// Windows named pipe path: \\.\pipe\<name>; the name is compared case-insensitively.
const WINDOWS_PIPE_PATH = /^\\\\\.\\pipe\\(.+)$/i
// The Windows named-pipe namespace; listing it does not connect to any pipe server.
const WINDOWS_PIPE_ROOT = '\\\\.\\pipe\\'

/**
 * Whether the configured native pipe exists: `null` (none configured), `'present'`,
 * `'missing'` or `'check failed'`; never throws. A Windows named pipe is matched against
 * the pipe directory listing, because stat/open/connect on it would attach as a client and
 * consume one of the Codex pipe server's listen instances while the listing does not. Any
 * other path is checked with `statPath` (ENOENT/ENOTDIR mean missing). O(P), P = pipe names.
 */
export function nativePipeState(path, {
  readPipeNames = () => readdirSync(WINDOWS_PIPE_ROOT),
  statPath = statSync,
} = {}) {
  if (typeof path !== 'string' || path === '') return null
  const match = WINDOWS_PIPE_PATH.exec(path)
  if (match !== null) {
    const wanted = match[1].toLowerCase()
    let names
    try {
      names = readPipeNames()
    } catch {
      return 'check failed'
    }
    if (!Array.isArray(names)) return 'check failed'
    return names.some((name) => typeof name === 'string' && name.toLowerCase() === wanted)
      ? 'present'
      : 'missing'
  }
  try {
    statPath(path)
    return 'present'
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
      ? 'missing'
      : 'check failed'
  }
}

/** Encode one message as a length-prefixed UTF-8 JSON frame. O(n) in the encoded size. */
export function encodeFrame(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8')
  if (json.length > MAX_FRAME_BYTES) {
    throw new RangeError(`frame too large: ${json.length} bytes`)
  }
  const frame = Buffer.alloc(4 + json.length)
  frame.writeUInt32LE(json.length, 0)
  json.copy(frame, 4)
  return frame
}

/** Decode the first complete frame as { message, rest }; null while it is incomplete. O(n). */
export function decodeFrame(buffer) {
  if (buffer.length < 4) return null
  const length = buffer.readUInt32LE(0)
  if (length > MAX_FRAME_BYTES) throw new Error('bad frame')
  if (buffer.length < 4 + length) return null
  let message
  try {
    message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))
  } catch {
    throw new Error('bad frame')
  }
  return { message, rest: buffer.subarray(4 + length) }
}

/**
 * Map one decoded pipe message to a fixed failure reason, or null when it confirms the end.
 * Only the fixed words from FEATURE-0.6.0-fixes.md A are used so log lines stay stable.
 */
function failureReason(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return 'bad frame'
  }
  if (message.error !== undefined && message.error !== null) return 'error response'
  return null
}

/**
 * Ask Codex to end one desktop turn over its native pipe, then disconnect.
 * O(1) work plus waiting: one connect, one frame write, one read cap of `timeoutMs`.
 * Resolves { ok: true } or { ok: false, reason } with a fixed reason; never throws, never retries.
 */
export function endTurn(pipeDirectory, identity, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!pipeDirectory) {
      resolve({ ok: false, reason: 'no pipe' })
      return
    }
    const request = {
      id: REQUEST_ID,
      jsonrpc: '2.0',
      method: 'request',
      params: {
        method: 'end_turn',
        params: {},
        codexTurnMetadata: {
          session_id: identity.sessionId,
          turn_id: identity.turnId,
        },
      },
    }
    let socket
    let settled = false
    let connected = false
    let buffer = Buffer.alloc(0)
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(result)
    }
    timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs)
    try {
      socket = connect(pipeDirectory)
    } catch {
      finish({ ok: false, reason: 'connect failed' })
      return
    }
    socket.once('connect', () => {
      connected = true
      try {
        socket.write(encodeFrame(request))
      } catch {
        finish({ ok: false, reason: 'connect failed' })
      }
    })
    socket.once('error', (error) => {
      if (connected) {
        // The connection was up, so the fixed reason set has no better word than this one.
        finish({ ok: false, reason: 'error response' })
        return
      }
      finish({ ok: false, reason: error.code === 'ENOENT' ? 'no pipe' : 'connect failed' })
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      let frame
      try {
        frame = decodeFrame(buffer)
      } catch {
        finish({ ok: false, reason: 'bad frame' })
        return
      }
      if (frame === null) return
      const reason = failureReason(frame.message)
      finish(reason === null ? { ok: true } : { ok: false, reason })
    })
    socket.once('close', () => {
      // A connection that closes before answering cannot be told apart from a refusal here.
      finish({ ok: false, reason: 'error response' })
    })
  })
}
