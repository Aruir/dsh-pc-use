// Approval policy (D2): only Codex's browser-access approval is accepted automatically.
// Every decision carries a reason so the audit log explains it, and an unrecognised
// wording fails closed instead of being accepted.

const BROWSER_APPROVAL = /^Allow Browser use to access \S+\?$/

export const APPROVE = 'accept'
export const DECLINE = 'decline'

/** True only for the exact browser-access prompt Codex sends for Chrome. */
export function isBrowserApproval(question) {
  if (typeof question !== 'string') return false
  return BROWSER_APPROVAL.test(question.trim())
}

/** Decide one `elicitation/create` request and say why. */
export function decideApproval(question, autoApprove) {
  if (autoApprove !== true) {
    return { action: DECLINE, reason: 'auto-approve is off' }
  }
  if (!isBrowserApproval(question)) {
    return { action: DECLINE, reason: 'not a browser-access approval' }
  }
  return { action: APPROVE, reason: 'browser access auto-approved' }
}
