// r26: the Codex computer-use skill provider. Every SKILL.md here is invented short text; the
// Codex home and HOME are temporary directories, and no server process is started.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { test } from 'node:test'

import { parseSkillFile, readCodexSkill, SKILL_DSH_NOTES, SKILL_NAME } from '../lib/codex-skill.js'
import { registerPlugin, tempDir, useHome, writeCodexHome } from './helpers.mjs'

const VERSION = '26.1013.31256'
const OLDER = '25.0101.00000'
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DESCRIPTION = 'Fake computer-use skill for tests.'
const BODY = 'Fake skill body line one.\n\nFake line two.'

/** One invented SKILL.md, LF endings unless `crlf` is set. O(lines). */
function skillText({ description = DESCRIPTION, body = BODY, crlf = false } = {}) {
  const text = `---\nname: computer-use:computer-use\ndescription: ${description}\n---\n${body}\n`
  return crlf ? text.replaceAll('\n', '\r\n') : text
}

/** Write one invented SKILL.md into a fake computer-use version; returns its path. O(1). */
function writeSkill(codexHome, version, text) {
  const dir = join(codexHome, 'plugins', 'cache', 'openai-bundled', 'computer-use', version,
    'skills', 'computer-use')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, text)
  return file
}

/** A fake `ctx.skills` service: records the provider and counts invalidations. O(1). */
function fakeSkills({ throwOnRegister = false } = {}) {
  const control = {
    invalidations: 0,
    invalidate() {
      this.invalidations += 1
    },
  }
  const providers = []
  const service = {
    registerProvider(create) {
      if (throwOnRegister) throw new Error('fake registerProvider failure')
      providers.push(create(control))
      return () => {}
    },
  }
  return { service, control, providers }
}

/** Apply the plugin with a temp HOME, a fake Codex skill and the fake skills service. O(1). */
function setup(options = {}) {
  const home = tempDir('dsh-pc-use-skill-')
  const restoreHome = useHome(home)
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [])
  writeSkill(codexHome, VERSION, options.text ?? skillText())
  const fake = options.skills ?? fakeSkills()
  const logFile = join(home, 'bridge.log')
  const plugin = registerPlugin({
    codexHome,
    computer: options.computer ?? true,
    logFile,
    ...(options.config ?? {}),
  }, { services: { skills: fake.service } })
  return {
    home,
    codexHome,
    logFile,
    fake,
    plugin,
    restore() {
      plugin.dispose()
      restoreHome()
    },
  }
}

test('parseSkillFile trims values and removes one pair of surrounding quotes', () => {
  const doubleQuoted = '---\ndescription:   "Quoted description"   \n---\nBody\n'
  const singleQuoted = "---\ndescription: 'Single quoted'\n---\nBody\n"
  assert.deepEqual(parseSkillFile(doubleQuoted), {
    description: 'Quoted description',
    body: 'Body',
  })
  assert.deepEqual(parseSkillFile(singleQuoted), { description: 'Single quoted', body: 'Body' })
})

test('parseSkillFile rejects missing frontmatter, missing description and empty bodies', () => {
  assert.equal(parseSkillFile('Body only'), null)
  assert.equal(parseSkillFile('---\nname: x\n'), null)
  assert.equal(parseSkillFile('---\nname: x\n---\nBody\n'), null)
  assert.equal(parseSkillFile('---\ndescription: d\n---\n   \n\n'), null)
})

test('parseSkillFile enforces the 1024-character description limit', () => {
  const long = skillText({ description: 'x'.repeat(1025) })
  const limit = skillText({ description: 'x'.repeat(1024) })
  assert.equal(parseSkillFile(long), null)
  assert.equal(parseSkillFile(limit).description.length, 1024)
})

test('parseSkillFile ignores unrecognised frontmatter lines', () => {
  const raw = [
    '---',
    'name: computer-use:computer-use',
    'this line has no colon pair',
    '  continuation: ignored',
    `description: ${DESCRIPTION}`,
    '---',
    BODY,
    '',
  ].join('\n')
  assert.deepEqual(parseSkillFile(raw), { description: DESCRIPTION, body: BODY })
})

test('readCodexSkill returns null for a missing, non-file or oversized SKILL.md', () => {
  const home = tempDir('dsh-pc-use-skill-')
  const codexHome = join(home, 'codex')
  assert.equal(readCodexSkill({ codexHome }), null)
  // A directory where the file should be.
  const dir = join(codexHome, 'plugins', 'cache', 'openai-bundled', 'computer-use', VERSION,
    'skills', 'computer-use', 'SKILL.md')
  mkdirSync(dir, { recursive: true })
  assert.equal(readCodexSkill({ codexHome }), null)
  rmSync(dir, { recursive: true, force: true })
  // A valid SKILL.md whose size is over the 64 KiB limit must still be refused.
  const oversized = skillText({ body: 'x'.repeat(64 * 1024) })
  writeSkill(codexHome, VERSION, oversized)
  assert.equal(readCodexSkill({ codexHome }), null)
})

test('readCodexSkill uses preferVersion, else the newest version', () => {
  const home = tempDir('dsh-pc-use-skill-')
  const codexHome = join(home, 'codex')
  writeSkill(codexHome, VERSION, skillText({ description: 'Newest version description.' }))
  writeSkill(codexHome, OLDER, skillText({ description: 'Older version description.' }))
  const preferred = readCodexSkill({ codexHome, preferVersion: OLDER })
  assert.equal(preferred.version, OLDER)
  assert.equal(preferred.description, 'Older version description.')
  assert.equal(preferred.versionDir, join(
    codexHome, 'plugins', 'cache', 'openai-bundled', 'computer-use', OLDER,
  ))
  const fallback = readCodexSkill({ codexHome, preferVersion: '99.9999.99999' })
  assert.equal(fallback.version, VERSION)
  assert.equal(fallback.description, 'Newest version description.')
})

test('computer off: list returns no candidate and get returns undefined', async () => {
  const context = setup({ computer: false })
  try {
    const provider = context.fake.providers[0]
    assert.deepEqual(await provider.list({}), [])
    assert.equal(await provider.get({}, {}), undefined)
  } finally {
    context.restore()
  }
})

test('computer on: list returns the candidate and get appends the DSH notes', async () => {
  const context = setup()
  try {
    const provider = context.fake.providers[0]
    const [candidate] = await provider.list({})
    assert.equal(candidate.name, SKILL_NAME)
    assert.match(candidate.name, NAME_RE)
    assert.equal(candidate.description, DESCRIPTION)
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(candidate.provider, 'dsh-pc-use')
    assert.equal(candidate.source, 'custom')
    assert.equal(candidate.rank, 600)
    const versionDir = join(
      context.codexHome, 'plugins', 'cache', 'openai-bundled', 'computer-use', VERSION,
    ).split(sep).join('/')
    assert.equal(candidate.path, join(versionDir.split('/').join(sep), 'skills', 'computer-use',
      'SKILL.md'))
    assert.deepEqual(candidate.locator, { file: candidate.path })
    assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: versionDir })
    const definition = await provider.get(candidate, {})
    assert.equal(definition.name, candidate.name)
    assert.equal(definition.description, DESCRIPTION)
    assert.equal(definition.path, candidate.path)
    assert.equal(definition.content, `${BODY}\n\n${SKILL_DSH_NOTES}`)
    assert.equal(definition.content.startsWith(BODY), true)
    assert.equal(definition.content.endsWith(SKILL_DSH_NOTES), true)
    assert.equal(definition.content.slice(BODY.length, BODY.length + 2), '\n\n')
    assert.equal('rank' in definition, false)
    assert.equal('locator' in definition, false)
  } finally {
    context.restore()
  }
})

test('get uses the version directory of the SKILL.md it read', async () => {
  const context = setup()
  try {
    const provider = context.fake.providers[0]
    const [candidate] = await provider.list({})
    const newer = '27.0101.00000'
    writeSkill(context.codexHome, newer, skillText({ body: 'Version B body.' }))
    rmSync(join(
      context.codexHome, 'plugins', 'cache', 'openai-bundled', 'computer-use', VERSION,
    ), { recursive: true, force: true })
    const definition = await provider.get(candidate, {})
    assert.equal(definition.content, `Version B body.\n\n${SKILL_DSH_NOTES}`)
    const versionDir = join(
      context.codexHome, 'plugins', 'cache', 'openai-bundled', 'computer-use', newer,
    ).split(sep).join('/')
    assert.equal(definition.resourceBase.path, versionDir)
    assert.equal(definition.path.endsWith(join(
      'computer-use', newer, 'skills', 'computer-use', 'SKILL.md',
    )), true)
  } finally {
    context.restore()
  }
})

test('desktop js tool off: list returns no candidate', async () => {
  const context = setup({ config: { tools: { desktopJs: false } } })
  try {
    assert.deepEqual(await context.fake.providers[0].list({}), [])
  } finally {
    context.restore()
  }
})

test('a deleted SKILL.md makes get return undefined and a rewrite is picked up', async () => {
  const context = setup()
  try {
    const provider = context.fake.providers[0]
    const [candidate] = await provider.list({})
    rmSync(candidate.path)
    assert.equal(await provider.get(candidate, {}), undefined)
    writeFileSync(candidate.path, skillText({ description: 'Changed.', body: 'Changed body.' }))
    const updated = await provider.get(candidate, {})
    assert.equal(updated.description, 'Changed.')
    assert.equal(updated.content, `Changed body.\n\n${SKILL_DSH_NOTES}`)
  } finally {
    context.restore()
  }
})

test('an aborted signal makes list return no candidate', async () => {
  const context = setup()
  try {
    const controller = new AbortController()
    controller.abort()
    const provider = context.fake.providers[0]
    assert.deepEqual(await provider.list({ signal: controller.signal }), [])
    assert.equal(await provider.get({}, { signal: controller.signal }), undefined)
  } finally {
    context.restore()
  }
})

test('loader/volatile-update invalidates the skill catalog', () => {
  const context = setup()
  try {
    assert.equal(context.fake.control.invalidations, 0)
    context.plugin.emit('loader/volatile-update')
    assert.equal(context.fake.control.invalidations, 1)
  } finally {
    context.restore()
  }
})

test('a throwing registerProvider only logs and keeps the nine tools', () => {
  const context = setup({ skills: fakeSkills({ throwOnRegister: true }) })
  try {
    assert.equal(context.plugin.tools.size, 9)
    assert.equal(
      readFileSync(context.logFile, 'utf8').includes('skill provider registration failed'),
      true,
    )
  } finally {
    context.restore()
  }
})
