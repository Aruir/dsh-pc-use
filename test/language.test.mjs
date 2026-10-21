// E1: every user-visible text exists in zh and en; the three-option card follows the
// `language` setting and the one-shot displayReason is a LocalizedText object.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Config } from '../index.js'
import { CONFIG_I18N, resolveLanguage, TEXT } from '../lib/text.js'
import { registerPlugin, tempDir, useHome, writeCodexHome } from './helpers.mjs'

const SERVER = process.env.CODEX_CU_DESKTOP_SERVER
  ?? fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))

const ZH_CARD = {
  header: '桌面授权',
  question: 'Codex Computer Use 请求操作“记事本”，是否允许？',
  once: {
    label: '允许这一次',
    description: '只允许这一步操作，下次操作该应用时再询问。',
  },
  session: {
    label: '本次会话内允许',
    description: '在本次 DSH 会话中操作“记事本”时不再询问；重新连接或重启后失效。',
  },
  deny: { label: '拒绝', description: '不允许这一步操作。' },
}

const EN_CARD = {
  header: 'Desktop approval',
  question: 'Codex Computer Use wants to operate “记事本”. Allow?',
  once: {
    label: 'Allow this time',
    description: 'Allow this step only; ask again the next time this app is used.',
  },
  session: {
    label: 'Allow for this session',
    description: 'Don\'t ask again for “记事本” in this DSH session; this ends on reconnect '
      + 'or restart.',
  },
  deny: { label: 'Deny', description: 'Don\'t allow this step.' },
}

const ZH_DISPLAY_REASON = '允许 Codex Computer Use 操作“记事本”？'
const EN_DISPLAY_REASON = 'Allow Codex Computer Use to operate “记事本”?'
const ZH_AUDIT_REASON = 'Codex Computer Use 请求操作桌面应用：记事本'
const EN_AUDIT_REASON = 'Codex Computer Use requests access to the desktop app: 记事本'

function approvalService(outcome = 'allowed-once') {
  const requests = []
  return {
    requests,
    service: {
      effectivePolicy() {
        return 'ask'
      },
      request(parameters) {
        requests.push(parameters)
        return Promise.resolve(outcome)
      },
    },
  }
}

function questionsService(answers) {
  const requests = []
  let index = 0
  return {
    requests,
    service: {
      async ask(request) {
        requests.push(request)
        const answer = answers[Math.min(index, answers.length - 1)]
        index += 1
        return answer
      },
    },
  }
}

function picked(label) {
  return { answers: [{ id: 'desktop-approval', selected: [label] }] }
}

function setup(options = {}) {
  const home = tempDir('pc-use-language-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const logFile = join(home, 'bridge.log')
  const codexHome = join(home, 'codex')
  // Desktop approvals are only raised by the desktop server; the browser server is absent.
  writeCodexHome(codexHome, [SERVER, options.mode ?? 'flow-meta', serverLog], {}, {
    browser: false,
    desktop: true,
  })
  const plugin = registerPlugin({
    codexHome,
    computer: true,
    rememberDesktopApprovals: true,
    language: options.language,
    logFile,
  }, { services: options.services ?? {} })
  return { home, restore, serverLog, logFile, plugin }
}

function execFor(callId = 'call-1') {
  return {
    agent: { id: 'agent-language', session: { id: 'session-language' } },
    name: 'pc_codex_desktop_js',
    callId,
    signal: new AbortController().signal,
  }
}

function runJs(context, exec = execFor()) {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '记事本@app', title: 'language' }, exec)
}

function serverAnswers(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('answer '))
}

function approvalLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('approval "'))
}

/** Expected question options for one of the two cards. O(1). */
function cardOptions(card) {
  return [
    { label: card.once.label, description: card.once.description },
    { label: card.session.label, description: card.session.description },
    { label: card.deny.label, description: card.deny.description },
  ]
}

function finish(context) {
  context.plugin.dispose()
  context.restore()
}

for (const [language, card] of [['zh', ZH_CARD], ['en', EN_CARD]]) {
  test(`language:${language} renders the whole card in that language`, async () => {
    const approval = approvalService()
    const questions = questionsService([picked(card.once.label)])
    const context = setup({
      language,
      services: { approval: approval.service, userQuestions: questions.service },
    })
    try {
      const result = await runJs(context)
      assert.match(result, /decision accept/)
      assert.equal(approval.requests.length, 0)
      assert.equal(questions.requests.length, 1)
      const question = questions.requests[0].questions[0]
      assert.equal(question.header, card.header)
      assert.equal(question.question, card.question)
      assert.equal(question.multiSelect, false)
      assert.deepEqual(question.options, cardOptions(card))
      assert.deepEqual(serverAnswers(context.serverLog), ['answer accept'])
    } finally {
      finish(context)
    }
  })
}

test('a Chinese card refuses an English option label', async () => {
  const questions = questionsService([picked(EN_CARD.once.label)])
  const context = setup({
    language: 'zh',
    services: { approval: approvalService().service, userQuestions: questions.service },
  })
  try {
    const result = await runJs(context)
    assert.match(result, /decision decline/)
    assert.equal(
      approvalLines(context.logFile).some((line) => line.includes('no valid choice')),
      true,
    )
    assert.deepEqual(serverAnswers(context.serverLog), ['answer decline'])
  } finally {
    finish(context)
  }
})

for (const [preference, card] of [['zh-CN', ZH_CARD], ['en-US', EN_CARD]]) {
  test(`auto follows the host locale preference ${preference}`, async () => {
    const questions = questionsService([picked(card.once.label)])
    const context = setup({
      language: 'auto',
      services: {
        approval: approvalService().service,
        userQuestions: questions.service,
        locale: { preference },
      },
    })
    try {
      await runJs(context)
      assert.equal(questions.requests[0].questions[0].header, card.header)
      assert.equal(questions.requests[0].questions[0].question, card.question)
    } finally {
      finish(context)
    }
  })
}

test('auto falls back to the system locale', async () => {
  const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale
  const expected = resolveLanguage('auto', systemLocale)
  const card = expected === 'zh' ? ZH_CARD : EN_CARD
  const questions = questionsService([picked(card.once.label)])
  const context = setup({
    language: 'auto',
    services: { approval: approvalService().service, userQuestions: questions.service },
  })
  try {
    await runJs(context)
    assert.equal(questions.requests[0].questions[0].header, card.header)
  } finally {
    finish(context)
  }
})

test('resolveLanguage maps BCP 47 tags and honours explicit zh / en', () => {
  assert.equal(resolveLanguage('auto', 'zh-CN'), 'zh')
  assert.equal(resolveLanguage('auto', 'zh-Hant-TW'), 'zh')
  assert.equal(resolveLanguage('auto', 'en-US'), 'en')
  assert.equal(resolveLanguage('auto', 'de-DE'), 'en')
  assert.equal(resolveLanguage('zh', 'en-US'), 'zh')
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en')
})

for (const [language, auditReason] of [['zh', ZH_AUDIT_REASON], ['en', EN_AUDIT_REASON]]) {
  test(`the one-shot card is localized and its audit reason follows ${language}`, async () => {
    const approval = approvalService()
    const context = setup({
      language,
      services: { approval: approval.service },
    })
    try {
      const result = await runJs(context)
      assert.match(result, /decision accept/)
      assert.equal(approval.requests.length, 1)
      assert.deepEqual(approval.requests[0].displayReason, {
        en: EN_DISPLAY_REASON,
        zh: ZH_DISPLAY_REASON,
      })
      assert.equal(approval.requests[0].reason, auditReason)
    } finally {
      finish(context)
    }
  })
}

/** Every leaf string of one text tree, keyed by its dotted path. O(n), n = leaves. */
function textLeaves(node, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') out[path] = value
    else textLeaves(value, path, out)
  }
  return out
}

test('the two text trees have identical keys and no empty strings', () => {
  const zh = textLeaves(TEXT.zh)
  const en = textLeaves(TEXT.en)
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const [key, value] of Object.entries(zh)) assert.notEqual(value.trim(), '', key)
  for (const [key, value] of Object.entries(en)) assert.notEqual(value.trim(), '', key)
})

function descriptionOf(schema, field) {
  const description = schema.meta?.description
  assert.equal(typeof description, 'object', `description missing for ${field}`)
  assert.notEqual((description.zh ?? '').trim(), '', `zh description missing for ${field}`)
  assert.notEqual((description.en ?? '').trim(), '', `en description missing for ${field}`)
}

test('every configuration field has zh and en descriptions', () => {
  descriptionOf(Config, 'the schema root')
  const fields = [
    'enabled', 'autoApprove', 'computer', 'rememberDesktopApprovals',
    'language', 'codexHome', 'logFile', 'timeoutMs', 'attachImages',
    'keepImageFiles', 'allowUserTabs', 'tools',
  ]
  for (const field of fields) {
    descriptionOf(Config.dict[field], field)
  }
  for (const tool of [
    'js', 'reset', 'desktopJs', 'desktopReset', 'desktopAddNodeModuleDir',
    'observe', 'runPlan', 'docs', 'status',
  ]) {
    descriptionOf(Config.dict.tools.dict[tool], `tools.${tool}`)
  }
})

test('the three desktop tool switches describe their tools in zh and en', () => {
  const expected = {
    desktopJs: '`pc_codex_desktop_js`',
    desktopReset: '`pc_codex_desktop_js_reset`',
    desktopAddNodeModuleDir: '`pc_codex_desktop_js_add_node_module_dir`',
  }
  for (const [key, toolName] of Object.entries(expected)) {
    for (const language of ['zh', 'en']) {
      const text = CONFIG_I18N[language].tools[key]
      assert.equal(typeof text, 'string', `${language} tools.${key}`)
      assert.equal(text.includes(toolName), true, `${language} tools.${key}`)
    }
  }
})
