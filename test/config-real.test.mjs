// F1 through the host's real config path: validate with the real schemastery, then apply.
// Skipped with a stated reason when schemastery is not installed.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { Config } from '../index.js'
import { isVolatile, unwrapConfigValue } from '../lib/config-value.js'
import { FAKE_SERVER, registerPlugin, tempDir, useHome, writeCodexHome } from './helpers.mjs'

const schemastery = await import('@deepseek-ai/schemastery').catch(() => null)
const canResolve = schemastery !== null && Config !== undefined
const SKIP = '@deepseek-ai/schemastery is not installed; the real Config resolution path cannot run'

const TOOL_NAMES = ['pc_codex_js', 'pc_codex_js_reset', 'pc_codex_docs', 'pc_status']

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
    tools: { js: true, reset: true, docs: true, status: true },
  }
}

test('the bundle patch config registers all four tools', (t) => {
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

test('desktopApprovalChoices and language default through the real config path', (t) => {
  if (!canResolve) return t.skip(SKIP)
  assert.equal(unwrapConfigValue(validate({}).desktopApprovalChoices), true)
  assert.equal(
    unwrapConfigValue(validate({ desktopApprovalChoices: false }).desktopApprovalChoices),
    false,
  )
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

test('tools.js:false registers the other three tools through the real config path', (t) => {
  if (!canResolve) return t.skip(SKIP)
  const plugin = registerPlugin(validate({ tools: { js: false } }))
  try {
    assert.deepEqual([...plugin.tools.keys()], [
      'pc_codex_js_reset', 'pc_codex_docs', 'pc_status',
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
  assert.equal(isVolatile(value.desktopApprovalChoices), true)
  assert.equal(isVolatile(value.language), true)
  assert.equal(isVolatile(value.enabled), false)
  assert.equal(isVolatile(value.codexHome), false)
  for (const [key, item] of Object.entries(value.tools)) {
    assert.equal(isVolatile(item), false, `tools.${key} must remount instead of updating`)
  }
})

test('autoApprove defaults to false (fail-closed)', (t) => {
  if (!canResolve) return t.skip(SKIP)
  const value = validate({})
  assert.equal(unwrapConfigValue(value.autoApprove), false)
  const plugin = registerPlugin(value)
  try {
    assert.equal(plugin.tools.size, 4)
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
