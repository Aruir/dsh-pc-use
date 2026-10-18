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
      docs: createVolatile(true),
      status: createVolatile(true),
    },
  })
  try {
    assert.deepEqual([...plugin.tools.keys()], [
      'pc_codex_js', 'pc_codex_js_reset', 'pc_codex_desktop_js',
      'pc_codex_desktop_js_reset', 'pc_codex_desktop_js_add_node_module_dir',
      'pc_codex_observe', 'pc_codex_run_plan', 'pc_codex_docs', 'pc_status',
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

test('a volatile tools.js:false registers the other eight tools', () => {
  const plugin = registerPlugin({ tools: { js: createVolatile(false) } })
  try {
    assert.deepEqual([...plugin.tools.keys()], [
      'pc_codex_js_reset', 'pc_codex_desktop_js', 'pc_codex_desktop_js_reset',
      'pc_codex_desktop_js_add_node_module_dir', 'pc_codex_observe',
      'pc_codex_run_plan', 'pc_codex_docs', 'pc_status',
    ])
  } finally {
    plugin.dispose()
  }
})
