// r15: one target's bridge lifecycle. A target is the browser or the desktop; its server is
// started lazily, reused across calls, re-checked before every reuse (D15) and rebuilt when
// its launch spec or the Codex home changes. This module owns the bridge state; index.js
// still decides what a bridge is (McpBridge) and what to forget when one stops.

import { versionFromSource } from './codex-config.js'

/** Launch fields compared before reusing a live bridge (D15). */
const SPEC_FIELDS = ['command', 'args', 'cwd', 'pipeDirectory', 'source']

/** Names of the launch fields that differ between two resolved specs. O(n), n = args. */
function changedSpecFields(previous, next) {
  const changed = []
  for (const field of SPEC_FIELDS) {
    if (field !== 'args') {
      if (previous[field] !== next[field]) changed.push(field)
      continue
    }
    const before = Array.isArray(previous.args) ? previous.args : []
    const after = Array.isArray(next.args) ? next.args : []
    const same = before.length === after.length
      && before.every((value, index) => value === after[index])
    if (!same) changed.push(field)
  }
  return changed
}

/** Trusted service names from a server's own env; null when absent or invalid. O(n). */
function trustedServiceNames(env) {
  const raw = env?.NODE_REPL_TRUSTED_SERVICES
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return Object.keys(parsed)
  } catch {
    return null
  }
}

/**
 * Build one target's bridge controller. `target` labels log lines; `resolveSpec(home)` returns
 * that target's launch spec (it may throw or return `ok: false`); `codexHome()` is read on
 * every use; `createBridge(spec)` returns an unstarted bridge with `start`/`stop`/`alive`/
 * `call`; `onStop()` runs after every stop; `log` is the plugin's log. O(1) per method plus
 * the handshake.
 */
export function createTargetBridge({
  target, resolveSpec, codexHome, createBridge, onConnected = () => {}, onStop = () => {},
  log,
}) {
  let bridge = null
  let connecting = null
  let generationCount = 0
  let lastSpec = null
  let lastSpecHome = null
  let services = null

  /**
   * Resolve the launch spec; an exception becomes `{ ok: false, reason: error.message }`.
   * O(file size).
   */
  const resolveSpecSafe = (home) => {
    try {
      return resolveSpec(home)
    } catch (error) {
      return { ok: false, reason: error.message }
    }
  }

  /** Re-resolve the launch spec; any failure or `ok: false` is null. O(file size). */
  const resolveSpecOrNull = (home) => {
    const spec = resolveSpecSafe(home)
    return spec.ok === true ? spec : null
  }

  /** Stop the bridge and forget its live state. Runs onStop even without a bridge. O(1). */
  const stop = () => {
    if (bridge !== null) bridge.stop()
    bridge = null
    services = null
    onStop()
  }

  /**
   * Tell the plugin about a finished handshake without affecting `ensure`: a throw or a
   * rejected promise is only logged. O(1).
   */
  const notifyConnected = (bridge, spec) => {
    try {
      const result = onConnected(bridge, spec)
      if (result !== null && typeof result === 'object'
        && typeof result.then === 'function') {
        result.catch(() => log('server docs update failed'))
      }
    } catch {
      log('server docs update failed')
    }
  }

  /** Lazy start, D15 re-check and codexHome handling. O(file size) per call. */
  const ensure = async () => {
    if (connecting !== null) await connecting
    const home = codexHome()
    // A changed codexHome belongs to another directory: drop this server first and
    // resolve below, so a failure never keeps the old connection (0.4.3 behaviour).
    if (lastSpecHome !== null && lastSpecHome !== home) {
      log(`Codex home changed; reconnecting (${target})`)
      stop()
    }
    // D15: Codex rewrites its config on every app start, so re-read this server's
    // launch spec before reusing its live bridge. Only this server is re-resolved.
    if (bridge !== null && bridge.alive) {
      const fresh = resolveSpecOrNull(home)
      if (fresh === null) {
        log('Codex server re-check failed; keeping the current connection')
        return bridge
      }
      const changed = lastSpec === null ? [] : changedSpecFields(lastSpec, fresh)
      if (changed.length === 0) return bridge
      // Log the field names only: the values contain paths and pipe names.
      log(`Codex server changed (${changed.join(', ')}); reconnecting (${target})`)
      stop()
    }
    if (bridge !== null) stop()
    const spec = resolveSpec(home)
    if (spec.ok !== true) throw new Error(`dsh-pc-use: ${spec.reason}`)
    lastSpec = spec
    lastSpecHome = home
    const created = createBridge(spec)
    bridge = created
    // One promise for the whole handshake: a second call during the first handshake
    // reuses this connection instead of spawning another server.
    connecting = created.start().then(
      () => {
        connecting = null
        generationCount += 1
        services = trustedServiceNames(spec.env)
        log(`connected via ${spec.source}`)
        notifyConnected(created, spec)
        return created
      },
      (error) => {
        connecting = null
        if (bridge === created) bridge = null
        throw error
      },
    )
    return connecting
  }

  /** True while a bridge object exists, alive or not. O(1). */
  const started = () => bridge !== null

  /** The live bridge, or null when there is none. O(1). */
  const liveBridge = () => (bridge !== null && bridge.alive === true ? bridge : null)

  /**
   * The last resolved native pipe while the bridge is alive, else null. The desktop turn
   * close consumes it and still ignores an empty pipe itself. O(1).
   */
  const connectedPipe = () => {
    if (bridge === null || bridge.alive !== true) return null
    return lastSpec?.pipeDirectory ?? null
  }

  /** The current bridge generation; it grows on every successful handshake. O(1). */
  const generation = () => generationCount

  /** Last resolved spec while the Codex home is unchanged; else re-resolve. O(file size). */
  const spec = () => {
    const home = codexHome()
    if (lastSpec !== null && lastSpecHome === home) return lastSpec
    return resolveSpecSafe(home)
  }

  /** This target's `pc_status` section; fields, order and values unchanged. O(file size). */
  const status = () => {
    const fresh = resolveSpecSafe(codexHome())
    const resolved = fresh.ok === true
    const connected = bridge !== null && bridge.alive
    const changed = connected && resolved && lastSpec !== null
      ? changedSpecFields(lastSpec, fresh) : []
    return {
      resolved,
      reason: resolved ? null : fresh.reason,
      source: resolved ? fresh.source : null,
      command: resolved ? fresh.command : null,
      cwd: resolved ? fresh.cwd : null,
      nativePipe: resolved ? fresh.pipeDirectory : null,
      connected,
      services: connected ? services : null,
      // The pipe of the live connection, next to the freshly resolved one.
      connectedPipe: connected && lastSpec !== null ? lastSpec.pipeDirectory : null,
      reconnectPending: connected && (resolved !== true || changed.length > 0),
      // r30: the connected bridge's MCP serverInfo (null when not connected) and the
      // version baked into the browser source path (null for the desktop side).
      serverInfo: connected ? (bridge.serverInfo ?? null) : null,
      pluginVersion: resolved ? versionFromSource(fresh.source) : null,
    }
  }

  return {
    ensure, stop, started, liveBridge, connectedPipe, generation, spec, status,
  }
}
