// r31: a result that mentions the unavailable native pipe gets one fixed guidance note, for
// success and isError results, on both targets and in both languages.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nativePipeUnavailableNote } from '../lib/text.js'
import { startServers, stopServers } from './fixtures/server-harness.mjs'

const PHRASE = 'native pipe is unavailable'

function browserCall(context) {
  return context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'browser' }, {})
}

function desktopCall(context) {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '1', title: 'desktop' }, {})
}

test('an isError desktop result appends the note in both languages', async () => {
  for (const language of ['zh', 'en']) {
    const context = startServers({
      desktop: { mode: 'pipe-error' },
      config: { computer: true, language },
    })
    try {
      await assert.rejects(() => desktopCall(context), (error) => {
        assert.equal(error.message.includes(PHRASE), true)
        assert.equal(error.message.endsWith(`\n\n${nativePipeUnavailableNote(language)}`), true)
        return true
      })
    } finally {
      assert.equal(await stopServers(context), true)
    }
  }
})

test('a success result with the phrase gets the note; a normal result does not', async () => {
  const context = startServers({ browser: { mode: 'pipe-text' }, config: { language: 'zh' } })
  try {
    const result = await browserCall(context)
    assert.equal(result.includes(PHRASE), true)
    assert.equal(result.endsWith(`\n\n${nativePipeUnavailableNote('zh')}`), true)
  } finally {
    assert.equal(await stopServers(context), true)
  }
  const normal = startServers({ config: { language: 'zh' } })
  try {
    const result = await browserCall(normal)
    assert.equal(result.includes(PHRASE), false)
    assert.equal(result.endsWith(nativePipeUnavailableNote('zh')), false)
  } finally {
    assert.equal(await stopServers(normal), true)
  }
})

test('the browser tool applies the note to isError results too', async () => {
  const context = startServers({ browser: { mode: 'pipe-error' }, config: { language: 'zh' } })
  try {
    await assert.rejects(() => browserCall(context), (error) => {
      assert.equal(error.message.endsWith(`\n\n${nativePipeUnavailableNote('zh')}`), true)
      return true
    })
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
