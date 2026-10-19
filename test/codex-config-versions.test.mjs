// r20: the version directory listing shared by the browser resolver and the docs resolver
// only accepts numeric directory names; a numeric file is not a version.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveComputerUseDocs } from '../lib/codex-config.js'
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
