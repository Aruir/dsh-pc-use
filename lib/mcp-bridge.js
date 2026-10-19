// A deliberately small MCP stdio client for Codex's `cua_repl`/`node_repl` servers.
//
// It does the three things Codex's own client does and a vanilla MCP client does not:
//   1. `initialize` advertises the form and url elicitation capabilities (needed for approvals)
//   2. every `tools/call` carries `_meta` with the Codex turn metadata and call identities
//   3. server-initiated `elicitation/create` approval requests are answered locally

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import readline from 'node:readline'

import {
  classifyApproval, decideLegacyApproval, readElicitationMeta, DECLINE,
} from './approval.js'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_INIT_TIMEOUT_MS = 30_000

// The approval log must not echo a URL: its query string can carry an access token. O(n),
// n = URL length; the host name is enough to identify the request.
function approvalHostname(value) {
  try {
    const parsed = new URL(String(value))
    return parsed.hostname === '' ? 'invalid url' : parsed.hostname
  } catch {
    return 'invalid url'
  }
}

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// Every `tools/call` except `turn_ended` carries these `_meta` fields: the native Codex
// client sends them (Codex 0.163.0-alpha.10.2 source analysis, not verified on the wire).
//
// Deliberately NOT sent, because DSH has no honest value for them:
//   codex_version, sandbox, sandbox_mode, plugin_id, windowId, itemId,
//   forked_from_thread_id, parent_thread_id, subagent_kind, thread_source, turn_trigger,
//   workspaces, user_input_requested_during_turn, traceparent, tracestate,
//   codex_bridge_mcp_call_id, openai/readOnly, openai/entitlementContext, _codex_apps,
//   codex/sandbox-launcher — Codex-internal identity/state or optional tracing fields.
//   openai/confirmation_policies — sending `{}` would clear the server's own startup
//   defaults, possibly dropping confirmation prompts.
//   codex/sandbox-state, codex/sandbox-state-meta — the server's use of these values is
//   unknown, and `{"type":"disabled"}` would claim "no sandbox" for DSH.
// The last two groups are separate cards if they are ever wanted.

/**
 * `_meta["x-codex-turn-metadata"]` for one normal tools/call. `thread_id` is the
 * session_id because each DSH agent identity is a native root thread. The three review
 * booleans are false: DSH has no Guardian review, and a call exists only while the REPL
 * is enabled. O(1).
 */
function turnMetadata(identity) {
  return {
    session_id: identity.sessionId,
    thread_id: identity.sessionId,
    turn_id: identity.turnId,
    turn_started_at_unix_ms: identity.turnStartedAtUnixMs,
    auto_review_enabled: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    ...identity.model === undefined ? {} : { model: identity.model },
    ...identity.reasoningEffort === undefined
      ? {}
      : { reasoning_effort: identity.reasoningEffort },
  }
}

/**
 * Complete `_meta` for one normal tools/call: the turn metadata plus the camelCase
 * identities the native client sends. `callId` is omitted when DSH has no call id. O(1).
 */
function callMetadata(identity) {
  return {
    ...identity.callId === undefined ? {} : { callId: identity.callId },
    threadId: identity.sessionId,
    sessionId: identity.sessionId,
    'x-codex-turn-metadata': turnMetadata(identity),
  }
}

/**
 * The `turn_ended` `_meta`, kept byte for byte as it was before the r1 meta-fields work: one
 * nested object with only session_id and turn_id. Aligning it with native is the separate
 * r3 turn-ended-align card, so this branch must not gain the new fields. O(1).
 */
function turnEndedMetadata(identity) {
  return {
    'x-codex-turn-metadata': {
      session_id: identity.sessionId,
      turn_id: identity.turnId,
    },
  }
}

/** Client version advertised to the MCP server; always the package version. */
export const clientVersion = packageJson.version

export class McpBridge {
  constructor({
    command, args, env, cwd, sessionId, shouldApprove = () => false,
    isComputerEnabled = () => false,
    requestDesktopApproval = async () => null,
    // Return a decline reason when this server received an approval kind it does not own.
    unexpectedApprovalReason = () => null,
    initTimeoutMs = DEFAULT_INIT_TIMEOUT_MS, log = () => {},
  }) {
    this.command = command
    this.args = args ?? []
    this.env = env
    this.cwd = cwd
    this.sessionId = sessionId
    this.turnId = `turn-${randomUUID()}`
    // The bridge-level fallback turn never rotates, so its start time is fixed here and
    // reported by calls made without an agent (for example a reset). O(1).
    this.turnStartedAtUnixMs = Date.now()
    this.shouldApprove = shouldApprove
    this.isComputerEnabled = isComputerEnabled
    this.requestDesktopApproval = requestDesktopApproval
    this.unexpectedApprovalReason = unexpectedApprovalReason
    this.initTimeoutMs = initTimeoutMs
    this.log = log
    this.child = null
    this.ready = false
    this.pending = new Map()
    // Elicitation ids already answered; one request must never get two replies.
    this.answeredApprovals = new Set()
    // Elicitations received but not answered yet; call timeouts pause while non-empty.
    this.activeApprovals = new Set()
    this.callTimersPaused = false
    this.nextId = 1
    this.starting = null
    this.stderrTail = []
  }

  get alive() {
    if (this.ready !== true || this.child === null) return false
    return this.child.exitCode === null && this.child.killed === false
  }

  async start() {
    if (this.starting !== null) return this.starting
    if (this.alive) return
    this.starting = this.#spawnAndHandshake().catch((error) => {
      this.#discardChild()
      this.starting = null
      throw error
    })
    return this.starting
  }

  /** Kill and forget the child; a live handshake rejects through `#failAll`/`exit`. */
  #discardChild() {
    this.ready = false
    const child = this.child
    this.child = null
    this.starting = null
    if (child === null) return
    try {
      child.stdin.end()
    } catch {}
    try {
      child.kill()
    } catch {}
  }

  #spawnAndHandshake() {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(this.command, this.args, {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.env,
          windowsHide: true,
        })
      } catch (error) {
        reject(new Error(`spawn failed: ${error.message}`))
        return
      }
      this.child = child
      this.ready = false
      this.stderrTail = []

      child.on('error', (error) => {
        if (this.child !== child) return
        this.#failAll(new Error(`Codex computer-use server error: ${error.message}`))
        this.#discardChild()
        reject(error)
      })
      child.on('exit', (code) => {
        // A child discarded by `#discardChild` is no longer the current one; its late
        // exit must not fail the handshake of a replacement child.
        if (this.child !== child) return
        this.ready = false
        this.child = null
        this.starting = null
        this.#failAll(new Error(`Codex computer-use server exited (code ${code})${this.#stderrSuffix()}`))
      })
      child.stderr.on('data', (chunk) => {
        const text = String(chunk)
        this.log(`stderr ${text.trim()}`)
        this.stderrTail.push(text)
        if (this.stderrTail.length > 20) this.stderrTail.shift()
      })
      // A dead child makes `stdin.write` fail asynchronously; log it instead of letting
      // the unhandled 'error' event take the host process down.
      child.stdin.on('error', (error) => {
        this.log(`stdin error: ${error.message}`)
      })
      readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
        .on('line', (line) => this.#onLine(line))

      const init = {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: {
          // Native Codex sends 2025-06-18 and both elicitation modes. Advertising url means
          // the server may ask the user to open a URL; #onApproval declines those requests.
          protocolVersion: '2025-06-18',
          capabilities: { elicitation: { form: {}, url: {} } },
          clientInfo: { name: 'dsh-pc-use', version: clientVersion },
        },
      }
      const entry = {
        resolve: (result) => {
          try {
            this.#write({ jsonrpc: '2.0', method: 'notifications/initialized' })
          } catch (error) {
            reject(error)
            return
          }
          this.ready = true
          resolve(result)
        },
        reject,
        timer: setTimeout(() => {
          this.pending.delete(init.id)
          const error = new Error(
            `initialize timed out after ${this.initTimeoutMs}ms${this.#stderrSuffix()}`,
          )
          this.#discardChild()
          reject(error)
        }, this.initTimeoutMs),
      }
      this.pending.set(init.id, entry)
      try {
        this.#write(init)
      } catch (error) {
        this.pending.delete(init.id)
        clearTimeout(entry.timer)
        this.#discardChild()
        reject(error)
      }
    })
  }

  /** Tell the server the client gave up, so the running code can be cancelled. */
  #cancel(requestId, reason) {
    try {
      this.#write({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId, reason },
      })
    } catch (error) {
      this.log(`cancel notification failed: ${error.message}`)
    }
  }

  #stderrSuffix() {
    const tail = this.stderrTail.join('').trim()
    return tail === '' ? '' : `: ${tail.slice(-600)}`
  }

  #write(message) {
    if (this.child === null || this.child.stdin.destroyed) throw new Error('Codex computer-use server is not running')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /** Count a received elicitation; the first one pauses every call timer. O(1). */
  #beginApproval(id) {
    if (this.activeApprovals.has(id)) return
    this.activeApprovals.add(id)
    if (this.activeApprovals.size === 1) this.#pauseCallTimers()
  }

  /** Count an answered elicitation; the last one resumes the call timers. O(1) + O(p). */
  #endApproval(id) {
    if (!this.activeApprovals.delete(id)) return
    if (this.activeApprovals.size === 0) this.#resumeCallTimers()
  }

  /** Stop every pending tool call timer and remember its remaining time. O(p), p = calls. */
  #pauseCallTimers() {
    this.callTimersPaused = true
    const now = Date.now()
    for (const entry of this.pending.values()) {
      if (entry.kind !== 'call' || entry.timer === null) continue
      clearTimeout(entry.timer)
      entry.timer = null
      entry.remainingMs = Math.max(0, entry.deadline - now)
    }
    this.log('call timers paused (approval pending)')
  }

  /** Re-arm every paused tool call timer with its remaining time. O(p), p = calls. */
  #resumeCallTimers() {
    this.callTimersPaused = false
    for (const entry of this.pending.values()) {
      if (entry.kind !== 'call' || entry.timer !== null) continue
      this.#startCallTimer(entry, entry.remainingMs ?? entry.timeoutMs)
    }
    this.log('call timers resumed')
  }

  /** Arm one tool call timer for `ms`; the timer is the only pending state. O(1). */
  #startCallTimer(entry, ms) {
    entry.remainingMs = null
    entry.deadline = Date.now() + ms
    entry.timer = setTimeout(() => {
      if (this.pending.get(entry.id) !== entry) return
      this.pending.delete(entry.id)
      this.#cancel(entry.id, `client timed out after ${entry.timeoutMs}ms`)
      entry.reject(new Error(
        `${entry.name} timed out after ${entry.timeoutMs}ms; `
          + 'the code may still be running on the server',
      ))
    }, ms)
  }

  /** Answer one elicitation. O(n), n = question length; one regex per prompt kind. */
  #onApproval(id, params) {
    this.#beginApproval(id)
    // URL-mode requests are declined before classification: the plugin has no UI to open a
    // URL, so a browser-looking message must not reach autoApprove or the desktop card.
    // Only the host name is logged, never the URL and its possible query-string token.
    if (params?.mode === 'url') {
      this.#replyApproval(id, approvalHostname(params?.url), {
        action: DECLINE,
        reason: 'url elicitation is not supported',
      })
      return
    }
    const question = params?.message ?? JSON.stringify(params ?? {})
    const classified = classifyApproval(question)
    const unexpected = this.unexpectedApprovalReason(classified.kind)
    if (typeof unexpected === 'string' && unexpected !== '') {
      this.#replyApproval(id, question, { action: DECLINE, reason: unexpected })
      return
    }
    if (classified.kind === 'computer') {
      if (this.isComputerEnabled() !== true) {
        this.#replyApproval(id, question, { action: DECLINE, reason: 'computer use is off' })
        return
      }
      this.#replyAfterHostApproval(id, question, classified.appName, readElicitationMeta(params))
      return
    }
    // Browser and unrecognised prompts keep the exact 0.2.0 decision and reasons.
    this.#replyApproval(id, question, decideLegacyApproval(question, this.shouldApprove() === true))
  }

  /** Log and write one approval reply; never throws or replies twice. O(1). */
  #replyApproval(id, question, decision) {
    if (this.answeredApprovals.has(id)) return
    this.answeredApprovals.add(id)
    this.log(`approval ${JSON.stringify(question)} -> ${decision.action} (${decision.reason})`)
    // The child may already be gone; a failed reply must not throw out of the parser.
    try {
      this.#write({
        jsonrpc: '2.0',
        id,
        result: { action: decision.action, content: {} },
      })
    } catch (error) {
      this.log(`approval reply failed: ${error.message}`)
    }
    this.#endApproval(id)
  }

  /** Ask the DSH host, then reply; always settles so no promise is left pending. O(1). */
  async #replyAfterHostApproval(id, question, appName, meta) {
    let decision
    try {
      decision = await this.requestDesktopApproval({ appName, question, meta })
    } catch {
      decision = { action: DECLINE, reason: 'approval request failed' }
    }
    if (decision === null || decision === undefined) {
      decision = { action: DECLINE, reason: 'approval unavailable' }
    }
    this.#replyApproval(id, question, decision)
  }

  #onLine(line) {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.log(`unparsed server output: ${line.slice(0, 200)}`)
      return
    }

    // Server-initiated request: answer approvals here, decline to invent others.
    if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
      if (message.method === 'elicitation/create') {
        this.#onApproval(message.id, message.params)
        return
      }
      try {
        this.#write({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `method not supported by dsh-pc-use: ${message.method}`,
          },
        })
      } catch (error) {
        this.log(`method reply failed: ${error.message}`)
      }
      return
    }

    // Responses.
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) {
      entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
    } else {
      entry.resolve(message.result)
    }
  }

  /**
   * Call an MCP tool and return its raw result. `turn` is this call's identity snapshot
   * (an agent turn or the caller's copy); `options.metaMode` is 'turn-ended' for the
   * turn_ended report, which keeps its old `_meta` byte for byte.
   */
  async call(name, args, timeoutMs = DEFAULT_TIMEOUT_MS, turn = null, options = {}) {
    // D16: fix the call identity before any await. The caller may rotate its turn state
    // as soon as this call is handed off, and _meta must describe this call, not the next.
    const identity = {
      sessionId: turn?.sessionId ?? this.sessionId,
      turnId: turn?.turnId ?? this.turnId,
      turnStartedAtUnixMs: turn?.turnStartedAtUnixMs ?? this.turnStartedAtUnixMs,
      callId: turn?.callId,
      model: turn?.model,
      reasoningEffort: turn?.reasoningEffort,
    }
    const meta = options.metaMode === 'turn-ended'
      ? turnEndedMetadata(identity)
      : callMetadata(identity)
    await this.start()
    const id = this.nextId++
    const request = {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name,
        arguments: args ?? {},
        _meta: meta,
      },
    }
    return new Promise((resolve, reject) => {
      const entry = {
        kind: 'call',
        id,
        name,
        timeoutMs,
        timer: null,
        remainingMs: timeoutMs,
        deadline: 0,
        resolve,
        reject,
      }
      this.pending.set(id, entry)
      // D14: a call made while an approval is pending starts paused and gets its whole
      // timeout back when the last approval is answered.
      if (this.callTimersPaused !== true) this.#startCallTimer(entry, timeoutMs)
      try {
        this.#write(request)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(entry.timer)
        reject(error)
      }
    })
  }

  stop() {
    this.ready = false
    this.activeApprovals.clear()
    this.callTimersPaused = false
    this.#failAll(new Error('Codex computer-use bridge stopped'))
    this.#discardChild()
  }
}
