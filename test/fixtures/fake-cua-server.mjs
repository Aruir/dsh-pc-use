// Fake cua_repl for tab-guard tests. It executes the plugin's guarded browser program in a
// persistent environment and can replace cua, start without cua, or omit a created id.
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

function createEnvironment() {
  let output = ''
  let nextId = 1
  const ownTabs = []
  const foreignTabs = [
    {
      id: 'FOREIGN-1', title: 'FOREIGN-TITLE-1',
      url: 'https://foreign.invalid/1',
    },
    { id: undefined, title: 'FOREIGN-NO-ID', url: 'https://foreign.invalid/no-id' },
  ]
  const calls = { create: 0, list: 0, listOptions: [] }
  const nodeRepl = {
    write(value) { output += `${String(value)}\n` },
  }

  function makeCua() {
    return {
      async createBrowserTab(_browserId, url) {
        calls.create += 1
        record({ type: 'createBrowserTab' })
        const tab = {
          title: `own-${url}`,
          url,
          async getAXState() { nodeRepl.write('AX') },
        }
        if (mode !== 'no-id-tab') tab.id = `tab-${nextId++}`
        ownTabs.push(tab)
        return tab
      },
      async listTabs(options = {}) {
        if (mode === 'throw-list') throw new Error('listTabs boom')
        calls.list += 1
        calls.listOptions.push(options)
        record({ type: 'listTabs', options })
        const all = [...ownTabs, ...foreignTabs].map((tab) => ({
          browserId: 'chrome', id: tab.id, providerTabId: tab.id,
          title: tab.title, url: tab.url,
        }))
        if (options.emit !== false) nodeRepl.write(JSON.stringify(all))
        return all
      },
    }
  }

  return {
    output: () => output,
    resetOutput: () => { output = '' },
    calls,
    nodeRepl,
    makeCua,
    cua: mode === 'no-cua' ? null : makeCua(),
    reset() {
      output = ''
      nextId = 1
      ownTabs.length = 0
      calls.create = 0
      calls.list = 0
      calls.listOptions = []
    },
  }
}

let environment = createEnvironment()
let installCua = true

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        serverInfo: { name: 'fake-cua' },
      },
    })
    return
  }
  if (message.method !== 'tools/call') return
  const name = message.params?.name
  record({ type: 'call', name, arguments: message.params?.arguments ?? {} })
  if (name === 'js_reset') {
    environment = createEnvironment()
    installCua = true
    delete globalThis[Symbol.for('dsh-pc-use.tabGuard.tabs')]
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'reset' }] } })
    return
  }
  if (name !== 'js') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } })
    return
  }
  const code = String(message.params?.arguments?.code ?? '')
  globalThis.makeCua = environment.makeCua
  if (installCua || globalThis.cua === undefined || globalThis.cua === null) {
    globalThis.cua = environment.cua
    installCua = false
  }
  globalThis.nodeRepl = environment.nodeRepl
  globalThis.tab = {
    async getAXState() { environment.nodeRepl.write('AX') },
  }
  environment.resetOutput()
  try {
    await new AsyncFunction(code)()
    if (mode === 'no-cua' && environment.cua === null) {
      environment.cua = environment.makeCua()
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: environment.output() }] },
    })
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { isError: true, content: [{ type: 'text', text: String(error.message) }] },
    })
  }
})
