// 0.5.0 S7.1: D14 pause counting is per bridge. A desktop approval pauses only desktop
// calls; a browser call keeps its own timeout. The desktop call resumes its remaining time.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { waitFor } from './helpers.mjs'
import { startServers, stopServers } from './fixtures/server-harness.mjs'

function execFor(callId, name = 'pc_codex_desktop_js') {
  return {
    agent: { id: 'agent-timers', session: { id: 'session-timers' } },
    name,
    callId,
    signal: new AbortController().signal,
  }
}

/** An approval service that keeps requests open until the test answers. O(1). */
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

/** An approval service that answers after `ms`. O(1). */
function approvalAfter(ms, outcome = 'allowed-once') {
  const state = { asked: 0 }
  return {
    state,
    service: {
      async request() {
        state.asked += 1
        await new Promise((done) => setTimeout(done, ms))
        return outcome
      },
    },
  }
}

function runDesktop(context, callId = 'call-desktop') {
  return context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '1', title: 'desktop' }, execFor(callId))
}

function runBrowser(context) {
  return context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'browser' }, {})
}

test('a pending desktop approval does not pause the browser call timeout', async () => {
  const approval = pendingApproval()
  const context = startServers({
    browser: { mode: 'hang' },
    desktop: { mode: 'computer' },
    config: { computer: true, timeoutMs: 1000 },
    services: { approval: approval.service },
  })
  let approvalAnswered = false
  let warmup = null
  try {
    const desktopCall = runDesktop(context)
    const desktopOutcome = desktopCall.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    assert.equal(await waitFor(() => approval.requests.length === 1), true)
    // Connect the browser server before starting the clock: its handshake must not count.
    warmup = runBrowser(context)
    warmup.catch(() => {})
    assert.equal(await waitFor(() => context.browserInit().length === 1), true)
    await new Promise((done) => setTimeout(done, 50))
    const startedAt = Date.now()
    const browserCall = runBrowser(context)
    browserCall.catch(() => {})
    let raceTimer = null
    const pending = new Promise((done) => {
      raceTimer = setTimeout(() => done({ pending: true }), 5000)
    })
    let outcome
    try {
      outcome = await Promise.race([
        browserCall.then(() => ({ error: null }), (error) => ({ error })),
        pending,
      ])
    } finally {
      clearTimeout(raceTimer)
    }
    const elapsed = Date.now() - startedAt
    assert.equal(
      outcome.pending,
      undefined,
      'the browser call must time out while the desktop waits',
    )
    assert.ok(outcome.error instanceof Error, 'the browser call must time out')
    assert.match(outcome.error.message, /timed out after 1000ms/)
    assert.ok(elapsed >= 700, `the browser call gave up too early (${elapsed}ms)`)
    assert.ok(elapsed < 3000, `the browser call waited for the desktop approval (${elapsed}ms)`)
    assert.equal(approval.requests.length, 1, 'the desktop approval is still pending')
    approval.requests[0].resolve('allowed-once')
    approvalAnswered = true
    const result = await desktopOutcome
    assert.equal(result.error, undefined, result.error?.message)
    assert.match(result.value, /decision accept/)
  } finally {
    // A failed mutation must not leave the approval or a call pending in this process.
    if (!approvalAnswered && approval.requests.length > 0) {
      approval.requests[0].resolve('allowed-once')
    }
    if (warmup !== null) {
      await Promise.race([
        warmup.catch(() => {}),
        new Promise((done) => setTimeout(done, 250)),
      ])
    }
    assert.equal(await stopServers(context), true)
  }
})

test('a desktop call resumes its remaining time after the approval', async () => {
  const approval = approvalAfter(700)
  const context = startServers({
    desktop: { mode: 'computer' },
    config: { computer: true, timeoutMs: 300 },
    services: { approval: approval.service },
  })
  try {
    const startedAt = Date.now()
    const result = await runDesktop(context)
    assert.match(result, /decision accept/)
    assert.equal(approval.state.asked, 1)
    assert.ok(Date.now() - startedAt >= 650, 'the wait for the user must not be cut short')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a desktop call without an approval still times out after timeoutMs', async () => {
  const context = startServers({
    desktop: { mode: 'hang' },
    config: { computer: true, timeoutMs: 200 },
  })
  try {
    await assert.rejects(() => runDesktop(context), /timed out after 200ms/)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
