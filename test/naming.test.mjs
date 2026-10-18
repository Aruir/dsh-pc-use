// R17: rename triggers that a user profile, the MCP handshake and screenshots rely on.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { name as pluginName } from '../index.js'
import { McpBridge } from '../lib/mcp-bridge.js'
import {
  FAKE_SERVER, registerPlugin, tempDir, useHome, waitFor, writeCodexHome,
} from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function bridgeFor(logFile) {
  return new McpBridge({
    command: process.execPath,
    args: [FAKE_SERVER, 'ok', logFile],
    env: process.env,
    cwd: tempDir(),
    sessionId: 'naming-test',
    log: () => {},
  })
}

test('the patch insert id is pc-use', () => {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const match = text.match(/^\s+- id:\s*'?([^'\s]+)'?\s*$/m)
  assert.ok(match, 'patch must declare an id')
  assert.equal(match[1], 'pc-use')
})

test('the plugin export name is pc-use', () => {
  assert.equal(pluginName, 'pc-use')
})

test('the MCP client advertises the renamed package and its version', async () => {
  const home = tempDir()
  const logFile = join(home, 'initialize.log')
  const bridge = bridgeFor(logFile)
  try {
    await bridge.start()
    const received = await waitFor(
      () => readFileSync(logFile, 'utf8').includes('initialize-params'),
    )
    assert.equal(received, true)
    const line = readFileSync(logFile, 'utf8').split('\n')
      .find((item) => item.startsWith('initialize-params '))
    const clientInfo = JSON.parse(line.slice('initialize-params '.length))
    assert.equal(clientInfo.name, 'dsh-pc-use')
    assert.equal(clientInfo.version, packageJson.version)
  } finally {
    bridge.stop()
  }
})

test('screenshots land in ~/.dsh/pc-use-images by default', async () => {
  const home = tempDir()
  const restore = useHome(home)
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [FAKE_SERVER, 'image', join(home, 'server.log')])
  const plugin = registerPlugin({
    codexHome,
    logFile: join(home, 'bridge.log'),
  })
  try {
    const js = plugin.tools.get('pc_codex_js')
    const result = await js.execute({ code: '1', title: 'image' }, {})
    const match = /\[image saved: (.+)\]/.exec(result)
    assert.ok(match, result)
    const prefix = join(home, '.dsh', 'pc-use-images')
    assert.equal(match[1].startsWith(prefix), true, match[1])
    assert.equal(existsSync(match[1]), true)
  } finally {
    plugin.dispose()
    restore()
  }
})
