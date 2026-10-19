// r13: per-agent Codex turn identity for DSH sessions. One agent (one DSH session) keeps one
// Codex session id across turns; each turn gets its own turn id and start time. The tracker
// also remembers whether a turn used the desktop bridge and that bridge's generation, because
// only then may the desktop cursor be closed. Sending stays in index.js: it needs the live
// bridges.

import { randomUUID } from 'node:crypto'

/** The servers a turn can be reported to, in send order. */
const KINDS = ['browser', 'desktop']

/**
 * Build the turn tracker. `generationOf(kind)` returns that server's current bridge
 * generation; `now` and `newId` are injected by tests only. Each method is O(1).
 */
export function createTurnTracker({ generationOf, now = Date.now, newId = randomUUID }) {
  // F6: one Codex session/turn identity per DSH agent, shared by both servers.
  const agentTurns = new WeakMap()
  // Subagent sessions are keyed by the session object, so entries disappear with it.
  const subagentSessions = new WeakSet()

  /** A fresh per-agent turn identity. O(1). */
  const newTurnState = () => ({
    sessionId: newId(),
    turnId: newId(),
    // The turn identity's creation time; rotated together with turnId (D16 / meta-fields) so
    // every call reports the start of the turn it belongs to, not of the next one.
    startedAtUnixMs: now(),
    used: { browser: false, desktop: false },
    generations: { browser: -1, desktop: -1 },
  })

  /** Get this agent's Codex identity; created on first use. O(1). */
  const turnStateFor = (agent) => {
    let state = agentTurns.get(agent)
    if (state === undefined) {
      state = newTurnState()
      agentTurns.set(agent, state)
    }
    return state
  }

  /**
   * The model and reasoning effort of the DSH agent running a call, read from the request
   * header the DSH agent loop logs for its latest request (packages/core/session:
   * `Session.requestHeader()`, an `EpochHeader` whose `config` is the resolved
   * `LlmCallConfig`). A tool call only runs after a request, but a missing or throwing
   * header simply omits both fields instead of failing the call. O(1).
   */
  const agentRoute = (agent) => {
    let config
    try {
      config = agent?.session?.requestHeader?.()?.config
    } catch {
      return {}
    }
    const model = config?.model
    const reasoningEffort = config?.reasoningEffort
    return {
      model: typeof model === 'string' && model !== '' ? model : undefined,
      reasoningEffort: typeof reasoningEffort === 'string' && reasoningEffort !== ''
        ? reasoningEffort
        : undefined,
    }
  }

  /**
   * One call's `_meta` identity. The per-call values come from the DSH tool execution:
   * `callId`, and the agent's current route for model/effort. `beginCall` calls this in the
   * same synchronous block that marks the server used, so `_meta` and the "used" marker
   * always describe the same turn (F1). O(1).
   */
  const callIdentity = (state, exec) => {
    const route = agentRoute(exec?.agent)
    return {
      sessionId: state?.sessionId,
      turnId: state?.turnId,
      turnStartedAtUnixMs: state?.startedAtUnixMs,
      callId: typeof exec?.callId === 'string' && exec.callId !== '' ? exec.callId : undefined,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
    }
  }

  /**
   * Begin one call: return its identity and mark the server used in the same synchronous
   * block (F1). A call without an agent has no tracked turn, so its three turn fields stay
   * undefined and nothing is marked used. O(1).
   */
  const beginCall = (exec, kind) => {
    const agent = exec?.agent
    const state = agent === null || agent === undefined ? null : turnStateFor(agent)
    const identity = callIdentity(state, exec)
    if (state !== null) {
      state.used[kind] = true
      state.generations[kind] = generationOf(kind)
    }
    return identity
  }

  /** Codex hook name for a finished DSH turn. O(1). */
  const turnEndedHookName = (event, subagent) => {
    if (subagent === true) return 'SubagentStop'
    const kind = event?.data?.reason?.kind
    if (kind === 'aborted' || kind === 'interrupted') return 'Interrupt'
    return 'Stop'
  }

  /**
   * Track subagent sessions and describe a finished turn: its hook name, the identity to
   * report, both server kinds in send order, and whether the desktop cursor should be closed.
   * Native Codex calls `turn_ended` on every connected server, whether or not the turn used
   * it, so `kinds` is always browser then desktop; the caller skips servers without a live
   * connection. `closeDesktop` is true only when this turn used the desktop bridge and that
   * bridge was not rebuilt since. Returns null for an event that is not a reportable turn.
   * The turn rotates before returning, so the next call starts a new one. O(1).
   */
  const onSessionEvent = (agents, session, event) => {
    if (event?.type === 'subagent/descriptor') {
      subagentSessions.add(session)
      return null
    }
    if (event?.type !== 'turn/end') return null
    const agent = agents?.get(session.id)
    if (agent === undefined || agent === null) return null
    const state = agentTurns.get(agent)
    if (state === undefined) return null
    const hookEventName = turnEndedHookName(event, subagentSessions.has(session))
    const identity = { sessionId: state.sessionId, turnId: state.turnId }
    // The cursor belongs to the desktop bridge this turn used; a rebuilt bridge keeps its
    // cursor for the turn that uses the new connection.
    const closeDesktop = state.used.desktop === true
      && state.generations.desktop === generationOf('desktop')
    state.turnId = newId()
    // A rotated turn gets a new start time, so the next call reports a later one.
    state.startedAtUnixMs = now()
    state.used = { browser: false, desktop: false }
    state.generations = { browser: -1, desktop: -1 }
    return { hookEventName, identity, kinds: [...KINDS], closeDesktop }
  }

  return { beginCall, onSessionEvent }
}
