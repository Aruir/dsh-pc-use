// G: the plugin records log write failures, reports them in pc_status, and marks them recovered.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { FAKE_SERVER, registerPlugin, tempDir, writeCodexHome } from './helpers.mjs'

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

function setup(logFile) {
  const home = tempDir('pc-use-health-')
  const codexHome = join(home, 'codex')
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  writeCodexHome(codexHome, [FAKE_SERVER, 'elicit', serverLog])
  const plugin = registerPlugin({ codexHome, computer: false, autoApprove: true, logFile })
  return { home, plugin }
}

async function status(plugin) {
  return JSON.parse(await plugin.tools.get('pc_status').execute({}, {}))
}

test('a failed log write is reported and a later success marks it recovered', async () => {
  const blocker = tempDir('pc-use-health-block-')
  const badPath = join(blocker, 'not-a-directory')
  writeFileSync(badPath, 'x')
  const goodPath = join(blocker, 'bridge.log')
  const logFile = createVolatile(join(badPath, 'bridge.log'))
  const { home, plugin } = setup(logFile)
  try {
    // Any tool call writes the connection log line, which fails on the blocked path.
    await plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'health' }, {})
    let report = await status(plugin)
    assert.equal(report.providers.codex.log.path, join(badPath, 'bridge.log'))
    assert.equal(report.providers.codex.log.writable, false)
    assert.equal(typeof report.providers.codex.log.lastError.kind, 'string')
    logFile[WRITE](goodPath)
    await plugin.tools.get('pc_codex_js').execute({ code: '2', title: 'health' }, {})
    report = await status(plugin)
    assert.equal(report.providers.codex.log.path, goodPath)
    assert.equal(report.providers.codex.log.writable, true)
    assert.equal(report.providers.codex.log.lastError.recovered, true)
  } finally {
    plugin.dispose()
    void home
  }
})
