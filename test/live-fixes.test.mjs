// Live-fix coverage: null desktop accessibility tree, screenshot fallback guidance,
// fixed-marker false positives, and the updated tool descriptions.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin } from './helpers.mjs'
import { startServers, stopServers } from './fixtures/server-harness.mjs'

const LIVE_SERVER = fileURLToPath(
  new URL('./fixtures/fake-live-server.mjs', import.meta.url),
)

function liveContext(mode, language = 'zh') {
  return startServers({
    browser: false,
    desktop: { server: LIVE_SERVER, mode },
    config: { computer: true, language },
  })
}

async function observe(context, args) {
  return context.plugin.tools.get('pc_codex_observe').execute({
    target: 'desktop', subject: 'targetWindow', ...args,
  }, {})
}

test('desktop observe with no tree adds the no-screenshot note', async () => {
  for (const [language, phrase] of [
    ['zh', /没有返回无障碍树/],
    ['en', /returned no accessibility tree/],
  ]) {
    const context = liveContext('no-tree', language)
    try {
      const value = await observe(context)
      assert.equal(value.includes('\u0000pc-no-tree'), false)
      assert.match(value, /\[no accessibility tree for this window\]/)
      assert.match(value, phrase)
      assert.match(value, /screenshot: true/)
      assert.match(value, /run_plan/)
    } finally {
      assert.equal(await stopServers(context), true)
    }
  }
})

test('desktop observe with no tree and a screenshot uses the screenshot note', async () => {
  for (const [language, phrase] of [
    ['zh', /本次附带的截图/],
    ['en', /screenshot included in this result/],
  ]) {
    const context = liveContext('no-tree', language)
    try {
      const value = await observe(context, { screenshot: true })
      assert.match(value, phrase)
      assert.doesNotMatch(value, /screenshot: true/)
    } finally {
      assert.equal(await stopServers(context), true)
    }
  }
})

test('an existing accessibility tree gets no no-tree note', async () => {
  const context = liveContext('tree')
  try {
    const value = await observe(context)
    assert.match(value, /TREE/)
    assert.doesNotMatch(value, /没有返回无障碍树/)
    assert.doesNotMatch(value, /returned no accessibility tree/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a fake no-tree marker inside the tree does not trigger the note', async () => {
  const context = liveContext('tree-fake-marker')
  try {
    const value = await observe(context)
    assert.equal(value.includes('\u0000pc-no-tree:fake\u0000'), true)
    assert.doesNotMatch(value, /没有返回无障碍树/)
    assert.doesNotMatch(value, /returned no accessibility tree/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('two no-tree observations use different markers', async () => {
  const context = liveContext('no-tree')
  try {
    await observe(context)
    await observe(context)
    const markers = context.desktopCalls()
      .map((call) => /pc-no-tree:([0-9a-f-]+)/.exec(call.arguments.code))
      .filter(Boolean)
      .map((match) => match[1])
    assert.equal(markers.length, 2)
    assert.notEqual(markers[0], markers[1])
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('text: false suppresses both the marker and the no-tree note', async () => {
  const context = liveContext('no-tree')
  try {
    const value = await observe(context, { text: false })
    assert.equal(value.includes('pc-no-tree'), false)
    assert.equal(value.includes('[no accessibility tree for this window]'), false)
    assert.doesNotMatch(value, /没有返回无障碍树/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('an isError observation replaces the marker and adds the note', async () => {
  const context = liveContext('no-tree-error')
  try {
    await assert.rejects(
      observe(context),
      (error) => {
        assert.equal(error.message.includes('\u0000pc-no-tree'), false)
        assert.match(error.message, /\[no accessibility tree for this window\]/)
        assert.match(error.message, /没有返回无障碍树/)
        return true
      },
    )
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('run_plan desktop observe with no tree also adds the note', async () => {
  const context = liveContext('no-tree')
  try {
    const value = await context.plugin.tools.get('pc_codex_run_plan').execute({
      target: 'desktop',
      steps: [{ title: 'noop', code: '1' }],
      observe: { subject: 'targetWindow' },
    }, {})
    assert.match(value, /没有返回无障碍树/)
    assert.match(value, /run_plan/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a fixed marker from model code does not append the note', async () => {
  const context = liveContext('plain-marker')
  try {
    const value = await context.plugin.tools.get('pc_codex_desktop_js')
      .execute({ code: 'plain', title: 'plain' }, {})
    assert.match(value, /\[no accessibility tree for this window\]/)
    assert.doesNotMatch(value, /没有返回无障碍树/)
    assert.doesNotMatch(value, /returned no accessibility tree/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('tool descriptions carry the live-fix guidance', () => {
  const plugin = registerPlugin({ computer: true, language: 'zh' })
  try {
    const browser = plugin.tools.get('pc_codex_js').description
    assert.match(browser, /getAXState\(\{ emit: false \}\)/)
    assert.match(browser, /globalThis/)
    assert.match(browser, /listTabs/)
    assert.match(browser, /do not need `pc_codex_docs`/)
    assert.match(browser, /`cua\.listTabs\(\)` returns only plugin tabs/)
    assert.match(browser, /other user tabs are filtered out/)
    assert.match(browser, /`browser\.user\.openTabs\(\)`/)
    assert.match(browser, /`claimTab`, `getTabContext` and `browser\.history\(\)`/)
    assert.match(browser, /blocked by default by the `allowUserTabs` setting/)
    assert.match(browser, /only with that switch on can you access user tabs/)
    assert.match(browser, /`cua\.getTab\(\.\.\.\)` only accepts ids of plugin tabs/)
    assert.match(browser, /`cua\.getState\(\)` lists only plugin tabs/)
    assert.match(browser, /`browser\.tabs\.get` and `browser\.tabs\.content` follow the same rule/)
    assert.match(browser,
      /`browser\.tabs\.list` and `browser\.tabs\.selected` cover only plugin tabs/)
    assert.match(browser, /check your own tab by id/)
    assert.match(browser, /globalThis\.tab = await cua\.createBrowserTab/)
    for (const name of ['pc_codex_desktop_js', 'pc_codex_observe']) {
      const description = plugin.tools.get(name).description
      assert.match(description, /accessibility: null/)
      assert.match(description, /include_text: true/)
      assert.match(description, /Do not read logs or configuration files/)
      assert.match(description, /stop and tell the user/)
    }
    const plan = plugin.tools.get('pc_codex_run_plan').description
    assert.match(plan, /do not use checks to read UI values/)
    assert.match(plan, /screenshot/)
  } finally {
    plugin.dispose()
  }
})
