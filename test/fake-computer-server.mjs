// Fake cua_repl server for the desktop-approval tests. Every method received and every
// approval answer is appended to the log file.
// Usage: node fake-computer-server.mjs <mode> <log-file>
// Modes:
//   computer               on tools/call ask `Allow Computer Use to use "记事本"?`
//   spontaneous            right after initialize, ask the computer question (no tool call)
//   spontaneous-after-call answer one tools/call, then ask with no call pending
//   flow-meta              app + action from the `code` argument; meta under params._meta
//   flow-meta-plain        same, but the meta object is under params.meta
//   flow-meta-nosession    same, but meta.persist is ["always"] (no "session")
//   flow-meta-nometa       same, but the request carries no meta at all
//   persist-store          meta asks for session; a persist reply is remembered in a file
//   flow-meta-reject-error same, but a user decline returns isError with Codex's wording
//   flow-meta-reject-error-slow same, but that isError arrives 300 ms later
//   turn-ended             answer tools/call; record `turn_ended` arguments
//   turn-ended-error       same, but answer `turn_ended` with a JSON-RPC error
import { appendFileSync, readFileSync } from 'node:fs'
import readline from 'node:readline'

const [mode, logFile, pidFile] = process.argv.slice(2)
if (pidFile !== undefined) appendFileSync(pidFile, `${process.pid}\n`)
const waiting = new Map()
// Counts tools/call messages for the `first-ask-then-slow` mode.
let toolCallCount = 0

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Initialize serverInfo: FAKE_SERVER_INFO JSON when set, else the fixture default. O(1). */
function initializeServerInfo() {
  const raw = process.env.FAKE_SERVER_INFO
  if (typeof raw !== 'string' || raw === '') return { name: 'fake-computer' }
  try {
    return JSON.parse(raw)
  } catch {
    return { name: 'fake-computer' }
  }
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

// r35: simulate Codex's on-disk session memory. A reply carrying `_meta.persist` "session"
// stores `<session id>\t<app>`; a later call with the same pair does not ask again, and the
// file survives a server restart. Set FAKE_PERSIST_STORE to the file path.
const persistStore = process.env.FAKE_PERSIST_STORE ?? null
const persistReplyLog = persistStore === null ? null : `${persistStore}.replies`
const pendingPersist = new Map()

function storedPersistKeys() {
  if (persistStore === null) return new Set()
  try {
    return new Set(readFileSync(persistStore, 'utf8').split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

function handlePersistStore(message) {
  const parts = flowParts(message.params?.arguments?.code)
  const sessionId = message.params?._meta?.['x-codex-turn-metadata']?.session_id ?? '-'
  const key = `${sessionId}\t${parts.appKey}`
  if (storedPersistKeys().has(key)) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'ran js' }] },
    })
    return
  }
  ask(message.id, `Allow Codex to use ${parts.displayName}?`,
    { persist: ['session'], tool_params: { app: parts.appKey } })
  // The approval reply uses the elicitation id, not the tool-call id.
  pendingPersist.set(`e-${message.id}`, key)
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

function handleTurnEnded(message, turnMode) {
  const name = message.params?.name
  const args = message.params?.arguments ?? {}
  if (name === 'turn_ended') {
    record(`turn_ended ${JSON.stringify(args)}`)
    record(
      `turn_ended-meta ${JSON.stringify(message.params?._meta?.['x-codex-turn-metadata'] ?? {})}`,
    )
    // The complete `_meta` as received, for the byte-for-byte turn_ended test.
    record(`turn_ended-meta-raw ${JSON.stringify(message.params?._meta)}`)
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
    if (mode === 'persist-store' && persistStore !== null) {
      const key = pendingPersist.get(message.id)
      if (key !== undefined) {
        pendingPersist.delete(message.id)
        if (message.result?._meta?.persist === 'session') {
          appendFileSync(persistStore, `${key}\n`)
        }
      }
      appendFileSync(persistReplyLog, `${JSON.stringify(message.result ?? null)}\n`)
    }
    const callId = waiting.get(message.id)
    if (callId !== undefined) {
      waiting.delete(message.id)
      const rejected = (mode === 'flow-meta-reject-error'
        || mode === 'flow-meta-reject-error-slow')
        && typeof action === 'string' && action.startsWith('decline')
      const reply = rejected
        ? {
          jsonrpc: '2.0',
          id: callId,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'Computer Use was not approved to use 记事本' }],
          },
        }
        : {
          jsonrpc: '2.0',
          id: callId,
          result: { content: [{ type: 'text', text: `decision ${action}` }] },
        }
      // The remaining-time test needs the result long after the approval answer, so the
      // client's resumed timer fires while the server is still busy.
      if (mode === 'slow-ask-answer') {
        setTimeout(() => send(reply), 4000)
      } else if (mode === 'flow-meta-reject-error-slow' && rejected) {
        setTimeout(() => send(reply), 300)
      } else {
        send(reply)
      }
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
        serverInfo: initializeServerInfo(),
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
  if (mode === 'persist-store') {
    handlePersistStore(message)
    return
  }
  if (mode === 'computer') {
    ask(message.id, COMPUTER_QUESTION)
    return
  }
  if (mode === 'slow-ask-answer') {
    // Ask only after 1000 ms, so a known part of the caller's 3000 ms timeout is used before the
    // timer is paused.
    setTimeout(() => ask(message.id, COMPUTER_QUESTION), 1000)
    return
  }
  if (mode === 'hang') {
    // Never answer the tool call, so the client's own timeout is the only way out.
    return
  }
  if (mode === 'first-ask-then-slow') {
    toolCallCount += 1
    if (toolCallCount === 1) {
      ask(message.id, COMPUTER_QUESTION)
      return
    }
    // Later calls never ask and answer after 1100 ms, so a call started while an
    // approval is pending must survive that wait without its own timeout firing.
    setTimeout(() => send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'ran js' }] },
    }), 1100)
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
