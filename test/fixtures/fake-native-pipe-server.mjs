// Fake Codex native-pipe server for native-pipe tests.
// It speaks the 4-byte little-endian length + UTF-8 JSON framing on its own: it does not import
// lib/native-pipe.js, so a framing bug in the module under test cannot hide here. It records
// every frame it receives and answers according to `mode`:
//   ok        answer the request with a JSON-RPC result
//   split     same, but write the answer in two chunks to exercise partial reads
//   error     answer with a JSON-RPC error
//   bad-frame answer with a length prefix followed by invalid JSON
//   silent    accept the request and never answer (client timeout)
//   close     close the connection without answering
// The caller passes the pipe path and must call close() when done; on Windows closing the
// server removes the named pipe.

import { createServer } from 'node:net'

const MAX_FRAME_BYTES = 8 * 1024 * 1024

function encode(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.alloc(4 + json.length)
  frame.writeUInt32LE(json.length, 0)
  json.copy(frame, 4)
  return frame
}

function readFrame(buffer) {
  if (buffer.length < 4) return null
  const length = buffer.readUInt32LE(0)
  if (length > MAX_FRAME_BYTES) throw new Error('bad frame')
  if (buffer.length < 4 + length) return null
  const payload = buffer.subarray(4, 4 + length)
  return {
    message: JSON.parse(payload.toString('utf8')),
    wire: buffer.subarray(0, 4 + length),
    rest: buffer.subarray(4 + length),
  }
}

export async function startFakePipe(pipePath, { mode = 'ok' } = {}) {
  const server = createServer()
  const frames = []
  const rawFrames = []
  const sockets = new Set()
  let connections = 0

  function answer(socket, message) {
    if (mode === 'silent') return
    if (mode === 'close') {
      socket.destroy()
      return
    }
    if (mode === 'error') {
      socket.write(encode({
        jsonrpc: '2.0',
        id: message?.id,
        error: { code: -32000, message: 'fake native pipe error' },
      }))
      return
    }
    if (mode === 'bad-frame') {
      const frame = Buffer.alloc(6)
      frame.writeUInt32LE(2, 0)
      frame.write('no', 4, 'utf8')
      socket.write(frame)
      return
    }
    const frame = encode({ jsonrpc: '2.0', id: message?.id, result: {} })
    if (mode !== 'split') {
      socket.write(frame)
      return
    }
    const half = Math.floor(frame.length / 2)
    socket.write(frame.subarray(0, half))
    setTimeout(() => socket.write(frame.subarray(half)), 10)
  }

  server.on('connection', (socket) => {
    connections += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        let frame
        try {
          frame = readFrame(buffer)
        } catch {
          socket.destroy()
          return
        }
        if (frame === null) return
        buffer = frame.rest
        frames.push(frame.message)
        rawFrames.push(frame.wire)
        answer(socket, frame.message)
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipePath, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    frames,
    rawFrames,
    get connections() {
      return connections
    },
    get openSockets() {
      return sockets.size
    },
    async waitForDisconnect(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (sockets.size > 0) {
        if (Date.now() > deadline) throw new Error('fake pipe: client stayed connected')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
