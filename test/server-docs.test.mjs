// r25: unit tests for the pure server-docs helpers. Every server doc here is invented, short
// fake text (never real Codex text), and every file lives in a temp directory under the OS temp
// dir that the after hook removes; no server process is started.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { after, test } from 'node:test'

import {
  canonicalJson, composeDescription, docsFromServer, readDocsCache, specFingerprint,
  writeDocsCacheEntry,
} from '../lib/server-docs.js'

const FAKE_INSTRUCTIONS = 'Fake namespace instructions for tests.'
const FAKE_TOOLS = [
  { name: 'js', description: 'Fake js description.', inputSchema: { type: 'object' } },
  { name: 'js_reset', description: 'Fake reset description.', inputSchema: { type: 'object' } },
  {
    name: 'js_add_node_module_dir',
    description: 'Fake module directory description.',
    inputSchema: { type: 'object' },
  },
  { name: 'observe', description: 'Fake observe description.', inputSchema: { type: 'object' } },
]

const tempDirs = new Set()
after(() => {
  for (const directory of tempDirs) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {}
  }
  tempDirs.clear()
})

/** Fresh temp directory under the OS temp dir; the after hook removes it. O(1). */
function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'pc-use-server-docs-'))
  tempDirs.add(directory)
  return directory
}

/**
 * Throw unless the process HOME is inside the OS temp dir; cache writes must stay temp.
 * P1-1: this file writes cache files, so it must never run under the real home. O(1).
 */
function assertTempHome() {
  const relativeHome = relative(tmpdir(), homedir())
  if (relativeHome === '' || relativeHome.startsWith('..') || isAbsolute(relativeHome)) {
    throw new Error(`test HOME must be inside the OS temp directory; got ${homedir()}`)
  }
}

/** SHA-256 hex of one text; lets a test build hash-consistent entries. O(text size). */
function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** One valid cache entry built from the fake docs; overrides replace fields. O(t log t). */
function fakeEntry(overrides = {}) {
  const docs = docsFromServer({ instructions: FAKE_INSTRUCTIONS, tools: FAKE_TOOLS })
  return {
    fingerprint: 'a'.repeat(64),
    instructions: docs.instructions,
    tools: docs.tools,
    docsHash: docs.docsHash,
    listHash: docs.listHash,
    toolNames: docs.toolNames,
    fetchedAt: '2026-10-20T05:00:00.000Z',
    ...overrides,
  }
}

/** Write a raw cache value; a string is written as-is so a test can pass invalid JSON. */
function writeCacheFile(directory, value, name = 'cache.json') {
  const file = join(directory, name)
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  writeFileSync(file, text, 'utf8')
  return file
}

/** Every `*.tmp` path under `root`, recursively; [] proves no temp file was left. O(files). */
function tempFiles(root) {
  const found = []
  const walk = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      if (item.isDirectory()) {
        walk(path)
      } else if (item.name.endsWith('.tmp')) {
        found.push(path)
      }
    }
  }
  walk(root)
  return found
}

/** Write one fake executable file; its contents only affect the stat size and mtime. O(1). */
function fakeCommand(directory, name, content = 'fake') {
  const file = join(directory, name)
  writeFileSync(file, content)
  return file
}

test('canonicalJson sorts object keys recursively and keeps array order', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 4, c: [3, { f: 6, e: 5 }] } }),
    '{"a":{"c":[3,{"e":5,"f":6}],"d":4},"b":1}',
  )
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
})

test('canonicalJson drops undefined object values and nulls undefined array items', () => {
  assert.equal(canonicalJson({ b: undefined, a: 1 }), '{"a":1}')
  assert.equal(canonicalJson([1, undefined, 2]), '[1,null,2]')
})

test('specFingerprint changes with command, args, source, size and mtime', () => {
  const dir = tempDir()
  const first = fakeCommand(dir, 'first.exe', 'a')
  const second = fakeCommand(dir, 'second.exe', 'bb')
  const source = join(dir, 'fake-source.json')
  const base = { command: first, args: [], source }
  const fingerprint = specFingerprint(base)
  assert.notEqual(specFingerprint({ ...base, command: second }), fingerprint)
  assert.notEqual(specFingerprint({ ...base, args: ['--other'] }), fingerprint)
  assert.notEqual(specFingerprint({ ...base, source: join(dir, 'other.json') }), fingerprint)
  // Same file, different mtime: Codex rewrites its config without changing the command size.
  utimesSync(first, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
  const retimed = specFingerprint(base)
  assert.notEqual(retimed, fingerprint)
  utimesSync(first, new Date(1_700_000_100_000), new Date(1_700_000_100_000))
  assert.notEqual(specFingerprint(base), retimed)
})

test('specFingerprint treats a non-array args as empty', () => {
  const dir = tempDir()
  const command = fakeCommand(dir, 'fake.exe', 'x')
  const base = { command, args: [], source: 'fake-source' }
  assert.equal(specFingerprint({ ...base, args: undefined }), specFingerprint(base))
  assert.equal(specFingerprint({ ...base, args: 'not-an-array' }), specFingerprint(base))
})

test('specFingerprint records a failed stat as two null file fields', () => {
  const dir = tempDir()
  const missing = join(dir, 'missing-command.exe')
  const args = ['--fake']
  const canonical = canonicalJson({
    command: missing, args, source: 'fake-source', commandSize: null, commandMtimeMs: null,
  })
  const spec = { command: missing, args, source: 'fake-source' }
  assert.equal(specFingerprint(spec), hashText(canonical))
})

test('docsFromServer hashes do not depend on tool list order', () => {
  const forward = docsFromServer({ instructions: FAKE_INSTRUCTIONS, tools: FAKE_TOOLS })
  const backward = docsFromServer({
    instructions: FAKE_INSTRUCTIONS,
    tools: [...FAKE_TOOLS].reverse(),
  })
  assert.equal(backward.docsHash, forward.docsHash)
  assert.equal(backward.listHash, forward.listHash)
  assert.deepEqual(backward.toolNames, forward.toolNames)
})

test('docsFromServer returns null without a usable js description', () => {
  const withoutJs = FAKE_TOOLS.filter((tool) => tool.name !== 'js')
  assert.equal(docsFromServer({ instructions: FAKE_INSTRUCTIONS, tools: withoutJs }), null)
  for (const description of ['', 42, null, undefined]) {
    const tools = FAKE_TOOLS.map((tool) => (
      tool.name === 'js' ? { ...tool, description } : tool
    ))
    assert.equal(docsFromServer({ instructions: FAKE_INSTRUCTIONS, tools }), null)
  }
  assert.equal(docsFromServer({ instructions: FAKE_INSTRUCTIONS }), null)
  assert.equal(docsFromServer(), null)
})

test('docsFromServer omits absent optional docs and nulls invalid instructions', () => {
  const tools = [
    { name: 'js', description: 'Fake js only.', inputSchema: {} },
    { name: 'js_reset', description: '', inputSchema: {} },
    { name: 'js_add_node_module_dir', description: 42, inputSchema: {} },
  ]
  for (const instructions of ['', 42, null, undefined]) {
    const docs = docsFromServer({ instructions, tools })
    assert.equal(docs.instructions, null)
    assert.deepEqual(docs.tools, { js: 'Fake js only.' })
    assert.deepEqual(docs.toolNames, ['js', 'js_add_node_module_dir', 'js_reset'])
  }
  assert.equal(docsFromServer({ instructions: '   ', tools }).instructions, '   ')
})

test('docsFromServer listHash covers non-js tools while docsHash does not', () => {
  const base = docsFromServer({ instructions: FAKE_INSTRUCTIONS, tools: FAKE_TOOLS })
  const changedTools = FAKE_TOOLS.map((tool) => (
    tool.name === 'observe' ? { ...tool, description: 'Changed fake observe.' } : tool
  ))
  const changed = docsFromServer({ instructions: FAKE_INSTRUCTIONS, tools: changedTools })
  assert.equal(changed.docsHash, base.docsHash)
  assert.notEqual(changed.listHash, base.listHash)
})

test('readDocsCache invalidates only the target with a bad entry', () => {
  const dir = tempDir()
  const good = fakeEntry()
  const badEntries = [
    { ...good, fingerprint: 'A'.repeat(64) },
    { ...good, fingerprint: 'abc' },
    { ...good, fingerprint: undefined },
    { ...good, docsHash: '0'.repeat(63) },
    { ...good, listHash: 42 },
    { ...good, instructions: 42 },
    { ...good, instructions: undefined },
    { ...good, tools: null },
    { ...good, tools: {} },
    { ...good, tools: { js: '' } },
    { ...good, tools: { js: 42 } },
    { ...good, tools: { js: good.tools.js, js_reset: '' } },
    { ...good, tools: { js: good.tools.js, js_reset: 42 } },
    { ...good, toolNames: 'js' },
    { ...good, toolNames: ['js', 42] },
    { ...good, fetchedAt: 42 },
    { ...good, fetchedAt: undefined },
  ]
  for (const bad of badEntries) {
    const cache = readDocsCache(writeCacheFile(dir, { version: 1, browser: bad, desktop: good }))
    assert.equal(cache.browser, null)
    assert.deepEqual(cache.desktop, good)
  }
})

test('readDocsCache rejects an entry whose docsHash does not match its docs', () => {
  const dir = tempDir()
  const good = fakeEntry()
  const tampered = { ...good, instructions: 'Changed fake instructions.' }
  const cache = readDocsCache(writeCacheFile(dir, { version: 1, browser: tampered, desktop: good }))
  assert.equal(cache.browser, null)
  assert.deepEqual(cache.desktop, good)
})

test('readDocsCache enforces the 64 KiB per-string limit', () => {
  const dir = tempDir()
  const good = fakeEntry()
  const longText = 'x'.repeat(64 * 1024 + 1)
  const tools = { js: longText }
  const docsHash = hashText(canonicalJson({ instructions: null, tools }))
  const overlongDocs = { ...good, instructions: null, tools, docsHash }
  const cache = readDocsCache(writeCacheFile(dir, {
    version: 1, browser: overlongDocs, desktop: good,
  }))
  assert.equal(cache.browser, null)
  assert.deepEqual(cache.desktop, good)
  const names = readDocsCache(writeCacheFile(dir, {
    version: 1, browser: { ...good, toolNames: [longText] }, desktop: null,
  }))
  assert.equal(names.browser, null)
})

// P1-1: keep the process HOME under the OS temp dir before any cache write.
const testHome = tempDir()
process.env.HOME = testHome
process.env.USERPROFILE = testHome
assertTempHome()

test('writeDocsCacheEntry reports a failure, removes the temp file and never throws', () => {
  const dir = tempDir()
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const badParent = writeDocsCacheEntry(join(blocker, 'cache.json'), 'browser', fakeEntry())
  assert.equal(badParent.ok, false)
  assert.equal(typeof badParent.reason, 'string')
  assert.equal(badParent.reason.length > 0, true)
  assert.deepEqual(tempFiles(dir), [])
  // Renaming over an existing directory also fails; its temp file must be removed too.
  const directoryTarget = join(dir, 'cache-as-directory.json')
  mkdirSync(directoryTarget)
  assert.equal(writeDocsCacheEntry(directoryTarget, 'browser', fakeEntry()).ok, false)
  assert.deepEqual(tempFiles(dir), [])
})

test('writeDocsCacheEntry rejects an unknown target without writing', () => {
  const dir = tempDir()
  const file = join(dir, 'cache.json')
  assert.deepEqual(writeDocsCacheEntry(file, 'tablet', fakeEntry()), {
    ok: false, reason: 'invalid target',
  })
  assert.equal(existsSync(file), false)
})

const SERVER_DOCS = docsFromServer({ instructions: FAKE_INSTRUCTIONS, tools: FAKE_TOOLS })

test('composeDescription joins instructions, js docs and appendix', () => {
  assert.equal(
    composeDescription(SERVER_DOCS, 'js', 'Fake plugin rules.'),
    `${FAKE_INSTRUCTIONS}\n\nFake js description.\n\nFake plugin rules.`,
  )
})

test('composeDescription omits null instructions and keeps an empty appendix segment', () => {
  const docs = { ...SERVER_DOCS, instructions: null }
  assert.equal(composeDescription(docs, 'js', ''), 'Fake js description.\n\n')
})

test('composeDescription uses only the tool docs for reset tools', () => {
  assert.equal(
    composeDescription(SERVER_DOCS, 'js_reset', 'Fake reset rules.'),
    'Fake reset description.\n\nFake reset rules.',
  )
  assert.equal(
    composeDescription(SERVER_DOCS, 'js_add_node_module_dir', 'Fake dir rules.'),
    'Fake module directory description.\n\nFake dir rules.',
  )
})

test('composeDescription returns null when the tool doc is missing', () => {
  assert.equal(composeDescription(SERVER_DOCS, 'js_unknown', 'x'), null)
  assert.equal(composeDescription({ tools: {} }, 'js', 'x'), null)
  assert.equal(composeDescription({}, 'js_reset', 'x'), null)
  assert.equal(composeDescription(null, 'js', 'x'), null)
})
