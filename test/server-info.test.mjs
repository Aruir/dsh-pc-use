// r30: pc_status reports the MCP initialize serverInfo of each connected server and the
// version directory baked into the browser source path.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  registerPlugin, tempDir, useHome, waitFor, writeCodexHome,
} from './helpers.mjs'
import {
  BROWSER_ENV, DESKTOP_ENV, UNIFIED_VERSION, isRunning, startServers, stopServers,
} from './fixtures/server-harness.mjs'

/** The fixture env plus one fake initialize serverInfo. O(1). */
function withInfo(base, value) {
  return { ...base, FAKE_SERVER_INFO: JSON.stringify(value) }
}

/** The `providers.codex` section of pc_status. O(1) plus the call. */
async function statusOf(context) {
  const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
  return status.providers.codex
}

async function connectBoth(context) {
  await context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'b' }, {})
  await context.plugin.tools.get('pc_codex_desktop_js').execute({ code: '1', title: 'd' }, {})
}

test('both servers report the serverInfo from their initialize result', async () => {
  const context = startServers({
    browser: { env: withInfo(BROWSER_ENV, { name: 'b-srv', version: '1.2.3' }) },
    desktop: { env: withInfo(DESKTOP_ENV, { name: 'd-srv', version: '4.5.6' }) },
    config: { computer: true },
  })
  try {
    await connectBoth(context)
    const codex = await statusOf(context)
    assert.deepEqual(codex.browser.serverInfo, { name: 'b-srv', version: '1.2.3' })
    assert.deepEqual(codex.desktop.serverInfo, { name: 'd-srv', version: '4.5.6' })
    assert.equal(codex.browser.pluginVersion, UNIFIED_VERSION)
    assert.equal(codex.desktop.pluginVersion, null)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('an unusable serverInfo is null', async () => {
  const cases = [
    ['null serverInfo', null],
    ['missing name', { version: '1.0' }],
    ['missing version', { name: 'x' }],
    ['non-string version', { name: 'x', version: 3 }],
    ['empty name', { name: '', version: '1.0' }],
  ]
  for (const [label, value] of cases) {
    const context = startServers({ browser: { env: withInfo(BROWSER_ENV, value) } })
    try {
      await context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'b' }, {})
      assert.equal((await statusOf(context)).browser.serverInfo, null, label)
    } finally {
      assert.equal(await stopServers(context), true)
    }
  }
})

test('serverInfo keeps only name and version and caps each value at 200 characters', async () => {
  const longName = 'n'.repeat(250)
  const longVersion = 'v'.repeat(250)
  const context = startServers({
    browser: {
      env: withInfo(BROWSER_ENV, {
        name: longName, version: longVersion, title: 'extra', other: { deep: true },
      }),
    },
  })
  try {
    await context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'b' }, {})
    const info = (await statusOf(context)).browser.serverInfo
    assert.deepEqual(info, {
      name: longName.slice(0, 200),
      version: longVersion.slice(0, 200),
    })
    assert.deepEqual(Object.keys(info), ['name', 'version'])
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('serverInfo is null before connecting and after the connection is gone', async () => {
  const context = startServers({
    browser: { env: withInfo(BROWSER_ENV, { name: 'gone', version: '1.0' }) },
  })
  try {
    const before = await statusOf(context)
    assert.equal(before.browser.serverInfo, null)
    assert.equal(before.desktop.serverInfo, null)
    assert.equal(before.browser.pluginVersion, UNIFIED_VERSION)
    assert.equal(before.desktop.pluginVersion, null)
    await context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'b' }, {})
    assert.deepEqual((await statusOf(context)).browser.serverInfo, { name: 'gone', version: '1.0' })
    const pid = context.browserStart()[0].pid
    process.kill(pid)
    assert.equal(await waitFor(() => !isRunning(pid)), true)
    // The child exit event may land after the pid disappears; wait for the bridge state.
    assert.equal(await waitFor(async () => (await statusOf(context)).browser.connected
      === false), true)
    const after = await statusOf(context)
    assert.equal(after.browser.serverInfo, null)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a numeric Codex home name is not reported as the desktop plugin version', async () => {
  const home = tempDir('pc-use-info-home-')
  const restore = useHome(home)
  const codexHome = join(home, '2026-codex')
  writeCodexHome(codexHome, [], {}, { desktop: true })
  const plugin = registerPlugin({ codexHome, logFile: join(home, 'bridge.log') })
  try {
    const codex = await statusOf({ plugin })
    assert.equal(codex.desktop.resolved, true)
    assert.equal(codex.desktop.pluginVersion, null)
    assert.equal(codex.browser.pluginVersion, UNIFIED_VERSION)
  } finally {
    plugin.dispose()
    restore()
  }
})

test('pluginVersion is null when the source does not resolve', async () => {
  const context = startServers({ browser: false, desktop: false })
  try {
    const codex = await statusOf(context)
    assert.equal(codex.browser.pluginVersion, null)
    assert.equal(codex.desktop.pluginVersion, null)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
