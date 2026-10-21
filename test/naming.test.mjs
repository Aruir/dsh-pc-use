// R17: rename triggers that a user profile, the MCP handshake and screenshots rely on.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { name as pluginName } from '../index.js'

const root = fileURLToPath(new URL('..', import.meta.url))

test('the patch insert id is pc-use', () => {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const match = text.match(/^\s+- id:\s*'?([^'\s]+)'?\s*$/m)
  assert.ok(match, 'patch must declare an id')
  assert.equal(match[1], 'pc-use')
})

test('the plugin export name is pc-use', () => {
  assert.equal(pluginName, 'pc-use')
})
