// Approval policy: browser prompts keep the 0.2.0 auto-approve rule; desktop prompts are
// decided by the DSH host (or the user) and never auto-accepted. Anything unrecognised is
// declined. Every decision carries a reason so the audit log explains it.

const BROWSER_APPROVAL = /^Allow Browser use to access \S+\?$/
const COMPUTER_APPROVAL = /^Allow Computer Use to use "([^"]+)"\?(?![\s\S])/
const CODEX_APPROVAL = /^Allow Codex to use (.+)\?(?![\s\S])/

export const APPROVE = 'accept'
export const DECLINE = 'decline'

// The user rejected the approval card.
export const REASON_REJECTED = 'rejected in DSH'
// The user answered the question card without a valid choice.
export const REASON_NO_CHOICE = 'no valid choice'
// The user allowed this app for the rest of this DSH session.
export const REASON_SESSION = 'approved for this DSH session'
// The approving desktop call ended while DSH was still asking.
export const REASON_CALL_ENDED = 'pc_codex_desktop_js call ended'

/**
 * True for a denial the user caused (rejected, or answered the card without a valid choice).
 * O(1).
 */
export function isUserDenial(decision) {
  return decision.action === DECLINE
    && (decision.reason === REASON_REJECTED || decision.reason === REASON_NO_CHOICE)
}

/** True only for the exact browser-access prompt Codex sends for Chrome. */
export function isBrowserApproval(question) {
  if (typeof question !== 'string') return false
  return BROWSER_APPROVAL.test(question.trim())
}

/** Classify one approval prompt. O(n), n = question length; a few whole-line regexes. */
export function classifyApproval(question) {
  if (typeof question !== 'string') return { kind: 'other' }
  if (isBrowserApproval(question)) return { kind: 'browser' }
  const computer = COMPUTER_APPROVAL.exec(question)
  if (computer !== null) return { kind: 'computer', appName: computer[1] }
  const codex = CODEX_APPROVAL.exec(question)
  if (codex !== null) {
    const appName = codex[1].trim()
    if (appName !== '') return { kind: 'computer', appName }
  }
  return { kind: 'other' }
}

/** 0.2.0 rule for browser and unrecognised prompts; kept identical. O(1). */
export function decideLegacyApproval(question, autoApprove) {
  if (autoApprove !== true) {
    return { action: DECLINE, reason: 'auto-approve is off' }
  }
  if (!isBrowserApproval(question)) {
    return { action: DECLINE, reason: 'not a browser-access approval' }
  }
  return { action: APPROVE, reason: 'browser access auto-approved' }
}

/** Map the DSH host approval outcome to a Codex decision. O(1). */
export function decisionFromHostOutcome(outcome) {
  if (outcome === 'allowed-once') {
    return { action: APPROVE, reason: 'approved in DSH' }
  }
  if (outcome === 'rejected') {
    return { action: DECLINE, reason: REASON_REJECTED }
  }
  if (outcome === 'cancelled') {
    return { action: DECLINE, reason: 'approval cancelled' }
  }
  return { action: DECLINE, reason: 'approval unavailable' }
}

/** Read elicitation metadata from `params._meta` (MCP) or `params.meta`. O(1). */
export function readElicitationMeta(params) {
  const meta = params?._meta ?? params?.meta
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null
  return meta
}

/** App key used to remember a desktop approval: meta app first, then display name. O(1). */
export function desktopAppKey(meta, appName) {
  const app = meta?.tool_params?.app
  if (typeof app === 'string' && app !== '') return app
  if (typeof appName === 'string' && appName !== '') return appName
  return null
}

/** True when the request asks to remember the approval for this DSH session. O(1). */
export function wantsSessionApproval(meta) {
  return Array.isArray(meta?.persist) && meta.persist.includes('session')
}
