// Fake MCP server for observe/run_plan tests: records calls and injects plan failures.
// Modes are not used except to name the side; code markers select the injected behavior.
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const [side, mode, logFile] = process.argv.slice(2)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function record(entry) {
  if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

record({ type: 'start', pid: process.pid, mode, side })

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
        serverInfo: { name: 'fake-plan' },
      },
    })
    return
  }
  if (message.method !== 'tools/call') return
  const code = String(message.params?.arguments?.code ?? '')
  record({ type: 'call', name: message.params?.name, arguments: message.params?.arguments ?? {} })
  if (code.includes('OUTPUT_DECLINE_WORDS')) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'decision decline is page text' }] },
    })
    return
  }
  // Execute the plugin's check wrapper for real, including thrown errors and syntax errors.
  if (code.includes('const ok = Boolean(await (async () =>')) {
    // The guarded check starts with the tab guard, which only wraps these stubs.
    globalThis.cua = {
      createBrowserTab: async () => ({ id: 'fake-check-tab' }),
      listTabs: async () => [],
    }
    globalThis.nodeRepl = { write() {} }
    try {
      await new AsyncFunction(code)()
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'check passed' }] },
      })
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: String(error?.message ?? error) }],
        },
      })
    }
    return
  }
  if (code.includes('STEP_FAIL')) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { isError: true, content: [{ type: 'text', text: 'step failed' }] },
    })
    return
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: { content: [{ type: 'text', text: 'ran js' }] },
  })
})
