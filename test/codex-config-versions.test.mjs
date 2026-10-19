// r20: the version directory listing shared by the browser resolver and the docs resolver
// only accepts numeric directory names; a numeric file is not a version.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveComputerUseDocs, versionFromSource } from '../lib/codex-config.js'
import { tempDir } from './helpers.mjs'

const TOPICS = ['skill', 'guidance', 'api', 'confirmations']

/** Write the four docs for one computer-use version. O(total bytes). */
function writeDocs(home, version) {
  for (const topic of TOPICS) {
    const segments = topic === 'skill'
      ? ['skills', 'computer-use', 'SKILL.md']
      : ['docs', `${topic}.md`]
    const dir = join(
      home, 'plugins', 'cache', 'openai-bundled', 'computer-use', version,
      ...segments.slice(0, -1),
    )
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, segments.at(-1)), `# ${topic} ${version}\n`)
  }
}

test('versionFromSource only accepts unified-computer-use/<version>/.mcp.json', () => {
  const browser = join('cache', 'unified-computer-use', '26.1013.31256', '.mcp.json')
  assert.equal(versionFromSource(browser), '26.1013.31256')
  // Not a .mcp.json file.
  assert.equal(versionFromSource(join('cache', 'unified-computer-use', '26.1013.31256',
    'config.toml')), null)
  // A numeric directory outside the unified-computer-use cache.
  assert.equal(versionFromSource(join('cache', 'other', '2026', '.mcp.json')), null)
  // A desktop source under a numeric Codex home must not look like a version.
  assert.equal(versionFromSource(join('/mnt/d/', '2026-codex', 'config.toml')), null)
  // A non-numeric version directory.
  assert.equal(versionFromSource(join('cache', 'unified-computer-use', 'abc', '.mcp.json')),
    null)
  assert.equal(versionFromSource(''), null)
  assert.equal(versionFromSource(null), null)
})

test('numeric directories are versions; files and other names are skipped', () => {
  const home = tempDir('pc-use-versions-')
  const root = join(home, 'plugins', 'cache', 'openai-bundled', 'computer-use')
  writeDocs(home, '9')
  writeDocs(home, '10')
  mkdirSync(join(root, 'abc'), { recursive: true })
  // A numeric file is not a version directory.
  writeFileSync(join(root, '11'), 'not a directory')

  assert.equal(resolveComputerUseDocs({ codexHome: home }).version, '10')
  assert.equal(resolveComputerUseDocs({ codexHome: home, preferVersion: '9' }).version, '9')
  assert.equal(resolveComputerUseDocs({ codexHome: home, preferVersion: '11' }).version, '10')
})
