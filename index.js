// dsh-pc-use — Codex Computer Use as native DeepSeek Harness tools.
//
// Codex runs browser computer use in its `cua_repl` MCP server and Windows desktop
// control in `node_repl`; this plugin starts each server the way Codex does, with its
// own source and its own unmodified environment:
//   browser tools -> cua_repl  (`lib/codex-config.js` resolveBrowserServer)
//   desktop tools -> node_repl (resolveDesktopServer)
// `lib/mcp-bridge.js` adds the three things a vanilla MCP client does not do: turn
// metadata on every call, an advertised elicitation capability, and local answers to
// the approval requests the servers send back.
//
// Everything is lazy: importing or applying the plugin never spawns a process.

import { readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  COMPUTER_USE_DOC_TOPICS, defaultCodexHome, resolveBrowserServer, resolveComputerUseDocs,
  resolveDesktopServer, versionFromSource,
} from './lib/codex-config.js'
import { SKILL_DSH_NOTES, SKILL_NAME, readCodexSkill } from './lib/codex-skill.js'
import { unwrapConfigValue } from './lib/config-value.js'
import { createDesktopApprovals } from './lib/desktop-approvals.js'
import { fallbackPlaceholders, prepareImageProjection } from './lib/image-projection.js'
import { saveImage } from './lib/images.js'
import { appendLogLine, checkLogWritable } from './lib/log-file.js'
import { endTurn } from './lib/native-pipe.js'
import {
  composeDescription, docsFromServer, readDocsCache, specFingerprint, writeDocsCacheEntry,
} from './lib/server-docs.js'
import { readService } from './lib/services.js'
import { McpBridge } from './lib/mcp-bridge.js'
import { definePortableTool } from './lib/define-tool.js'
import { tabGuardSource } from './lib/tab-guard.js'
import { createTargetBridge } from './lib/target-bridge.js'
import {
  CONFIG_I18N, TEXT, closeAppsNote, declineNote, illegalReturnNote, noAccessibilityTreeNote,
  resolveLanguage, serverDocsChangedNote, systemLocale,
} from './lib/text.js'
import { parseObserveArgs, parsePlanArgs } from './lib/tool-args.js'
import {
  BROWSER_JS_DESCRIPTION, BROWSER_JS_RESET_DESCRIPTION, BROWSER_JS_RESET_RULES, BROWSER_JS_RULES,
  DESKTOP_ADD_NODE_MODULE_DIR_DESCRIPTION, DESKTOP_ADD_NODE_MODULE_DIR_RULES,
  DESKTOP_JS_DESCRIPTION, DESKTOP_JS_RESET_DESCRIPTION, DESKTOP_JS_RESET_RULES, DESKTOP_JS_RULES,
} from './lib/tool-docs.js'
import { createTurnTracker } from './lib/turn-tracker.js'

export const name = 'pc-use'
export const inject = ['tools']

// r26: provider name in DSH's skill registry; `codex-computer-use` is the skill name.
const SKILL_PROVIDER_NAME = 'dsh-pc-use'

// Both platform packages are supplied by the running harness. A soft import keeps
// this module loadable (tools use a JSON Schema adapter) if a future build moves
// them; a hard failure here would take every tool down at once.
let Schema = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  Schema = mod?.default?.object !== undefined ? mod.default : (mod?.object !== undefined ? mod : null)
} catch (error) {
  console.warn('dsh-pc-use: @deepseek-ai/schemastery unavailable — config defaults are applied by hand', error)
}

let defineTool = null
try {
  defineTool = (await import('@deepseek-ai/dsh-tools')).defineTool ?? null
} catch (error) {
  console.warn('dsh-pc-use: @deepseek-ai/dsh-tools unavailable — using the JSON Schema adapter')
}

/**
 * @typedef {{enabled: boolean, autoApprove: boolean, computer: boolean,
 *   rememberDesktopApprovals: boolean, language: string,
 *   codexHome: string, logFile: string, timeoutMs: number,
 *   attachImages: boolean, keepImageFiles: boolean, allowUserTabs: boolean,
 *   tools: {js: boolean, reset: boolean, desktopJs: boolean, desktopReset: boolean,
 *     desktopAddNodeModuleDir: boolean, observe: boolean, runPlan: boolean,
 *     docs: boolean, status: boolean}}} Config
 */

/** One tool call's timeout unless the configuration sets another. */
const DEFAULT_TIMEOUT_MS = 120000

/**
 * The plugin's configuration schema. `autoApprove`, `computer`,
 * `rememberDesktopApprovals`, `language`, `codexHome`, `logFile`
 * and `timeoutMs` are `.volatile()`: the loader writes new values into the running plugin
 * and every use re-reads them, so they never remount it (the settings page edits them live).
 * `enabled` and `tools.*` are deliberately not volatile: changing one remounts the plugin,
 * the old bridges are disposed by `ctx.effect`, and the tools are registered again.
 */
function buildConfig(schema) {
  if (schema === null) return undefined
  try {
    return schema.object({
      enabled: schema.boolean().default(true)
        .description(TEXT.zh.config.enabled),
      autoApprove: schema.boolean().default(false)
        .description(TEXT.zh.config.autoApprove)
        .volatile(),
      computer: schema.boolean().default(false)
        .description(TEXT.zh.config.computer)
        .volatile(),
      rememberDesktopApprovals: schema.boolean().default(true)
        .description(TEXT.zh.config.rememberDesktopApprovals)
        .volatile(),
      language: schema.union(['auto', 'zh', 'en']).default('auto')
        .description(TEXT.zh.config.language)
        .volatile(),
      codexHome: schema.string().default('')
        .description(TEXT.zh.config.codexHome)
        .volatile(),
      logFile: schema.string().default('')
        .description(TEXT.zh.config.logFile)
        .volatile(),
      timeoutMs: schema.number().default(DEFAULT_TIMEOUT_MS)
        .description(TEXT.zh.config.timeoutMs)
        .volatile(),
      attachImages: schema.boolean().default(true)
        .description(TEXT.zh.config.attachImages)
        .volatile(),
      keepImageFiles: schema.boolean().default(false)
        .description(TEXT.zh.config.keepImageFiles)
        .volatile(),
      allowUserTabs: schema.boolean().default(false)
        .description(TEXT.zh.config.allowUserTabs)
        .volatile(),
      prefetchServerDocs: schema.boolean().default(true)
        .description(TEXT.zh.config.prefetchServerDocs)
        .volatile(),
      tools: schema.object({
        js: schema.boolean().default(true).description(TEXT.zh.config.tools.js),
        reset: schema.boolean().default(true).description(TEXT.zh.config.tools.reset),
        desktopJs: schema.boolean().default(true)
          .description(TEXT.zh.config.tools.desktopJs),
        desktopReset: schema.boolean().default(true)
          .description(TEXT.zh.config.tools.desktopReset),
        desktopAddNodeModuleDir: schema.boolean().default(true)
          .description(TEXT.zh.config.tools.desktopAddNodeModuleDir),
        docs: schema.boolean().default(true)
          .description(TEXT.zh.config.tools.docs),
        status: schema.boolean().default(true).description(TEXT.zh.config.tools.status),
        observe: schema.boolean().default(true)
          .description(TEXT.zh.config.tools.observe),
        runPlan: schema.boolean().default(true)
          .description(TEXT.zh.config.tools.runPlan),
      }).description(TEXT.zh.config.tools.description),
    }).description(TEXT.zh.config.description)
      .i18n(CONFIG_I18N)
  } catch (error) {
    console.warn('dsh-pc-use: building the Config schema failed — running on built-in defaults', error)
    return undefined
  }
}

export const Config = buildConfig(Schema)

const RESOLVERS = { browser: resolveBrowserServer, desktop: resolveDesktopServer }

/** One error's message text; the non-Error fallback matches the old String() coercion. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function defaultLogFile() {
  return join(homedir(), '.dsh', 'pc-use.log')
}

function imagesDirectory() {
  return join(homedir(), '.dsh', 'pc-use-images')
}

/** Replaceable nonce marker for one image collected across a tool call. O(1). */
function imageMarker(collector, index) {
  return `\u0000pc-image:${collector.nonce}:${index}\u0000`
}

/**
 * Flatten an MCP tool result into the canonical string value DSH renders for the model.
 * With a collector, images become markers for the execute-time projection decision;
 * without one (or on an error), they keep the existing local-path fallback. O(content).
 */
function renderResult(result, collector = null) {
  const items = Array.isArray(result?.content) ? result.content : []
  const parts = []
  for (const item of items) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    } else if (item?.type === 'image') {
      if (collector !== null && result?.isError !== true) {
        const index = collector.images.length
        collector.images.push(item)
        parts.push(imageMarker(collector, index))
      } else if (typeof item.data === 'string') {
        // The canonical value is a string, so keep the image reachable instead of dropping it.
        try {
          const file = saveImage(item, imagesDirectory())
          parts.push(`[image saved: ${file}]`)
        } catch {
          parts.push('[image could not be saved]')
        }
      } else {
        parts.push(JSON.stringify(item))
      }
    } else if (item != null) {
      parts.push(JSON.stringify(item))
    }
  }
  const text = parts.join('\n')
  if (result?.isError === true) throw new Error(text || 'Codex computer-use tool returned an error')
  return text
}

/**
 * Native Codex puts this header in front of a direct MCP call's result, before the server
 * text: the wall time with four decimals and an `Output:` marker. O(1).
 */
function wallTimeHeader(elapsedMs) {
  return `Wall time: ${(elapsedMs / 1000).toFixed(4)} seconds\nOutput:\n`
}

/** Wrap a spec with defineTool when the platform package is available. */
function tool(spec) {
  return definePortableTool(spec, defineTool)
}

const output = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
}

const MAX_DOC_BYTES = 512 * 1024
const DOCS_EXPLANATION = [
  'In DSH this document maps to the following:',
  '- `node_repl` JavaScript runs through the `pc_codex_desktop_js` tool.',
  '- Reset the JavaScript session with `pc_codex_desktop_js_reset`.',
  '- Run the code from the Initialize section inside `pc_codex_desktop_js`.',
  '- Desktop approvals appear as DSH approval cards.',
  `- ${closeAppsNote('en')}`,
].join('\n')

/** What a desktop call reports when `computer` is off. O(1). */
const COMPUTER_OFF = 'dsh-pc-use: computer use is off; '
  + 'set computer: true in the dsh-pc-use configuration'
const CHECK_FAILED_MARKER = 'pc_codex_run_plan check failed'
// Two fixed guard sources: the user-tabs switch is read for every call, but only its value
// changes, so building the source once per state keeps the per-call cost constant.
const TAB_GUARD_USER_TABS_OFF = tabGuardSource(false)
const TAB_GUARD_USER_TABS_ON = tabGuardSource(true)

/**
 * @param {{enabled?: boolean, autoApprove?: boolean, computer?: boolean,
 *   rememberDesktopApprovals?: boolean,
 *   language?: string, codexHome?: string, logFile?: string, timeoutMs?: number,
 *   tools?: Record<string, boolean>}} raw
 */
export function apply(ctx, raw = {}) {
  const source = raw ?? {}
  if (unwrapConfigValue(source.enabled) === false) return

  /** Read the configured Codex home at every use; the field is volatile. O(1). */
  const codexHome = () => {
    const configuredHome = unwrapConfigValue(source.codexHome)
    return typeof configuredHome === 'string' && configuredHome !== ''
      ? configuredHome
      : defaultCodexHome()
  }

  /** Every tool is on by default; the schema carries the same defaults. O(1). */
  const toolEnabled = (key) => {
    const tools = unwrapConfigValue(source.tools)
    const value = tools === null || tools === undefined ? undefined : unwrapConfigValue(tools[key])
    return value === undefined ? true : value
  }

  // Hot-updatable values are read through these getters at every use, never captured.
  const autoApproveEnabled = () => unwrapConfigValue(source.autoApprove) === true
  const computerEnabled = () => unwrapConfigValue(source.computer) === true
  const rememberEnabled = () => unwrapConfigValue(source.rememberDesktopApprovals) !== false
  const configuredLanguage = () => {
    const value = unwrapConfigValue(source.language)
    return value === 'zh' || value === 'en' ? value : 'auto'
  }
  const localePreference = () => {
    if (typeof ctx.get !== 'function') return null
    try {
      const preference = ctx.get('locale')?.preference
      return typeof preference === 'string' && preference !== '' ? preference : null
    } catch {
      return null
    }
  }
  const effectiveLanguage = () => (
    resolveLanguage(configuredLanguage(), localePreference() ?? systemLocale())
  )
  const configuredLogFile = () => {
    const value = unwrapConfigValue(source.logFile)
    return typeof value === 'string' && value !== '' ? value : defaultLogFile()
  }
  const configuredTimeoutMs = () => {
    const value = unwrapConfigValue(source.timeoutMs)
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return DEFAULT_TIMEOUT_MS
    }
    return value
  }
  /** The user-tabs switch is re-read on every browser call, so changing it is hot. O(1). */
  const allowUserTabsEnabled = () => unwrapConfigValue(source.allowUserTabs) === true

  // Last log write failure, kept for `pc_status.log`; a later successful write marks it
  // recovered instead of dropping the record (feature G chose "keep, mark recovered").
  let lastLogError = null
  // r25: also guards background work (prefetch, after-connect fetch) from writing after the
  // plugin was unloaded; the log directory may already be gone by then.
  let disposed = false
  const log = (message) => {
    if (disposed === true) return
    const line = `${new Date().toISOString()} ${message}\n`
    try {
      appendLogLine(configuredLogFile(), line)
      if (lastLogError !== null && lastLogError.recovered !== true) {
        lastLogError = {
          ...lastLogError,
          recovered: true,
          recoveredAt: new Date().toISOString(),
        }
      }
    } catch (error) {
      lastLogError = {
        at: new Date().toISOString(),
        kind: typeof error?.code === 'string' ? error.code : (error?.name ?? 'Error'),
      }
      console.warn(`dsh-pc-use: ${message} (log write failed: ${error.message})`)
    }
  }

  const readApprovalService = () => readService(ctx, 'approval')
  const readQuestionsService = () => readService(ctx, 'userQuestions')

  // r14: desktop approvals live in their own module; it only receives the DSH services and
  // the current remember/language switches.
  const approvals = createDesktopApprovals({
    approvalService: readApprovalService,
    questionsService: readQuestionsService,
    rememberEnabled,
    language: effectiveLanguage,
  })

  // r25: assigned once the server-docs state exists; a bridge cannot connect before apply
  // returns, so the indirection is safe and keeps the callback out of the servers block.
  let onServerConnected = () => {}

  /**
   * Construct one target's bridge from its launch spec. The target decides the parts that
   * differ between the servers; the rest is shared plugin state. O(1).
   */
  const bridgeFor = (target) => (spec) => new McpBridge({
    command: spec.command,
    args: spec.args,
    // The server receives its own copy of its environment, unchanged.
    env: { ...spec.env },
    cwd: spec.cwd,
    // Bridge-level session id for calls without an agent: generated in memory on
    // every new bridge; no state file is read or written.
    sessionId: `dsh-pc-${randomUUID()}`,
    shouldApprove: autoApproveEnabled,
    isComputerEnabled: () => target === 'desktop' && computerEnabled() === true,
    // Each server only accepts its own approval kinds; the other kind is declined
    // and logged with an explicit reason.
    unexpectedApprovalReason: (approvalKind) => {
      if (target === 'browser' && approvalKind === 'computer') {
        return 'unexpected approval for the browser server'
      }
      if (target === 'desktop' && approvalKind === 'browser') {
        return 'unexpected approval for the desktop server'
      }
      return null
    },
    requestDesktopApproval: approvals.decide,
    log,
  })

  // r15: one bridge controller per target; this file only supplies how to build a bridge and
  // what to forget when the desktop one stops (remembered approvals).
  const targetBridge = (target, onStop) => createTargetBridge({
    target,
    resolveSpec: (home) => RESOLVERS[target]({ codexHome: home }),
    codexHome,
    createBridge: bridgeFor(target),
    onConnected: (bridge, spec) => onServerConnected(target, bridge, spec),
    onStop,
    log,
  })
  const servers = {
    browser: targetBridge('browser'),
    desktop: targetBridge('desktop', () => approvals.forgetAll()),
  }

  // r26: the Codex computer-use skill is offered to DSH's skill registry. Every list/get reads
  // the SKILL.md from the local Codex installation, so the text is never copied into the repo.
  let skillControl = null
  /** The version directory the browser server uses; pc_codex_docs resolves docs the same way. */
  const skillPreferVersion = () => {
    const spec = servers.browser.spec()
    return spec.ok === true ? versionFromSource(spec.source) : null
  }
  /** True when the skill may be offered: computer on, desktop js on, and not aborted. O(1). */
  const skillAvailable = (options) => {
    if (options?.signal?.aborted === true) return false
    if (computerEnabled() !== true) return false
    return toolEnabled('desktopJs') === true
  }
  /**
   * Provider-visible fields shared by the candidate and the loaded definition. They are
   * rebuilt from this read's SKILL.md, so a version change updates `path` and `resourceBase`
   * together instead of leaving the definition on an old directory. O(1).
   */
  const skillSummary = (skill) => ({
    name: SKILL_NAME,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: SKILL_PROVIDER_NAME,
    source: 'custom',
    path: skill.file,
    resourceBase: { kind: 'directory', path: skill.versionDir.split(sep).join('/') },
  })
  /** Read the local SKILL.md and build its candidate, or null. O(file size). */
  const skillCandidate = () => {
    const skill = readCodexSkill({ codexHome: codexHome(), preferVersion: skillPreferVersion() })
    if (skill === null) return null
    return {
      ...skillSummary(skill),
      // DSH's BUNDLED_SKILL_RANK is 600; the plugin cannot reliably import that package, so
      // the value is repeated here.
      rank: 600,
      locator: { file: skill.file },
    }
  }
  /** The provider DSH registers; list and get re-read the file on every call. O(file size). */
  const skillProvider = () => ({
    name: SKILL_PROVIDER_NAME,
    async list(options) {
      if (!skillAvailable(options)) return []
      const candidate = skillCandidate()
      return candidate === null ? [] : [candidate]
    },
    async get(candidate, options) {
      if (!skillAvailable(options)) return undefined
      const skill = readCodexSkill({ codexHome: codexHome(), preferVersion: skillPreferVersion() })
      if (skill === null) return undefined
      // The definition carries this read's `path` and `resourceBase`, never the candidate's
      // potentially older version directory.
      return { ...skillSummary(skill), content: `${skill.body}\n\n${SKILL_DSH_NOTES}` }
    },
  })


  // r25: server documentation is cached on disk and registered without waiting for any server.
  // A cache entry is used only when its launch-spec fingerprint matches the installed Codex;
  // otherwise the built-in descriptions stay registered and may be prefetched in the background.
  const TARGETS = ['browser', 'desktop']
  const docsCacheFile = join(homedir(), '.dsh', 'pc-use-server-docs.json')
  // Read once: the switch only matters at DSH start.
  const prefetchDocs = unwrapConfigValue(source.prefetchServerDocs) !== false
  const cachedDocs = readDocsCache(docsCacheFile)
  // One fixed receiver for calls without an agent, so they get at most one re-send too.
  const noAgentReceiver = {}
  const targetDocs = {}
  for (const target of TARGETS) {
    const spec = servers[target].spec()
    const fingerprint = spec.ok === true ? specFingerprint(spec) : null
    const cached = cachedDocs[target]
    const fromCache = cached !== null && fingerprint !== null
      && cached.fingerprint === fingerprint
    targetDocs[target] = {
      spec,
      fingerprint,
      cache: fromCache ? cached : null,
      registered: fromCache ? 'server-cache' : 'built-in',
      registeredHash: fromCache ? cached.docsHash : null,
      server: null,
      lastError: null,
      reSend: null,
      sent: new WeakMap(),
    }
  }
  const SERVER_TOOL_KEYS = {
    js: 'js',
    reset: 'js_reset',
    desktopJs: 'js',
    desktopReset: 'js_reset',
    desktopAddNodeModuleDir: 'js_add_node_module_dir',
  }
  const TOOL_TARGETS = {
    js: 'browser',
    reset: 'browser',
    desktopJs: 'desktop',
    desktopReset: 'desktop',
    desktopAddNodeModuleDir: 'desktop',
  }
  const BUILTIN_DESCRIPTIONS = {
    js: BROWSER_JS_DESCRIPTION,
    reset: BROWSER_JS_RESET_DESCRIPTION,
    desktopJs: DESKTOP_JS_DESCRIPTION,
    desktopReset: DESKTOP_JS_RESET_DESCRIPTION,
    desktopAddNodeModuleDir: DESKTOP_ADD_NODE_MODULE_DIR_DESCRIPTION,
  }
  const TOOL_RULES = {
    js: BROWSER_JS_RULES,
    reset: BROWSER_JS_RESET_RULES,
    desktopJs: DESKTOP_JS_RULES,
    desktopReset: DESKTOP_JS_RESET_RULES,
    desktopAddNodeModuleDir: DESKTOP_ADD_NODE_MODULE_DIR_RULES,
  }

  /** Registration-time description for one of the five server-documented tools. O(1). */
  const toolDescription = (key) => {
    const cached = targetDocs[TOOL_TARGETS[key]].cache
    if (cached === null) return BUILTIN_DESCRIPTIONS[key]
    const composed = composeDescription(cached, SERVER_TOOL_KEYS[key], TOOL_RULES[key])
    return composed === null ? BUILTIN_DESCRIPTIONS[key] : composed
  }

  /** One target's `pc_status.serverDocs` section; hashes are shown as 12 hex characters. O(1). */
  const serverDocsStatus = (target) => {
    const state = targetDocs[target]
    const serverHash = state.server === null ? null : state.server.docsHash
    return {
      registered: state.registered,
      registeredHash: state.registeredHash === null
        ? null
        : state.registeredHash.slice(0, 12),
      serverHash: serverHash === null ? null : serverHash.slice(0, 12),
      listHash: state.server === null ? null : state.server.listHash.slice(0, 12),
      toolNames: state.server === null ? [] : state.server.toolNames,
      stale: serverHash === null ? null : serverHash !== state.registeredHash,
      lastError: state.lastError,
    }
  }

  /**
   * Apply one connection's server documentation: list the tools, cache the result and queue
   * one re-send when it differs from what was registered. Never throws. O(tools).
   */
  onServerConnected = async (target, bridge, spec) => {
    const state = targetDocs[target]
    try {
      const tools = await bridge.listTools(configuredTimeoutMs())
      const fetched = docsFromServer({ instructions: bridge.instructions, tools })
      if (fetched === null) {
        log('server docs: no usable js description')
        return
      }
      state.lastError = null
      const fingerprint = specFingerprint(spec)
      const cached = state.cache
      const needsWrite = cached === null || cached.fingerprint !== fingerprint
        || cached.docsHash !== fetched.docsHash
      if (needsWrite) {
        const written = writeDocsCacheEntry(docsCacheFile, target, {
          fingerprint,
          instructions: fetched.instructions,
          tools: fetched.tools,
          docsHash: fetched.docsHash,
          listHash: fetched.listHash,
          toolNames: fetched.toolNames,
          fetchedAt: new Date().toISOString(),
        })
        if (written.ok !== true) {
          // The reason is one of our fixed sentences; never a command, args or path.
          state.lastError = written.reason
          log('server docs cache write failed')
        }
      }
      state.server = fetched
      if (fetched.docsHash !== state.registeredHash) {
        const composed = composeDescription(fetched, 'js', '')
        // Drop the empty appendix segment composeDescription keeps at the end.
        const text = composed === null ? null : composed.replace(/\n\n$/, '')
        state.reSend = text === null ? null : { docsHash: fetched.docsHash, text }
      } else {
        // P2-2: back on the registered version, a queued re-send would describe a server
        // that is no longer current, so drop it.
        state.reSend = null
      }
    } catch {
      state.lastError = 'server docs fetch failed'
      log('server docs fetch failed')
    }
  }

  // r13: turn tracking lives in its own module; it only needs each server's generation,
  // so a bridge rebuilt mid-turn never receives the old turn.
  const turns = createTurnTracker({ generationOf: (kind) => servers[kind].generation() })

  /** Send turn_ended on one server's existing connection; never starts one. O(1). */
  const reportTurnEnded = (kind, hookEventName, identity) => {
    const active = servers[kind].liveBridge()
    if (active === null) return
    // D16: the identity is a snapshot taken before the turn tracker rotated the turn; call()
    // fixes its _meta from that snapshot before its first await. turn_ended uses the native
    // `_meta` shape (threadId only), like Codex 0.163 does for a finished turn.
    active.call('turn_ended', {
      hook_event_name: hookEventName,
      session_id: identity.sessionId,
      turn_id: identity.turnId,
    }, 10_000, identity, { metaMode: 'turn-ended' }).then(
      () => log(`turn ended (${hookEventName})`),
      (error) => log(`turn_ended failed: ${error.message}`),
    )
  }
  /**
   * End the desktop turn over Codex's native pipe so the cursor overlay closes. The node_repl
   * `turn_ended` above does not reach the overlay (sky registers no turn-ended handler), so this
   * is the only way to make it disappear. One best-effort attempt; failures are logged only. O(1).
   */
  const closeDesktopTurn = (identity) => {
    const pipeDirectory = servers.desktop.connectedPipe()
    if (typeof pipeDirectory !== 'string' || pipeDirectory === '') return
    endTurn(pipeDirectory, identity).then(
      (result) => {
        log(result.ok === true
          ? 'desktop turn closed (end_turn)'
          : `end_turn failed: ${result.reason}`)
      },
      () => log('end_turn failed: connect failed'),
    )
  }
  /**
   * Report one finished turn to every server (the connected ones are picked inside
   * `reportTurnEnded`), then close the desktop overlay only when this turn used it. O(1).
   */
  const reportEndedTurn = (ended) => {
    for (const kind of ended.kinds) {
      reportTurnEnded(kind, ended.hookEventName, ended.identity)
    }
    if (ended.closeDesktop === true) closeDesktopTurn(ended.identity)
  }

  /**
   * The `computer` switch is read on every use: off always stops the desktop server. The
   * optional log line lets the loader handler explain its stop first. O(1).
   */
  const syncComputerSwitch = (logLine = null) => {
    if (computerEnabled() === true || !servers.desktop.started()) return
    if (logLine !== null) log(logLine)
    servers.desktop.stop()
  }

  /** Reject a desktop call while `computer` is off, before any process could start. O(1). */
  const requireComputer = () => {
    if (computerEnabled() !== true) throw new Error(COMPUTER_OFF)
  }

  /**
   * Run one MCP call on one server with the identity of the turn it belongs to. `beginCall`
   * reads the turn, snapshots the identity and marks the server used in one synchronous
   * block after `servers[kind].ensure()`, so the `_meta` turn and the reported-as-used turn
   * are always the same (F1). D16 stays in `call()`: it fixes the identity snapshot before
   * its first await. `wallTime` adds the native result header to direct MCP calls only; the
   * elapsed time starts after `ensure()` (server startup is not part of the call) and ends
   * when the call returns, including the error text of an `isError` result. O(1).
   */
  const callOn = async (kind, method, args, timeoutMs, exec, collector = null,
    { wallTime = false } = {}) => {
    const active = await servers[kind].ensure()
    const identity = turns.beginCall(exec, kind)
    const guarded = kind === 'browser' && method === 'js' && typeof args?.code === 'string'
      ? {
        ...args,
        code: `${allowUserTabsEnabled() ? TAB_GUARD_USER_TABS_ON : TAB_GUARD_USER_TABS_OFF}\n`
          + `${args.code}`,
      }
      : args
    const startedAt = performance.now()
    const result = await active.call(method, guarded, timeoutMs, identity)
    const prefix = wallTime ? wallTimeHeader(performance.now() - startedAt) : ''
    try {
      return prefix + renderResult(result, collector)
    } catch (error) {
      // An `isError` result has no text to return, so the header goes on the thrown message;
      // a transport failure throws before this point and stays without a header.
      throw prefix === '' ? error : new Error(prefix + errorMessage(error))
    }
  }

  /**
   * Take this call's user-caused declined app and clear the registration record, so the note
   * is shown once. Only a user-caused denial sets it; call-end declines and automatic
   * approvals leave it null. O(1).
   */
  const takeDeclinedApp = (registration) => {
    const appName = registration?.declinedApp ?? null
    if (registration) registration.declinedApp = null
    return appName
  }

  /** Append the language-aware hints to one result text. O(1). */
  const appendToolNotes = (text, declinedApp, noTreeMarker = null, screenshot = false) => {
    const language = effectiveLanguage()
    let result = text
    if (declinedApp !== null) {
      result += `\n\n${declineNote(language, declinedApp)}`
    }
    if (text.includes('Illegal return statement')) {
      result += `\n\n${illegalReturnNote(language)}`
    }
    if (noTreeMarker !== null && text.includes(noTreeMarker)) {
      result = result.replaceAll(noTreeMarker, '[no accessibility tree for this window]')
      result += `\n\n${noAccessibilityTreeNote(language, screenshot)}`
    }
    return result
  }

  /** Append language-aware hints to a successful tool result. O(1). */
  const withToolNotes = (text, registration = null, noTreeMarker = null, screenshot = false) => (
    appendToolNotes(text, takeDeclinedApp(registration), noTreeMarker, screenshot)
  )

  /** Append the same hints when Codex returned isError (the real rejection path). O(1). */
  const withToolErrorNotes = (error, registration = null, noTreeMarker = null,
    screenshot = false) => {
    const message = errorMessage(error)
    const result = appendToolNotes(message, takeDeclinedApp(registration), noTreeMarker,
      screenshot)
    return result === message ? error : new Error(result)
  }

  /** Timeout for a `js` call, honouring an explicit `timeout_ms`. O(1). */
  const jsTimeoutMs = (requested) => {
    const timeoutMs = configuredTimeoutMs()
    return Number.isFinite(requested) ? Math.max(requested + 30_000, timeoutMs) : timeoutMs
  }

  /**
   * Run one tool body on its target: the browser runs without a call registration, while the
   * desktop target requires `computer` and registers the call so approvals reach it. The
   * switch check stays first, as before. O(1) plus the task.
   */
  const onTarget = (target, exec, task) => {
    syncComputerSwitch()
    if (target === 'browser') return task(null)
    requireComputer()
    return approvals.withCall(exec, task)
  }

  /**
   * Append the one-time server-docs update to a successful js result. The record is per
   * agent (and per docsHash), so each DSH session gets each changed documentation once. O(1).
   */
  const appendServerDocs = (text, target, exec) => {
    const state = targetDocs[target]
    if (state.reSend === null) return text
    const receiver = exec?.agent ?? noAgentReceiver
    if (state.sent.get(receiver) === state.reSend.docsHash) return text
    state.sent.set(receiver, state.reSend.docsHash)
    return `${text}\n\n${serverDocsChangedNote(effectiveLanguage())}\n\n${state.reSend.text}`
  }

  /** Run one js tool call on one target; `registration` is null for the browser. O(1) + wait. */
  const runJs = async (target, args, exec, registration) => {
    const collector = createImageCollector()
    try {
      const text = await callOn(target, 'js', {
        code: args.code,
        title: args.title,
        ...(Number.isFinite(args.timeout_ms) ? { timeout_ms: args.timeout_ms } : {}),
      }, jsTimeoutMs(args.timeout_ms), exec, collector, { wallTime: true })
      const noted = withToolNotes(text, registration)
      return await finishImages(exec, appendServerDocs(noted, target, exec), collector)
    } catch (error) {
      throw withToolErrorNotes(error, registration)
    }
  }

  /** Fixed observation code for one target; the methods print their own output. O(1). */
  const observeCode = (target, subject, screenshot, full, textMode, marker) => {
    if (target === 'browser') {
      const method = screenshot ? 'getAXStateAndScreenshot' : 'getAXState'
      return `await ${subject}.${method}({ disableDiffing: ${full} });`
    }
    const empty = textMode
      ? `(state.accessibility == null ? ${JSON.stringify(marker)} : '')`
      : "''"
    return `{
  const { sky } = await import("@oai/sky");
  globalThis.state = await sky.get_window_state({ window: ${subject}, ` +
    `include_screenshot: ${screenshot}, include_text: ${textMode} });
  globalThis.${subject} = state.window;
  nodeRepl.write(String(state.accessibility?.tree || ` +
    `state.accessibility?.document_text || ${empty}));
}`
  }

  /** Run one observation through the normal js path. O(1) plus the wait. */
  const runObserve = async (target, subject, screenshot, full, textMode, exec,
    registration, collector) => {
    const marker = `\u0000pc-no-tree:${randomUUID()}\u0000`
    try {
      const text = await callOn(target, 'js', {
        code: observeCode(target, subject, screenshot, full, textMode, marker),
        title: `observe ${target}`,
      }, configuredTimeoutMs(), exec, collector)
      return withToolNotes(text, registration, marker, screenshot)
    } catch (error) {
      throw withToolErrorNotes(error, registration, marker, screenshot)
    }
  }

  /** Run one descriptor through the normal js path, keeping the desktop registration. O(1). */
  const runTargetCode = async (target, code, title, exec, registration, collector) => {
    try {
      const text = await callOn(target, 'js', { code, title },
        configuredTimeoutMs(), exec, collector)
      // Take the plugin's own decline record before the notes use it.
      // Browsers have no per-call decline record; an isError is their only signal.
      const declinedApp = takeDeclinedApp(registration)
      return { text: appendToolNotes(text, declinedApp), declined: declinedApp !== null }
    } catch (error) {
      throw withToolErrorNotes(error, registration)
    }
  }

  /** Build and run a plan; returns the text plus whether any step failed. O(steps). */
  const executePlan = async (target, steps, observe, exec, registration, collector) => {
    const results = []
    let stopStatus = null
    let stopIndex = null
    for (let index = 0; index < steps.length; index += 1) {
      if (exec?.signal?.aborted === true) {
        stopStatus = 'not_run'
        stopIndex = index + 1
        break
      }
      const step = steps[index]
      let status = 'ok'
      let output = ''
      try {
        const stepResult = await runTargetCode(
          target, step.code, step.title, exec, registration, collector)
        output = stepResult.text
        if (stepResult.declined) {
          status = 'error'
        }
        if (status === 'ok' && step.check !== undefined && exec?.signal?.aborted !== true) {
          const checkCode = `{ const ok = Boolean(await (async () => (\n${step.check}\n))()); `
            + `if (!ok) throw new Error('${CHECK_FAILED_MARKER}'); }`
          try {
            const checkResult = await runTargetCode(
              target, checkCode, `check ${step.title}`, exec, registration, collector)
            output += `\ncheck: ${checkResult.text}`
            if (checkResult.declined) status = 'check_error'
          } catch (error) {
            const message = errorMessage(error)
            status = message.includes(CHECK_FAILED_MARKER) ? 'check_failed' : 'check_error'
            output += `\n${message}`
          }
        }
      } catch (error) {
        status = 'error'
        output = errorMessage(error)
      }
      results.push({ index: index + 1, title: step.title, status, output })
      if (status !== 'ok') {
        stopStatus = status
        stopIndex = index + 1
        break
      }
    }
    while (results.length < steps.length) {
      const step = steps[results.length]
      results.push({ index: results.length + 1, title: step.title, status: 'not_run', output: '' })
    }
    let observation = ''
    if (observe !== null && exec?.signal?.aborted !== true) {
      try {
        const text = await runObserve(target, observe.subject, observe.screenshot,
          false, true, exec, registration, collector)
        observation = `observation:\n${text}`
      } catch (error) {
        observation = `observation error: ${error instanceof Error ? error.message : error}`
      }
    }
    const okCount = results.filter((item) => item.status === 'ok').length
    const progress = `run_plan: ${okCount}/${steps.length} steps ok`
    const summary = stopStatus === null
      ? progress
      : `${progress}; stopped at step ${stopIndex} (${stopStatus})`
    const body = results.map((item) => {
      const head = `${item.index}. ${item.title}: ${item.status}`
      return item.output === '' ? head : `${head}\n${item.output}`
    })
    const text = [summary, ...body, ...(observation === '' ? [] : [observation])].join('\n')
    return { text, failed: stopStatus !== null }
  }

  const imageProjections = new WeakMap()
  const createImageCollector = () => ({ images: [], nonce: randomUUID() })
  const attachImagesEnabled = () => unwrapConfigValue(source.attachImages) !== false
  const keepImageFilesEnabled = () => unwrapConfigValue(source.keepImageFiles) === true
  const saveLocalImage = (image) => saveImage(image, imagesDirectory())

  /**
   * Replace collected image markers with attached/fallback placeholders and, when
   * possible, prepare the projection for projectContent. O(images).
   */
  const finishImages = async (exec, text, collector, forceFallback = false) => {
    const images = collector?.images ?? []
    if (images.length === 0) return text
    if (forceFallback) log('image projection fallback: tool call failed')
    const prepared = forceFallback
      ? fallbackPlaceholders(images, saveLocalImage, 'tool call failed')
      : await prepareImageProjection({
        ctx,
        exec,
        images,
        attachImages: attachImagesEnabled(),
        keepImageFiles: keepImageFilesEnabled(),
        saveLocal: saveLocalImage,
        log,
      })
    let value = text
    for (let index = 0; index < images.length; index += 1) {
      value = value.split(imageMarker(collector, index)).join(prepared.placeholders[index])
    }
    if (typeof exec !== 'object' || exec === null) return value
    const attached = prepared.refs.filter((ref) => ref !== null)
    if (attached.length === 0) return value
    const content = [{ type: 'text', text: value }]
    for (const ref of attached) content.push({ type: 'image', attachment: ref })
    imageProjections.set(exec, {
      value,
      fallback: output.render(undefined, value),
      content,
    })
    return value
  }

  /** Three-check projector: single use, no error result, unchanged value/content. O(1). */
  const projectImageContent = (exec, result) => {
    if (typeof exec !== 'object' || exec === null) return undefined
    const prepared = imageProjections.get(exec)
    if (prepared === undefined) return undefined
    imageProjections.delete(exec)
    if (result?.isError === true) return undefined
    if (!isDeepStrictEqual(result?.value, prepared.value)) return undefined
    if (!isDeepStrictEqual(result?.content, prepared.fallback)) return undefined
    return prepared.content
  }

  const definitions = {
    js: () => tool({
      name: 'pc_codex_js',
      description: toolDescription('js'),
      parameters: {
        code: { type: 'string', required: true, description: 'JavaScript to run in the persistent cua_repl kernel.' },
        title: { type: 'string', required: true, description: 'Short user-facing description of what the code does.' },
        timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds (default 30000).' },
      },
      output,
      projectContent: projectImageContent,
      async execute(args, exec) {
        const run = (registration) => runJs('browser', args, exec, registration)
        return onTarget('browser', exec, run)
      },
    }),
    reset: () => tool({
      name: 'pc_codex_js_reset',
      description: toolDescription('reset'),
      parameters: {},
      output,
      async execute(_args, exec) {
        // Same turn identity as pc_codex_js, so a reset-only turn still reports turn_ended.
        syncComputerSwitch()
        return callOn('browser', 'js_reset', {}, configuredTimeoutMs(), exec, null,
          { wallTime: true })
      },
    }),
    desktopJs: () => tool({
      name: 'pc_codex_desktop_js',
      description: toolDescription('desktopJs'),
      parameters: {
        code: {
          type: 'string',
          required: true,
          description: 'JavaScript to run in the persistent node_repl kernel.',
        },
        title: {
          type: 'string',
          required: true,
          description: 'Short user-facing description of what the code does.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Execution timeout in milliseconds (default 30000).',
        },
      },
      output,
      projectContent: projectImageContent,
      async execute(args, exec) {
        const run = (registration) => runJs('desktop', args, exec, registration)
        return onTarget('desktop', exec, run)
      },
    }),
    desktopReset: () => tool({
      name: 'pc_codex_desktop_js_reset',
      description: toolDescription('desktopReset'),
      parameters: {},
      output,
      async execute(_args, exec) {
        syncComputerSwitch()
        requireComputer()
        return callOn('desktop', 'js_reset', {}, configuredTimeoutMs(), exec, null,
          { wallTime: true })
      },
    }),
    desktopAddNodeModuleDir: () => tool({
      name: 'pc_codex_desktop_js_add_node_module_dir',
      description: toolDescription('desktopAddNodeModuleDir'),
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Directory to add to the node_repl module search path.',
        },
      },
      output,
      async execute(args, exec) {
        // It uses the same agent identity as pc_codex_desktop_js and counts as desktop use.
        return onTarget('desktop', exec, async (registration) => {
          try {
            const text = await callOn('desktop', 'js_add_node_module_dir', { path: args.path },
              configuredTimeoutMs(), exec, null, { wallTime: true })
            return withToolNotes(text, registration)
          } catch (error) {
            throw withToolErrorNotes(error, registration)
          }
        })
      },
    }),
    observe: () => tool({
      name: 'pc_codex_observe',
      description:
        'Read-only observation of the browser or desktop target through the corresponding js ' +
        'kernel. Prints the complete accessibility tree (or text) for understanding the ' +
        'whole interface. Routine checks should read specific accessibility values ' +
        'inside js code and print only what they need. Some Windows apps return ' +
        '`accessibility: null` even with `include_text: true` (Notepad, Calculator); for ' +
        'those use `screenshot: true` and judge from the screenshot. Do not read logs or ' +
        'configuration files, and do not search the disk; if the screenshot is not ' +
        'enough, stop and tell the user. screenshot defaults to false; enable it when ' +
        'visual information is needed.',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description: 'browser or desktop.',
        },
        subject: {
          type: 'string',
          required: true,
          description: 'REPL global variable for the tab/app or desktop sky Window.',
        },
        screenshot: {
          type: 'boolean',
          description: 'Capture a screenshot too (default false).',
        },
        full: {
          type: 'boolean',
          description: 'Browser only: capture a full, non-diff state (default false).',
        },
        text: {
          type: 'boolean',
          description: 'Desktop only: include accessibility text (default true).',
        },
      },
      output,
      projectContent: projectImageContent,
      async execute(args, exec) {
        const { target, subject, screenshot, full, textMode } = parseObserveArgs(args)
        return onTarget(target, exec, async (registration) => {
          const collector = createImageCollector()
          const text = await runObserve(
            target, subject, screenshot, full, textMode, exec, registration, collector,
          )
          return await finishImages(exec, text, collector)
        })
      },
    }),
    runPlan: () => tool({
      name: 'pc_codex_run_plan',
      description:
        'Fallback plan runner: use when you need step-by-step status reporting or automatic ' +
        'observation after a failure. Runs 1 to 20 ordered steps through the browser or ' +
        'desktop js kernel, reusing the persistent REPL. Each step code may itself contain ' +
        'conditions and assertions. Checks should read accessibility values. When the ' +
        'target window returns no accessibility tree, do not use checks to read UI ' +
        'values; observe with a screenshot instead. Only include steps whose inputs are ' +
        'known or whose check verifies the plan; a check failure means the UI and plan ' +
        'differ, so ' +
        'observe with `pc_codex_observe` before deciding again. Stops at the first failing ' +
        'step and reports it as an error; each step and each check is bounded by the ' +
        'single-call timeout.',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description: 'browser or desktop.',
        },
        steps: {
          type: 'array',
          required: true,
          description: '1 to 20 objects: { title, code, check? }.',
        },
        observe: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional { subject, screenshot? } observation after the plan.',
        },
      },
      output,
      projectContent: projectImageContent,
      async execute(args, exec) {
        const { target, steps, observe } = parsePlanArgs(args)
        const run = async (registration) => {
          const collector = createImageCollector()
          const result = await executePlan(
            target, steps, observe, exec, registration, collector,
          )
          const text = await finishImages(exec, result.text, collector, result.failed)
          if (result.failed) throw new Error(text)
          return text
        }
        return onTarget(target, exec, run)
      },
    }),
    docs: () => tool({
      name: 'pc_codex_docs',
      description:
        'Read Codex\'s own Computer Use documentation from the local Codex installation. Topics: ' +
        '`skill` (entry point: initialization and which document to read), `guidance` (runtime ' +
        'rules, target windows, screenshots, recovery), `api` (the full `sky` API), and ' +
        '`confirmations` (actions that need user confirmation). These topics document the ' +
        'desktop `node_repl` only; the browser-side guide is returned by the first ' +
        '`pc_codex_js` call. Read `skill`, `guidance` and `confirmations` before controlling ' +
        'Windows apps; read `api` when you need method signatures.',
      parameters: {
        topic: {
          type: 'string',
          required: true,
          description: 'One of skill, guidance, api, confirmations.',
        },
      },
      output,
      async execute(args) {
        syncComputerSwitch()
        const topic = args.topic
        if (!COMPUTER_USE_DOC_TOPICS.includes(topic)) {
          throw new Error(
            `pc_codex_docs topic must be one of: ${COMPUTER_USE_DOC_TOPICS.join(', ')}`,
          )
        }
        // The `unified-computer-use` version lives in the browser source; it selects the
        // matching docs directory.
        const spec = servers.browser.spec()
        const preferVersion = spec.ok === true ? versionFromSource(spec.source) : null
        const resolved = resolveComputerUseDocs({ codexHome: codexHome(), preferVersion })
        const file = resolved.files[topic]
        let size
        try {
          size = statSync(file).size
        } catch {
          throw new Error(`Codex computer-use doc not found: ${file}`)
        }
        if (size > MAX_DOC_BYTES) {
          throw new Error(
            `Codex computer-use doc is too large: ${file} (${size} bytes; limit 512 KB)`,
          )
        }
        let content
        try {
          // No cache: read the current file on every call, O(file size).
          content = readFileSync(file, 'utf8')
        } catch {
          throw new Error(`cannot read Codex computer-use doc: ${file}`)
        }
        const sourceLine = `Source: ${file} (Codex computer-use ${resolved.version})`
        return `${sourceLine}\n\n${DOCS_EXPLANATION}\n\n${content}`
      },
    }),
    status: () => tool({
      name: 'pc_status',
      description:
        'Report how this plugin resolved Codex Computer Use: browser and desktop config sources, ' +
        'launch commands, native pipes and connection state. Use it first when a pc_ tool fails.',
      parameters: {},
      output,
      async execute() {
        syncComputerSwitch()

        return JSON.stringify({
          providers: {
            codex: {
              codexHome: codexHome(),
              autoApprove: autoApproveEnabled(),
              computer: computerEnabled(),
              serverDocs: {
                cacheFile: docsCacheFile,
                prefetch: prefetchDocs,
                browser: serverDocsStatus('browser'),
                desktop: serverDocsStatus('desktop'),
              },
              browser: servers.browser.status(),
              desktop: servers.desktop.status(),
              log: {
                path: configuredLogFile(),
                writable: checkLogWritable(configuredLogFile()),
                lastError: lastLogError,
              },
            },
          },
        }, null, 2)
      },
    }),
  }

  // Registration is effect-based: disposing the plugin fiber unregisters the tools.
  for (const [key, factory] of Object.entries(definitions)) {
    if (toolEnabled(key) !== true) continue
    try {
      ctx.tools.register(factory())
    } catch (error) {
      console.error(`dsh-pc-use: registering the ${key} tool failed`, error)
    }
  }

  // r25: prefetch only when the registered docs are built-in. setImmediate keeps apply fast;
  // the bridge it connects is the normal one, so the first tool call reuses that handshake.
  const prefetchTools = {
    browser: ['js', 'reset'],
    desktop: ['desktopJs', 'desktopReset', 'desktopAddNodeModuleDir'],
  }
  for (const target of TARGETS) {
    const state = targetDocs[target]
    if (state.registered !== 'built-in') continue
    if (state.spec.ok !== true) continue
    if (prefetchDocs !== true) continue
    if (target === 'desktop' && computerEnabled() !== true) continue
    if (!prefetchTools[target].some((key) => toolEnabled(key) === true)) continue
    setImmediate(() => {
      if (disposed === true) return
      servers[target].ensure().then(
        () => {
          if (disposed === true) servers[target].stop()
        },
        () => {
          if (disposed === true) return
          log('server docs prefetch failed')
        },
      )
    })
  }

  // S1.4: the loader emits `loader/volatile-update` after writing volatile fields into the
  // running plugin. Turning `computer` off must stop the desktop server immediately, not on
  // the next tool call; the browser server is untouched. syncComputerSwitch stays as a
  // fallback for a host that never emits the event.
  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('loader/volatile-update', () => {
      syncComputerSwitch('computer turned off; stopping the desktop server')
      // r26: the skill catalog depends on `computer` and `tools.desktopJs`.
      if (skillControl !== null) skillControl.invalidate()
    }), 'dsh-pc-use: computer switch')
  }

  // The settings page edits the volatile fields, so tell the settings service this
  // plugin provides its own page instead of a generated form. The service is optional.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (scope) => {
      scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
    })
  }

  // r26: DSH's skill registry is optional. `scope.effect` ties the provider to the
  // injection's lifetime; a missing service or a throwing registerProvider leaves the nine
  // tools untouched.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (scope) => {
      try {
        scope.effect(() => scope.skills.registerProvider((control) => {
          skillControl = control
          return skillProvider()
        }))
      } catch {
        log('skill provider registration failed')
      }
    })
  }

  // F6: DSH session events. `ctx.inject` waits for the `agents` service and the
  // subscription is owned by this plugin context (removed on unload).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents'], (scope) => {
      scope.on('session/event', (session, event) => {
        const ended = turns.onSessionEvent(scope.agents, session, event)
        if (ended !== null) reportEndedTurn(ended)
      })
    })
  }

  ctx.effect(() => () => {
    // r25: a prefetch still handshaking must not survive unload; its `.then` stops the
    // fresh connection once the handshake settles.
    disposed = true
    // Stop both servers; only the desktop bridge's onStop forgets remembered approvals.
    servers.browser.stop()
    servers.desktop.stop()
  }, 'dsh-pc-use: computer-use bridges')
}
