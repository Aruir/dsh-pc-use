// F1-F3: desktop approvals are remembered per agent for the lifetime of a bridge.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { registerPlugin, tempDir, useHome, waitFor, writeCodexHome } from './helpers.mjs'

const DESKTOP_SERVER = process.env.CODEX_CU_DESKTOP_SERVER
  ?? fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))
const WRITE = Symbol.for('cosmokit.volatile.write')
const EARLIER = 'approved earlier in this DSH session'
const APP = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'

function createVolatile(value) {
  let current = value
  return Object.freeze({
    get: () => current,
    [WRITE](next) {
      current = next
    },
  })
}

function approach(agent, callId) {
  return {
    agent,
    name: 'pc_codex_js',
    callId,
    signal: new AbortController().signal,
  }
}

function execFor(agent, callId) {
  return approach(agent, callId)
}

function approvalService(queue, requests) {
  return {
    async request(parameters) {
      requests.push(parameters)
      if (queue.length > 1) return queue.shift()
      return queue[0]
    },
  }
}

function setup(options = {}) {
  const home = tempDir('pc-use-remember-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [DESKTOP_SERVER, options.mode ?? 'flow-meta', serverLog])
  const logFile = join(home, 'bridge.log')
  const plugin = registerPlugin({
    codexHome,
    computer: options.computer ?? true,
    rememberDesktopApprovals: options.remember,
    autoApprove: false,
    logFile,
  }, { services: options.services ?? {} })
  return { home, restore, serverLog, logFile, plugin }
}

function approvalLines(logFile) {
  return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.includes('approval '))
}

function serverAnswers(serverLog) {
  return readFileSync(serverLog, 'utf8').split('\n').filter((line) => line.startsWith('answer'))
}

function finish(context) {
  context.plugin.dispose()
  context.restore()
}

function runJs(context, code, exec) {
  return context.plugin.tools.get('pc_codex_js').execute({ code, title: code }, exec)
}

test('same agent and app: the second request is remembered', async () => {
  const agent = { id: 'agent-one' }
  const requests = []
  const context = setup({
    services: { approval: approvalService(['allowed-once', 'rejected'], requests) },
  })
  try {
    const first = await runJs(context, `${APP}`, execFor(agent, 'call-1'))
    assert.match(first, /decision accept/)
    const second = await runJs(context, `${APP}`, execFor(agent, 'call-2'))
    assert.match(second, /decision accept/)
    assert.equal(requests.length, 1)
    const lines = approvalLines(context.logFile)
    assert.equal(lines.length, 2)
    assert.match(lines[1], /-> accept \(approved earlier in this DSH session\)/)
    assert.deepEqual(serverAnswers(context.serverLog), ['answer accept', 'answer accept'])
  } finally {
    finish(context)
  }
})

test('same agent, different app: still asks DSH', async () => {
  const agent = { id: 'agent-two' }
  const requests = []
  const context = setup({
    services: { approval: approvalService(['allowed-once'], requests) },
  })
  try {
    await runJs(context, 'Calc', execFor(agent, 'call-a'))
    await runJs(context, 'Notepad', execFor(agent, 'call-b'))
    assert.equal(requests.length, 2)
    const lines = approvalLines(context.logFile)
    assert.equal(lines.length, 2)
    assert.equal(lines[1].includes(EARLIER), false)
  } finally {
    finish(context)
  }
})

test('different agents: still asks DSH', async () => {
  const requests = []
  const context = setup({
    services: { approval: approvalService(['allowed-once'], requests) },
  })
  try {
    await runJs(context, APP, execFor({ id: 'agent-three-a' }, 'call-a'))
    await runJs(context, APP, execFor({ id: 'agent-three-b' }, 'call-b'))
    assert.equal(requests.length, 2)
  } finally {
    finish(context)
  }
})

test('a rejected approval is not remembered', async () => {
  const agent = { id: 'agent-four' }
  const requests = []
  const context = setup({
    services: { approval: approvalService(['rejected', 'allowed-once'], requests) },
  })
  try {
    const first = await runJs(context, APP, execFor(agent, 'call-1'))
    assert.match(first, /decision decline/)
    const second = await runJs(context, APP, execFor(agent, 'call-2'))
    assert.match(second, /decision accept/)
    assert.equal(requests.length, 2)
  } finally {
    finish(context)
  }
})

test('an unavailable approval is not remembered', async () => {
  const agent = { id: 'agent-five' }
  const requests = []
  const context = setup({
    services: { approval: approvalService(['unavailable', 'allowed-once'], requests) },
  })
  try {
    const first = await runJs(context, APP, execFor(agent, 'call-1'))
    assert.match(first, /decision decline/)
    await runJs(context, APP, execFor(agent, 'call-2'))
    assert.equal(requests.length, 2)
  } finally {
    finish(context)
  }
})

test('meta without "session" in persist is not remembered', async () => {
  const agent = { id: 'agent-six' }
  const requests = []
  const context = setup({
    mode: 'flow-meta-nosession',
    services: { approval: approvalService(['allowed-once'], requests) },
  })
  try {
    await runJs(context, APP, execFor(agent, 'call-1'))
    await runJs(context, APP, execFor(agent, 'call-2'))
    assert.equal(requests.length, 2)
  } finally {
    finish(context)
  }
})

test('a request without meta is not remembered', async () => {
  const agent = { id: 'agent-seven' }
  const requests = []
  const context = setup({
    mode: 'flow-meta-nometa',
    services: { approval: approvalService(['allowed-once'], requests) },
  })
  try {
    await runJs(context, APP, execFor(agent, 'call-1'))
    await runJs(context, APP, execFor(agent, 'call-2'))
    assert.equal(requests.length, 2)
  } finally {
    finish(context)
  }
})

test('meta under params.meta is read too', async () => {
  const agent = { id: 'agent-eight' }
  const requests = []
  const context = setup({
    mode: 'flow-meta-plain',
    services: { approval: approvalService(['allowed-once'], requests) },
  })
  try {
    await runJs(context, APP, execFor(agent, 'call-1'))
    await runJs(context, APP, execFor(agent, 'call-2'))
    assert.equal(requests.length, 1)
  } finally {
    finish(context)
  }
})

test('tool_params.app takes priority over the displayed app name', async () => {
  const agent = { id: 'agent-nine' }
  const requests = []
  const context = setup({
    services: { approval: approvalService(['allowed-once'], requests) },
  })
  try {
    await runJs(context, `Calculator@${APP}`, execFor(agent, 'call-1'))
    await runJs(context, `Calc@${APP}`, execFor(agent, 'call-2'))
    assert.equal(requests.length, 1)
  } finally {
    finish(context)
  }
})

test('rememberDesktopApprovals:false asks every time and resets the memory', async () => {
  const agent = { id: 'agent-ten' }
  const remember = createVolatile(true)
  const requests = []
  const context = setup({
    remember,
    services: { approval: approvalService(['allowed-once'], requests) },
  })
  try {
    await runJs(context, APP, execFor(agent, 'call-1'))
    assert.equal(requests.length, 1)
    remember[WRITE](false)
    await runJs(context, APP, execFor(agent, 'call-2'))
    assert.equal(requests.length, 2)
    remember[WRITE](true)
    await runJs(context, APP, execFor(agent, 'call-3'))
    assert.equal(requests.length, 3)
  } finally {
    finish(context)
  }
})

test('hot switching computer asks again after the bridge is rebuilt', async () => {
  const agent = { id: 'agent-eleven' }
  const computer = createVolatile(true)
  const requests = []
  const context = setup({
    computer,
    services: { approval: approvalService(['allowed-once'], requests) },
  })
  try {
    await runJs(context, APP, execFor(agent, 'call-1'))
    assert.equal(requests.length, 1)
    computer[WRITE](false)
    const declined = await runJs(context, APP, execFor(agent, 'call-2'))
    assert.match(declined, /decision decline/)
    computer[WRITE](true)
    await runJs(context, APP, execFor(agent, 'call-3'))
    assert.equal(requests.length, 2)
  } finally {
    finish(context)
  }
})

test('a remembered app still needs a running pc_codex_js call', async () => {
  const agent = { id: 'agent-twelve' }
  const requests = []
  const context = setup({
    services: { approval: approvalService(['allowed-once'], requests) },
  })
  try {
    await runJs(context, APP, execFor(agent, 'call-1'))
    assert.equal(requests.length, 1)
    const js = context.plugin.tools.get('pc_codex_js')
    const result = await js.execute(
      { code: `${APP}|spontaneous`, title: 'after' },
      execFor(agent, 'call-2'),
    )
    assert.equal(result, 'ran js')
    const declined = await waitFor(
      () => serverAnswers(context.serverLog).includes('answer decline'),
    )
    assert.equal(declined, true)
    assert.equal(requests.length, 1)
    const lines = approvalLines(context.logFile)
    assert.match(lines[1], /-> decline \(no active pc_codex_js call\)/)
  } finally {
    finish(context)
  }
})

test('a remembered app is declined while computer is off', async () => {
  const agent = { id: 'agent-thirteen' }
  const computer = createVolatile(true)
  const requests = []
  const context = setup({
    computer,
    services: { approval: approvalService(['allowed-once'], requests) },
  })
  try {
    await runJs(context, APP, execFor(agent, 'call-1'))
    assert.equal(requests.length, 1)
    computer[WRITE](false)
    const result = await runJs(context, APP, execFor(agent, 'call-2'))
    assert.match(result, /decision decline/)
    assert.equal(requests.length, 1)
    const lines = approvalLines(context.logFile)
    assert.match(lines[1], /-> decline \(computer use is off\)/)
  } finally {
    finish(context)
  }
})
