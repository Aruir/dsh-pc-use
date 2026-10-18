// C: the top-level return hint is appended to both js tools' results.
// D/E: desktop tool descriptions and the docs mapping carry their guidance.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { TEXT } from '../lib/text.js'
import { registerPlugin, tempDir, useHome, writeCodexHome } from './helpers.mjs'

const ERROR_SERVER = fileURLToPath(
  new URL('./fixtures/fake-illegal-return-server.mjs', import.meta.url),
)

function setup() {
  const home = tempDir('pc-use-guidance-')
  const restore = useHome(home)
  const codexHome = join(home, 'codex')
  const log = join(home, 'server.log')
  writeFileSync(log, '')
  writeCodexHome(codexHome, [ERROR_SERVER, log], {}, { desktop: true })
  const plugin = registerPlugin({
    codexHome,
    computer: true,
    language: 'zh',
    logFile: join(home, 'bridge.log'),
  })
  return { home, restore, plugin }
}

test('both js tools append the top-level return hint on that parser error', async () => {
  const context = setup()
  try {
    for (const name of ['pc_codex_js', 'pc_codex_desktop_js']) {
      await assert.rejects(
        context.plugin.tools.get(name).execute({ code: 'return 1', title: 'ret' }, {}),
        (error) => {
          assert.match(error.message, /Illegal return statement/)
          assert.match(error.message, /去掉顶层 return/)
          return true
        },
      )
    }
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('a normal js result gets no top-level return hint', async () => {
  const context = setup()
  try {
    const result = await context.plugin.tools.get('pc_codex_js')
      .execute({ code: '1 + 1', title: 'ok' }, {})
    assert.match(result, /ran js/)
    assert.equal(result.includes('去掉顶层 return'), false)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('desktop tools and docs explain that the model should close the apps it opened', () => {
  const plugin = registerPlugin({})
  try {
    const desktop = plugin.tools.get('pc_codex_desktop_js').description
    assert.equal(desktop.includes(TEXT.en.notes.closeApps), true)
    const docs = plugin.tools.get('pc_codex_docs').description
    assert.match(docs, /desktop `node_repl` only/)
    assert.match(docs, /browser-side guide is returned by the first `pc_codex_js` call/)
    assert.equal(TEXT.zh.notes.closeApps.includes('关闭本次由它打开的应用'), true)
  } finally {
    plugin.dispose()
  }
})

test('the docs mapping carries the close-apps instruction', async () => {
  const home = tempDir('pc-use-guidance-docs-')
  const restore = useHome(home)
  const version = '26.1013.31256'
  const skill = join(
    home, 'plugins', 'cache', 'openai-bundled', 'computer-use', version,
    'skills', 'computer-use', 'SKILL.md',
  )
  mkdirSync(join(skill, '..'), { recursive: true })
  writeFileSync(skill, '# skill\n')
  const unified = join(
    home, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', version,
  )
  mkdirSync(unified, { recursive: true })
  writeFileSync(join(unified, '.mcp.json'), JSON.stringify({
    mcpServers: { cua_repl: { command: process.execPath, args: [], env: {}, env_vars: [] } },
  }))
  const plugin = registerPlugin({ codexHome: home, logFile: join(home, 'bridge.log') })
  try {
    const text = await plugin.tools.get('pc_codex_docs').execute({ topic: 'skill' }, {})
    assert.equal(text.includes(TEXT.en.notes.closeApps), true)
  } finally {
    plugin.dispose()
    restore()
  }
})
