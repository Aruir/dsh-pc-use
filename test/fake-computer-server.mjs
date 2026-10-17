// Fake cua_repl server for the desktop-approval tests. Every method received and every
// approval answer is appended to the log file.
// Usage: node fake-computer-server.mjs <mode> <log-file>
// Modes:
//   computer        on tools/call ask `Allow Computer Use to use "记事本"?`
//   computer-codex  on tools/call ask `Allow Codex to use Notepad?`
//   spontaneous     right after initialize, ask the computer question (no tool call)
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const [mode, logFile] = process.argv.slice(2)
const waiting = new Map()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function record(text) {
  appendFileSync(logFile, `${text}\n`)
}

function ask(callId, text) {
  const elicitationId = `e-${callId}`
  send({
    jsonrpc: '2.0',
    id: elicitationId,
    method: 'elicitation/create',
    params: { message: text },
  })
  waiting.set(elicitationId, callId)
}

const COMPUTER_QUESTION = 'Allow Computer Use to use "记事本"?'
const CODEX_QUESTION = 'Allow Codex to use Notepad?'

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)

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
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        serverInfo: { name: 'fake-computer' },
      },
    })
    if (mode === 'spontaneous') ask('init-approval', COMPUTER_QUESTION)
    return
  }

  if (message.method !== 'tools/call') return
  if (mode === 'computer') {
    ask(message.id, COMPUTER_QUESTION)
    return
  }
  if (mode === 'computer-codex') {
    ask(message.id, CODEX_QUESTION)
    return
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: { content: [{ type: 'text', text: 'ran js' }] },
  })
})
