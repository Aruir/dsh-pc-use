// R4: a DSH cancellation while a desktop approval waits must withdraw that approval,
// and a stale answer must never become a grant. Since 0.4.2 (D14) pauses the call
// timeout while an elicitation is pending, the card can no longer be ended by it.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

const DESKTOP_SERVER = process.env.CODEX_CU_DESKTOP_SERVER
  ?? fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))

test('the signal handed to DSH follows a host cancellation', async () => {
  const home = tempDir('pc-use-cancel-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [DESKTOP_SERVER, 'computer', serverLog], {}, { desktop: true })
  let seenSignal = null
  const approval = {
    request(parameters) {
      seenSignal = parameters.signal
      return new Promise(() => {})
    },
  }
  const plugin = registerPlugin({
    codexHome,
    computer: true,
    timeoutMs: 60_000,
    logFile: join(home, 'bridge.log'),
  }, { services: { approval } })
  const controller = new AbortController()
  const exec = {
    agent: { id: 'agent' },
    name: 'pc_codex_desktop_js',
    callId: 'call-cancel',
    signal: controller.signal,
  }
  try {
    const js = plugin.tools.get('pc_codex_desktop_js')
    const pending = js.execute({ code: '1', title: 'cancel' }, exec)
      .then((value) => value, (error) => error)
    assert.equal(await waitFor(() => seenSignal !== null), true)
    controller.abort()
    assert.equal(await waitFor(() => seenSignal.aborted === true, 2000), true)
    plugin.dispose()
    await pending
  } finally {
    plugin.dispose()
    restore()
  }
})
