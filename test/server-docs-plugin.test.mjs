// r25: server documentation integration. A fake Codex server publishes invented short docs via
// initialize/tools/list; HOME and the Codex home are temporary, and nothing here uses real
// Codex documentation text.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  assertTempHome, registerPlugin, tempDir, useHome, waitFor, waitForProcessExit, writeCodexHome,
} from './helpers.mjs'
import {
  BROWSER_JS_DESCRIPTION, BROWSER_JS_RESET_DESCRIPTION, DESKTOP_ADD_NODE_MODULE_DIR_DESCRIPTION,
  DESKTOP_JS_DESCRIPTION, DESKTOP_JS_RESET_DESCRIPTION, BROWSER_JS_RULES,
} from '../lib/tool-docs.js'

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url))
const ENV_KEYS = ['FAKE_DOCS_INSTRUCTIONS', 'FAKE_DOCS_JS', 'FAKE_DOCS_JS_RESET',
  'FAKE_DOCS_JS_ADD_NODE_MODULE_DIR', 'FAKE_DOCS_NO_JS', 'FAKE_DOCS_PAGES',
  'FAKE_DOCS_FAIL_FIRST', 'FAKE_DOCS_FILE']
const OLD = { instructions: 'INSTRUCTIONS-OLD', js: 'SERVER-JS-OLD',
  reset: 'SERVER-RESET-OLD', add: 'SERVER-ADD-OLD' }
const NEW = { instructions: 'INSTRUCTIONS-NEW', js: 'SERVER-JS-NEW',
  reset: 'SERVER-RESET-NEW', add: 'SERVER-ADD-NEW' }
const NOTE_ZH = '【dsh-pc-use】DSH 载入工具列表后'
const NOTE_EN = '[dsh-pc-use] The Codex server changed its documentation'
const TABLE = [
  ['pc_codex_js', 2483, '0efd837c7d75850a', BROWSER_JS_DESCRIPTION],
  ['pc_codex_js_reset', 110, 'fbbd5b1764cab040', BROWSER_JS_RESET_DESCRIPTION],
  ['pc_codex_desktop_js', 1976, 'c027e89486683d59', DESKTOP_JS_DESCRIPTION],
  ['pc_codex_desktop_js_reset', 102, '12aa3b8265669468', DESKTOP_JS_RESET_DESCRIPTION],
  ['pc_codex_desktop_js_add_node_module_dir', 149, 'b6cbb458b7e5f8c4',
    DESKTOP_ADD_NODE_MODULE_DIR_DESCRIPTION],
]

/** Install the fake server docs for one run. O(1). */
function setDocs(docs) {
  for (const key of ENV_KEYS) delete process.env[key]
  if (docs === null || docs === undefined) return
  if (docs.instructions !== undefined) process.env.FAKE_DOCS_INSTRUCTIONS = docs.instructions
  if (docs.js !== undefined) process.env.FAKE_DOCS_JS = docs.js
  if (docs.reset !== undefined) process.env.FAKE_DOCS_JS_RESET = docs.reset
  if (docs.add !== undefined) process.env.FAKE_DOCS_JS_ADD_NODE_MODULE_DIR = docs.add
  if (docs.noJs === true) process.env.FAKE_DOCS_NO_JS = '1'
  if (docs.pages !== undefined) process.env.FAKE_DOCS_PAGES = String(docs.pages)
  if (docs.failFirst !== undefined) process.env.FAKE_DOCS_FAIL_FIRST = String(docs.failFirst)
  if (docs.file !== undefined) process.env.FAKE_DOCS_FILE = docs.file
}

function clearDocs() {
  setDocs(null)
}

/** One plugin run over a temporary HOME and Codex home. O(1) + the plugin work. */
function setup(options = {}) {
  const home = options.home ?? tempDir('pc-use-server-docs-')
  const restoreHome = useHome(home)
  // P1-1: cache-writing tests must never run under the real home; a missing useHome()
  // (or a broken helper) throws here instead of writing to ~/.dsh.
  assertTempHome()
  const codexHome = join(home, 'codex')
  const serverLog = join(home, options.serverLogName ?? 'server.log')
  const args = options.args ?? [FAKE_SERVER, options.mode ?? 'ok', serverLog, 'SECRET-ARG']
  writeCodexHome(codexHome, args, {}, { desktop: options.desktop === true })
  if (options.keepServerLog !== true) writeFileSync(serverLog, '')
  const logFile = join(home, 'bridge.log')
  const plugin = registerPlugin({
    codexHome,
    logFile,
    computer: options.computer ?? false,
    prefetchServerDocs: options.prefetch ?? false,
    ...(options.config ?? {}),
  }, { services: options.services ?? {} })
  const cacheFile = join(home, '.dsh', 'pc-use-server-docs.json')
  return {
    home,
    codexHome,
    serverLog,
    logFile,
    cacheFile,
    plugin,
    restore() {
      plugin.dispose()
      restoreHome()
    },
  }
}

function agentOf(name) {
  return { id: name, session: { id: `session-${name}` } }
}

function execFor(agent, callId = 'call-1') {
  return { agent, name: 'pc_codex_js', callId, signal: new AbortController().signal }
}

function runJs(context, agent, code = '1') {
  return context.plugin.tools.get('pc_codex_js').execute({ code, title: 't' },
    execFor(agent))
}

function serverMethods(context) {
  return readFileSync(context.serverLog, 'utf8').split('\n').filter((line) => line !== '')
}

function countMethod(context, name) {
  return serverMethods(context).filter((line) => line === name).length
}

function cacheOf(context) {
  return JSON.parse(readFileSync(context.cacheFile, 'utf8'))
}

async function waitCache(context) {
  assert.equal(await waitFor(() => existsSync(context.cacheFile)), true, 'cache not written')
}

function sha16(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

async function statusOf(context) {
  return JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    .providers.codex.serverDocs
}

test('no cache: built-in descriptions and no process, prefetch off', () => {
  setDocs(OLD)
  const context = setup()
  try {
    for (const [name, length, hash] of TABLE) {
      const description = context.plugin.tools.get(name).description
      assert.equal(Buffer.byteLength(description, 'utf8'), length, name)
      assert.equal(sha16(description), hash, name)
    }
    assert.equal(existsSync(context.cacheFile), false)
    assert.deepEqual(serverMethods(context), [])
  } finally {
    context.restore()
    clearDocs()
  }
})

test('prefetch starts the browser server, fetches docs and writes the cache', async () => {
  setDocs(OLD)
  const context = setup({ prefetch: true })
  try {
    await waitCache(context)
    const entry = cacheOf(context).browser
    assert.equal(entry.instructions, OLD.instructions)
    assert.equal(entry.tools.js, OLD.js)
    assert.equal(entry.tools.js_reset, OLD.reset)
    assert.equal(typeof entry.fingerprint, 'string')
    assert.equal(typeof entry.docsHash, 'string')
    assert.equal(countMethod(context, 'initialize'), 1)
    assert.equal(countMethod(context, 'tools/list') >= 1, true)
    assert.equal(cacheOf(context).desktop, null)
    // The registered description was fixed before the prefetch: still the handwritten text.
    assert.equal(context.plugin.tools.get('pc_codex_js').description, BROWSER_JS_DESCRIPTION)
    // A prefetch and the first call share one handshake and one process.
    await runJs(context, agentOf('shared'))
    assert.equal(countMethod(context, 'initialize'), 1)
  } finally {
    context.restore()
    clearDocs()
  }
})

test('computer on: prefetch fills both targets', async () => {
  setDocs(OLD)
  const context = setup({ prefetch: true, computer: true, desktop: true })
  try {
    assert.equal(await waitFor(() => {
      if (!existsSync(context.cacheFile)) return false
      const data = cacheOf(context)
      return data.browser !== null && data.desktop !== null
    }), true)
    const data = cacheOf(context)
    assert.equal(data.browser.tools.js, OLD.js)
    assert.equal(data.desktop.tools.js, OLD.js)
  } finally {
    context.restore()
    clearDocs()
  }
})

test('corrupt caches fall back to built-in descriptions', async () => {
  setDocs(OLD)
  const first = setup({ prefetch: true })
  try {
    await waitCache(first)
    const base = cacheOf(first)
    const corruptions = [
      ['not json', 'not json at all'],
      ['wrong version', JSON.stringify({ ...base, version: 2 })],
      ['bad hash', JSON.stringify({
        ...base, browser: { ...base.browser, docsHash: '0'.repeat(64) },
      })],
      ['long string', JSON.stringify({
        ...base,
        browser: { ...base.browser, tools: { js: 'x'.repeat(70 * 1024) } },
      })],
      ['oversized file', JSON.stringify({ ...base, padding: 'x'.repeat(260 * 1024) })],
    ]
    for (const [label, content] of corruptions) {
      writeFileSync(first.cacheFile, content)
      const context = setup({ home: first.home })
      try {
        assert.equal(context.plugin.tools.get('pc_codex_js').description,
          BROWSER_JS_DESCRIPTION, label)
      } finally {
        context.restore()
      }
    }
    // One broken target does not invalidate the other (the browser entry stays valid).
    writeFileSync(first.cacheFile, JSON.stringify({
      ...base,
      desktop: { ...base.browser, docsHash: '1'.repeat(64) },
    }))
    const mixed = setup({ home: first.home })
    try {
      assert.notEqual(mixed.plugin.tools.get('pc_codex_js').description, BROWSER_JS_DESCRIPTION)
      assert.equal(mixed.plugin.tools.get('pc_codex_desktop_js').description,
        DESKTOP_JS_DESCRIPTION)
    } finally {
      mixed.restore()
    }
  } finally {
    first.restore()
    clearDocs()
  }
})

test('changed docs are re-sent once per agent, after errors and around tools', async () => {
  setDocs(OLD)
  const first = setup({ prefetch: true })
  try {
    await waitCache(first)
  } finally {
    first.restore()
  }
  setDocs({ ...NEW, failFirst: 1 })
  const second = setup({ home: first.home, config: { language: 'zh' } })
  try {
    const js = second.plugin.tools.get('pc_codex_js')
    assert.equal(js.description.includes(OLD.js), true)
    const agentA = agentOf('a')
    const agentB = agentOf('b')
    // The first call fails; its error must neither carry the note nor consume it.
    await assert.rejects(() => runJs(second, agentA, '1'), /fake tools\/call failure/)
    assert.equal(await waitFor(() => (
      existsSync(second.cacheFile) && cacheOf(second).browser.tools.js === NEW.js
    )), true)
    // reset and observe never carry the note.
    const reset = await second.plugin.tools.get('pc_codex_js_reset').execute({}, execFor(agentA))
    assert.equal(reset.includes('INSTRUCTIONS-NEW'), false)
    const observe = await second.plugin.tools.get('pc_codex_observe')
      .execute({ target: 'browser', subject: 'tab' }, execFor(agentA))
    assert.equal(observe.includes('INSTRUCTIONS-NEW'), false)
    // The next successful js result carries the note with the raw server docs.
    const firstSuccess = await runJs(second, agentA, '2')
    assert.equal(firstSuccess.includes(NOTE_ZH), true)
    assert.equal(firstSuccess.includes(NEW.js), true)
    assert.equal(firstSuccess.includes(BROWSER_JS_RULES), false)
    const again = await runJs(second, agentA, '3')
    assert.equal(again.includes(NEW.js), false)
    const otherAgent = await runJs(second, agentB, '4')
    assert.equal(otherAgent.includes(NOTE_ZH), true)
    assert.equal(otherAgent.includes(NEW.js), true)
  } finally {
    second.restore()
    clearDocs()
  }
})

test('the re-send note follows the interface language', async () => {
  setDocs(OLD)
  const first = setup({ prefetch: true })
  try {
    await waitCache(first)
  } finally {
    first.restore()
  }
  setDocs({ ...NEW, failFirst: 1 })
  const second = setup({ home: first.home, config: { language: 'en' } })
  try {
    const agent = agentOf('english')
    await assert.rejects(() => runJs(second, agent, '1'), /fake tools\/call failure/)
    assert.equal(await waitFor(() => (
      existsSync(second.cacheFile) && cacheOf(second).browser.tools.js === NEW.js
    )), true)
    const result = await runJs(second, agent, '2')
    assert.equal(result.includes(NOTE_EN), true)
    assert.equal(result.includes(NEW.js), true)
  } finally {
    second.restore()
    clearDocs()
  }
})

test('returning to the registered docs clears a queued re-send', async () => {
  const home = tempDir('pc-use-server-docs-')
  const docsFile = join(home, 'server-docs.json')
  const writeDocs = (docs) => writeFileSync(docsFile, JSON.stringify({
    instructions: docs.instructions,
    tools: { js: docs.js, js_reset: docs.reset, js_add_node_module_dir: docs.add },
  }))
  writeDocs(OLD)
  setDocs({ file: docsFile })
  const first = setup({ prefetch: true })
  try {
    await waitCache(first)
  } finally {
    first.restore()
  }
  const second = setup({ home: first.home })
  try {
    assert.equal(second.plugin.tools.get('pc_codex_js').description.includes(OLD.js), true)
    // The server moves to NEW: the connection queues that re-send.
    writeDocs(NEW)
    await runJs(second, agentOf('moving'), '1')
    assert.equal(await waitFor(() => (
      existsSync(second.cacheFile) && cacheOf(second).browser.tools.js === NEW.js
    )), true)
    // The server goes back to OLD; changed args force a reconnect for the next call.
    writeDocs(OLD)
    const args = [FAKE_SERVER, 'ok', join(second.home, 'server.log'), 'SECRET-ARG', 'again']
    writeCodexHome(second.codexHome, args)
    await runJs(second, agentOf('moving'), '2')
    assert.equal(await waitFor(() => (
      existsSync(second.cacheFile) && cacheOf(second).browser.tools.js === OLD.js
    )), true)
    // A new agent must not receive the stale NEW docs as a "docs changed" note.
    const result = await runJs(second, agentOf('fresh-agent'), '3')
    assert.equal(result.includes(NEW.js), false)
    assert.equal(result.includes(NOTE_ZH), false)
  } finally {
    second.restore()
    clearDocs()
  }
})

test('prefetch failure leaves every tool registered and later calls connect', async () => {
  setDocs(OLD)
  const context = setup({ prefetch: true, mode: 'init-error' })
  try {
    assert.equal(await waitFor(() => existsSync(context.logFile)
      && readFileSync(context.logFile, 'utf8').includes('server docs prefetch failed')), true)
    assert.equal(context.plugin.tools.size, 9)
    assert.equal(existsSync(context.cacheFile), false)
  } finally {
    context.restore()
  }
  const healthy = setup({ prefetch: true })
  try {
    await waitCache(healthy)
    const result = await runJs(healthy, agentOf('after-failure'))
    assert.match(result, /ran js/)
  } finally {
    healthy.restore()
    clearDocs()
  }
})

test('a server that exits at startup only fails the prefetch', async () => {
  setDocs(OLD)
  const context = setup({ prefetch: true, mode: 'init-exit' })
  try {
    assert.equal(await waitFor(() => existsSync(context.logFile)
      && readFileSync(context.logFile, 'utf8').includes('server docs prefetch failed')), true)
    assert.equal(context.plugin.tools.size, 9)
    assert.equal(existsSync(context.cacheFile), false)
  } finally {
    context.restore()
    clearDocs()
  }
})

test('unloading during the prefetch handshake stops the process', async () => {
  setDocs(OLD)
  const context = setup({ prefetch: true, mode: 'init-delay' })
  try {
    // Wait for the handshake to actually arrive: the pid is written at startup, and a
    // dispose racing ahead of `initialize` would test something else.
    assert.equal(await waitFor(() => existsSync(context.serverLog)
      && /^pid \d+$/m.test(readFileSync(context.serverLog, 'utf8'))
      && /^initialize$/m.test(readFileSync(context.serverLog, 'utf8'))), true)
    const pid = Number(readFileSync(context.serverLog, 'utf8').match(/^pid (\d+)$/m)[1])
    context.plugin.dispose()
    // The unload must stop the process that was still handshaking and never cache its docs.
    assert.equal(await waitForProcessExit(pid), true)
    await new Promise((done) => setTimeout(done, 700))
    const lines = readFileSync(context.serverLog, 'utf8').split('\n')
    assert.equal(lines.filter((line) => line === 'initialize').length, 1)
    assert.equal(existsSync(context.cacheFile), false)
  } finally {
    context.restore()
  }
  // A prefetch that was still queued must not start a process after the unload either.
  const early = setup({ prefetch: true, mode: 'init-delay' })
  try {
    early.plugin.dispose()
    await new Promise((done) => setTimeout(done, 700))
    assert.equal(/^pid \d+$/m.test(readFileSync(early.serverLog, 'utf8')), false)
    assert.equal(existsSync(early.cacheFile), false)
  } finally {
    early.restore()
    clearDocs()
  }
})

test('unloading before the prefetch runs starts no process', async () => {
  setDocs(OLD)
  const context = setup({ prefetch: true })
  try {
    context.plugin.dispose()
    await new Promise((done) => setTimeout(done, 300))
    assert.equal(existsSync(context.cacheFile), false)
    assert.deepEqual(serverMethods(context), [])
  } finally {
    context.restore()
    clearDocs()
  }
})

test('tools/list pagination is merged and more than ten pages is refused', async () => {
  setDocs({ ...OLD, pages: 2 })
  const paged = setup({ prefetch: true })
  try {
    await waitCache(paged)
    const entry = cacheOf(paged).browser
    assert.equal(countMethod(paged, 'tools/list'), 2)
    assert.equal(entry.toolNames.includes('get_browser'), true)
    assert.equal(entry.toolNames.length, 5)
  } finally {
    paged.restore()
  }
  setDocs({ ...OLD, pages: 11 })
  const tooMany = setup({ prefetch: true })
  try {
    await new Promise((done) => setTimeout(done, 600))
    assert.equal(existsSync(tooMany.cacheFile), false)
    const result = await runJs(tooMany, agentOf('pages'))
    assert.match(result, /ran js/)
    const status = await statusOf(tooMany)
    assert.equal(status.browser.lastError, 'server docs fetch failed')
  } finally {
    tooMany.restore()
    clearDocs()
  }
})

test('without a js description no cache is written and the tools still work', async () => {
  setDocs({ ...OLD, noJs: true })
  const context = setup({ prefetch: true })
  try {
    await new Promise((done) => setTimeout(done, 500))
    assert.equal(existsSync(context.cacheFile), false)
    assert.equal(context.plugin.tools.get('pc_codex_js').description, BROWSER_JS_DESCRIPTION)
    assert.match(await runJs(context, agentOf('no-js')), /ran js/)
  } finally {
    context.restore()
    clearDocs()
  }
})

test('pc_status reports sources, hashes, stale and no command or argument leaks', async () => {
  setDocs(OLD)
  const fresh = setup()
  try {
    const before = await statusOf(fresh)
    assert.equal(before.prefetch, false)
    assert.equal(before.browser.registered, 'built-in')
    assert.equal(before.browser.registeredHash, null)
    assert.equal(before.browser.serverHash, null)
    assert.equal(before.browser.listHash, null)
    assert.deepEqual(before.browser.toolNames, [])
    assert.equal(before.browser.stale, null)
    assert.equal(before.browser.lastError, null)
    await runJs(fresh, agentOf('status'))
    assert.equal(await waitFor(async () => (
      (await statusOf(fresh)).browser.serverHash !== null
    )), true)
    const connected = await statusOf(fresh)
    assert.equal(connected.browser.serverHash.length, 12)
    assert.equal(connected.browser.stale, true)
    assert.equal(connected.browser.toolNames.includes('js'), true)
    assert.equal(connected.browser.lastError, null)
    const text = JSON.stringify(connected)
    assert.equal(text.includes(process.execPath), false)
    assert.equal(text.includes('SECRET-ARG'), false)
    // No connection yet after a restart: registered server-cache, no server hashes, stale null.
    await waitCache(fresh)
  } finally {
    fresh.restore()
  }
  const restarted = setup({ home: fresh.home })
  try {
    const cached = await statusOf(restarted)
    assert.equal(cached.browser.registered, 'server-cache')
    assert.equal(cached.browser.registeredHash.length, 12)
    assert.equal(cached.browser.serverHash, null)
    assert.equal(cached.browser.stale, null)
    await runJs(restarted, agentOf('status-2'))
    assert.equal(await waitFor(async () => (
      (await statusOf(restarted)).browser.serverHash !== null
    )), true)
    assert.equal((await statusOf(restarted)).browser.stale, false)
  } finally {
    restarted.restore()
    clearDocs()
  }
})

test('an unwritable cache directory is reported through lastError only', async () => {
  setDocs(OLD)
  const home = tempDir('pc-use-server-docs-')
  writeFileSync(join(home, '.dsh'), 'not a directory')
  const context = setup({ home, prefetch: true })
  try {
    assert.equal(await waitFor(async () => {
      const status = await statusOf(context)
      return typeof status.browser.lastError === 'string'
    }), true)
    const status = await statusOf(context)
    assert.match(status.browser.lastError, /^cache write failed: /)
    assert.equal(status.browser.lastError.includes(process.execPath), false)
    assert.equal(status.browser.lastError.includes('SECRET-ARG'), false)
  } finally {
    context.restore()
    clearDocs()
  }
})
