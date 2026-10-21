// D18: desktop approvals use a three-option DSH question card when the approval policy
// is "ask" and the user-questions service is available; every other case keeps the
// 0.4.1 one-shot approval card.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

const SERVER = process.env.CODEX_CU_DESKTOP_SERVER
  ?? fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))

const ONCE = '允许这一次'
const SESSION = '本次会话内允许'
const DENY = '拒绝'
const HEADER = '桌面授权'
const QUESTION = 'Codex Computer Use 请求操作“记事本”，是否允许？'
const ONCE_DESCRIPTION = '只允许这一步操作，下次操作该应用时再询问。'
const SESSION_DESCRIPTION = '在本次 DSH 会话中操作“记事本”时不再询问；重新连接或重启后失效。'
const DENY_DESCRIPTION = '不允许这一步操作。'

/** Fake approval service: policy plus the 0.4.1 one-shot request path. O(1). */
function approvalService(options = {}) {
  const requests = []
  return {
    requests,
    service: {
      effectivePolicy() {
        if (options.policyError === true) throw new Error('policy read failed')
        return options.policy ?? 'ask'
      },
      request(parameters) {
        requests.push(parameters)
        return Promise.resolve(options.outcome ?? 'allowed-once')
      },
    },
  }
}

/** Fake user-questions service returning one fixed answer batch or throwing it. O(1). */
function questionsService(answer) {
  const requests = []
  return {
    requests,
    service: {
      async ask(request) {
        requests.push(request)
        const value = typeof answer === 'function' ? answer(request) : answer
        if (value instanceof Error) throw value
        return value
      },
    },
  }
}

/** A user-questions service that keeps the card open until the test settles it. O(1). */
function pendingQuestions() {
  const requests = []
  return {
    requests,
    service: {
      ask(request) {
        return new Promise((resolve, reject) => {
          requests.push({ request, resolve, reject })
          request.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' }))
          }, { once: true })
        })
      },
    },
  }
}

/** One selected label as the answer batch the service returns. O(1). */
function picked(label) {
  return { answers: [{ id: 'desktop-approval', selected: [label] }] }
}

function setup(options = {}) {
  const home = tempDir('pc-use-choices-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const logFile = join(home, 'bridge.log')
  const codexHome = join(home, 'codex')
  // The desktop server comes from [mcp_servers.node_repl]; the browser source is unused.
  writeCodexHome(
    codexHome,
    [SERVER, options.mode ?? 'flow-meta', serverLog],
    {},
    { desktop: true },
  )
  const plugin = registerPlugin({
    codexHome,
    computer: true,
    rememberDesktopApprovals: options.remember,
    language: options.language ?? 'zh',
    // A legacy profile may still carry this removed field; it must be ignored.
    ...(options.legacyChoices === undefined ? {} : {
      desktopApprovalChoices: options.legacyChoices,
    }),
    logFile,
  }, { services: options.services ?? {} })
  return { home, restore, serverLog, logFile, plugin }
}

function execFor(callId = 'call-1') {
  return {
    agent: { id: 'agent-choice', session: { id: 'session-choice' } },
    name: 'pc_codex_desktop_js',
    callId,
    signal: new AbortController().signal,
  }
}

function runJs(context, exec = execFor(), code = '记事本@app') {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code, title: 'desktop choice' }, exec)
}

function serverAnswers(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('answer '))
}

function approvalLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('approval "'))
}

function finish(context) {
  context.plugin.dispose()
  context.restore()
}

function choiceServices(options = {}) {
  const approval = approvalService(options.approval)
  const questions = questionsService(options.answer)
  return {
    approval,
    questions,
    services: { approval: approval.service, userQuestions: questions.service },
  }
}

test('the three-option card shows the documented labels and descriptions', async () => {
  const { approval, questions, services } = choiceServices({ answer: picked(ONCE) })
  const context = setup({ services })
  try {
    const exec = execFor('call-1')
    const result = await runJs(context, exec)
    assert.match(result, /decision accept/)
    assert.equal(approval.requests.length, 0)
    assert.equal(questions.requests.length, 1)
    const request = questions.requests[0]
    assert.equal(request.questions.length, 1)
    const question = request.questions[0]
    assert.equal(question.header, HEADER)
    assert.equal(question.question, QUESTION)
    assert.equal(question.multiSelect, false)
    assert.deepEqual(question.options, [
      { label: ONCE, description: ONCE_DESCRIPTION },
      { label: SESSION, description: SESSION_DESCRIPTION },
      { label: DENY, description: DENY_DESCRIPTION },
    ])
    assert.equal(typeof request.signal?.addEventListener, 'function')
    assert.deepEqual(serverAnswers(context.serverLog), ['answer accept'])
    // "允许这一次" is not remembered: the same agent and app ask again.
    await runJs(context, { ...exec, callId: 'call-2' })
    assert.equal(questions.requests.length, 2)
    assert.equal(approval.requests.length, 0)
  } finally {
    finish(context)
  }
})

test('"本次会话内允许" remembers the app for this DSH session', async () => {
  const { approval, questions, services } = choiceServices({ answer: picked(SESSION) })
  const context = setup({ services })
  try {
    const exec = execFor('call-1')
    const first = await runJs(context, exec)
    assert.match(first, /decision accept/)
    const second = await runJs(context, { ...exec, callId: 'call-2' })
    assert.match(second, /decision accept/)
    assert.equal(questions.requests.length, 1)
    assert.equal(approval.requests.length, 0)
    assert.deepEqual(serverAnswers(context.serverLog), ['answer accept', 'answer accept'])
    assert.equal(
      approvalLines(context.logFile).some((line) => line.includes('approved for this DSH session')),
      true,
    )
  } finally {
    finish(context)
  }
})

test('"拒绝" declines the request', async () => {
  const { questions, services } = choiceServices({ answer: picked(DENY) })
  const context = setup({ services })
  try {
    const result = await runJs(context)
    assert.match(result, /decision decline/)
    assert.equal(questions.requests.length, 1)
    assert.deepEqual(serverAnswers(context.serverLog), ['answer decline'])
    assert.equal(
      approvalLines(context.logFile).some((line) => line.includes('rejected in DSH')),
      true,
    )
  } finally {
    finish(context)
  }
})

test('rememberDesktopApprovals:false offers only allow-once and deny', async () => {
  const { questions, services } = choiceServices({ answer: picked(ONCE) })
  const context = setup({ remember: false, services })
  try {
    const result = await runJs(context)
    assert.match(result, /decision accept/)
    const options = questions.requests[0].questions[0].options
    assert.deepEqual(options.map((option) => option.label), [ONCE, DENY])
  } finally {
    finish(context)
  }
})

test('a request without the session persist scope offers only two options', async () => {
  const { questions, services } = choiceServices({ answer: picked(ONCE) })
  const context = setup({ mode: 'flow-meta-nosession', services })
  try {
    await runJs(context)
    const options = questions.requests[0].questions[0].options
    assert.deepEqual(options.map((option) => option.label), [ONCE, DENY])
  } finally {
    finish(context)
  }
})

test('a label that was not offered is refused', async () => {
  const { services } = choiceServices({ answer: picked(SESSION) })
  const context = setup({ remember: false, services })
  try {
    const result = await runJs(context)
    assert.match(result, /decision decline/)
    assert.equal(
      approvalLines(context.logFile).some((line) => line.includes('no valid choice')),
      true,
    )
  } finally {
    finish(context)
  }
})

for (const [name, answer] of [
  ['custom text', { answers: [{ id: 'desktop-approval', selected: [], custom: '让我想想' }] }],
  ['an empty selection', { answers: [{ id: 'desktop-approval', selected: [] }] }],
  ['an unknown label', { answers: [{ id: 'desktop-approval', selected: ['稍后'] }] }],
]) {
  test(`a card answer with ${name} is refused`, async () => {
    const { services } = choiceServices({ answer })
    const context = setup({ services })
    try {
      const result = await runJs(context)
      assert.match(result, /decision decline/)
      assert.deepEqual(serverAnswers(context.serverLog), ['answer decline'])
      assert.equal(
        approvalLines(context.logFile).some((line) => line.includes('no valid choice')),
        true,
      )
    } finally {
      finish(context)
    }
  })
}

test('an ask() failure is refused', async () => {
  const { services } = choiceServices({
    answer: () => Object.assign(new Error('question backend failed'), { code: 'ASK_FAILED' }),
  })
  const context = setup({ services })
  try {
    const result = await runJs(context)
    assert.match(result, /decision decline/)
    assert.deepEqual(serverAnswers(context.serverLog), ['answer decline'])
  } finally {
    finish(context)
  }
})

test('policy never keeps the one-shot approval card', async () => {
  const { approval, questions, services } = choiceServices({
    approval: { policy: 'never', outcome: 'rejected' },
    answer: picked(ONCE),
  })
  const context = setup({ services })
  try {
    const result = await runJs(context)
    assert.match(result, /decision decline/)
    assert.equal(questions.requests.length, 0)
    assert.equal(approval.requests.length, 1)
    assert.equal(
      approvalLines(context.logFile).some((line) => line.includes('rejected in DSH')),
      true,
    )
  } finally {
    finish(context)
  }
})

test('a policy read error keeps the one-shot approval card', async () => {
  const { approval, questions, services } = choiceServices({ approval: { policyError: true } })
  const context = setup({ services })
  try {
    const result = await runJs(context)
    assert.match(result, /decision accept/)
    assert.equal(questions.requests.length, 0)
    assert.equal(approval.requests.length, 1)
  } finally {
    finish(context)
  }
})

test('without the questions service the one-shot approval card is used', async () => {
  const approval = approvalService()
  const context = setup({ services: { approval: approval.service } })
  try {
    const result = await runJs(context)
    assert.match(result, /decision accept/)
    assert.equal(approval.requests.length, 1)
  } finally {
    finish(context)
  }
})

test('a delegated caller falls back to the one-shot approval card', async () => {
  const { approval, questions, services } = choiceServices({
    answer: () => Object.assign(new Error('delegated'), { code: 'DELEGATED_CALLER' }),
  })
  const context = setup({ services })
  try {
    const result = await runJs(context)
    assert.match(result, /decision accept/)
    assert.equal(questions.requests.length, 1)
    assert.equal(approval.requests.length, 1)
  } finally {
    finish(context)
  }
})

test('ending the call withdraws the choice card', async () => {
  const approval = approvalService()
  const pending = pendingQuestions()
  const context = setup({
    services: { approval: approval.service, userQuestions: pending.service },
  })
  const controller = new AbortController()
  const exec = {
    agent: { id: 'agent-choice', session: { id: 'session-choice' } },
    name: 'pc_codex_desktop_js',
    callId: 'call-end',
    signal: controller.signal,
  }
  try {
    const call = runJs(context, exec)
    assert.equal(await waitFor(() => pending.requests.length === 1), true)
    controller.abort()
    const result = await call
    assert.match(result, /decision decline/)
    assert.equal(pending.requests[0].request.signal.aborted, true)
    assert.deepEqual(serverAnswers(context.serverLog), ['answer decline'])
    // A late answer that arrives after the withdrawal must not become a grant.
    pending.requests[0].resolve(picked(ONCE))
    await new Promise((done) => setTimeout(done, 100))
    assert.deepEqual(serverAnswers(context.serverLog), ['answer decline'])
  } finally {
    finish(context)
  }
})
