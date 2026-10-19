// Tab guard: browser cua_repl programs only see tabs opened by createBrowserTab.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { startServers, stopServers } from './fixtures/server-harness.mjs'

const CUA_SERVER = fileURLToPath(new URL('./fixtures/fake-cua-server.mjs', import.meta.url))

function browserContext(mode = 'ok') {
  return startServers({
    browser: { server: CUA_SERVER, mode },
    desktop: false,
    config: { computer: false },
  })
}

function runJs(context, code) {
  return context.plugin.tools.get('pc_codex_js').execute({ code, title: 'tab guard' }, {})
}

function listOptions(context) {
  return readFileSync(context.logs.browser, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'listTabs')
}

test('createBrowserTab then listTabs with emit:false lists only the own tab', async () => {
  const context = browserContext()
  try {
    const value = await runJs(context, `
      const tab = await cua.createBrowserTab('chrome', 'https://own.invalid/1');
      const tabs = await cua.listTabs({ emit: false });
      nodeRepl.write(JSON.stringify(tabs));
    `)
    assert.match(value, /tab-1/)
    assert.doesNotMatch(value, /FOREIGN/)
    assert.equal(listOptions(context).at(-1).options.emit, false)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('listTabs without arguments prints only the own tab and forces emit:false', async () => {
  const context = browserContext()
  try {
    const value = await runJs(context, `
      await cua.createBrowserTab('chrome', 'https://own.invalid/2');
      await cua.listTabs();
    `)
    assert.match(value, /tab-1/)
    assert.doesNotMatch(value, /FOREIGN/)
    assert.equal(listOptions(context).at(-1).options.emit, false)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('listTabs before any create returns an empty array', async () => {
  const context = browserContext()
  try {
    const value = await runJs(context,
      'nodeRepl.write(JSON.stringify(await cua.listTabs({ emit: false })));')
    assert.equal(value.trim(), '[]')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('the guard is installed once and does not re-wrap functions per call', async () => {
  const context = browserContext()
  try {
    await runJs(context, `
      await cua.createBrowserTab('chrome', 'https://own.invalid/once');
      await cua.listTabs({ emit: false });
      globalThis.firstTabs = cua.listTabs;
    `)
    const value = await runJs(context,
      'nodeRepl.write(String(globalThis.firstTabs === cua.listTabs));')
    assert.match(value, /true/)
    const entries = readFileSync(context.logs.browser, 'utf8').split('\n')
      .filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
    assert.equal(entries.filter((entry) => entry.type === 'createBrowserTab').length, 1)
    assert.equal(entries.filter((entry) => entry.type === 'listTabs').length, 1)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('reset clears the remembered tab ids and installs a fresh guard', async () => {
  const context = browserContext()
  try {
    const before = await runJs(context,
      "nodeRepl.write(String((await cua.createBrowserTab('chrome', 'https://own.invalid/3')).id));")
    assert.match(before, /tab-1/)
    await context.plugin.tools.get('pc_codex_js_reset').execute({}, {})
    const after = await runJs(context,
      'nodeRepl.write(JSON.stringify(await cua.listTabs({ emit: false })));')
    assert.equal(after.trim(), '[]')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('model code can declare const tab twice without a guard redeclaration', async () => {
  const context = browserContext()
  try {
    const code = "const tab = await cua.createBrowserTab('chrome', 'https://own.invalid/4'); "
      + 'nodeRepl.write(tab.id);'
    assert.match(await runJs(context, code), /tab-1/)
    assert.match(await runJs(context, code), /tab-2/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('run_plan browser steps and checks, and observe, all carry the guard', async () => {
  const context = browserContext()
  try {
    await context.plugin.tools.get('pc_codex_run_plan').execute({
      target: 'browser',
      steps: [{ title: 'one', code: '1', check: 'true' }],
      // The guard must also precede this separate check call.
      observe: { subject: 'tab' },
    }, {})
    await context.plugin.tools.get('pc_codex_observe').execute({
      target: 'browser', subject: 'tab',
    }, {})
    const calls = context.browserCalls().map((call) => call.arguments.code)
    assert.equal(calls.length >= 4, true)
    for (const code of calls) assert.match(code, /dsh-pc-use\.tabGuard/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('desktop js calls do not carry the browser guard', async () => {
  const context = startServers({
    browser: false,
    desktop: { server: CUA_SERVER, mode: 'ok' },
    config: { computer: true },
  })
  try {
    await context.plugin.tools.get('pc_codex_desktop_js').execute({ code: '1', title: 'x' }, {})
    const code = context.desktopCalls()[0].arguments.code
    assert.equal(code.includes('dsh-pc-use.tabGuard'), false)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a listTabs error is propagated unchanged', async () => {
  const context = browserContext('throw-list')
  try {
    await assert.rejects(
      runJs(context, 'await cua.listTabs();'),
      /listTabs boom/,
    )
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('replacing globalThis.cua keeps recorded ids and wraps the new object', async () => {
  const context = browserContext()
  try {
    const created = await runJs(context,
      "nodeRepl.write(String((await cua.createBrowserTab("
      + "'chrome', 'https://own.invalid/replace')).id));")
    assert.match(created, /tab-1/)
    await runJs(context, 'globalThis.cua = makeCua();')
    const value = await runJs(context,
      'nodeRepl.write(JSON.stringify(await cua.listTabs({ emit: false })));')
    assert.match(value, /tab-1/)
    assert.doesNotMatch(value, /FOREIGN/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a missing cua is a no-op and the next call installs the guard', async () => {
  const context = browserContext('no-cua')
  try {
    const first = await runJs(context, 'nodeRepl.write("ok");')
    assert.equal(first.trim(), 'ok')
    const second = await runJs(context, `
      await cua.createBrowserTab('chrome', 'https://own.invalid/no-cua');
      nodeRepl.write(JSON.stringify(await cua.listTabs({ emit: false })));
    `)
    assert.match(second, /tab-1/)
    assert.doesNotMatch(second, /FOREIGN/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('listTabs preserves caller options while forcing emit:false', async () => {
  const context = browserContext()
  try {
    await runJs(context, `
      await cua.createBrowserTab('chrome', 'https://own.invalid/options');
      await cua.listTabs({ emit: false, probeOption: 7 });
    `)
    const options = listOptions(context).at(-1).options
    assert.equal(options.emit, false)
    assert.equal(options.probeOption, 7)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a created tab without an id does not match an external id-less tab', async () => {
  const context = browserContext('no-id-tab')
  try {
    const value = await runJs(context, `
      await cua.createBrowserTab('chrome', 'https://own.invalid/no-id');
      nodeRepl.write(JSON.stringify(await cua.listTabs({ emit: false })));
    `)
    assert.equal(value.trim(), '[]')
    assert.doesNotMatch(value, /FOREIGN/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('the browser description documents the guarded listTabs and bypass warning', async () => {
  const context = browserContext()
  try {
    const description = context.plugin.tools.get('pc_codex_js').description
    assert.match(description, /`cua\.listTabs\(\)` returns only plugin tabs/)
    assert.match(description, /other user tabs are filtered out/)
    assert.match(description, /check your own tab by id/)
    assert.match(description, /`browser\.user\.openTabs\(\)`/)
    assert.match(description, /`claimTab`, `getTabContext` and `browser\.history\(\)`/)
    assert.match(description, /blocked by default by the `allowUserTabs` setting/)
    assert.match(description, /globalThis\.tab = await cua\.createBrowserTab/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
