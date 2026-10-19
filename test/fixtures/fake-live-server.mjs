// Fake node_repl for live-fix tests. It executes the plugin's desktop observation block
// with a stubbed sky/nodeRepl so the null-accessibility branch itself runs.
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const [side, mode, logFile] = process.argv.slice(2)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function record(entry) {
  if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify({ side, ...entry })}\n`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function runObservation(code) {
  let output = ''
  globalThis.targetWindow = { id: 'fake-window' }
  globalThis.nodeRepl = { write(value) { output = String(value) } }
  globalThis.__sky = {
    async get_window_state() {
      return {
        window: { id: 'fake-window' },
        accessibility: mode === 'tree'
          ? { tree: 'TREE' }
          : mode === 'tree-fake-marker'
            ? { tree: '\u0000pc-no-tree:fake\u0000 [no accessibility tree here]' }
            : null,
      }
    },
  }
  const executable = code.replace(
    'const { sky } = await import("@oai/sky");',
    'const sky = globalThis.__sky;',
  )
  await new AsyncFunction(executable)()
  return output
}

record({ type: 'start', pid: process.pid, mode })

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    record({ type: 'init', pid: process.pid })
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        serverInfo: { name: 'fake-live' },
      },
    })
    return
  }
  if (message.method !== 'tools/call') return
  const code = String(message.params?.arguments?.code ?? '')
  record({ type: 'call', name: message.params?.name, arguments: message.params?.arguments ?? {} })
  try {
    let text = 'ran js'
    if (mode === 'plain-marker') {
      text = '[no accessibility tree for this window]'
    } else if (code.includes('sky.get_window_state')) {
      text = await runObservation(code)
    }
    if (mode === 'no-tree-error') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text }] },
      })
      return
    }
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } })
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { isError: true, content: [{ type: 'text', text: String(error.message) }] },
    })
  }
})
