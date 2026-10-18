// D5/D6/D9/D10: manifest, display assets, tool names and the pc_status shape.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin } from './helpers.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const TOOL_NAMES = [
  'pc_codex_js',
  'pc_codex_js_reset',
  'pc_codex_js_add_node_module_dir',
  'pc_codex_docs',
  'pc_status',
]
const PC_CODEX_JS_DOCS_SENTENCE = 'Before controlling Windows apps, call `pc_codex_docs` for '
  + '`skill`, `guidance` and `confirmations`; call it for `api` when you need method signatures.'

function register() {
  return registerPlugin({
    codexHome: join(tmpdir(), 'dsh-pc-use-manifest-codex'),
    logFile: join(tmpdir(), 'dsh-pc-use-manifest.log'),
    stateFile: join(tmpdir(), 'dsh-pc-use-manifest-state.json'),
  })
}

test('locale files are valid JSON with non-empty display metadata', () => {
  for (const locale of ['en', 'zh']) {
    const file = join(root, 'locale', `${locale}.json`)
    assert.equal(existsSync(file), true, file)
    const data = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof data.meta.title, 'string')
    assert.notEqual(data.meta.title, '')
    assert.equal(typeof data.meta.description, 'string')
    assert.notEqual(data.meta.description, '')
  }
  const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
  assert.equal(en.meta.title, 'PC Use')
  assert.equal(zh.meta.title, '电脑操控')
})

test('icon.svg is a renderable SVG with only the standard namespace', () => {
  const file = join(root, 'icon.svg')
  assert.equal(existsSync(file), true)
  assert.ok(statSync(file).size < 256 * 1024)
  const svg = readFileSync(file, 'utf8')
  assert.equal(svg.startsWith('<svg'), true)
  assert.equal(svg.includes('viewBox'), true)
  const rootTag = svg.slice(0, svg.indexOf('>') + 1)
  assert.match(rootTag, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  // The namespace is the only permitted remote-looking token; strip it, then check.
  const withoutNamespace = svg.replaceAll('http://www.w3.org/2000/svg', '')
  for (const bad of ['http:', 'https:', 'href', 'url(', '<image']) {
    assert.equal(withoutNamespace.includes(bad), false, `icon.svg must not contain ${bad}`)
  }
})

test('package exports and files publish the new display assets', () => {
  assert.equal(packageJson.exports['./locale/*.json'], './locale/*.json')
  assert.equal(packageJson.exports['./icon'], './icon.svg')
  assert.equal(existsSync(join(root, packageJson.exports['.'])), true)
  for (const entry of ['index.js', 'lib', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(packageJson.files.includes(entry), `files must include ${entry}`)
  }
  assert.equal(packageJson.name, 'dsh-pc-use')
})

test('the patch insert uses the package name and loads the exported entry', () => {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  // Only the first `name:` under `insert:` is matched; this patch has exactly one row.
  const match = text.match(/^\s+name:\s*'([^']+)'\s*$/m)
  assert.ok(match, 'patch must declare a name')
  assert.equal(match[1], packageJson.name)
  assert.equal(existsSync(join(root, packageJson.exports['.'])), true)
})

test('exactly the five new tool names are registered', () => {
  const plugin = register()
  try {
    assert.deepEqual([...plugin.tools.keys()], TOOL_NAMES)
    for (const name of plugin.tools.keys()) {
      assert.equal(name.startsWith('codex_'), false)
    }
  } finally {
    plugin.dispose()
  }
})

test('pc_codex_js tells the model to read pc_codex_docs first', () => {
  const plugin = register()
  try {
    const description = plugin.tools.get('pc_codex_js').description
    assert.equal(description.includes(PC_CODEX_JS_DOCS_SENTENCE), true)
  } finally {
    plugin.dispose()
  }
})

test('pc_status puts the existing fields under backends.codex', async () => {
  const plugin = register()
  try {
    const status = JSON.parse(await plugin.tools.get('pc_status').execute({}, {}))
    assert.deepEqual(Object.keys(status), ['backends'])
    const codex = status.backends.codex
    assert.equal(typeof codex, 'object')
    assert.equal(codex.connected, false)
    assert.equal(codex.computer, null)
    assert.equal(codex.services, null)
    assert.equal(codex.servicesFrom, null)
    assert.equal(status.connected, undefined)
  } finally {
    plugin.dispose()
  }
})
