// r35: the approval reply must stay free of `_meta.persist`. Codex would otherwise write the
// allowed app into a per-session file on disk, so neither turning the remember switch off nor
// reconnecting the desktop bridge would ask the user again. The fake server below simulates
// that file (FAKE_PERSIST_STORE) and remembers across its own restarts.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, writeCodexHome } from './helpers.mjs'

const SERVER = process.env.CODEX_CU_DESKTOP_SERVER
  ?? fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))
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

function approvalService() {
  const requests = []
  return {
    requests,
    service: {
      effectivePolicy: () => 'ask',
      request(parameters) {
        requests.push(parameters)
        return Promise.resolve('allowed-once')
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

/** One run over a temp home; the fake server keeps its session memory in a temp file. O(1). */
function setup(options = {}) {
  const home = tempDir('pc-use-no-persist-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const store = join(home, 'persist-store.txt')
  const codexHome = join(home, 'codex')
  writeCodexHome(
    codexHome,
    [SERVER, 'persist-store', serverLog],
    { FAKE_PERSIST_STORE: store },
    { desktop: true },
  )
  const approval = approvalService()
  const questions = questionsService(picked(options.choice ?? SESSION))
  const remember = options.remember ?? createVolatile(true)
  const computer = options.computer ?? createVolatile(true)
  const plugin = registerPlugin({
    codexHome,
    computer,
    rememberDesktopApprovals: remember,
    language: 'zh',
    logFile: join(home, 'bridge.log'),
  }, { services: { approval: approval.service, userQuestions: questions.service } })
  return { home, restore, serverLog, store, plugin, approval, questions, remember }
}

function execFor() {
  return {
    agent: { id: 'agent-no-persist', session: { id: 'session-no-persist' } },
    name: 'pc_codex_desktop_js',
    callId: 'call-1',
    signal: new AbortController().signal,
  }
}

function runDesktop(context, exec = execFor()) {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '记事本@app', title: 'no persist' }, exec)
}

function readReplyLog(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function finish(context) {
  context.plugin.dispose()
  context.restore()
}

test('turning remember off asks again instead of trusting the server store', async () => {
  const context = setup()
  const exec = execFor()
  try {
    await runDesktop(context, exec)
    assert.equal(context.questions.requests.length, 1)
    context.remember[WRITE](false)
    context.plugin.emit('loader/volatile-update')
    await runDesktop(context, exec)
    assert.equal(context.questions.requests.length, 2)
  } finally {
    await finish(context)
  }
})

test('a reconnected desktop bridge asks again instead of trusting the store', async () => {
  const computer = createVolatile(true)
  const context = setup({ computer })
  const exec = execFor()
  try {
    await runDesktop(context, exec)
    assert.equal(context.questions.requests.length, 1)
    computer[WRITE](false)
    context.plugin.emit('loader/volatile-update')
    computer[WRITE](true)
    await runDesktop(context, exec)
    assert.equal(context.questions.requests.length, 2)
  } finally {
    await finish(context)
  }
})

test('no approval reply carries _meta', async () => {
  for (const choice of [ONCE, SESSION, DENY]) {
    const context = setup({ choice })
    try {
      await runDesktop(context)
      assert.equal(context.questions.requests.length, 1)
      const replies = readReplyLog(`${context.store}.replies`)
      assert.equal(replies.length, 1)
      assert.deepEqual(Object.keys(replies[0]).sort(), ['action', 'content'])
      assert.equal('_meta' in replies[0], false)
    } finally {
      await finish(context)
    }
  }
})
