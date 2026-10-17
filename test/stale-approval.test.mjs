// R4: when a codex_js call ends (here: its own timeout) while a desktop approval is
// still waiting in DSH, the approval must be withdrawn and answered with decline.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

const DESKTOP_SERVER = process.env.CODEX_CU_DESKTOP_SERVER
  ?? fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))

function serverAnswers(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('answer'))
}

function approvalLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('approval '))
}

test('a timed-out codex_js call withdraws the pending desktop approval', async () => {
  const home = tempDir('codex-cu-stale-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [DESKTOP_SERVER, 'computer', serverLog])
  const logFile = join(home, 'bridge.log')
  let seenSignal = null
  let resolveApproval = null
  const approval = {
    request(parameters) {
      seenSignal = parameters.signal
      return new Promise((resolve) => {
        resolveApproval = resolve
      })
    },
  }
  const plugin = registerPlugin({
    codexHome,
    computer: true,
    timeoutMs: 300,
    logFile,
    stateFile: join(home, 'state.json'),
  }, { services: { approval } })
  const exec = {
    agent: { id: 'agent' },
    name: 'codex_js',
    callId: 'call-stale',
    signal: new AbortController().signal,
  }
  try {
    const js = plugin.tools.get('codex_js')
    await assert.rejects(
      () => js.execute({ code: '1', title: 'stale' }, exec),
      /timed out after 300ms/,
    )
    assert.equal(seenSignal.aborted, true)
    assert.equal(await waitFor(() => serverAnswers(serverLog).length > 0), true)
    assert.deepEqual(serverAnswers(serverLog), ['answer decline'])
    assert.equal(
      approvalLines(logFile).some((line) => line.includes('codex_js call ended')),
      true,
    )
    // The user now clicks "allow" on the stale card; that answer must be discarded.
    assert.equal(typeof resolveApproval, 'function')
    resolveApproval('allowed-once')
    await new Promise((done) => setTimeout(done, 300))
    assert.deepEqual(serverAnswers(serverLog), ['answer decline'])
  } finally {
    plugin.dispose()
    restore()
  }
})
