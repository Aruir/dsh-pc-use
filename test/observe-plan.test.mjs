// New observe/run_plan tools: fixed observe code, plan ordering/checks, and switches.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  registerPlugin, tempDir, useHome, writeCodexHome,
} from './helpers.mjs'
import { startServers, stopServers } from './fixtures/server-harness.mjs'

const PLAN_SERVER = fileURLToPath(new URL('./fixtures/fake-plan-server.mjs', import.meta.url))
const COMPUTER_SERVER = fileURLToPath(new URL('./fake-computer-server.mjs', import.meta.url))

function planContext(options = {}) {
  return startServers({
    browser: options.browser === false ? false : { server: PLAN_SERVER, mode: 'browser' },
    desktop: options.desktop === false ? false : { server: PLAN_SERVER, mode: 'desktop' },
    config: { computer: options.computer ?? true },
  })
}

function calls(context, side) {
  return side === 'desktop' ? context.desktopCalls() : context.browserCalls()
}

test('browser observe sends the fixed read-only calls', async () => {
  const context = planContext()
  try {
    const tool = context.plugin.tools.get('pc_codex_observe')
    await tool.execute({ target: 'browser', subject: 'tab' }, {})
    await tool.execute({ target: 'browser', subject: 'tab', screenshot: true, full: true }, {})
    const codes = calls(context, 'browser').map((item) => item.arguments.code)
    assert.deepEqual(codes, [
      'await tab.getAXState({ disableDiffing: false });',
      'await tab.getAXStateAndScreenshot({ disableDiffing: true });',
    ])
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('desktop observe sends the guidance block with the requested flags', async () => {
  const context = planContext({ browser: false })
  try {
    await context.plugin.tools.get('pc_codex_observe')
      .execute({ target: 'desktop', subject: 'targetWindow', screenshot: true, text: false }, {})
    const code = calls(context, 'desktop')[0].arguments.code
    assert.match(code, /const \{ sky \} = await import\("@oai\/sky"\);/)
    assert.match(code, /include_screenshot: true, include_text: false/)
    assert.match(code, /globalThis\.targetWindow = state\.window;/)
    assert.match(code, /nodeRepl\.write\(String\(state\.accessibility/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('invalid observe arguments send no code and desktop respects computer off', async () => {
  const context = planContext({ desktop: false })
  const off = startServers({ browser: false, desktop: false, config: { computer: false } })
  try {
    await assert.rejects(
      context.plugin.tools.get('pc_codex_observe').execute(
        { target: 'browser', subject: 'bad-name' }, {}),
      /subject must be a JavaScript identifier/,
    )
    assert.equal(calls(context, 'browser').length, 0)
    await assert.rejects(
      context.plugin.tools.get('pc_codex_observe').execute(
        { target: 'tablet', subject: 'tab' }, {}),
      /target must be "browser" or "desktop"/,
    )
    await assert.rejects(
      off.plugin.tools.get('pc_codex_observe').execute(
        { target: 'desktop', subject: 'targetWindow' }, {}),
      /computer use is off/,
    )
    await assert.rejects(
      off.plugin.tools.get('pc_codex_run_plan').execute(
        { target: 'desktop', steps: [{ title: 'x', code: '1' }] }, {}),
      /computer use is off/,
    )
    assert.equal(calls(context, 'browser').length, 0)
  } finally {
    assert.equal(await stopServers(context), true)
    assert.equal(await stopServers(off), true)
  }
})

test('run_plan executes all steps and reports the summary', async () => {
  const context = planContext({ desktop: false })
  try {
    const result = await context.plugin.tools.get('pc_codex_run_plan').execute({
      target: 'browser',
      steps: [{ title: 'first', code: '1 + 1' }, { title: 'second', code: '2 + 2' }],
    }, {})
    assert.match(result, /^run_plan: 2\/2 steps ok/)
    assert.match(result, /1\. first: ok/)
    assert.match(result, /2\. second: ok/)
    assert.equal(calls(context, 'browser').length, 2)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('run_plan stops after an error and does not send later steps', async () => {
  const context = planContext({ desktop: false })
  try {
    await assert.rejects(
      context.plugin.tools.get('pc_codex_run_plan').execute({
        target: 'browser',
        steps: [
          { title: 'first', code: '1 + 1' },
          { title: 'second', code: 'STEP_FAIL' },
          { title: 'third', code: '3 + 3' },
        ],
      }, {}),
      (error) => {
        assert.match(error.message, /run_plan: 1\/3 steps ok; stopped at step 2 \(error\)/)
        assert.match(error.message, /3\. third: not_run/)
        return true
      },
    )
    assert.equal(calls(context, 'browser').length, 2)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('run_plan marks check_failed, check_error and continues on true checks', async () => {
  const context = planContext({ desktop: false })
  try {
    await assert.rejects(
      context.plugin.tools.get('pc_codex_run_plan').execute({
        target: 'browser',
        steps: [{ title: 'false check', code: '1 + 1', check: 'false' }],
      }, {}),
      /check_failed/,
    )
    await assert.rejects(
      context.plugin.tools.get('pc_codex_run_plan').execute({
        target: 'browser',
        steps: [{
          title: 'broken check', code: '1 + 1',
          check: '(() => { throw new Error("boom") })()',
        }],
      }, {}),
      /check_error/,
    )
    const result = await context.plugin.tools.get('pc_codex_run_plan').execute({
      target: 'browser',
      steps: [{ title: 'true check', code: '1 + 1', check: 'true' }],
    }, {})
    assert.match(result, /^run_plan: 1\/1 steps ok/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('run_plan executes check wrappers for truthiness, errors and comments', async () => {
  const context = planContext({ desktop: false })
  try {
    const tool = context.plugin.tools.get('pc_codex_run_plan')
    for (const check of ["false", "0", "''", 'null', 'Promise.resolve(false)']) {
      await assert.rejects(
        tool.execute({
          target: 'browser',
          steps: [{ title: 'falsey', code: '1 + 1', check }],
        }, {}),
        /check_failed/,
        check,
      )
    }
    for (const check of ['true', '1', 'Promise.resolve(true)']) {
      const result = await tool.execute({
        target: 'browser',
        steps: [{ title: 'truthy', code: '1 + 1', check }],
      }, {})
      assert.match(result, /^run_plan: 1\/1 steps ok/, check)
    }
    for (const check of [
      '(() => { throw new Error("boom") })()',
      '(',
    ]) {
      await assert.rejects(
        tool.execute({
          target: 'browser',
          steps: [{ title: 'throwing', code: '1 + 1', check }],
        }, {}),
        /check_error/,
        check,
      )
    }
    await assert.rejects(
      tool.execute({
        target: 'browser',
        steps: [{ title: 'comment', code: '1 + 1', check: 'false // trailing comment' }],
      }, {}),
      /check_failed/,
    )
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('run_plan ignores decision-decline page text when no decline occurred', async () => {
  const context = planContext({ desktop: false })
  try {
    const result = await context.plugin.tools.get('pc_codex_run_plan').execute({
      target: 'browser',
      steps: [{ title: 'page text', code: 'OUTPUT_DECLINE_WORDS' }],
    }, {})
    assert.match(result, /^run_plan: 1\/1 steps ok/)
    assert.match(result, /1\. page text: ok/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('run_plan rejects invalid steps before sending anything', async () => {
  const context = planContext({ desktop: false })
  try {
    const tool = context.plugin.tools.get('pc_codex_run_plan')
    const invalid = [
      { target: 'browser', steps: [] },
      { target: 'browser', steps: Array.from({ length: 21 }, (_item, index) => (
        { title: `t${index}`, code: '1' })) },
      { target: 'browser', steps: [{ title: 'missing code' }] },
    ]
    for (const args of invalid) {
      await assert.rejects(tool.execute(args, {}), /steps/)
    }
    assert.equal(calls(context, 'browser').length, 0)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('run_plan stops before the first step when the call is already aborted', async () => {
  const context = planContext({ desktop: false })
  const controller = new AbortController()
  controller.abort()
  try {
    await assert.rejects(
      context.plugin.tools.get('pc_codex_run_plan').execute({
        target: 'browser', steps: [{ title: 'first', code: '1' }],
      }, { signal: controller.signal }),
      /run_plan: 0\/1 steps ok; stopped at step 1 \(not_run\)/,
    )
    assert.equal(calls(context, 'browser').length, 0)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('run_plan observes after stopping and reports the observation', async () => {
  const context = planContext({ desktop: false })
  try {
    await assert.rejects(
      context.plugin.tools.get('pc_codex_run_plan').execute({
        target: 'browser',
        steps: [{ title: 'bad', code: 'STEP_FAIL' }],
        observe: { subject: 'tab' },
      }, {}),
      (error) => {
        assert.match(error.message, /observation:\nran js/)
        return true
      },
    )
    assert.equal(calls(context, 'browser').length, 2)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('desktop run_plan keeps the user-decline note and stops', async () => {
  const home = tempDir('pc-use-plan-approval-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(codexHome, [COMPUTER_SERVER, 'flow-meta', serverLog], {}, { desktop: true })
  const approval = {
    effectivePolicy: () => 'ask',
    request: () => Promise.resolve('rejected'),
  }
  const questions = {
    async ask() {
      return { answers: [{ id: 'desktop-approval', selected: ['拒绝'] }] }
    },
  }
  const plugin = registerPlugin({
    codexHome, computer: true, language: 'zh', logFile: join(home, 'bridge.log'),
  }, { services: { approval, userQuestions: questions } })
  const exec = {
    agent: { id: 'agent-plan', session: { id: 'session-plan' } },
    name: 'pc_codex_run_plan',
    callId: 'plan-1',
    signal: new AbortController().signal,
  }
  try {
    await assert.rejects(
      plugin.tools.get('pc_codex_run_plan').execute({
        target: 'desktop',
        steps: [{ title: 'click', code: '记事本@app' }],
      }, exec),
      (error) => {
        assert.match(error.message, /没有批准/)
        assert.match(error.message, /stopped at step 1 \(error\)/)
        return true
      },
    )
    assert.match(readFileSync(serverLog, 'utf8'), /answer decline/)
  } finally {
    plugin.dispose()
    restore()
  }
})

test('desktop run_plan stops on an isError rejection and skips later steps', async () => {
  const home = tempDir('pc-use-plan-iserror-')
  const restore = useHome(home)
  const serverLog = join(home, 'server.log')
  writeFileSync(serverLog, '')
  const codexHome = join(home, 'codex')
  writeCodexHome(
    codexHome, [COMPUTER_SERVER, 'flow-meta-reject-error', serverLog], {}, { desktop: true },
  )
  const approval = {
    effectivePolicy: () => 'ask',
    request: () => Promise.resolve('rejected'),
  }
  const questions = {
    async ask() {
      return { answers: [{ id: 'desktop-approval', selected: ['拒绝'] }] }
    },
  }
  const plugin = registerPlugin({
    codexHome, computer: true, language: 'zh', logFile: join(home, 'bridge.log'),
  }, { services: { approval, userQuestions: questions } })
  const exec = {
    agent: { id: 'agent-plan-iserror', session: { id: 'session-plan-iserror' } },
    name: 'pc_codex_run_plan',
    callId: 'plan-iserror',
    signal: new AbortController().signal,
  }
  try {
    await assert.rejects(
      plugin.tools.get('pc_codex_run_plan').execute({
        target: 'desktop',
        steps: [
          { title: 'click', code: '记事本@app' },
          { title: 'second', code: '2 + 2' },
        ],
      }, exec),
      (error) => {
        assert.match(error.message, /没有批准/)
        assert.match(error.message, /0\/2 steps ok; stopped at step 1 \(error\)/)
        assert.match(error.message, /2\. second: not_run/)
        return true
      },
    )
    assert.match(readFileSync(serverLog, 'utf8'), /answer decline/)
  } finally {
    plugin.dispose()
    restore()
  }
})

test('observe/run_plan switches and batch descriptions are present', () => {
  const off = registerPlugin({ tools: { observe: false, runPlan: false } })
  try {
    assert.equal(off.tools.has('pc_codex_observe'), false)
    assert.equal(off.tools.has('pc_codex_run_plan'), false)
  } finally {
    off.dispose()
  }
  const plugin = registerPlugin({})
  try {
    const browser = plugin.tools.get('pc_codex_js').description
    const desktop = plugin.tools.get('pc_codex_desktop_js').description
    for (const description of [browser, desktop]) {
      assert.match(description, /Preferred:/)
      assert.match(description, /one program/)
      assert.match(description, /pc_codex_run_plan/)
      assert.ok(description.indexOf('Preferred:') < description.indexOf('pc_codex_run_plan'))
    }
  } finally {
    plugin.dispose()
  }
})
