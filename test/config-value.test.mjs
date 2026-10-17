// F1 without schemastery: the config layer must accept plain values and hand-built
// objects that follow cosmokit's Volatile protocol.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { unwrapConfigValue } from '../lib/config-value.js'
import { registerPlugin, tempDir, useHome } from './helpers.mjs'

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

test('plain values pass through unchanged', () => {
  assert.equal(unwrapConfigValue(false), false)
  assert.equal(unwrapConfigValue(''), '')
  assert.equal(unwrapConfigValue(120000), 120000)
  assert.equal(unwrapConfigValue(undefined), undefined)
  const plain = { js: true }
  assert.equal(unwrapConfigValue(plain), plain)
})

test('cosmokit Volatile objects are unwrapped on every read', () => {
  const ref = createVolatile(false)
  assert.equal(unwrapConfigValue(ref), false)
  ref[WRITE](true)
  assert.equal(unwrapConfigValue(ref), true)
})

test('objects that only look similar are not unwrapped', () => {
  const fake = { get: () => 1 }
  assert.equal(unwrapConfigValue(fake), fake)
  const writeOnly = { [WRITE]: () => {} }
  assert.equal(unwrapConfigValue(writeOnly), writeOnly)
})

test('volatile switches still register the enabled tools', () => {
  const restore = useHome(tempDir())
  const plugin = registerPlugin({
    enabled: createVolatile(true),
    autoApprove: createVolatile(false),
    codexHome: createVolatile(''),
    logFile: createVolatile(''),
    timeoutMs: createVolatile(120000),
    tools: {
      js: createVolatile(true),
      reset: createVolatile(true),
      addNodeModuleDir: createVolatile(true),
      status: createVolatile(true),
    },
  })
  try {
    assert.deepEqual([...plugin.tools.keys()], [
      'codex_js', 'codex_js_reset', 'codex_js_add_node_module_dir', 'codex_status',
    ])
  } finally {
    plugin.dispose()
    restore()
  }
})

test('a volatile enabled:false registers nothing', () => {
  const plugin = registerPlugin({ enabled: createVolatile(false) })
  try {
    assert.equal(plugin.tools.size, 0)
  } finally {
    plugin.dispose()
  }
})

test('a volatile tools.js:false registers the other three tools', () => {
  const plugin = registerPlugin({ tools: { js: createVolatile(false) } })
  try {
    assert.deepEqual([...plugin.tools.keys()], [
      'codex_js_reset', 'codex_js_add_node_module_dir', 'codex_status',
    ])
  } finally {
    plugin.dispose()
  }
})
