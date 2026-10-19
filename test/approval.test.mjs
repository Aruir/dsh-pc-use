// F1 hot updates and F3 approval policy: drive the bridge through the fake server's
// elicitation modes and inspect both the decision and the log line.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { FAKE_SERVER, registerPlugin, tempDir, useHome, writeCodexHome } from './helpers.mjs'

const WRITE = Symbol.for('cosmokit.volatile.write')
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)

function createVolatile(value) {
  let current = value
  return Object.freeze({
    get: () => current,
    [WRITE](next) {
      current = next
    },
  })
}

function approvalLines(logFile) {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.includes('approval "'))
}

/** The full initialize params the fake server received. O(n), n = log lines. */
function initializeParams(serverLog) {
  const line = readFileSync(serverLog, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('initialize-full '))
  assert.ok(line, 'the fixture must record the initialize params')
  return JSON.parse(line.slice('initialize-full '.length))
}

/** Start the plugin against the fake server; `logFile` null means the default log path. */
function setup({ mode, autoApprove, customLogFile = true }) {
  const home = tempDir()
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [FAKE_SERVER, mode, serverLog])
  const logFile = customLogFile ? join(home, 'bridge.log') : ''
  const plugin = registerPlugin({
    codexHome,
    autoApprove,
    logFile,
  })
  return {
    home,
    restore,
    serverLog,
    expectedLogFile: customLogFile ? logFile : join(home, '.dsh', 'pc-use.log'),
    plugin,
  }
}

async function exercise(context) {
  const js = context.plugin.tools.get('pc_codex_js')
  return js.execute({ code: '1', title: 'approval test' }, {})
}

test('autoApprove:true accepts a browser approval and logs the decision', async () => {
  const context = setup({ mode: 'elicit', autoApprove: true })
  try {
    const text = await exercise(context)
    assert.match(text, /decision accept/)
    const lines = approvalLines(context.expectedLogFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /"Allow Browser use to access https:\/\/example\.com\?"/)
    assert.match(lines[0], /-> accept \(browser access auto-approved\)/)
    assert.match(readFileSync(context.serverLog, 'utf8'), /answer accept/)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('autoApprove:true declines a non-browser approval and says why', async () => {
  const context = setup({ mode: 'elicit-other', autoApprove: true })
  try {
    const text = await exercise(context)
    assert.match(text, /decision decline/)
    const lines = approvalLines(context.expectedLogFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /Allow Codex to control the Notepad app\?/)
    assert.match(lines[0], /-> decline \(not a browser-access approval\)/)
    assert.match(readFileSync(context.serverLog, 'utf8'), /answer decline/)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('autoApprove:false declines a browser approval because auto-approve is off', async () => {
  const context = setup({ mode: 'elicit', autoApprove: false })
  try {
    const text = await exercise(context)
    assert.match(text, /decision decline/)
    const lines = approvalLines(context.expectedLogFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(auto-approve is off\)/)
    assert.match(readFileSync(context.serverLog, 'utf8'), /answer decline/)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('autoApprove:false declines a non-browser approval too', async () => {
  const context = setup({ mode: 'elicit-other', autoApprove: false })
  try {
    const text = await exercise(context)
    assert.match(text, /decision decline/)
    const lines = approvalLines(context.expectedLogFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(auto-approve is off\)/)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('autoApprove is fail-closed by default', async () => {
  const context = setup({ mode: 'elicit', autoApprove: undefined })
  try {
    const text = await exercise(context)
    assert.match(text, /decision decline/)
    const lines = approvalLines(context.expectedLogFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(auto-approve is off\)/)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('an empty logFile falls back to ~/.dsh/pc-use.log', async () => {
  const context = setup({ mode: 'elicit', autoApprove: true, customLogFile: false })
  try {
    await exercise(context)
    assert.equal(existsSync(context.expectedLogFile), true)
    const lines = approvalLines(context.expectedLogFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> accept \(browser access auto-approved\)/)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('the next approval after a volatile autoApprove rewrite uses the new value', async () => {
  const autoApprove = createVolatile(true)
  const context = setup({ mode: 'elicit', autoApprove })
  try {
    const first = await exercise(context)
    assert.match(first, /decision accept/)
    autoApprove[WRITE](false)
    const second = await exercise(context)
    assert.match(second, /decision decline/)
    const lines = approvalLines(context.expectedLogFile)
    assert.equal(lines.length, 2)
    assert.match(lines[0], /-> accept/)
    assert.match(lines[1], /-> decline/)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('initialize matches native protocol, capabilities and the dsh clientInfo', async () => {
  const context = setup({ mode: 'ok', autoApprove: false })
  try {
    await exercise(context)
    const params = initializeParams(context.serverLog)
    assert.equal(params.protocolVersion, '2025-06-18')
    assert.deepEqual(params.capabilities, { elicitation: { form: {}, url: {} } })
    assert.equal(params.clientInfo.name, 'dsh-pc-use')
    assert.equal(params.clientInfo.version, packageJson.version)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('a url-mode elicitation is declined even when autoApprove would accept its text', async () => {
  const context = setup({ mode: 'elicit-url', autoApprove: true })
  try {
    const text = await exercise(context)
    assert.match(text, /decision decline/)
    const lines = approvalLines(context.expectedLogFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(url elicitation is not supported\)/)
    assert.match(lines[0], /example\.com/)
    assert.doesNotMatch(lines[0], /\/secret|token=SECRET/)
    assert.match(readFileSync(context.serverLog, 'utf8'), /answer decline/)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('a url-mode elicitation with an unparseable url logs invalid url', async () => {
  const context = setup({ mode: 'elicit-url-invalid', autoApprove: true })
  try {
    const text = await exercise(context)
    assert.match(text, /decision decline/)
    const lines = approvalLines(context.expectedLogFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> decline \(url elicitation is not supported\)/)
    assert.match(lines[0], /invalid url/)
    assert.doesNotMatch(lines[0], /not a url/)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})

test('an explicit form-mode elicitation keeps the browser auto-approval', async () => {
  const context = setup({ mode: 'elicit-form', autoApprove: true })
  try {
    const text = await exercise(context)
    assert.match(text, /decision accept/)
    const lines = approvalLines(context.expectedLogFile)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /-> accept \(browser access auto-approved\)/)
  } finally {
    context.plugin.dispose()
    context.restore()
  }
})
