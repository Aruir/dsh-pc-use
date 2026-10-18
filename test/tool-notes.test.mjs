// B: user-caused desktop approval denials add a "do not retry" note to the tool result.
// The real Codex rejects with isError: true ("Computer Use was not approved to use ..."),
// so the fake server reproduces that error path; call registration keeps the note per call.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  FAKE_SERVER, registerPlugin, tempDir, useHome, waitFor, writeCodexHome,
} from './helpers.mjs'

const SERVER = fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))
const ZH_NOTE = '用户在 DSH 中没有批准对“记事本”的操作。不要重试，也不要换写法绕过；'
const EN_NOTE = 'The user did not approve operating "记事本" in DSH. Do not retry'

function approvalService() {
  return {
    service: {
      effectivePolicy: () => 'ask',
      request: () => Promise.resolve('allowed-once'),
    },
  }
}

function answer(selected) {
  return { answers: [{ id: 'desktop-approval', selected }] }
}

function questionsService(answers) {
  const queue = [...answers]
  const requests = []
  return {
    requests,
    service: {
      async ask(request) {
        requests.push(request)
        const value = queue.length > 1 ? queue.shift() : queue[0]
        return typeof value === 'function' ? value() : value
      },
    },
  }
}

function pendingQuestions() {
  let resolve
  const requests = []
  return {
    requests,
    service: {
      ask(request) {
        requests.push(request)
        return new Promise((done) => {
          resolve = done
          request.signal?.addEventListener('abort', () => done({ answers: [] }), { once: true })
        })
      },
    },
    resolve(value) {
      resolve(value)
    },
  }
}

function setup(options = {}) {
  const home = tempDir('pc-use-notes-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [FAKE_SERVER, 'ok', join(home, 'browser.log')])
  writeCodexHome(codexHome, [SERVER, options.mode ?? 'flow-meta-reject-error', serverLog], {}, {
    browser: false,
    desktop: true,
  })
  const approval = approvalService()
  const services = { approval: approval.service }
  if (options.questions !== undefined) services.userQuestions = options.questions.service
  const plugin = registerPlugin({
    codexHome,
    computer: true,
    language: options.language ?? 'zh',
    logFile: join(home, 'bridge.log'),
  }, { services })
  return { home, restore, plugin, serverLog }
}

function execFor(callId, signal = new AbortController().signal) {
  return {
    agent: { id: 'agent-notes', session: { id: 'session-notes' } },
    name: 'pc_codex_desktop_js',
    callId,
    signal,
  }
}

function run(context, exec = execFor('call-notes')) {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '记事本@app', title: 'notes' }, exec)
}

async function messageOf(promise) {
  try {
    return await promise
  } catch (error) {
    return error.message
  }
}

function finish(context) {
  context.plugin.dispose()
  context.restore()
}

test('a real isError rejection carries the Chinese no-retry note', async () => {
  const cases = [
    answer(['拒绝']),
    { answers: [{ id: 'desktop-approval', selected: [] }] },
    { answers: [{ id: 'desktop-approval', custom: '不要' }] },
  ]
  for (const value of cases) {
    const context = setup({ questions: questionsService([value]) })
    try {
      const text = await messageOf(run(context))
      assert.equal(text.includes('Computer Use was not approved'), true, text)
      assert.equal(text.includes(ZH_NOTE), true, text)
    } finally {
      finish(context)
    }
  }
})

test('the English note follows the language setting on the error path', async () => {
  const questions = questionsService([answer(['Deny'])])
  const context = setup({ questions, language: 'en' })
  try {
    const text = await messageOf(run(context))
    assert.equal(text.includes(EN_NOTE), true, text)
  } finally {
    finish(context)
  }
})

test('an automatic host approval adds no note', async () => {
  const context = setup()
  try {
    const result = await run(context)
    assert.match(result, /decision/)
    assert.equal(result.includes('没有批准'), false)
    assert.equal(result.includes('did not approve'), false)
  } finally {
    finish(context)
  }
})

test('a call-end decline adds no note', async () => {
  const questions = pendingQuestions()
  const context = setup({ questions })
  const controller = new AbortController()
  try {
    const call = run(context, execFor('call-end', controller.signal))
    assert.equal(await waitFor(() => questions.requests.length === 1), true)
    controller.abort()
    const text = await messageOf(call)
    assert.equal(text.includes('没有批准'), false, text)
    assert.equal(text.includes('did not approve'), false, text)
  } finally {
    finish(context)
  }
})

test('two concurrent desktop calls keep the denial note on the rejected call only', async () => {
  const questions = questionsService([
    answer(['拒绝']),
    answer(['允许这一次']),
  ])
  // The slow rejection keeps A active after its denial is recorded, so B really overlaps it.
  const context = setup({ questions, mode: 'flow-meta-reject-error-slow' })
  try {
    const first = run(context, execFor('call-a'))
    assert.equal(await waitFor(() => readFileSync(context.serverLog, 'utf8')
      .includes('answer decline')), true)
    const firstTextPromise = messageOf(first)
    const second = run(context, execFor('call-b'))
    const secondText = await messageOf(second)
    const firstText = await firstTextPromise
    assert.equal(firstText.includes(ZH_NOTE), true, firstText)
    assert.equal(secondText.includes('没有批准'), false, secondText)
  } finally {
    finish(context)
  }
})

test('a browser call started during the rejection does not steal the note', async () => {
  const questions = pendingQuestions()
  const context = setup({ questions, mode: 'flow-meta-reject-error-slow' })
  try {
    const desktop = run(context, execFor('call-desktop'))
    assert.equal(await waitFor(() => questions.requests.length === 1), true)
    questions.resolve(answer(['拒绝']))
    const desktopTextPromise = messageOf(desktop)
    // Wait until the denial is recorded, but before the deliberately delayed isError replies.
    assert.equal(await waitFor(() => (
      readFileSync(context.serverLog, 'utf8').includes('answer decline')
    )), true)
    // The browser call starts while the desktop rejection is being handled; with a shared
    // record it would steal the note from the desktop call.
    const browser = await context.plugin.tools.get('pc_codex_js')
      .execute({ code: '1 + 1', title: 'browser' }, {
        agent: { id: 'agent-browser', session: { id: 'session-browser' } },
        name: 'pc_codex_js',
        callId: 'call-browser',
        signal: new AbortController().signal,
      })
    const desktopText = await desktopTextPromise
    assert.equal(desktopText.includes(ZH_NOTE), true, desktopText)
    assert.equal(browser.includes('没有批准'), false, browser)
  } finally {
    finish(context)
  }
})
