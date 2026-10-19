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
  + '`browser.history()` are blocked by default by the `allowUserTabs` setting; with that '
  + 'switch on, use them only when the user explicitly asks.'

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
  return readFileSync(context.logs.browser, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'userMethod')
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
    const value = await runJs(context, `
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
`)
    const result = JSON.parse(value.trim())
    for (const name of ['get', 'getDefault', 'getForUrl']) {
      assert.equal(result[name].includes('browser.user.openTabs()'), true, name)
      assert.equal(result[name].includes('allowUserTabs'), true, name)
    }
    assert.equal(userCalls(context).length, 0)
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
  } finally {
    plugin.dispose()
  }
})
