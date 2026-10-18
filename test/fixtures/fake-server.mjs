// Fake MCP server for dsh-pc-use bridge tests and repros.
// Usage: node fake-server.mjs <mode> <log-file>
// Modes:
//   ok                answer initialize and every tools/call
//   init-error        answer initialize with a JSON-RPC error
//   init-hang         never answer initialize
//   elicit            on tools/call, ask a browser-access approval and report the decision
//   elicit-other      same, but with a non-browser approval message
//   elicit-then-exit  ask an approval, then exit before the client can answer
//   slow              never answer tools/call (client timeout and cancellation)
//   image             answer tools/call with one image content item
// Every method received is appended to <log-file>, one per line; answers to approvals
// are logged as "answer <action>", and initialize's clientInfo as "initialize-params ...".
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const mode = process.argv[2]
const logFile = process.argv[3]
const waiting = new Map()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function record(text) {
  appendFileSync(logFile, `${text}\n`)
}

function askApproval(callId, text) {
  const elicitationId = `e-${callId}`
  send({
    jsonrpc: '2.0',
    id: elicitationId,
    method: 'elicitation/create',
    params: { message: text },
  })
  waiting.set(elicitationId, callId)
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)

  // A response from the client: only approval answers are expected.
  if (message.method === undefined) {
    const action = message.result?.action ?? `error ${message.error?.message}`
    record(`answer ${action}`)
    const callId = waiting.get(message.id)
    if (callId !== undefined) {
      waiting.delete(message.id)
      send({
        jsonrpc: '2.0',
        id: callId,
        result: { content: [{ type: 'text', text: `decision ${action}` }] },
      })
    }
    return
  }

  record(message.method)

  if (message.method === 'initialize') {
    record(`initialize-params ${JSON.stringify(message.params?.clientInfo ?? null)}`)
    if (mode === 'init-hang') {
      return
    }
    if (mode === 'init-error') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'native pipe not ready' },
      })
      return
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        serverInfo: { name: 'fake' },
      },
    })
    return
  }

  if (message.method !== 'tools/call') {
    return
  }
  if (mode === 'slow') {
    return
  }
  if (mode === 'elicit') {
    askApproval(message.id, 'Allow Browser use to access https://example.com?')
    return
  }
  if (mode === 'elicit-other') {
    askApproval(message.id, 'Allow Codex to control the Notepad app?')
    return
  }
  if (mode === 'elicit-then-exit') {
    askApproval(message.id, 'Allow Browser use to access https://example.com?')
    process.exit(0)
  }
  if (mode === 'image') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] },
    })
    return
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: { content: [{ type: 'text', text: `ran ${message.params.name}` }] },
  })
})
