// Fake MCP server for dsh-pc-use bridge tests and repros.
// Usage: node fake-server.mjs <mode> <log-file>
// Modes:
//   ok                answer initialize and every tools/call
//   init-error        answer initialize with a JSON-RPC error
//   init-exit         exit right after receiving initialize
//   init-hang         never answer initialize
//   init-delay        write "pid <n>" to the log, then answer initialize after 500 ms
//   elicit            on tools/call, ask a browser-access approval and report the decision
//   elicit-other      same, but with a non-browser approval message
//   elicit-url        same as elicit, as a url-mode request with a token in the query
//   elicit-url-invalid  url-mode request whose url cannot be parsed
//   slow              never answer tools/call (client timeout and cancellation)
//   image             answer tools/call with one image content item
// Every method received is appended to <log-file>, one per line; answers to approvals
// are logged as "answer <action>", initialize's clientInfo as "initialize-params ...", and
// its full params as "initialize-full ...".
//
// r25 server-docs responses are controlled by environment variables (invented short text
// only; never copy real Codex documentation into a fixture):
//   FAKE_DOCS_INSTRUCTIONS           initialize `instructions` string (default: absent)
//   FAKE_DOCS_JS                     description of the `js` tool
//   FAKE_DOCS_JS_RESET               description of the `js_reset` tool
//   FAKE_DOCS_JS_ADD_NODE_MODULE_DIR description of the `js_add_node_module_dir` tool
//   FAKE_DOCS_NO_JS=1                omit the `js` tool from tools/list
//   FAKE_DOCS_PAGES=N                split tools/list into N pages with nextCursor
//   FAKE_DOCS_FILE=path              read {instructions, tools} JSON from this file on every
//                                    initialize and tools/list, so a test can change the
//                                    server docs between reconnects (default: use the env vars)
// tools/list is recorded like every other method, so tests can count page requests.
import { appendFileSync, readFileSync } from 'node:fs'
import readline from 'node:readline'

const mode = process.argv[2]
const logFile = process.argv[3]
const waiting = new Map()
// FAKE_DOCS_FAIL_FIRST=N makes the first N tools/call requests fail with an error while
// initialize and tools/list still succeed, so a docs re-send can be tested around errors.
const failFirstCalls = Math.max(0, Number(process.env.FAKE_DOCS_FAIL_FIRST ?? '0') || 0)
let callCount = 0
const DOCS_ENV = ['FAKE_DOCS_INSTRUCTIONS', 'FAKE_DOCS_JS', 'FAKE_DOCS_JS_RESET',
  'FAKE_DOCS_JS_ADD_NODE_MODULE_DIR', 'FAKE_DOCS_NO_JS', 'FAKE_DOCS_PAGES',
  'FAKE_DOCS_FAIL_FIRST', 'FAKE_DOCS_FILE']

/** Docs read from FAKE_DOCS_FILE on every request; null when absent or unreadable. O(size). */
function fileDocs() {
  const file = process.env.FAKE_DOCS_FILE
  if (typeof file !== 'string' || file === '') return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** The initialize `instructions`: the docs file wins, then the env override. O(size). */
function currentInstructions() {
  const docs = fileDocs()
  if (docs !== null && typeof docs.instructions === 'string' && docs.instructions !== '') {
    return docs.instructions
  }
  return process.env.FAKE_DOCS_INSTRUCTIONS
}

/** The invented server tools for `tools/list`; docs may be overridden per environment. */
function serverTools() {
  const docs = fileDocs()
  if (docs !== null && docs.tools !== null && typeof docs.tools === 'object') {
    const fromFile = []
    for (const [name, description] of Object.entries(docs.tools)) {
      if (typeof description !== 'string' || description === '') continue
      fromFile.push({ name, description, inputSchema: { type: 'object' } })
    }
    return fromFile
  }
  const overrides = {
    js: process.env.FAKE_DOCS_JS,
    js_reset: process.env.FAKE_DOCS_JS_RESET,
    js_add_node_module_dir: process.env.FAKE_DOCS_JS_ADD_NODE_MODULE_DIR,
  }
  const base = [
    ['js', 'fake server js documentation'],
    ['js_reset', 'fake server js_reset documentation'],
    ['js_add_node_module_dir', 'fake server js_add_node_module_dir documentation'],
    ['list_windows', 'fake server list_windows documentation'],
    ['get_browser', 'fake server get_browser documentation'],
  ]
  const tools = []
  for (const [name, fallback] of base) {
    if (name === 'js' && process.env.FAKE_DOCS_NO_JS === '1') continue
    tools.push({ name, description: overrides[name] ?? fallback, inputSchema: { type: 'object' } })
  }
  return tools
}

/** One tools/list page for the cursor in params; tools are split evenly across pages. */
function toolsPage(params) {
  const all = serverTools()
  const pages = Math.max(1, Number(process.env.FAKE_DOCS_PAGES ?? '1') || 1)
  const cursor = params?.cursor
  const page = cursor === undefined ? 0 : (Number(String(cursor).replace('p', '')) || 0)
  const start = Math.floor((all.length * page) / pages)
  const end = Math.floor((all.length * (page + 1)) / pages)
  const result = { tools: all.slice(start, end) }
  if (page + 1 < pages) result.nextCursor = `p${page + 1}`
  return result
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function record(text) {
  appendFileSync(logFile, `${text}\n`)
}

// r25 P1-2: let the test see the pid before the delayed handshake completes.
if (mode === 'init-delay') record(`pid ${process.pid}`)

function askApproval(callId, text, extra = null) {
  const elicitationId = `e-${callId}`
  send({
    jsonrpc: '2.0',
    id: elicitationId,
    method: 'elicitation/create',
    params: { message: text, ...(extra ?? {}) },
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
    record(`initialize-full ${JSON.stringify(message.params ?? null)}`)
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
    if (mode === 'init-exit') {
      process.exit(0)
    }
    const instructions = currentInstructions()
    const reply = {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        serverInfo: { name: 'fake' },
        ...(typeof instructions === 'string' && instructions !== '' ? { instructions } : {}),
      },
    }
    if (mode === 'init-delay') {
      setTimeout(() => send(reply), 500)
      return
    }
    send(reply)
    return
  }

  if (message.method === 'tools/list') {
    // r25: older tests wrap this fixture and expect no docs update; answer tools/list
    // only when a docs variable is present.
    const docsRequested = DOCS_ENV.some((key) => process.env[key] !== undefined)
    if (!docsRequested) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'tools/list is not supported in this mode' },
      })
      return
    }
    send({ jsonrpc: '2.0', id: message.id, result: toolsPage(message.params) })
    return
  }

  if (message.method !== 'tools/call') {
    return
  }
  if (mode === 'slow') {
    return
  }
  // r25: let tests see a failing js call before the docs re-send is consumed.
  callCount += 1
  if (callCount <= failFirstCalls) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: 'fake tools/call failure' },
    })
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
  if (mode === 'elicit-url') {
    askApproval(message.id, 'Allow Browser use to access https://example.com?', {
      mode: 'url',
      url: 'https://example.com/secret/path?token=SECRET',
    })
    return
  }
  if (mode === 'elicit-url-invalid') {
    askApproval(message.id, 'Allow Browser use to access https://example.com?', {
      mode: 'url',
      url: 'not a url',
    })
    return
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
