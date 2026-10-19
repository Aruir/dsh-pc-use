// Fake MCP server for the two-server tests. It records its pid, the launch env keys the
// tests care about, every `tools/call` (name, arguments, turn metadata) and every
// `turn_ended` as one JSON line per event, so a test can tell which source launched it.
// Usage: node fake-dual-server.mjs <label> <mode> <log-file>
// Modes:
//   ok             answer every tools/call with `ran <name>`
//   computer       on tools/call ask `Allow Computer Use to use "记事本"?`
//   computer-delayed  same, but 400 ms after the call, so a test can flip a switch first
//   computer-meta  same, plus persist:["session"] metadata, so DSH may remember it
//   browser        on tools/call ask `Allow Browser use to access https://example.com?`
//   spontaneous    ask the computer question right after initialize, with no call pending
//   hang           never answer a tools/call (the client's own timeout is the only way out)
//   error          answer tools/call with an isError result (`server error text`)
//   illegal-return answer tools/call with text containing `Illegal return statement`
// `turn_ended` is always answered regardless of the mode.
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const [label, mode, logFile] = process.argv.slice(2)
const waiting = new Map()

function record(entry) {
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Initialize serverInfo: FAKE_SERVER_INFO JSON when set, else the fixture default. O(1). */
function initializeServerInfo() {
  const raw = process.env.FAKE_SERVER_INFO
  if (typeof raw !== 'string' || raw === '') return { name: 'fake-dual' }
  try {
    return JSON.parse(raw)
  } catch {
    return { name: 'fake-dual' }
  }
}

record({
  type: 'start',
  pid: process.pid,
  label,
  env: {
    CUA_REPL_ENABLED_SURFACES: process.env.CUA_REPL_ENABLED_SURFACES ?? null,
    NODE_REPL_TRUSTED_SERVICES: process.env.NODE_REPL_TRUSTED_SERVICES ?? null,
  },
})

/** Ask one elicitation; the answer resolves the pending tools/call (null for none). O(1). */
function ask(callId, text, meta = null) {
  const elicitationId = `e-${callId ?? 'none'}`
  const params = { message: text }
  if (meta !== null) params._meta = meta
  send({
    jsonrpc: '2.0',
    id: elicitationId,
    method: 'elicitation/create',
    params,
  })
  waiting.set(elicitationId, callId)
}

function answerCall(callId, text) {
  send({
    jsonrpc: '2.0',
    id: callId,
    result: { content: [{ type: 'text', text }] },
  })
}

const COMPUTER_QUESTION = 'Allow Computer Use to use "记事本"?'
const BROWSER_QUESTION = 'Allow Browser use to access https://example.com?'
const COMPUTER_META = { persist: ['session'], tool_params: { app: '记事本' } }

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === undefined) {
    const action = message.result?.action ?? `error ${message.error?.message}`
    record({ type: 'answer', action })
    const callId = waiting.get(message.id)
    if (callId !== undefined) {
      waiting.delete(message.id)
      if (callId !== null) answerCall(callId, `decision ${action}`)
    }
    return
  }

  if (message.method !== 'tools/call') {
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: initializeServerInfo(),
        },
      })
      record({ type: 'init', pid: process.pid })
      if (mode === 'spontaneous') ask(null, COMPUTER_QUESTION)
    }
    return
  }

  const name = message.params?.name
  const args = message.params?.arguments ?? {}
  const meta = message.params?._meta ?? null
  const turnMeta = meta?.['x-codex-turn-metadata'] ?? {}
  record({
    type: 'call',
    pid: process.pid,
    name,
    arguments: args,
    session_id: turnMeta.session_id ?? null,
    turn_id: turnMeta.turn_id ?? null,
    meta,
  })

  if (name === 'turn_ended') {
    answerCall(message.id, 'ok')
    return
  }
  if (mode === 'hang') return
  if (mode === 'error') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'server error text' }], isError: true },
    })
    return
  }
  if (mode === 'illegal-return') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'Illegal return statement' }] },
    })
    return
  }
  if (mode === 'computer') {
    ask(message.id, COMPUTER_QUESTION)
    return
  }
  if (mode === 'computer-delayed') {
    setTimeout(() => ask(message.id, COMPUTER_QUESTION), 400)
    return
  }
  if (mode === 'computer-meta') {
    ask(message.id, COMPUTER_QUESTION, COMPUTER_META)
    return
  }
  if (mode === 'browser') {
    ask(message.id, BROWSER_QUESTION)
    return
  }
  answerCall(message.id, `ran ${name}`)
})
