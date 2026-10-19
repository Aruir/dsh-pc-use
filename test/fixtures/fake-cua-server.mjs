// Fake cua_repl for tab-guard and user-tabs-guard tests. It executes the plugin's guarded
// browser program in a persistent environment and can replace cua, start without cua, omit a
// created id, return Browser objects synchronously, put the user-tab methods on the browser
// instance, emulate the runtime's cached proxies, freeze the Browser, or make cua.browsers an
// accessor.
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
  let browser = null
  let membraneCached = null
  const ownTabs = []
  const claimedTabs = []
  const foreignTabs = [
    {
      id: 'FOREIGN-1', title: 'FOREIGN-TITLE-1',
      url: 'https://foreign.invalid/1',
    },
    { id: undefined, title: 'FOREIGN-NO-ID', url: 'https://foreign.invalid/no-id' },
  ]
  const calls = {
    create: 0,
    list: 0,
    listOptions: [],
    user: { openTabs: 0, claimTab: 0, getTabContext: 0, history: 0 },
  }
  const nodeRepl = {
    write(value) { output += `${String(value)}\n` },
  }

  // Synthetic user data; every original call is recorded once so a test can prove that a
  // blocked wrapper never called the real method. O(1) per call.
  function openTabs() {
    calls.user.openTabs += 1
    record({ type: 'userMethod', method: 'openTabs' })
    return [{ id: 'user-tab-1', title: 'USER-TAB-TITLE-1', url: 'https://user.invalid/1' }]
  }

  function claimTab() {
    calls.user.claimTab += 1
    record({ type: 'userMethod', method: 'claimTab' })
    const claimed = {
      id: 'claimed-1',
      title: 'USER-TAB-TITLE-1',
      url: 'https://user.invalid/1',
      async getAXState() { nodeRepl.write('CLAIMED-AX') },
    }
    claimedTabs.push(claimed)
    return claimed
  }

  function getTabContext() {
    calls.user.getTabContext += 1
    record({ type: 'userMethod', method: 'getTabContext' })
    return {
      id: 'user-tab-1',
      title: 'USER-TAB-TITLE-1',
      url: 'https://user.invalid/1',
      text: 'USER-TAB-TEXT-1',
    }
  }

  function history() {
    calls.user.history += 1
    record({ type: 'userMethod', method: 'history' })
    return [{ title: 'HISTORY-TITLE-1', url: 'https://history.invalid/1' }]
  }

  class StubBrowserUser {
    async openTabs() { return openTabs() }

    async claimTab() { return claimTab() }

    async getTabContext() { return getTabContext() }
  }

  class StubBrowser {
    constructor() {
      this.id = 'browser-1'
      this.user = new StubBrowserUser()
    }

    async history() { return history() }
  }

  // Shape one Browser for the current mode; fresh objects let each entry point be checked alone.
  function shapeBrowser() {
    const created = new StubBrowser()
    if (mode === 'own-methods') {
      created.user.openTabs = async () => openTabs()
      created.user.claimTab = async () => claimTab()
      created.user.getTabContext = async () => getTabContext()
      created.history = async () => history()
    }
    if (mode === 'no-user') delete created.user
    if (mode === 'frozen-user') {
      created.user.openTabs = async () => openTabs()
      created.user.claimTab = async () => claimTab()
      created.user.getTabContext = async () => getTabContext()
      Object.freeze(created.user)
    }
    return created
  }

  // cua.getBrowser returns one Browser per environment, so repeated calls prove the guard does
  // not wrap that object twice.
  function makeBrowser() {
    if (browser === null) browser = shapeBrowser()
    return browser
  }

  // cua.browsers.* returns a new Browser each time, so a missing entrance wrapper is visible.
  function freshBrowser() {
    return shapeBrowser()
  }

  // Emulate the runtime proxy: a function-valued property is wrapped on first read and the
  // wrapper is cached by name; defineProperty writes the target but does not refresh the cache.
  function membrane(target) {
    const cache = new Map()
    return new Proxy(target, {
      get(obj, key, receiver) {
        const value = Reflect.get(obj, key, receiver)
        if (typeof value !== 'function') return value
        record({ type: 'membraneGet', key: String(key) })
        if (cache.has(key)) return cache.get(key)
        const wrapped = (...args) => Reflect.apply(value, obj, args)
        cache.set(key, wrapped)
        return wrapped
      },
    })
  }

  function membraneBrowser() {
    const created = shapeBrowser()
    if (created.user !== undefined) created.user = membrane(created.user)
    return membrane(created)
  }

  // A frozen Browser keeps `user` and `history` as fixed own data properties, so a Proxy get
  // trap must return them unchanged or throw the guard error.
  function frozenBrowser() {
    const created = new StubBrowser()
    created.user.openTabs = async () => openTabs()
    created.user.claimTab = async () => claimTab()
    created.user.getTabContext = async () => getTabContext()
    created.history = async () => history()
    Object.freeze(created.user)
    Object.freeze(created)
    return created
  }

  function makeMembraneBrowser() {
    if (membraneCached === null) membraneCached = membraneBrowser()
    return membraneCached
  }

  function makeCua() {
    const created = {
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
        const all = [...ownTabs, ...claimedTabs, ...foreignTabs].map((tab) => ({
          browserId: 'chrome', id: tab.id, providerTabId: tab.id,
          title: tab.title, url: tab.url,
        }))
        if (options.emit !== false) nodeRepl.write(JSON.stringify(all))
        return all
      },
    }
    if (mode !== 'no-get-browser') {
      if (mode === 'sync-entrance') {
        created.getBrowser = () => makeBrowser()
        created.browsers = {
          get: () => freshBrowser(),
          getDefault: () => freshBrowser(),
          getForUrl: () => freshBrowser(),
        }
      } else {
        created.getBrowser = async () => makeBrowser()
        created.browsers = {
          async get() { return freshBrowser() },
          async getDefault() { return freshBrowser() },
          async getForUrl() { return freshBrowser() },
        }
      }
    }
    if (mode === 'membrane') {
      created.getBrowser = async () => makeMembraneBrowser()
      created.browsers = membrane({
        async get() { return membraneBrowser() },
        async getDefault() { return membraneBrowser() },
        async getForUrl() { return membraneBrowser() },
      })
    } else if (mode === 'frozen-browser') {
      created.getBrowser = async () => frozenBrowser()
      created.browsers = {
        async get() { return frozenBrowser() },
        async getDefault() { return frozenBrowser() },
        async getForUrl() { return frozenBrowser() },
      }
    } else if (mode === 'browsers-accessor') {
      const accessorBrowsers = () => ({
        async get() { return freshBrowser() },
        async getDefault() { return freshBrowser() },
        async getForUrl() { return freshBrowser() },
      })
      Object.defineProperty(created, 'browsers', {
        configurable: true,
        get() {
          record({ type: 'browsersAccessor' })
          return accessorBrowsers()
        },
      })
    }
    return created
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
      browser = null
      membraneCached = null
      ownTabs.length = 0
      claimedTabs.length = 0
      calls.create = 0
      calls.list = 0
      calls.listOptions = []
      calls.user = { openTabs: 0, claimTab: 0, getTabContext: 0, history: 0 }
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
