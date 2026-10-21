// r19: the approval reasons are shared constants, so the decision helpers and the desktop
// approval logic compare constants instead of repeating literals that must stay in sync.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  APPROVE, DECLINE, REASON_CALL_ENDED, REASON_NO_CHOICE, REASON_REJECTED, REASON_SESSION,
  decisionFromHostOutcome, isUserDenial,
} from '../lib/approval.js'
import { choiceDecision, desktopApprovalLabels } from '../lib/text.js'

const LABELS = desktopApprovalLabels('zh')

/** One question-card answer batch with the given selected labels. O(1). */
function answer(...selected) {
  return { answers: [{ id: 'desktop-approval', selected }] }
}

test('the reason constants keep the exact log text', () => {
  assert.equal(REASON_REJECTED, 'rejected in DSH')
  assert.equal(REASON_NO_CHOICE, 'no valid choice')
  assert.equal(REASON_SESSION, 'approved for this DSH session')
  assert.equal(REASON_CALL_ENDED, 'pc_codex_desktop_js call ended')
})

test('a host "rejected" outcome is a user denial, the others are not', () => {
  assert.equal(isUserDenial(decisionFromHostOutcome('rejected')), true)
  for (const outcome of ['allowed-once', 'cancelled', 'unavailable', undefined]) {
    assert.equal(isUserDenial(decisionFromHostOutcome(outcome)), false, String(outcome))
  }
})

test('choiceDecision returns the shared reasons', () => {
  assert.deepEqual(choiceDecision(answer(LABELS.deny), 'zh', false), {
    action: DECLINE, reason: REASON_REJECTED,
  })
  assert.deepEqual(choiceDecision(answer(), 'zh', false), {
    action: DECLINE, reason: REASON_NO_CHOICE,
  })
  assert.deepEqual(choiceDecision({ answers: [{ custom: 'my answer' }] }, 'zh', false), {
    action: DECLINE, reason: REASON_NO_CHOICE,
  })
  assert.deepEqual(choiceDecision(answer(LABELS.session), 'zh', true), {
    action: APPROVE, reason: REASON_SESSION,
  })
})
