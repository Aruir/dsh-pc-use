// 0.5.0 S5: pc_status reports each server's own resolution, connection, native pipe and
// trusted service names; the two sides never share those values.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { waitFor } from './helpers.mjs'
import {
  DESKTOP_ENV, DUAL_SERVER, isRunning, startServers, stopServers, writeDesktopSource,
} from './fixtures/server-harness.mjs'

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

function runBrowser(context) {
  return context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'browser' }, {})
}

function runDesktop(context) {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '1', title: 'desktop' }, {})
}

test('pc_status reports each connected server with its own services and native pipe', async () => {
  const context = startServers({ config: { computer: true } })
  try {
    await runBrowser(context)
    await runDesktop(context)
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    const codex = status.backends.codex
    assert.equal(codex.computer, true)
    assert.equal(codex.autoApprove, false)
    for (const side of ['browser', 'desktop']) {
      assert.equal(codex[side].resolved, true, side)
      assert.equal(codex[side].connected, true, side)
    }
    assert.equal(codex.browser.nativePipe, 'pipe-browser')
    assert.equal(codex.desktop.nativePipe, null)
    assert.deepEqual(codex.browser.services, ['browser'])
    assert.deepEqual(codex.desktop.services, ['sky'])
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('turning computer off stops the desktop server and clears its status only', async () => {
  const computer = createVolatile(true)
  const context = startServers({ config: { computer } })
  try {
    await runBrowser(context)
    await runDesktop(context)
    computer[WRITE](false)
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    const codex = status.backends.codex
    assert.equal(codex.computer, false)
    assert.equal(codex.browser.connected, true)
    assert.equal(codex.desktop.connected, false)
    assert.equal(codex.desktop.services, null)
    // The desktop process is gone before the status call returns.
    const desktopPid = context.desktopStart()[0].pid
    assert.equal(await waitFor(() => !isRunning(desktopPid)), true)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a browser source that does not resolve leaves the desktop side intact', async () => {
  const context = startServers({ browser: false, config: { computer: true } })
  try {
    await runDesktop(context)
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.backends.codex.browser.resolved, false)
    assert.equal(typeof status.backends.codex.browser.reason, 'string')
    assert.equal(status.backends.codex.browser.connected, false)
    assert.equal(status.backends.codex.desktop.resolved, true)
    assert.equal(status.backends.codex.desktop.connected, true)
    assert.deepEqual(status.backends.codex.desktop.services, ['sky'])
  } finally {
    assert.equal(await stopServers(context), true)
  }
})


test('pc_status re-reads config and flags a pending reconnect', async () => {
  const context = startServers({ config: { computer: true } })
  try {
    await runBrowser(context)
    await runDesktop(context)
    writeDesktopSource(
      context.codexHome,
      [DUAL_SERVER, 'desktop', 'ok', context.logs.desktop],
      { ...DESKTOP_ENV, SKY_CUA_NATIVE_PIPE_DIRECTORY: 'pipe-desktop-new' },
    )
    let status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.backends.codex.desktop.nativePipe, 'pipe-desktop-new')
    assert.equal(status.backends.codex.desktop.connectedPipe, null)
    assert.equal(status.backends.codex.desktop.reconnectPending, true)
    await runDesktop(context)
    status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.backends.codex.desktop.nativePipe, 'pipe-desktop-new')
    assert.equal(status.backends.codex.desktop.connectedPipe, 'pipe-desktop-new')
    assert.equal(status.backends.codex.desktop.reconnectPending, false)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
