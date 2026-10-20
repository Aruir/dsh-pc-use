// r14: desktop approvals for Codex Computer Use. An elicitation request carries no tool call
// id, so a desktop approval is attributed to the earliest-started desktop call still running;
// with none it is declined. Remembered approvals are per DSH agent and per app for the life of
// a desktop bridge: a desktop bridge rebuild forgets them, a browser rebuild does not.

import {
  APPROVE, DECLINE, REASON_CALL_ENDED, REASON_NO_CHOICE, REASON_SESSION,
  decisionFromHostOutcome, desktopAppKey, isUserDenial, wantsSessionApproval,
} from './approval.js'
import {
  auditReason, choiceDecision, desktopApprovalQuestion, legacyDisplayReason,
} from './text.js'

// Marker for "the approving desktop call ended while DSH was still asking".
const CALL_ENDED = Symbol('pc_codex_desktop_js call ended')

// Marker for "only the one-shot approval card can be used (no top-level agent)".
const DELEGATED = Symbol('delegated caller')

/** The decline used whenever the approving desktop call has ended. A new object each time. O(1). */
function callEndedDecision() {
  return { action: DECLINE, reason: REASON_CALL_ENDED }
}

/**
 * Build desktop approval handling. `approvalService()` and `questionsService()` are read on
 * every request, because a DSH service may appear after the plugin loads; `rememberEnabled()`
 * and `language()` are read per request too, so hot config changes apply. O(1) per call plus
 * the wait for the user.
 */
export function createDesktopApprovals({
  approvalService, questionsService, rememberEnabled, language,
}) {
  // Only desktop tools register here. Each registration also owns the app of a user-caused
  // denial for THIS call, so concurrent calls cannot steal each other's note (feature B).
  const activeCalls = []

  // Remembered desktop approvals: WeakMap(agent -> Set(appKey)). The agent object is a
  // process-local object, so entries disappear with the agent; a desktop bridge rebuild
  // resets it, a browser bridge rebuild does not.
  let rememberedApps = new WeakMap()

  /** Forget every remembered desktop approval. O(1). */
  const forgetAll = () => {
    rememberedApps = new WeakMap()
  }

  /** True when this agent already allowed this app. O(1). */
  const wasRemembered = (agent, appKey) => rememberedApps.get(agent)?.has(appKey) === true

  /** Remember one app for one agent. O(1). */
  const rememberApp = (agent, appKey) => {
    let apps = rememberedApps.get(agent)
    if (apps === undefined) {
      apps = new Set()
      rememberedApps.set(agent, apps)
    }
    apps.add(appKey)
  }

  /** Remember a user-caused denial's app on the call registration it belongs to. O(1). */
  const rememberDecision = (decision, appName) => {
    const registration = activeCalls[0]
    // A call that is already ending may surface as "no valid choice"; that is not a user
    // decision, so it must not get the no-retry note.
    const callEnded = registration?.exec?.signal?.aborted === true
    if (callEnded !== true && isUserDenial(decision)) {
      if (registration !== undefined) registration.declinedApp = appName
    }
    return decision
  }

  /**
   * Register one desktop call for its whole lifetime. The registration exposes the call's
   * `exec` and its user-caused `declinedApp` note (null when none; the caller may clear it);
   * `controller` is internal. Ending the call unregisters it and aborts its pending approval,
   * so an unanswered card cannot outlive the call. O(1).
   */
  const withCall = async (exec, task) => {
    const registration = { exec, controller: new AbortController(), declinedApp: null }
    activeCalls.push(registration)
    try {
      return await task(registration)
    } finally {
      const position = activeCalls.indexOf(registration)
      if (position >= 0) activeCalls.splice(position, 1)
      // Ending the call must also end its pending desktop approval.
      registration.controller.abort()
    }
  }

  /**
   * Ask DSH to approve one desktop app. The three-option question card is used when
   * the host allows it; otherwise the 0.4.1 one-shot approval card is used unchanged.
   * O(1) apart from waiting for the user.
   */
  const decide = async ({ appName, meta }) => {
    const active = activeCalls[0]
    if (active === undefined || active.exec === undefined || active.exec === null) {
      return { action: DECLINE, reason: 'no active pc_codex_desktop_js call' }
    }
    const exec = active.exec
    if (exec.agent === undefined || exec.agent === null) {
      return { action: DECLINE, reason: 'no agent for this call' }
    }
    const remember = rememberEnabled()
    if (remember !== true) {
      forgetAll()
    }
    const appKey = desktopAppKey(meta, appName)
    const wantSession = wantsSessionApproval(meta)
    // The server keeps its own session-wide copy only when this decision also makes the
    // plugin remember the app (or it already has) and the request asked for `session`.
    // `always` is never sent. O(1).
    const withSessionPersist = (decision, remembered) => (
      remembered === true && decision.action === APPROVE && wantSession
        ? { ...decision, persist: 'session' }
        : decision
    )
    if (remember === true && appKey !== null && wasRemembered(exec.agent, appKey)) {
      return withSessionPersist(
        { action: APPROVE, reason: 'approved earlier in this DSH session' }, true,
      )
    }
    const approval = approvalService()
    if (approval === undefined || approval === null) {
      return { action: DECLINE, reason: 'no DSH approval service' }
    }
    const callSignal = active.controller.signal
    const signals = [callSignal]
    if (exec.signal !== undefined && exec.signal !== null) {
      signals.push(exec.signal)
    }
    const signal = signals.length > 1 ? AbortSignal.any(signals) : callSignal
    const ended = new Promise((resolve) => {
      if (callSignal.aborted) {
        resolve(CALL_ENDED)
        return
      }
      callSignal.addEventListener('abort', () => resolve(CALL_ENDED), { once: true })
    })
    const sessionOption = remember === true && wantsSessionApproval(meta)
    const questions = questionsService()
    const lang = language()
    if (canUseDesktopChoices(approval, questions, exec.agent)) {
      const decision = await requestDesktopChoice({
        questions,
        agent: exec.agent,
        appName,
        language: lang,
        signal,
        ended,
        callSignal,
        sessionOption,
        remember,
        appKey,
      })
      if (decision !== DELEGATED) {
        const remembered = decision.action === APPROVE && decision.reason === REASON_SESSION
          && remember === true && appKey !== null
        return rememberDecision(withSessionPersist(decision, remembered), appName)
      }
    }
    const legacy = await requestLegacyDesktopApproval({
      approval, exec, appName, language: lang, signal, ended, callSignal, remember, appKey, meta,
    })
    const legacyRemembered = remember === true && legacy.action === APPROVE
      && appKey !== null && wantSession
    return rememberDecision(withSessionPersist(legacy, legacyRemembered), appName)
  }

  /** True when the three-option question card may be used. O(1). */
  const canUseDesktopChoices = (approval, questions, agent) => {
    if (questions === undefined || questions === null) return false
    try {
      return approval.effectivePolicy(agent.session) === 'ask'
    } catch {
      return false
    }
  }

  /**
   * Show the three-option card and map its answer. Returns DELEGATED when only a
   * subagent may ask, so the caller falls back to the one-shot card. O(1) + the wait.
   */
  const requestDesktopChoice = async ({
    questions, agent, appName, language, signal, ended, callSignal, sessionOption, remember,
    appKey,
  }) => {
    try {
      const answer = await Promise.race([
        questions.ask({
          questions: [desktopApprovalQuestion(language, appName, sessionOption)],
          agent,
          signal,
        }),
        ended,
      ])
      if (callSignal.aborted || answer === CALL_ENDED) {
        return callEndedDecision()
      }
      const decision = choiceDecision(answer, language, sessionOption)
      if (
        decision.action === APPROVE
        && decision.reason === REASON_SESSION
        && remember === true
        && appKey !== null
      ) {
        rememberApp(agent, appKey)
      }
      return decision
    } catch (error) {
      if (callSignal.aborted) {
        return callEndedDecision()
      }
      if (error?.code === 'DELEGATED_CALLER') return DELEGATED
      return { action: DECLINE, reason: REASON_NO_CHOICE }
    }
  }

  /**
   * The 0.4.1 one-shot approval path, used whenever the question card does not apply.
   * O(1) apart from waiting for the user.
   */
  const requestLegacyDesktopApproval = async ({
    approval, exec, appName, language, signal, ended, callSignal, remember, appKey, meta,
  }) => {
    try {
      const outcome = await Promise.race([
        approval.request({
          agent: exec.agent,
          toolName: exec.name,
          callId: exec.callId,
          reason: auditReason(language, appName),
          displayReason: legacyDisplayReason(appName),
          signal,
        }),
        ended,
      ])
      // A call that already ended must never approve a stale card, even when the
      // user answered at the same moment.
      if (callSignal.aborted || outcome === CALL_ENDED) {
        return callEndedDecision()
      }
      const decision = decisionFromHostOutcome(outcome)
      if (
        remember === true
        && decision.action === APPROVE
        && appKey !== null
        && wantsSessionApproval(meta)
      ) {
        rememberApp(exec.agent, appKey)
      }
      return decision
    } catch {
      // A request that failed because the call ended is a call-end decline, not a
      // host failure; keep the log reason accurate.
      if (callSignal.aborted) {
        return callEndedDecision()
      }
      return { action: DECLINE, reason: 'approval request failed' }
    }
  }

  return { withCall, decide, forgetAll }
}
