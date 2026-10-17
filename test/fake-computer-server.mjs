// Fake cua_repl server for the desktop-approval tests. Every method received and every
// approval answer is appended to the log file.
// Usage: node fake-computer-server.mjs <mode> <log-file>
// Modes:
//   computer               on tools/call ask `Allow Computer Use to use "记事本"?`
//   computer-codex         on tools/call ask `Allow Codex to use Notepad?`
//   spontaneous            right after initialize, ask the computer question (no tool call)
//   spontaneous-after-call answer one tools/call, then ask with no call pending
//   flow-meta              app + action from the `code` argument; meta under params._meta
//   flow-meta-plain        same, but the meta object is under params.meta
//   flow-meta-nosession    same, but meta.persist is ["always"] (no "session")
//   flow-meta-nometa       same, but the request carries no meta at all
//   turn-ended             answer tools/call; record `turn_ended` arguments
//   turn-ended-error       same, but answer `turn_ended` with a JSON-RPC error
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const [mode, logFile, pidFile] = process.argv.slice(2)
if (pidFile !== undefined) appendFileSync(pidFile, `${process.pid}\n`)
const waiting = new Map()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function record(text) {
  appendFileSync(logFile, `${text}\n`)
}

function ask(callId, text, meta = null, plain = false) {
  const elicitationId = `e-${callId}`
  const params = { message: text }
  if (meta !== null) {
    if (plain) {
      params.meta = meta
    } else {
      params._meta = meta
    }
  }
  send({
    jsonrpc: '2.0',
    id: elicitationId,
    method: 'elicitation/create',
    params,
  })
  waiting.set(elicitationId, callId)
}

/** Parse `display@appKey|action` from the code argument. O(1), n = code length. */
function flowParts(code) {
  const [base, action] = String(code ?? '').split('|')
  const [displayName, appKey] = base.split('@')
  return { displayName, appKey: appKey ?? displayName, action }
}

function flowMeta(appKey, flowMode) {
  const persist = flowMode === 'flow-meta-nosession' ? ['always'] : ['session']
  return { persist, tool_params: { app: appKey } }
}

function handleFlow(message, flowMode) {
  const parts = flowParts(message.params?.arguments?.code)
  const question = `Allow Codex to use ${parts.displayName}?`
  const meta = flowMode === 'flow-meta-nometa' ? null : flowMeta(parts.appKey, flowMode)
  const plain = flowMode === 'flow-meta-plain'
  if (parts.action === 'spontaneous') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'ran js' }] },
    })
    setTimeout(() => ask(`post-${message.id}`, question, meta, plain), 120)
    return
  }
  ask(message.id, question, meta, plain)
}

const COMPUTER_QUESTION = 'Allow Computer Use to use "记事本"?'
const CODEX_QUESTION = 'Allow Codex to use Notepad?'

function handleTurnEnded(message, turnMode) {
  const name = message.params?.name
  const args = message.params?.arguments ?? {}
  if (name === 'turn_ended') {
    record(`turn_ended ${JSON.stringify(args)}`)
    if (turnMode === 'turn-ended-error') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'boom' } })
      return
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'ok' }] },
    })
    return
  }
  const meta = message.params?._meta?.['x-codex-turn-metadata'] ?? {}
  record(`call ${name} ${meta.session_id ?? '-'} ${meta.turn_id ?? '-'}`)
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: { content: [{ type: 'text', text: 'ran js' }] },
  })
}

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
  if (mode.startsWith('turn-ended')) {
    handleTurnEnded(message, mode)
    return
  }
  if (mode.startsWith('flow-meta')) {
    handleFlow(message, mode)
    return
  }
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
  if (mode === 'spontaneous-after-call') {
    // Answer the tool call first, then ask when the call has certainly finished.
    setTimeout(() => ask('post-call', COMPUTER_QUESTION), 150)
  }
})
