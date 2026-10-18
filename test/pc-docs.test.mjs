// D1/D2: pc_codex_docs reads Codex's own computer-use docs from a fake Codex home.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { registerPlugin } from './helpers.mjs'

const TOPICS = ['skill', 'guidance', 'api', 'confirmations']
const UNIFIED = '26.1013.31256'
const EXPLANATION_LINES = [
  'In DSH this document maps to the following:',
  '- `node_repl` JavaScript runs through the `pc_codex_js` tool.',
  '- Reset the JavaScript session with `pc_codex_js_reset`.',
  '- Run the code from the Initialize section inside `pc_codex_js`.',
  '- Desktop approvals appear as DSH approval cards.',
]

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-pc-use-docs-'))
}

/** Write the unified-computer-use entry `resolveCodexServer` reads. O(1). */
function writeUnified(codexHome, version) {
  const dir = join(
    codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', version,
  )
  mkdirSync(dir, { recursive: true })
  const config = {
    mcpServers: {
      cua_repl: { command: process.execPath, args: [], env: {}, env_vars: [] },
    },
  }
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify(config))
}

/** Relative path per topic inside one computer-use version directory. O(1). */
function docPath(topic) {
  if (topic === 'skill') return ['skills', 'computer-use', 'SKILL.md']
  return ['docs', `${topic}.md`]
}

/** Write one version directory with the given docs. O(total bytes). */
function writeDocsVersion(codexHome, version, docs) {
  for (const topic of Object.keys(docs)) {
    const dir = join(
      codexHome, 'plugins', 'cache', 'openai-bundled', 'computer-use', version,
      ...docPath(topic).slice(0, -1),
    )
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, docPath(topic).at(-1)), docs[topic])
  }
}

function docsFor(version, missing = null) {
  const docs = {}
  for (const topic of TOPICS) {
    if (topic === missing) continue
    docs[topic] = `# ${topic} ${version}\ncontent-${topic}-${version}\n`
  }
  return docs
}

function register(codexHome, config = {}) {
  return registerPlugin({
    codexHome,
    logFile: join(codexHome, 'bridge.log'),
    ...config,
  })
}

function sourceLine(text) {
  return text.split('\n')[0]
}

test('each topic returns source, explanation and the raw file bytes', async () => {
  const home = tempHome()
  writeUnified(home, UNIFIED)
  const docs = docsFor(UNIFIED)
  writeDocsVersion(home, UNIFIED, docs)
  const plugin = register(home)
  try {
    const tool = plugin.tools.get('pc_codex_docs')
    assert.ok(tool)
    for (const topic of TOPICS) {
      const text = await tool.execute({ topic }, {})
      assert.equal(text.startsWith('Source: '), true)
      const versionPattern = new RegExp(`Codex computer-use ${UNIFIED.replaceAll('.', '\\.')}`)
      assert.match(sourceLine(text), versionPattern)
      for (const line of EXPLANATION_LINES) assert.equal(text.includes(line), true, line)
      assert.equal(text.endsWith(docs[topic]), true)
    }
  } finally {
    plugin.dispose()
  }
})

test('the currently used version wins over a newer computer-use version', async () => {
  const home = tempHome()
  writeUnified(home, UNIFIED)
  writeDocsVersion(home, UNIFIED, docsFor(UNIFIED))
  writeDocsVersion(home, '26.1014.1', docsFor('26.1014.1'))
  const plugin = register(home)
  try {
    const text = await plugin.tools.get('pc_codex_docs').execute({ topic: 'api' }, {})
    assert.match(sourceLine(text), /26\.1013\.31256/)
    assert.equal(text.endsWith(docsFor(UNIFIED).api), true)
  } finally {
    plugin.dispose()
  }
})

test('without a matching version the newest version is used, compared numerically', async () => {
  const home = tempHome()
  writeUnified(home, '26.1011.1')
  writeDocsVersion(home, '26.1013.9', docsFor('26.1013.9'))
  writeDocsVersion(home, '26.1013.31256', docsFor('26.1013.31256'))
  // A non-version directory must never win over a numeric version (R20).
  mkdirSync(join(home, 'plugins', 'cache', 'openai-bundled', 'computer-use', 'zzz-tmp'))
  const plugin = register(home)
  try {
    const text = await plugin.tools.get('pc_codex_docs').execute({ topic: 'api' }, {})
    assert.match(sourceLine(text), /26\.1013\.31256/)
    assert.equal(text.endsWith(docsFor('26.1013.31256').api), true)
  } finally {
    plugin.dispose()
  }
})

test('an invalid topic lists the four values and reads no file', async () => {
  const home = tempHome()
  const plugin = register(home)
  try {
    const tool = plugin.tools.get('pc_codex_docs')
    for (const topic of ['../x', 'API', '']) {
      await assert.rejects(() => tool.execute({ topic }, {}), (error) => {
        assert.ok(error instanceof Error)
        for (const legal of TOPICS) assert.match(error.message, new RegExp(legal))
        assert.equal(error.message.includes(home), false)
        return true
      })
    }
  } finally {
    plugin.dispose()
  }
})

test('a missing file fails with the expected path instead of an empty string', async () => {
  const home = tempHome()
  writeUnified(home, UNIFIED)
  writeDocsVersion(home, UNIFIED, docsFor(UNIFIED, 'api'))
  const plugin = register(home)
  try {
    const expected = join(
      home, 'plugins', 'cache', 'openai-bundled', 'computer-use', UNIFIED, 'docs', 'api.md',
    )
    await assert.rejects(
      () => plugin.tools.get('pc_codex_docs').execute({ topic: 'api' }, {}),
      (error) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message.includes(expected), true)
        return true
      },
    )
  } finally {
    plugin.dispose()
  }
})

test('a file larger than 512 KB is refused with its size', async () => {
  const home = tempHome()
  writeUnified(home, UNIFIED)
  const docs = docsFor(UNIFIED)
  docs.api = 'x'.repeat(512 * 1024 + 10)
  writeDocsVersion(home, UNIFIED, docs)
  const plugin = register(home)
  try {
    await assert.rejects(
      () => plugin.tools.get('pc_codex_docs').execute({ topic: 'api' }, {}),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /524298/)
        assert.match(error.message, /512 KB/)
        return true
      },
    )
  } finally {
    plugin.dispose()
  }
})

test('tools.docs:false does not register pc_codex_docs', () => {
  const home = tempHome()
  const plugin = register(home, { tools: { docs: false } })
  try {
    assert.equal(plugin.tools.has('pc_codex_docs'), false)
    assert.equal(plugin.tools.has('pc_codex_js'), true)
  } finally {
    plugin.dispose()
  }
})
