// r14: desktop approvals are pure state over DSH services. These tests inject the approval
// and question services and the remember/language getters, so no process, temp directory or
// fake server is needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { APPROVE, DECLINE } from '../lib/approval.js'
import { desktopApprovalLabels } from '../lib/text.js'
import { createDesktopApprovals } from '../lib/desktop-approvals.js'

const LABELS = desktopApprovalLabels('zh')
// The three-option card shows the session choice only when the request asks for it.
const META = { persist: ['session'] }

/** One DSH tool execution: only agent, name, callId and signal matter to the tracker. O(1). */
function execFor(agent, callId = 'call-1') {
  return {
    agent,
    name: 'pc_codex_desktop_js',
    callId,
    signal: new AbortController().signal,
  }
}

/**
 * Fake approval service: policy "ask" plus the one-shot path. Outcomes repeat the last value
 * once the list is down to one, like the existing approval fakes. O(1).
 */
function approvalService(outcomes = ['allowed-once']) {
  const requests = []
  const queue = [...outcomes]
  return {
    requests,
    service: {
      effectivePolicy() {
        return 'ask'
      },
      async request(parameters) {
        requests.push(parameters)
        return queue.length > 1 ? queue.shift() : queue[0]
      },
    },
  }
}

/** An approval service that keeps its one request pending until the test answers it. O(1). */
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

/** Fake user-questions service returning one answer batch, throwing it, or answering later. */
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

/** One selected option label as the answer batch the service returns. O(1). */
function picked(label) {
  return { answers: [{ id: 'desktop-approval', selected: [label] }] }
}

/** Build one approvals instance over fakes; `approval: null` means "no service". O(1). */
function makeApprovals({ approval = approvalService(), questions = null, remember = true } = {}) {
  let remembered = remember
  const approvals = createDesktopApprovals({
    approvalService: () => approval?.service,
    questionsService: () => questions?.service,
    rememberEnabled: () => remembered,
    language: () => 'zh',
  })
  return {
    approvals,
    approval,
    questions,
    setRemember(value) {
      remembered = value
    },
  }
}

/** Resolve a decision, but fail fast with a marker when it is still pending. O(wait). */
function withTimeout(promise, ms, marker) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(marker), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

test('a request with no registered desktop call is declined', async () => {
  const { approvals } = makeApprovals()
  const decision = await approvals.decide({ appName: 'Notepad', meta: {} })
  assert.deepEqual(decision, {
    action: DECLINE, reason: 'no active pc_codex_desktop_js call',
  })
})

test('a registered call without an agent is declined', async () => {
  const { approvals } = makeApprovals()
  const exec = {
    name: 'pc_codex_desktop_js', callId: 'call-1', signal: new AbortController().signal,
  }
  const decision = await approvals.withCall(exec, () => approvals.decide({
    appName: 'Notepad', meta: {},
  }))
  assert.deepEqual(decision, { action: DECLINE, reason: 'no agent for this call' })
})

test('a missing approval service is declined', async () => {
  const { approvals } = makeApprovals({ approval: null })
  const decision = await approvals.withCall(execFor({ id: 'agent-no-service' }), () =>
    approvals.decide({ appName: 'Notepad', meta: {} }))
  assert.deepEqual(decision, { action: DECLINE, reason: 'no DSH approval service' })
})

test('the session choice is remembered for that agent only', async () => {
  const approval = approvalService()
  const questions = questionsService(picked(LABELS.session))
  const { approvals } = makeApprovals({ approval, questions })
  const firstAgent = { id: 'agent-first' }
  await approvals.withCall(execFor(firstAgent), async () => {
    assert.deepEqual(await approvals.decide({ appName: 'Notepad', meta: META }), {
      action: APPROVE, reason: 'approved for this DSH session',
    })
    // The remembered app is approved without opening another card.
    assert.deepEqual(await approvals.decide({ appName: 'Notepad', meta: META }), {
      action: APPROVE, reason: 'approved earlier in this DSH session',
    })
  })
  assert.equal(questions.requests.length, 1)
  assert.equal(approval.requests.length, 0)
  // Another DSH agent still gets the card.
  await approvals.withCall(execFor({ id: 'agent-second' }), async () => {
    await approvals.decide({ appName: 'Notepad', meta: META })
  })
  assert.equal(questions.requests.length, 2)
})

test('the remember switch off asks again', async () => {
  const approval = approvalService(['allowed-once', 'allowed-once'])
  const { approvals, setRemember } = makeApprovals({ approval })
  const exec = execFor({ id: 'agent-toggle' })
  await approvals.withCall(exec, () => approvals.decide({ appName: 'Notepad', meta: META }))
  setRemember(false)
  await approvals.withCall(exec, () => approvals.decide({ appName: 'Notepad', meta: META }))
  assert.equal(approval.requests.length, 2)
})

test('forgetAll makes the next request ask again', async () => {
  const approval = approvalService(['allowed-once', 'allowed-once'])
  const { approvals } = makeApprovals({ approval })
  const exec = execFor({ id: 'agent-forget' })
  await approvals.withCall(exec, () => approvals.decide({ appName: 'Notepad', meta: META }))
  approvals.forgetAll()
  await approvals.withCall(exec, () => approvals.decide({ appName: 'Notepad', meta: META }))
  assert.equal(approval.requests.length, 2)
})

test('DELEGATED_CALLER falls back to the one-shot card', async () => {
  const delegated = Object.assign(new Error('delegated caller'), { code: 'DELEGATED_CALLER' })
  const approval = approvalService(['allowed-once'])
  const questions = questionsService(delegated)
  const { approvals } = makeApprovals({ approval, questions })
  const decision = await approvals.withCall(execFor({ id: 'agent-delegated' }), () =>
    approvals.decide({ appName: 'Notepad', meta: {} }))
  assert.deepEqual(decision, { action: APPROVE, reason: 'approved in DSH' })
  assert.equal(questions.requests.length, 1)
  assert.equal(approval.requests.length, 1)
})

test('the one-shot card remembers only when meta asks for the session', async () => {
  const approval = approvalService(['allowed-once', 'allowed-once', 'allowed-once'])
  const { approvals } = makeApprovals({ approval })
  const rememberedAgent = { id: 'agent-remember' }
  await approvals.withCall(execFor(rememberedAgent), async () => {
    await approvals.decide({ appName: 'Notepad', meta: META })
    assert.deepEqual(await approvals.decide({ appName: 'Notepad', meta: META }), {
      action: APPROVE, reason: 'approved earlier in this DSH session',
    })
  })
  const plainAgent = { id: 'agent-plain' }
  await approvals.withCall(execFor(plainAgent), async () => {
    await approvals.decide({ appName: 'Notepad', meta: {} })
    await approvals.decide({ appName: 'Notepad', meta: {} })
  })
  assert.equal(approval.requests.length, 3)
})

test('a call that ends with its card open declines even if the service later allows', async () => {
  const pending = pendingApproval()
  const { approvals } = makeApprovals({ approval: pending })
  let decisionPromise
  const call = approvals.withCall(execFor({ id: 'agent-ended' }), async () => {
    decisionPromise = approvals.decide({ appName: 'Notepad', meta: {} })
    // Do not await: the call ends with the card still open.
    return null
  })
  await call
  assert.equal(pending.requests.length, 1)
  const decision = await withTimeout(decisionPromise, 500, 'still pending')
  assert.deepEqual(decision, { action: DECLINE, reason: 'pc_codex_desktop_js call ended' })
  // A late answer must not reopen a card whose call has ended.
  pending.requests[0].resolve('allowed-once')
  assert.deepEqual(await withTimeout(decisionPromise, 500, 'still pending'), {
    action: DECLINE, reason: 'pc_codex_desktop_js call ended',
  })
})

test('a user decline is noted on the call registration', async () => {
  const approval = approvalService(['rejected'])
  const { approvals } = makeApprovals({ approval })
  const exec = execFor({ id: 'agent-declined' })
  let registration
  const decision = await approvals.withCall(exec, async (active) => {
    registration = active
    return approvals.decide({ appName: 'Notepad', meta: {} })
  })
  assert.deepEqual(decision, { action: DECLINE, reason: 'rejected in DSH' })
  assert.equal(registration.declinedApp, 'Notepad')
})

test('a call-end decline is not noted as a user decision', async () => {
  // An ordinary question-service failure maps to "no valid choice". Keep the registration
  // active while the exec signal is already aborted, so this covers rememberDecision's
  // callEnded guard rather than "the call ended, so no registration was found".
  const noChoice = new Error('question service unavailable')
  const approval = approvalService()
  const questions = questionsService(noChoice)
  const { approvals } = makeApprovals({ approval, questions })
  const callController = new AbortController()
  const exec = { ...execFor({ id: 'agent-ended-note' }), signal: callController.signal }
  const decision = await approvals.withCall(exec, async (registration) => {
    // The DSH call is ending while its card is still open.
    callController.abort()
    const result = await approvals.decide({ appName: 'Notepad', meta: {} })
    assert.equal(registration.declinedApp, null)
    return result
  })
  assert.deepEqual(decision, { action: DECLINE, reason: 'no valid choice' })
  assert.equal(approval.requests.length, 0)
})

test('a request belongs to the earliest running call, then to the next one', async () => {
  const approval = approvalService(['allowed-once', 'allowed-once'])
  const { approvals } = makeApprovals({ approval })
  const firstExec = execFor({ id: 'agent-first' }, 'call-first')
  const secondExec = execFor({ id: 'agent-second' }, 'call-second')
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  let releaseSecond
  const secondGate = new Promise((resolve) => { releaseSecond = resolve })
  const firstCall = approvals.withCall(firstExec, () => firstGate)
  const secondCall = approvals.withCall(secondExec, () => secondGate)
  await approvals.decide({ appName: 'Notepad', meta: {} })
  assert.equal(approval.requests[0].agent, firstExec.agent)
  releaseFirst()
  await firstCall
  await approvals.decide({ appName: 'Notepad', meta: {} })
  assert.equal(approval.requests[1].agent, secondExec.agent)
  releaseSecond()
  await secondCall
})
