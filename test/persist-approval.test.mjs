// r32: when the plugin remembers a desktop app it also tells the Codex server to remember it
// for this session, and turning the remember switch off restarts the desktop server so both
// sides forget. Fake servers/processes only; the home is temporary.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'
import {
  COMPUTER_SERVER, isRunning, startServers, stopServers,
} from './fixtures/server-harness.mjs'

const ONCE = '允许这一次'
const SESSION = '本次会话内允许'
const DENY = '拒绝'
const WRITE = Symbol.for('cosmokit.volatile.write')

/** A mutable volatile config value, like the loader writes. O(1). */
function createVolatile(value) {
  let current = value
  return Object.freeze({
    get: () => current,
    [WRITE](next) {
      current = next
    },
  })
}

function picked(label) {
  return { answers: [{ id: 'desktop-approval', selected: [label] }] }
}

function approvalService(policy = 'ask', outcomes = []) {
  const requests = []
  return {
    requests,
    service: {
      effectivePolicy: () => policy,
      request(parameters) {
        requests.push(parameters)
        return Promise.resolve(outcomes.shift() ?? 'allowed-once')
      },
    },
  }
}

function questionsService(answer) {
  const requests = []
  return {
    requests,
    service: {
      async ask(request) {
        requests.push(request)
        return typeof answer === 'function' ? answer(request) : answer
      },
    },
  }
}

/** One desktop-approval run over a temp home and the fake computer server. O(1). */
function setup(options = {}) {
  const home = tempDir('pc-use-persist-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [COMPUTER_SERVER, options.mode ?? 'flow-meta', serverLog], {},
    { desktop: true })
  const approval = options.approval ?? approvalService()
  const questions = options.questions ?? questionsService(picked(SESSION))
  const plugin = registerPlugin({
    codexHome,
    computer: true,
    rememberDesktopApprovals: options.remember ?? true,
    language: 'zh',
    logFile: join(home, 'bridge.log'),
  }, { services: { approval: approval.service, userQuestions: questions.service } })
  return {
    home,
    restore,
    serverLog,
    logFile: join(home, 'bridge.log'),
    plugin,
    approval,
    questions,
  }
}

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
  } catch {
    return []
  }
}

/** Complete approval replies recorded by the fake server. O(n). */
function replies(file) {
  const prefix = 'reply '
  return readLines(file).filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)))
}

/** The approval line without the log's timestamp prefix. O(n). */
function approvalLines(file) {
  return readLines(file)
    .filter((line) => line.includes('approval "'))
    .map((line) => line.slice(line.indexOf('approval "')))
}

function execFor(id = 'agent-persist') {
  return {
    agent: { id, session: { id: `session-${id}` } },
    name: 'pc_codex_desktop_js',
    callId: 'call-1',
    signal: new AbortController().signal,
  }
}

function runDesktop(context, exec = execFor(), code = '记事本@app') {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code, title: 'persist' }, exec)
}

function browserCall(context) {
  return context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'browser' }, {})
}

function desktopCall(context) {
  return context.plugin.tools.get('pc_codex_desktop_js').execute({ code: '1', title: 'd' }, {})
}

async function finish(context) {
  context.plugin.dispose()
  context.restore()
}

test('a session choice replies and logs persist=session', async () => {
  const context = setup()
  const exec = execFor()
  try {
    await runDesktop(context, exec)
    assert.equal(await waitFor(() => replies(context.serverLog).length === 1), true)
    assert.deepEqual(replies(context.serverLog)[0], {
      action: 'accept',
      content: {},
      _meta: { persist: 'session' },
    })
    const log = approvalLines(context.logFile)
    assert.equal(log.length, 1)
    assert.equal(log[0].endsWith(' persist=session'), true)
    assert.equal(log[0].includes('(approved for this DSH session) persist=session'), true)
    // A second call is accepted by the plugin and refreshes the server's copy too.
    await runDesktop(context, exec)
    assert.equal(await waitFor(() => replies(context.serverLog).length === 2), true)
    assert.deepEqual(replies(context.serverLog)[1], {
      action: 'accept',
      content: {},
      _meta: { persist: 'session' },
    })
    assert.equal(context.questions.requests.length, 1)
  } finally {
    await finish(context)
  }
})

test('allow once and deny keep the old reply shape and log line', async () => {
  const once = setup({ questions: questionsService(picked(ONCE)) })
  try {
    await runDesktop(once)
    assert.equal(await waitFor(() => replies(once.serverLog).length === 1), true)
    assert.deepEqual(replies(once.serverLog)[0], { action: 'accept', content: {} })
    assert.equal(approvalLines(once.logFile)[0],
      `approval ${JSON.stringify('Allow Codex to use 记事本?')} -> accept (approved once in DSH)`)
  } finally {
    await finish(once)
  }
  const deny = setup({ questions: questionsService(picked(DENY)) })
  try {
    await runDesktop(deny)
    assert.equal(await waitFor(() => replies(deny.serverLog).length === 1), true)
    assert.deepEqual(replies(deny.serverLog)[0], { action: 'decline', content: {} })
    assert.equal(approvalLines(deny.logFile)[0],
      `approval ${JSON.stringify('Allow Codex to use 记事本?')} -> decline (rejected in DSH)`)
  } finally {
    await finish(deny)
  }
})

test('a request without a session persist never gets _meta', async () => {
  for (const mode of ['flow-meta-nosession', 'flow-meta-nometa']) {
    const context = setup({ mode, questions: questionsService(picked(ONCE)) })
    try {
      await runDesktop(context)
      assert.equal(await waitFor(() => replies(context.serverLog).length === 1), true)
      assert.deepEqual(replies(context.serverLog)[0], { action: 'accept', content: {} })
      assert.equal(approvalLines(context.logFile)[0].includes('persist='), false)
    } finally {
      await finish(context)
    }
  }
})

test('an already remembered app persists only while the request asks for it', async () => {
  const context = setup({ mode: 'flow-meta-drop' })
  const exec = execFor()
  try {
    await runDesktop(context, exec)
    await runDesktop(context, exec)
    assert.equal(await waitFor(() => replies(context.serverLog).length === 2), true)
    assert.deepEqual(replies(context.serverLog)[0]._meta, { persist: 'session' })
    assert.equal('_meta' in replies(context.serverLog)[1], false)
    assert.equal(approvalLines(context.logFile)[1].includes('persist='), false)
  } finally {
    await finish(context)
  }
})

test('the one-shot card persists only when it remembers, and never sends always', async () => {
  const remembered = setup({ approval: approvalService('never') })
  try {
    await runDesktop(remembered)
    assert.equal(await waitFor(() => replies(remembered.serverLog).length === 1), true)
    assert.deepEqual(replies(remembered.serverLog)[0]._meta, { persist: 'session' })
    assert.equal(approvalLines(remembered.logFile)[0].endsWith(' persist=session'), true)
  } finally {
    await finish(remembered)
  }
  const plain = setup({ approval: approvalService('never'), remember: false })
  try {
    await runDesktop(plain)
    assert.equal(await waitFor(() => replies(plain.serverLog).length === 1), true)
    assert.equal('_meta' in replies(plain.serverLog)[0], false)
    assert.equal(approvalLines(plain.logFile)[0].includes('persist='), false)
  } finally {
    await finish(plain)
  }
  for (const context of [remembered, plain]) {
    for (const reply of replies(context.serverLog)) {
      assert.notEqual(reply._meta?.persist, 'always')
    }
    assert.equal(readFileSync(context.logFile, 'utf8').includes('persist=always'), false)
  }
})

test('turning remember off stops the desktop server and leaves the browser server', async () => {
  const remember = createVolatile(true)
  const context = startServers({ config: { computer: true, rememberDesktopApprovals: remember } })
  try {
    await browserCall(context)
    await desktopCall(context)
    const browserPid = context.browserStart()[0].pid
    const desktopPid = context.desktopStart()[0].pid
    remember[WRITE](false)
    context.plugin.emit('loader/volatile-update')
    assert.equal(await waitFor(() => !isRunning(desktopPid)), true)
    assert.equal(isRunning(browserPid), true)
    assert.equal(readFileSync(context.logFile, 'utf8')
      .includes('remember approvals turned off; stopping the desktop server'), true)
    await desktopCall(context)
    assert.equal(await waitFor(() => context.desktopStart().length === 2), true)
    assert.notEqual(context.desktopStart()[1].pid, desktopPid)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('while the switch is off, two desktop calls reuse the server', async () => {
  const remember = createVolatile(false)
  const context = startServers({ config: { computer: true, rememberDesktopApprovals: remember } })
  try {
    await desktopCall(context)
    const pid = context.desktopStart()[0].pid
    await desktopCall(context)
    assert.equal(context.desktopStart().length, 1)
    assert.equal(isRunning(pid), true)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('turning remember back on does not restart the desktop server', async () => {
  const remember = createVolatile(false)
  const context = startServers({ config: { computer: true, rememberDesktopApprovals: remember } })
  try {
    await desktopCall(context)
    const pid = context.desktopStart()[0].pid
    remember[WRITE](true)
    context.plugin.emit('loader/volatile-update')
    await new Promise((done) => setTimeout(done, 150))
    assert.equal(context.desktopStart().length, 1)
    assert.equal(isRunning(pid), true)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('without a host event the next desktop call restarts the server', async () => {
  const remember = createVolatile(true)
  const context = startServers({ config: { computer: true, rememberDesktopApprovals: remember } })
  try {
    await desktopCall(context)
    const pid = context.desktopStart()[0].pid
    remember[WRITE](false)
    await desktopCall(context)
    assert.equal(await waitFor(() => context.desktopStart().length === 2), true)
    assert.notEqual(context.desktopStart()[1].pid, pid)
    assert.equal(readFileSync(context.logFile, 'utf8')
      .includes('remember approvals turned off; stopping the desktop server'), true)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
