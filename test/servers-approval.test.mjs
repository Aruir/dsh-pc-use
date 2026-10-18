// 0.5.0 S3: desktop approvals belong to desktop calls and the desktop bridge only; the
// browser bridge keeps autoApprove and declines desktop approvals, and remembered apps
// are forgotten only when the desktop bridge is rebuilt.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { waitFor } from './helpers.mjs'
import {
  DUAL_SERVER, recordsOf, startServers, stopServers, writeBrowserSource, writeDesktopSource,
} from './fixtures/server-harness.mjs'

function execFor(agent, callId, name = 'pc_codex_desktop_js') {
  return { agent, name, callId, signal: new AbortController().signal }
}

function runDesktop(context, exec) {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '记事本', title: 'desktop' }, exec)
}

function runAddDir(context, exec) {
  return context.plugin.tools.get('pc_codex_desktop_js_add_node_module_dir')
    .execute({ path: 'C:\\fake\\modules' }, exec)
}

function runBrowser(context) {
  return context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'browser' }, {})
}

function readLog(context) {
  return readFileSync(context.logFile, 'utf8')
}

function approvalService(outcome, requests) {
  return {
    async request(parameters) {
      requests.push(parameters)
      return outcome
    },
  }
}

/** An approval service that keeps every request open until the test answers. O(1). */
function pendingApproval() {
  const requests = []
  return {
    requests,
    service: {
      request(parameters) {
        return new Promise((resolve) => {
          requests.push({ parameters, resolve })
        })
      },
    },
  }
}

test('desktop approvals are attributed to the desktop tool call', async () => {
  const requests = []
  const context = startServers({
    desktop: { mode: 'computer' },
    config: { computer: true },
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const agent = { id: 'agent-desktop', session: { id: 'session-desktop' } }
    const exec = execFor(agent, 'call-42')
    const result = await runDesktop(context, exec)
    assert.match(result, /decision accept/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].agent, agent)
    assert.equal(requests[0].toolName, 'pc_codex_desktop_js')
    assert.equal(requests[0].callId, 'call-42')
    assert.deepEqual(requests[0].displayReason, {
      en: 'Allow Codex Computer Use to operate “记事本”?',
      zh: '允许 Codex Computer Use 操作“记事本”？',
    })
    const log = readLog(context)
    assert.match(log, /-> accept \(approved in DSH\)/)
    assert.equal(log.includes('agent-desktop'), false)
    assert.equal(log.includes('call-42'), false)
    assert.deepEqual(
      recordsOf(context.logs.desktop, 'answer').map((entry) => entry.action),
      ['accept'],
    )
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a desktop approval while only pc_codex_js runs is declined', async () => {
  const requests = []
  const context = startServers({
    browser: { mode: 'computer' },
    config: { computer: true },
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const result = await runBrowser(context)
    assert.match(result, /decision decline/)
    assert.equal(requests.length, 0, 'the host must not be asked for a desktop approval')
    assert.match(readLog(context), /\(unexpected approval for the browser server\)/)
    assert.deepEqual(
      recordsOf(context.logs.browser, 'answer').map((entry) => entry.action),
      ['decline'],
    )
    assert.equal(recordsOf(context.logs.desktop, 'start').length, 0)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('the desktop server declines browser approvals', async () => {
  const requests = []
  const context = startServers({
    desktop: { mode: 'browser' },
    config: { computer: true },
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const agent = { id: 'agent-kind', session: { id: 'session-kind' } }
    const result = await runDesktop(context, execFor(agent, 'call-kind'))
    assert.match(result, /decision decline/)
    assert.equal(requests.length, 0)
    assert.match(readLog(context), /\(unexpected approval for the desktop server\)/)
    assert.deepEqual(
      recordsOf(context.logs.desktop, 'answer').map((entry) => entry.action),
      ['decline'],
    )
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a desktop approval without an active desktop call is declined', async () => {
  const requests = []
  const context = startServers({
    desktop: { mode: 'spontaneous' },
    config: { computer: true },
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const agent = { id: 'agent-idle', session: { id: 'session-idle' } }
    await context.plugin.tools.get('pc_codex_desktop_js_reset')
      .execute({}, execFor(agent, 'call-reset', 'pc_codex_desktop_js_reset'))
    assert.equal(await waitFor(() => recordsOf(context.logs.desktop, 'answer').length === 1), true)
    assert.equal(requests.length, 0)
    assert.match(readLog(context), /\(no active pc_codex_desktop_js call\)/)
    assert.equal(recordsOf(context.logs.desktop, 'answer')[0].action, 'decline')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('add_node_module_dir calls are attributed like desktop js calls', async () => {
  const requests = []
  const context = startServers({
    desktop: { mode: 'computer' },
    config: { computer: true },
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const agent = { id: 'agent-add', session: { id: 'session-add' } }
    const result = await runAddDir(context, execFor(
      agent, 'call-add', 'pc_codex_desktop_js_add_node_module_dir',
    ))
    assert.match(result, /decision accept/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].toolName, 'pc_codex_desktop_js_add_node_module_dir')
    assert.equal(requests[0].callId, 'call-add')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a browser call never receives the desktop approval', async () => {
  const requests = []
  const context = startServers({
    browser: { mode: 'hang' },
    desktop: { mode: 'computer' },
    config: { computer: true, timeoutMs: 30_000 },
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    // Start a long browser call first: it must not become the approval target.
    const browserCall = runBrowser(context).catch(() => 'stopped')
    assert.equal(await waitFor(() => context.browserStart().length === 1), true)
    const agent = { id: 'agent-browser', session: { id: 'session-browser' } }
    const result = await runDesktop(context, execFor(agent, 'call-desktop'))
    assert.match(result, /decision accept/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].callId, 'call-desktop')
    assert.equal(requests[0].toolName, 'pc_codex_desktop_js')
  } finally {
    // Disposing the plugin ends the hanging browser call above.
    assert.equal(await stopServers(context), true)
  }
})

test('a desktop approval goes to the earliest running desktop call', async () => {
  const approval = pendingApproval()
  const context = startServers({
    desktop: { mode: 'computer' },
    config: { computer: true },
    services: { approval: approval.service },
  })
  try {
    const agent = { id: 'agent-order', session: { id: 'session-order' } }
    const first = runDesktop(context, execFor(agent, 'call-first'))
    assert.equal(await waitFor(() => approval.requests.length >= 1), true)
    const second = runDesktop(context, execFor(agent, 'call-second'))
    assert.equal(await waitFor(() => approval.requests.length >= 2), true)
    assert.equal(approval.requests[1].parameters.callId, 'call-first')
    for (const request of approval.requests) request.resolve('rejected')
    await Promise.allSettled([first, second])
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('the browser bridge keeps the autoApprove rule and never asks DSH', async () => {
  const requests = []
  const context = startServers({
    browser: { mode: 'browser' },
    config: { autoApprove: true },
    services: { approval: approvalService('rejected', requests) },
  })
  try {
    const result = await runBrowser(context)
    assert.match(result, /decision accept/)
    assert.equal(requests.length, 0)
    assert.match(readLog(context), /browser access auto-approved/)
    assert.equal(recordsOf(context.logs.desktop, 'start').length, 0)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('remembered apps survive a browser rebuild and are cleared by a desktop rebuild', async () => {
  const requests = []
  const context = startServers({
    desktop: { mode: 'computer-meta' },
    config: { computer: true },
    services: { approval: approvalService('allowed-once', requests) },
  })
  try {
    const agent = { id: 'agent-remember', session: { id: 'session-remember' } }
    assert.match(await runDesktop(context, execFor(agent, 'call-1')), /decision accept/)
    assert.equal(requests.length, 1)
    assert.match(await runDesktop(context, execFor(agent, 'call-2')), /decision accept/)
    assert.equal(requests.length, 1, 'the second call must be remembered')
    // A browser rebuild must not forget the desktop approval lifetime.
    await runBrowser(context)
    assert.equal(await waitFor(() => context.browserStart().length === 1), true)
    writeBrowserSource(context.codexHome, [
      DUAL_SERVER, 'browser', 'ok', context.logs.browser, 'extra',
    ])
    await runBrowser(context)
    assert.equal(await waitFor(() => context.browserStart().length === 2), true)
    assert.match(await runDesktop(context, execFor(agent, 'call-3')), /decision accept/)
    assert.equal(requests.length, 1, 'a browser rebuild must keep remembered desktop apps')
    // A desktop bridge rebuild starts a new approval lifetime.
    writeDesktopSource(context.codexHome, [
      DUAL_SERVER, 'desktop', 'computer-meta', context.logs.desktop, 'extra',
    ])
    assert.match(await runDesktop(context, execFor(agent, 'call-4')), /decision accept/)
    assert.equal(requests.length, 2, 'a desktop rebuild must forget remembered desktop apps')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
