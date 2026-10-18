// F1 through the host's real config path: validate with the real schemastery, then apply.
// Skipped with a stated reason when schemastery is not installed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { Config } from '../index.js'
import { isVolatile, unwrapConfigValue } from '../lib/config-value.js'
import { FAKE_SERVER, registerPlugin, tempDir, useHome, writeCodexHome } from './helpers.mjs'

const schemastery = await import('@deepseek-ai/schemastery').catch(() => null)
const canResolve = schemastery !== null && Config !== undefined
const SKIP = '@deepseek-ai/schemastery is not installed; the real Config resolution path cannot run'
const PATCH = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

const TOOL_NAMES = [
  'pc_codex_js',
  'pc_codex_js_reset',
  'pc_codex_desktop_js',
  'pc_codex_desktop_js_reset',
  'pc_codex_desktop_js_add_node_module_dir',
  'pc_codex_observe',
  'pc_codex_run_plan',
  'pc_codex_docs',
  'pc_status',
]

function validate(raw) {
  const result = Config['~standard'].validate(raw)
  assert.equal(result.issues, undefined)
  return result.value
}

function bundlePatch(codexHome = '') {
  return {
    enabled: true,
    autoApprove: true,
    codexHome,
    logFile: '',
    timeoutMs: 120000,
    tools: {
      js: true,
      reset: true,
      desktopJs: true,
      desktopReset: true,
      desktopAddNodeModuleDir: true,
      docs: true,
      status: true,
    },
  }
}

test('the bundle patch config registers all nine tools', (t) => {
  if (!canResolve) return t.skip(SKIP)
  const plugin = registerPlugin(validate(bundlePatch()))
  try {
    assert.deepEqual([...plugin.tools.keys()], TOOL_NAMES)
  } finally {
    plugin.dispose()
  }
})

test('old config keys addNodeModuleDir and stateFile are tolerated', (t) => {
  if (!canResolve) return t.skip(SKIP)
  const value = validate({
    tools: { js: true, reset: true, addNodeModuleDir: true, docs: true, status: true },
    stateFile: 'X',
  })
  const plugin = registerPlugin(value)
  try {
    assert.deepEqual([...plugin.tools.keys()], TOOL_NAMES)
  } finally {
    plugin.dispose()
  }
})

test('a legacy desktopApprovalChoices field validates and is ignored', (t) => {
  if (!canResolve) return t.skip(SKIP)
  // The field is gone from the schema, so settings pages and `Config.dict` no longer show it.
  assert.equal(Config.dict.desktopApprovalChoices, undefined)
  // Schemastery objects are non-strict: the unknown key is preserved by validation, not rejected.
  for (const value of [true, false]) {
    const config = validate({ desktopApprovalChoices: value })
    assert.equal(config.desktopApprovalChoices, value)
  }
  assert.equal(unwrapConfigValue(validate({}).language), 'auto')
  assert.equal(unwrapConfigValue(validate({ language: 'en' }).language), 'en')
})

test('enabled:false registers nothing through the real config path', (t) => {
  if (!canResolve) return t.skip(SKIP)
  const plugin = registerPlugin(validate({ enabled: false }))
  try {
    assert.equal(plugin.tools.size, 0)
  } finally {
    plugin.dispose()
  }
})

test('tools.js:false registers the other eight tools through the real config path', (t) => {
  if (!canResolve) return t.skip(SKIP)
  const plugin = registerPlugin(validate({ tools: { js: false } }))
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

test('only the hot-updatable fields come back as Volatile', (t) => {
  if (!canResolve) return t.skip(SKIP)
  const value = validate(bundlePatch())
  assert.equal(isVolatile(value.autoApprove), true)
  assert.equal(isVolatile(value.logFile), true)
  assert.equal(isVolatile(value.timeoutMs), true)
  assert.equal(isVolatile(value.language), true)
  assert.equal(isVolatile(value.codexHome), true)
  assert.equal(isVolatile(value.enabled), false)
  for (const [key, item] of Object.entries(value.tools)) {
    assert.equal(isVolatile(item), false, `tools.${key} must remount instead of updating`)
  }
})

test('the three new tool switches default to true and are not volatile', (t) => {
  if (!canResolve) return t.skip(SKIP)
  const value = validate({})
  for (const key of ['desktopJs', 'desktopReset', 'desktopAddNodeModuleDir']) {
    assert.equal(unwrapConfigValue(value.tools[key]), true, `tools.${key} must default to true`)
    assert.equal(isVolatile(value.tools[key]), false, `tools.${key} must not be volatile`)
    // The bundle patch must ship the same default, or a fresh profile would differ.
    const line = new RegExp(`^\\s+${key}: true$`, 'm')
    assert.match(PATCH, line, `cordis.patch.yml must enable tools.${key}`)
  }
})

test('autoApprove defaults to false (fail-closed)', (t) => {
  if (!canResolve) return t.skip(SKIP)
  const value = validate({})
  assert.equal(unwrapConfigValue(value.autoApprove), false)
  const plugin = registerPlugin(value)
  try {
    assert.equal(plugin.tools.size, 9)
  } finally {
    plugin.dispose()
  }
})

test('pc_status reports the configured codexHome as a string', async (t) => {
  if (!canResolve) return t.skip(SKIP)
  const home = tempDir()
  const restore = useHome(home)
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [FAKE_SERVER, 'ok', join(home, 'server.log')])
  const plugin = registerPlugin(validate(bundlePatch(codexHome)))
  try {
    const status = plugin.tools.get('pc_status')
    const report = JSON.parse(await status.execute({}, {}))
    assert.equal(typeof report.backends.codex.codexHome, 'string')
    assert.equal(report.backends.codex.codexHome, codexHome)
  } finally {
    plugin.dispose()
    restore()
  }
})

test('the real config path reads volatile values when they are used', async (t) => {
  if (!canResolve) return t.skip(SKIP)
  const home = tempDir()
  const restore = useHome(home)
  const codexHome = join(home, 'codex')
  const plugin = registerPlugin(validate({ ...bundlePatch(codexHome), autoApprove: true }))
  try {
    const report = JSON.parse(await plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(report.backends.codex.autoApprove, true)
  } finally {
    plugin.dispose()
    restore()
  }
})
