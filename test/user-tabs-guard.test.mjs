// User-tabs guard: a Browser obtained through cua.getBrowser or cua.browsers.* blocks
// browser.user.openTabs/claimTab/getTabContext and browser.history while allowUserTabs is
// off, and passes the original calls through when it is on. The switch is read per call, so
// it stays hot-switchable inside one persistent REPL.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin } from './helpers.mjs'
import { startServers, stopServers } from './fixtures/server-harness.mjs'

const CUA_SERVER = fileURLToPath(new URL('./fixtures/fake-cua-server.mjs', import.meta.url))
const WRITE = Symbol.for('cosmokit.volatile.write')

const USER_TABS_RULE = '`browser.user.openTabs()`, `claimTab`, `getTabContext` and '
  + '`browser.history()` are blocked by default by the `allowUserTabs` setting; only with '
  + 'that switch on can you access the user\'s own tabs, and then only when the user '
  + 'explicitly asks.'

function createVolatile(value) {
  let current = value
  return Object.freeze({
    get: () => current,
    [WRITE](next) { current = next },
  })
}

function browserContext(mode = 'ok', config = {}) {
  return startServers({
    browser: { server: CUA_SERVER, mode },
    desktop: false,
    config: { computer: false, ...config },
  })
}

function runJs(context, code) {
  return context.plugin.tools.get('pc_codex_js').execute({ code, title: 'user tabs' }, {})
}

function userCalls(context) {
  return browserRecords(context, 'userMethod')
}

function browserRecords(context, type) {
  return readFileSync(context.logs.browser, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === type)
}

/** Reads of the guarded methods recorded by the membrane fixture. O(n), n = log lines. */
function guardedMethodReads(context) {
  const names = ['openTabs', 'claimTab', 'getTabContext', 'history']
  return browserRecords(context, 'membraneGet').filter((entry) => names.includes(entry.key))
}

function methodCounts(context, method) {
  return userCalls(context).filter((entry) => entry.method === method).length
}

const TRY_ALL = `
{
  const browser = await cua.getBrowser('chrome');
  const attempts = {
    openTabs: () => browser.user.openTabs(),
    claimTab: () => browser.user.claimTab('user-tab-1'),
    getTabContext: () => browser.user.getTabContext('user-tab-1'),
    history: () => browser.history(),
  };
  const result = {};
  for (const [name, call] of Object.entries(attempts)) {
    try {
      result[name] = { ok: true, value: await call() };
    } catch (error) {
      result[name] = { ok: false, error: String(error.message) };
    }
  }
  nodeRepl.write(JSON.stringify(result));
}
`

const ALLOWED = `
{
  const browser = await cua.getBrowser('chrome');
  const tabs = await browser.user.openTabs();
  const context = await browser.user.getTabContext('user-tab-1');
  const claimed = await browser.user.claimTab('user-tab-1');
  const entries = await browser.history({ max: 5 });
  nodeRepl.write(JSON.stringify({ tabs, context, claimed, entries }));
}
`

const BLOCKED_LABELS = {
  openTabs: 'browser.user.openTabs()',
  claimTab: 'browser.user.claimTab()',
  getTabContext: 'browser.user.getTabContext()',
  history: 'browser.history()',
}

async function assertAllBlocked(context) {
  const value = await runJs(context, TRY_ALL)
  const result = JSON.parse(value.trim())
  for (const [method, label] of Object.entries(BLOCKED_LABELS)) {
    assert.equal(result[method].ok, false, `${method} must be blocked`)
    assert.equal(result[method].error.includes(label), true, `${method} names the method`)
    assert.equal(result[method].error.includes('allowUserTabs'), true,
      `${method} names the setting`)
  }
  assert.equal(userCalls(context).length, 0)
  assert.doesNotMatch(value, /USER-TAB|user\.invalid|history\.invalid/)
}

const BROWSERS_ENTRANCES = `
{
  const result = {};
  for (const [name, get] of [
    ['get', () => cua.browsers.get('chrome')],
    ['getDefault', () => cua.browsers.getDefault()],
    ['getForUrl', () => cua.browsers.getForUrl('https://example.invalid/')],
  ]) {
    try {
      const browser = await get();
      result[name] = await browser.user.openTabs();
    } catch (error) {
      result[name] = String(error.message);
    }
  }
  nodeRepl.write(JSON.stringify(result));
}
`

async function assertBrowsersEntrancesBlocked(context) {
  const value = await runJs(context, BROWSERS_ENTRANCES)
  const result = JSON.parse(value.trim())
  for (const name of ['get', 'getDefault', 'getForUrl']) {
    assert.equal(result[name].includes('browser.user.openTabs()'), true, name)
    assert.equal(result[name].includes('allowUserTabs'), true, name)
  }
  assert.equal(userCalls(context).length, 0)
}

test('default off blocks all four user-tab methods without calling them', async () => {
  const context = browserContext()
  try {
    await assertAllBlocked(context)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('the switch on passes all four methods through to the original data', async () => {
  const context = browserContext('ok', { allowUserTabs: true })
  try {
    const value = await runJs(context, ALLOWED)
    assert.match(value, /USER-TAB-TITLE-1/)
    assert.match(value, /USER-TAB-TEXT-1/)
    assert.match(value, /user\.invalid/)
    assert.match(value, /claimed-1/)
    assert.match(value, /history\.invalid/)
    for (const method of Object.keys(BLOCKED_LABELS)) {
      assert.equal(methodCounts(context, method), 1, `${method} must run exactly once`)
    }
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('off/on/off takes effect on the same REPL without a reset', async () => {
  const allowUserTabs = createVolatile(false)
  const context = browserContext('ok', { allowUserTabs })
  const blocked = 'await (await cua.getBrowser("chrome")).user.openTabs();'
  const allowed = 'nodeRepl.write(JSON.stringify(await (await cua.getBrowser("chrome"))'
    + '.user.openTabs()));'
  try {
    await assert.rejects(runJs(context, blocked), /allowUserTabs/)
    allowUserTabs[WRITE](true)
    assert.match(await runJs(context, allowed), /USER-TAB-TITLE-1/)
    allowUserTabs[WRITE](false)
    await assert.rejects(runJs(context, blocked), /allowUserTabs/)
    assert.equal(methodCounts(context, 'openTabs'), 1)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('Browsers.get, getDefault and getForUrl browsers are blocked too', async () => {
  const context = browserContext()
  try {
    await assertBrowsersEntrancesBlocked(context)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('cua.browsers feature detection sees the three entrances', async () => {
  const context = browserContext()
  try {
    const value = await runJs(context, `
nodeRepl.write(JSON.stringify({
  get: 'get' in cua.browsers,
  getDefault: 'getDefault' in cua.browsers,
  getForUrl: 'getForUrl' in cua.browsers,
  missing: 'missing' in cua.browsers,
}));
`)
    assert.deepEqual(JSON.parse(value.trim()), {
      get: true, getDefault: true, getForUrl: true, missing: false,
    })
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

for (const mode of ['ok', 'own-methods']) {
  test(`prototype and own user methods are both blocked (${mode})`, async () => {
    const context = browserContext(mode)
    try {
      await assertAllBlocked(context)
    } finally {
      assert.equal(await stopServers(context), true)
    }
  })
}

test('own user methods still work when the switch is on', async () => {
  const context = browserContext('own-methods', { allowUserTabs: true })
  try {
    const value = await runJs(context, ALLOWED)
    assert.match(value, /USER-TAB-TITLE-1/)
    assert.match(value, /history\.invalid/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('membrane: cached runtime proxies do not defeat either entrance', async () => {
  const context = browserContext('membrane')
  try {
    await assertAllBlocked(context)
    await assertBrowsersEntrancesBlocked(context)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('membrane: the switch on passes through the runtime proxies', async () => {
  const context = browserContext('membrane', { allowUserTabs: true })
  try {
    const value = await runJs(context, ALLOWED)
    assert.match(value, /USER-TAB-TITLE-1/)
    assert.match(value, /history\.invalid/)
    for (const method of Object.keys(BLOCKED_LABELS)) {
      assert.equal(methodCounts(context, method), 1, `${method} must run exactly once`)
    }
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('membrane: off/on/off still takes effect on the same REPL', async () => {
  const allowUserTabs = createVolatile(false)
  const context = browserContext('membrane', { allowUserTabs })
  const blocked = 'await (await cua.getBrowser("chrome")).user.openTabs();'
  const allowed = 'nodeRepl.write(JSON.stringify(await (await cua.getBrowser("chrome"))'
    + '.user.openTabs()));'
  try {
    await assert.rejects(runJs(context, blocked), /allowUserTabs/)
    allowUserTabs[WRITE](true)
    assert.match(await runJs(context, allowed), /USER-TAB-TITLE-1/)
    allowUserTabs[WRITE](false)
    await assert.rejects(runJs(context, blocked), /allowUserTabs/)
    assert.equal(methodCounts(context, 'openTabs'), 1)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('membrane: the browser and user views keep their identity', async () => {
  const context = browserContext('membrane')
  try {
    const value = await runJs(context, `
{
  const b = await cua.getBrowser('chrome');
  const b2 = await cua.getBrowser('chrome');
  nodeRepl.write(JSON.stringify({
    sameBrowser: b === b2,
    sameUser: b.user === b.user,
    sameOpenTabs: b.user.openTabs === b.user.openTabs,
    sameHistory: b.history === b.history,
  }));
}
`)
    const result = JSON.parse(value.trim())
    assert.deepEqual(result, {
      sameBrowser: true, sameUser: true, sameOpenTabs: true, sameHistory: true,
    })
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('membrane: building the user view does not read the guarded methods', async () => {
  const context = browserContext('membrane')
  try {
    const value = await runJs(context, `
{
  const b = await cua.getBrowser('chrome');
  const user = b.user;
  nodeRepl.write(typeof user.openTabs);
}
`)
    assert.equal(value.trim(), 'function')
    assert.equal(guardedMethodReads(context).length, 0)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('frozen-browser: fixed properties throw the guard error instead of TypeError', async () => {
  const context = browserContext('frozen-browser')
  try {
    const value = await runJs(context, `
{
  const b = await cua.getBrowser('chrome');
  const result = {};
  for (const [name, read] of [['user', () => b.user], ['history', () => b.history]]) {
    try { read(); result[name] = 'no throw' } catch (e) { result[name] = String(e.message) }
  }
  nodeRepl.write(JSON.stringify(result));
}
`)
    const result = JSON.parse(value.trim())
    assert.match(result.user, /dsh-pc-use blocked browser\.user/)
    assert.match(result.history, /dsh-pc-use blocked browser\.history/)
    assert.doesNotMatch(value, /TypeError/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('frozen-browser: the switch on returns the original values', async () => {
  const context = browserContext('frozen-browser', { allowUserTabs: true })
  try {
    const value = await runJs(context, `
{
  const b = await cua.getBrowser('chrome');
  const tabs = await b.user.openTabs();
  const entries = await b.history();
  nodeRepl.write(JSON.stringify({ tabs, entries }));
}
`)
    assert.match(value, /USER-TAB-TITLE-1/)
    assert.match(value, /history\.invalid/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('frozen-user: fixed methods throw the guard error or pass through', async () => {
  const offContext = browserContext('frozen-user')
  try {
    const value = await runJs(offContext, `
{
  const b = await cua.getBrowser('chrome');
  try { b.user.openTabs(); nodeRepl.write('no throw') }
  catch (e) { nodeRepl.write(String(e.message)) }
}
`)
    assert.match(value, /dsh-pc-use blocked browser\.user\.openTabs/)
    assert.doesNotMatch(value, /TypeError/)
  } finally {
    assert.equal(await stopServers(offContext), true)
  }
  const onContext = browserContext('frozen-user', { allowUserTabs: true })
  try {
    const value = await runJs(onContext, `
{
  const b = await cua.getBrowser('chrome');
  nodeRepl.write(JSON.stringify(await b.user.openTabs()));
}
`)
    assert.match(value, /USER-TAB-TITLE-1/)
  } finally {
    assert.equal(await stopServers(onContext), true)
  }
})

test('an accessor cua.browsers is wrapped on every read', async () => {
  const context = browserContext('browsers-accessor')
  try {
    const value = await runJs(context, `
{
  const result = {};
  for (const [name, get] of [
    ['getDefault', () => cua.browsers.getDefault()],
    ['getForUrl', () => cua.browsers.getForUrl('https://example.invalid/')],
  ]) {
    try {
      const browser = await get();
      result[name] = await browser.user.openTabs();
    } catch (error) {
      result[name] = String(error.message);
    }
  }
  nodeRepl.write(JSON.stringify(result));
}
`)
    const result = JSON.parse(value.trim())
    for (const name of ['getDefault', 'getForUrl']) {
      assert.equal(result[name].includes('browser.user.openTabs()'), true, name)
    }
    assert.equal(browserRecords(context, 'browsersAccessor').length >= 2, true)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('cua.getTab only accepts this session\'s ids while off', async () => {
  const context = browserContext('ok')
  try {
    const value = await runJs(context, `
{
  const own = await cua.createBrowserTab('chrome', 'https://own.invalid/get');
  const out = { ownId: own.id };
  for (const [name, arg] of [
    ['foreign', 'FOREIGN-1'],
    ['url', { url: 'https://foreign.invalid/1' }],
    ['mention', { mention: 'x' }],
    ['missing', undefined],
    ['own', own.id],
  ]) {
    try { const tab = await cua.getTab(arg); out[name] = tab?.id ?? null }
    catch (error) { out[name] = 'blocked' }
  }
  nodeRepl.write(JSON.stringify(out));
}
`)
    const result = JSON.parse(value.trim())
    for (const name of ['foreign', 'url', 'mention', 'missing']) {
      assert.equal(result[name], 'blocked', name)
    }
    assert.equal(result.own, result.ownId)
    assert.equal(browserRecords(context, 'getTab').length, 1)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('cua.getTab on lets a foreign tab into the session tab set', async () => {
  const context = browserContext('ok', { allowUserTabs: true })
  try {
    const value = await runJs(context, `
{
  const tab = await cua.getTab('FOREIGN-1');
  const list = await cua.listTabs({ emit: false });
  nodeRepl.write(JSON.stringify({ id: tab.id, ids: list.map((item) => item.id) }));
}
`)
    const result = JSON.parse(value.trim())
    assert.equal(result.id, 'FOREIGN-1')
    assert.equal(result.ids.includes('FOREIGN-1'), true)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('cua.getState off filters tabs in the return value and the output', async () => {
  const context = browserContext('ok')
  try {
    const value = await runJs(context, `
{
  const own = await cua.createBrowserTab('chrome', 'https://own.invalid/state');
  const state = await cua.getState();
  const ids = state.browsers[0].tabs.map((tab) => tab.id);
  nodeRepl.write(JSON.stringify({ ownId: own.id, ids }));
}
`)
    assert.doesNotMatch(value, /FOREIGN-TITLE|foreign\.invalid/)
    assert.match(value, /\n2 user tabs hidden because allowUserTabs is off/)
    const marker = value.split('\n').find((line) => line.startsWith('{"ownId"'))
    const result = JSON.parse(marker)
    assert.deepEqual(result.ids, [result.ownId])
    const calls = browserRecords(context, 'getState')
    assert.equal(calls.at(-1).options.emit, false)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('cua.getState off with emit:false produces no output and filters the result', async () => {
  const context = browserContext('ok')
  try {
    const value = await runJs(context, `
{
  const state = await cua.getState({ emit: false });
  if (state.browsers[0].tabs.some((tab) => tab.id === 'FOREIGN-1')) {
    throw new Error('unfiltered state');
  }
}
`)
    assert.equal(value.trim(), '')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('cua.getState on passes the caller options and full state through', async () => {
  const context = browserContext('ok', { allowUserTabs: true })
  try {
    const value = await runJs(context, `
{
  const state = await cua.getState({ includeApps: true });
  const ids = state.browsers[0].tabs.map((tab) => tab.id);
  nodeRepl.write('IDS ' + JSON.stringify(ids));
}
`)
    assert.match(value, /FOREIGN-TITLE-1/)
    assert.match(value, /foreign\.invalid/)
    const line = value.split('\n').find((entry) => entry.startsWith('IDS '))
    assert.equal(JSON.parse(line.slice(4)).includes('FOREIGN-1'), true)
    assert.deepEqual(browserRecords(context, 'getState').at(-1).options,
      { includeApps: true })
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('browser.tabs guards get and content and records new tabs', async () => {
  const context = browserContext('ok')
  try {
    const value = await runJs(context, `
{
  const own = await cua.createBrowserTab('chrome', 'https://own.invalid/tabs');
  const browser = await cua.getBrowser('chrome');
  const out = {};
  for (const [name, call] of [
    ['foreignGet', () => browser.tabs.get('FOREIGN-1')],
    ['foreignContent', () => browser.tabs.content('FOREIGN-1')],
  ]) {
    try { await call(); out[name] = 'NOT BLOCKED' } catch { out[name] = 'blocked' }
  }
  out.ownGet = (await browser.tabs.get(own.id)).id === own.id;
  out.ownContent = await browser.tabs.content(own.id);
  const created = await browser.tabs.new();
  out.newId = created.id;
  out.newGet = (await browser.tabs.get(created.id)).id === created.id;
  const list = await browser.tabs.list();
  out.list = { isArray: Array.isArray(list), count: list.length };
  out.selected = (await browser.tabs.selected()) !== undefined;
  nodeRepl.write(JSON.stringify(out));
}
`)
    const result = JSON.parse(value.trim())
    assert.equal(result.foreignGet, 'blocked')
    assert.equal(result.foreignContent, 'blocked')
    assert.equal(result.ownGet, true)
    assert.equal(result.newGet, true)
    assert.equal(result.list.isArray, true)
    assert.equal(result.list.count, 2)
    assert.equal(result.selected, true)
    assert.equal(browserRecords(context, 'tabsGet').length, 2)
    assert.equal(browserRecords(context, 'tabsContent').length, 1)
    assert.equal(browserRecords(context, 'tabsNew').length, 1)
    assert.equal(browserRecords(context, 'tabsList').length, 1)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('membrane: getTab, getState and tabs.get stay guarded', async () => {
  const context = browserContext('membrane')
  try {
    const value = await runJs(context, `
{
  const browser = await cua.getBrowser('chrome');
  const out = {};
  try { await cua.getTab('FOREIGN-1'); out.getTab = 'NOT BLOCKED' }
  catch { out.getTab = 'blocked' }
  try { await browser.tabs.get('FOREIGN-1'); out.tabsGet = 'NOT BLOCKED' }
  catch { out.tabsGet = 'blocked' }
  const state = await cua.getState({ emit: false });
  out.ids = state.browsers[0].tabs.map((tab) => tab.id);
  nodeRepl.write(JSON.stringify(out));
}
`)
    const result = JSON.parse(value.trim())
    assert.equal(result.getTab, 'blocked')
    assert.equal(result.tabsGet, 'blocked')
    assert.equal(result.ids.includes('FOREIGN-1'), false)
    assert.equal(browserRecords(context, 'getTab').length, 0)
    assert.equal(browserRecords(context, 'tabsGet').length, 0)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('getTab and getState follow the switch on/off/on/off in one REPL', async () => {
  const allowUserTabs = createVolatile(false)
  const context = browserContext('ok', { allowUserTabs })
  const ids = async () => {
    const value = await runJs(context, `
{
  const state = await cua.getState({ emit: false });
  nodeRepl.write(JSON.stringify(state.browsers[0].tabs.map((tab) => tab.id)));
}
`)
    return JSON.parse(value.trim())
  }
  try {
    const url = 'https://example.invalid/hot'
    await assert.rejects(runJs(context, `await cua.getTab({ url: "${url}" });`),
      /allowUserTabs/)
    assert.equal((await ids()).includes('FOREIGN-1'), false)
    allowUserTabs[WRITE](true)
    const allowed = await runJs(context,
      `nodeRepl.write((await cua.getTab({ url: "${url}" })).id);`)
    assert.equal(allowed.trim(), 'url-tab-1')
    assert.equal((await ids()).includes('FOREIGN-1'), true)
    allowUserTabs[WRITE](false)
    await assert.rejects(runJs(context, `await cua.getTab({ url: "${url}" });`),
      /allowUserTabs/)
    assert.equal((await ids()).includes('FOREIGN-1'), false)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

for (const mode of ['ok', 'sync-entrance']) {
  test(`Promise and synchronous entrance results are both blocked (${mode})`, async () => {
    const context = browserContext(mode)
    try {
      await assertAllBlocked(context)
    } finally {
      assert.equal(await stopServers(context), true)
    }
  })
}

test('repeated calls do not layer wrappers, and reset reinstalls the guard', async () => {
  const context = browserContext('ok', { allowUserTabs: true })
  const code = 'await (await cua.getBrowser("chrome")).user.openTabs();'
  try {
    await runJs(context, code)
    await runJs(context, code)
    assert.equal(methodCounts(context, 'openTabs'), 2)
    await context.plugin.tools.get('pc_codex_js_reset').execute({}, {})
    await runJs(context, code)
    assert.equal(methodCounts(context, 'openTabs'), 3)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a successful claimTab lets listTabs return the claimed tab', async () => {
  const context = browserContext('ok', { allowUserTabs: true })
  try {
    const value = await runJs(context, `
{
  const browser = await cua.getBrowser('chrome');
  const claimed = await browser.user.claimTab('user-tab-1');
  const tabs = await cua.listTabs({ emit: false });
  nodeRepl.write(JSON.stringify({ id: claimed.id, tabs }));
}
`)
    const result = JSON.parse(value.trim())
    assert.equal(result.id, 'claimed-1')
    assert.equal(result.tabs.some((tab) => tab.id === 'claimed-1'), true)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a missing cua, getBrowser or browser.user does not throw', async () => {
  for (const mode of ['no-cua', 'no-get-browser']) {
    const context = browserContext(mode)
    try {
      const value = await runJs(context, 'nodeRepl.write("ok");')
      assert.equal(value.trim(), 'ok', mode)
    } finally {
      assert.equal(await stopServers(context), true)
    }
  }
  const context = browserContext('no-user')
  try {
    const value = await runJs(context,
      'const browser = await cua.getBrowser("chrome"); nodeRepl.write(String(browser.user));')
    assert.equal(value.trim(), 'undefined')
    await assert.rejects(
      runJs(context, 'await (await cua.getBrowser("chrome")).history();'),
      /allowUserTabs/,
    )
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('run_plan browser steps and checks, and observe, carry the same guard', async () => {
  const context = browserContext()
  try {
    await assert.rejects(context.plugin.tools.get('pc_codex_run_plan').execute({
      target: 'browser',
      steps: [{
        title: 'blocked',
        code: "await (await cua.getBrowser('chrome')).user.openTabs();",
      }],
    }, {}), /stopped at step 1/)
    await context.plugin.tools.get('pc_codex_run_plan').execute({
      target: 'browser',
      steps: [{ title: 'one', code: '1', check: 'true' }],
      observe: { subject: 'tab' },
    }, {})
    await context.plugin.tools.get('pc_codex_observe').execute({
      target: 'browser', subject: 'tab',
    }, {})
    const codes = context.browserCalls().map((call) => call.arguments.code)
    assert.equal(codes.length >= 4, true)
    for (const code of codes) {
      assert.match(code, /dsh-pc-use\.userTabs\.allowed/)
      assert.match(code, /allowUserTabs/)
    }
    assert.equal(userCalls(context).length, 0)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('desktop calls do not carry the browser user-tabs guard', async () => {
  const context = startServers({
    browser: false,
    desktop: { server: CUA_SERVER, mode: 'ok' },
    config: { computer: true },
  })
  try {
    await context.plugin.tools.get('pc_codex_desktop_js')
      .execute({ code: '1', title: 'x' }, {})
    const code = context.desktopCalls()[0].arguments.code
    assert.equal(code.includes('dsh-pc-use.userTabs'), false)
    assert.equal(code.includes('allowUserTabs'), false)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('the pc_codex_js description states the allowUserTabs rule in full', () => {
  const plugin = registerPlugin({})
  try {
    const description = plugin.tools.get('pc_codex_js').description
    assert.equal(description.includes(USER_TABS_RULE), true)
    assert.match(description,
      /`cua\.getTab\(\.\.\.\)` only accepts ids of tabs this session opened/)
    assert.match(description, /`cua\.getState\(\)` lists only this session's tabs/)
    assert.match(description,
      /`browser\.tabs\.get` and `browser\.tabs\.content` follow the same rule/)
    assert.match(description,
      /`browser\.tabs\.list` and `browser\.tabs\.selected` cover only this session/)
  } finally {
    plugin.dispose()
  }
})
