// 0.5.0 S1.3/S1.4: the `computer` switch controls only the desktop server. Desktop tools
// are always registered; the desktop server starts lazily on a desktop call, a hot off
// stops only the desktop process, and a hot on starts a new one on the next call.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { waitFor } from './helpers.mjs'
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

function runBrowser(context) {
  return context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'browser' }, {})
}

function runDesktop(context) {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '1', title: 'desktop' }, {})
}

test('computer:false keeps the desktop tools registered but starts nothing', async () => {
  const context = startServers({ config: { computer: false } })
  try {
    assert.equal(context.plugin.tools.has('pc_codex_desktop_js'), true)
    await assert.rejects(() => runDesktop(context), /computer use is off/)
    assert.equal(context.desktopStart().length, 0)
    assert.equal(context.browserStart().length, 0)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('enabling computer starts a new desktop server on the next desktop call', async () => {
  const computer = createVolatile(false)
  const context = startServers({ config: { computer } })
  try {
    await runBrowser(context)
    const browserPid = context.browserStart()[0].pid
    computer[WRITE](true)
    // Flipping the switch does not start anything by itself.
    await new Promise((done) => setTimeout(done, 150))
    assert.equal(context.desktopStart().length, 0)
    await runDesktop(context)
    assert.equal(await waitFor(() => context.desktopStart().length === 1), true)
    assert.equal(context.browserStart().length, 1)
    assert.equal(isRunning(browserPid), true)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('hot switching computer off stops only the desktop server', async () => {
  const computer = createVolatile(true)
  const context = startServers({ config: { computer } })
  try {
    await runBrowser(context)
    await runDesktop(context)
    const browserPid = context.browserStart()[0].pid
    const desktopPid = context.desktopStart()[0].pid
    computer[WRITE](false)
    // The next browser call notices the switch and stops the desktop server.
    await runBrowser(context)
    assert.equal(await waitFor(() => !isRunning(desktopPid)), true)
    assert.equal(isRunning(browserPid), true)
    assert.equal(context.browserStart().length, 1)
    assert.equal(context.desktopStart().length, 1)
    computer[WRITE](true)
    // Re-enabling does not restart it either: the next desktop call does.
    await new Promise((done) => setTimeout(done, 150))
    assert.equal(context.desktopStart().length, 1)
    await runDesktop(context)
    assert.equal(await waitFor(() => context.desktopStart().length === 2), true)
    assert.notEqual(context.desktopStart()[1].pid, desktopPid)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('the loader volatile event stops the desktop server immediately', async () => {
  const computer = createVolatile(true)
  const context = startServers({ config: { computer } })
  try {
    await runBrowser(context)
    await runDesktop(context)
    const browserPid = context.browserStart()[0].pid
    const desktopPid = context.desktopStart()[0].pid
    computer[WRITE](false)
    context.plugin.emit('loader/volatile-update', ['computer'])
    assert.equal(await waitFor(() => !isRunning(desktopPid)), true)
    assert.equal(isRunning(browserPid), true)
    assert.equal(context.browserStart().length, 1)
    assert.equal(context.desktopStart().length, 1)
    computer[WRITE](true)
    context.plugin.emit('loader/volatile-update', ['computer'])
    await new Promise((done) => setTimeout(done, 150))
    assert.equal(context.desktopStart().length, 1)
    await runDesktop(context)
    assert.equal(await waitFor(() => context.desktopStart().length === 2), true)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('an approval that arrives after computer turns off is declined', async () => {
  const computer = createVolatile(true)
  const context = startServers({
    desktop: { mode: 'computer-delayed' },
    config: { computer },
  })
  try {
    const call = runDesktop(context)
    const outcome = call.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    assert.equal(await waitFor(() => context.desktopCalls().length === 1), true)
    // No volatile event here: the bridge's own isComputerEnabled check must see the switch.
    computer[WRITE](false)
    const result = await outcome
    assert.equal(result.error, undefined, result.error?.message)
    assert.match(result.value, /decision decline/)
    // The bridge logs the reason; the MCP reply itself only carries the action.
    assert.match(readFileSync(context.logFile, 'utf8'), /-> decline \(computer use is off\)/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a desktop call while computer is off stops a desktop server left running', async () => {
  const computer = createVolatile(true)
  const context = startServers({ config: { computer } })
  try {
    await runDesktop(context)
    const desktopPid = context.desktopStart()[0].pid
    computer[WRITE](false)
    await assert.rejects(() => runDesktop(context), /computer use is off/)
    assert.equal(await waitFor(() => !isRunning(desktopPid)), true)
    assert.equal(context.desktopStart().length, 1)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
