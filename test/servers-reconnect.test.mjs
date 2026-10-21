// 0.5.0 S7: each server is re-resolved and reconnected on its own; a `codexHome` change
// still drops both servers and fails both tools instead of keeping stale connections.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { stripWallTime, waitFor } from './helpers.mjs'
import { isRunning, startServers, stopServers } from './fixtures/server-harness.mjs'

const WRITE = Symbol.for('cosmokit.volatile.write')

function createVolatile(value) {
  let current = value
  return Object.freeze({
    get: () => current,
    [WRITE](next) {
      current = next
    },
  })
}

async function runBrowser(context) {
  const result = await context.plugin.tools.get('pc_codex_js')
    .execute({ code: '1', title: 'browser' }, {})
  return stripWallTime(result)
}

async function runDesktop(context) {
  const result = await context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '1', title: 'desktop' }, {})
  return stripWallTime(result)
}

function readLog(context) {
  return readFileSync(context.logFile, 'utf8')
}

test('an unreadable desktop config keeps the desktop connection', async () => {
  const context = startServers({ config: { computer: true } })
  try {
    await runDesktop(context)
    const pid = context.desktopStart()[0].pid
    writeFileSync(join(context.codexHome, 'config.toml'), 'this is not a config\n')
    assert.equal(await runDesktop(context), 'ran js')
    assert.equal(context.desktopStart().length, 1)
    assert.equal(isRunning(pid), true)
    assert.match(
      readLog(context),
      /Codex server re-check failed; keeping the current connection/,
    )
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.providers.codex.desktop.connected, true)
    assert.deepEqual(status.providers.codex.desktop.services, ['sky'])
    assert.equal(await stopServers(context), true)
  } finally {
    await stopServers(context)
  }
})

test('codexHome change fails both tools and reports both unresolved', async () => {
  const codexHome = createVolatile('unset')
  const context = startServers({ config: { computer: true, codexHome } })
  try {
    codexHome[WRITE](context.codexHome)
    await runBrowser(context)
    await runDesktop(context)
    assert.equal(await waitFor(() => (
      context.browserStart().length === 1 && context.desktopStart().length === 1
    )), true)
    const browserPid = context.browserStart()[0].pid
    const desktopPid = context.desktopStart()[0].pid
    const missing = join(context.home, 'missing-home')
    codexHome[WRITE](missing)
    await assert.rejects(() => runBrowser(context), /dsh-pc-use: cannot read/)
    await assert.rejects(() => runDesktop(context), /dsh-pc-use: cannot read/)
    assert.equal(await waitFor(() => !isRunning(browserPid) && !isRunning(desktopPid)), true)
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.providers.codex.codexHome, missing)
    for (const side of ['browser', 'desktop']) {
      assert.equal(status.providers.codex[side].resolved, false, side)
      assert.equal(typeof status.providers.codex[side].reason, 'string', side)
      assert.equal(status.providers.codex[side].connected, false, side)
      assert.equal(status.providers.codex[side].services, null, side)
    }
    const log = readLog(context)
    assert.match(log, /Codex home changed; reconnecting \(browser\)/)
    assert.match(log, /Codex home changed; reconnecting \(desktop\)/)
    assert.equal(log.includes(missing), false, 'the log must not contain the path')
    // Back to a valid home: each side starts a fresh process on its next call.
    codexHome[WRITE](context.codexHome)
    await runBrowser(context)
    await runDesktop(context)
    assert.equal(await waitFor(() => context.browserStart().length === 2), true)
    assert.equal(await waitFor(() => context.desktopStart().length === 2), true)
    const repaired = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(repaired.providers.codex.browser.resolved, true)
    assert.equal(repaired.providers.codex.desktop.resolved, true)
    assert.equal(repaired.providers.codex.browser.connected, true)
    assert.equal(repaired.providers.codex.desktop.connected, true)
    assert.equal(await stopServers(context), true)
  } finally {
    await stopServers(context)
  }
})
