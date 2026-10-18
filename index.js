// dsh-pc-use — Codex computer-use (cua_repl) as native DeepSeek Harness tools.
//
// Written against the official plugin docs:
//   docs/user/develop/basic/index.zh.md   (apply / inject / ctx.effect)
//   docs/user/develop/basic/tool.zh.md    (defineTool + parameters DSL + output.render)
//   docs/user/develop/basic/config.zh.md  (exported Schemastery Config)
//   docs/user/develop/basic/publish.zh.md (dsh.bundle bundle package)
//
// The Codex desktop app ships a `cua_repl` MCP server that drives the user's real
// Chrome through the Codex browser extension. Using it from outside Codex needs three
// things a vanilla MCP client does not do, all handled by `lib/mcp-bridge.js`:
// turn metadata on every call, an advertised elicitation capability, and local
// answers to the approval requests the server sends back.
//
// `lib/codex-config.js` resolves the launch spec from Codex's own config on every
// start, because the app rewrites the native pipe GUID and runtime hashes on restart.
//
// Everything is lazy: importing or applying the plugin never spawns a process.

import { readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  APPROVE, DECLINE, decisionFromHostOutcome, desktopAppKey, wantsSessionApproval,
} from './lib/approval.js'
import {
  COMPUTER_USE_DOC_TOPICS, defaultCodexHome, resolveCodexServer, resolveComputerUseDocs,
  versionFromSource,
} from './lib/codex-config.js'
import { unwrapConfigValue } from './lib/config-value.js'
import { saveImage } from './lib/images.js'
import { appendLogLine } from './lib/log-file.js'
import { McpBridge } from './lib/mcp-bridge.js'
import { enableComputerSurface, mergeTrustedServices } from './lib/surfaces.js'
import { definePortableTool } from './lib/define-tool.js'
import {
  CONFIG_I18N, auditReason, choiceDecision, desktopApprovalQuestion, legacyDisplayReason,
  resolveLanguage, systemLocale,
} from './lib/text.js'

export const name = 'pc-use'
export const inject = ['tools']

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
 *   rememberDesktopApprovals: boolean, desktopApprovalChoices: boolean, language: string,
 *   codexHome: string, logFile: string, timeoutMs: number,
 *   tools: {js: boolean, reset: boolean, docs: boolean, status: boolean}}} Config
 */

/**
 * The plugin's configuration schema. `autoApprove`, `computer`,
 * `rememberDesktopApprovals`, `logFile` and `timeoutMs` are `.volatile()`: the loader
 * writes new values into the running plugin and every use re-reads them, so they never
 * remount it. `desktopApprovalChoices` and `language` are volatile too, because the
 * settings UI flips them live; `enabled`, `codexHome` and `tools.*` are deliberately not
 * volatile: changing one remounts the plugin, the old bridge is disposed by `ctx.effect`,
 * and the tools are registered again for the new values.
 */
function buildConfig(schema) {
  if (schema === null) return undefined
  try {
    return schema.object({
      enabled: schema.boolean().default(true)
        .description('注册 Codex 工具。关闭后本插件不提供任何工具（相当于停用）。'),
      autoApprove: schema.boolean().default(false)
        .description('自动接受 Codex 的浏览器访问授权；其他审批请求一律拒绝。每次审批都会记录到日志。')
        .volatile(),
      computer: schema.boolean().default(false)
        .description('开启 Windows 桌面应用操控（Codex Computer Use）；桌面授权交给 DSH 的审批策略，'
          + '“完全权限”下直接放行。')
        .volatile(),
      rememberDesktopApprovals: schema.boolean().default(true)
        .description('同一个 DSH 会话里，某个应用经你允许一次后不再询问；拒绝不会被记住。'
          + '桥接重连或关闭此项后重新询问。')
        .volatile(),
      desktopApprovalChoices: schema.boolean().default(true)
        .description('桌面授权使用三选项卡片（允许这一次 / 本次会话内允许 / 拒绝）；'
          + '关闭后沿用一次性授权卡片。')
        .volatile(),
      language: schema.union(['auto', 'zh', 'en']).default('auto')
        .description('插件界面文字的语言：auto 跟随 DSH 界面语言，或强制 zh / en。')
        .volatile(),
      codexHome: schema.string().default('')
        .description('Codex 配置目录；留空表示 %USERPROFILE%\\.codex。'),
      logFile: schema.string().default('')
        .description('桥接日志路径；留空则写入 ~/.dsh/pc-use.log。')
        .volatile(),
      timeoutMs: schema.number().default(120000)
        .description('单次工具调用超时（毫秒）。')
        .volatile(),
      tools: schema.object({
        js: schema.boolean().default(true).description('注册 `pc_codex_js`：在持久的 cua_repl 内核中执行 JS。'),
        reset: schema.boolean().default(true).description('注册 `pc_codex_js_reset`：重置 JS 内核。'),
        docs: schema.boolean().default(true)
          .description('注册 `pc_codex_docs`：读取 Codex 自带的 Computer Use 文档。'),
        status: schema.boolean().default(true).description('注册 `pc_status`：报告解析结果与连接状态。'),
      }).description('要注册哪些工具。'),
    }).description('dsh-pc-use 的功能开关与默认值。')
      .i18n(CONFIG_I18N)
  } catch (error) {
    console.warn('dsh-pc-use: building the Config schema failed — running on built-in defaults', error)
    return undefined
  }
}

export const Config = buildConfig(Schema)

const DEFAULTS = {
  enabled: true,
  autoApprove: false,
  computer: false,
  rememberDesktopApprovals: true,
  desktopApprovalChoices: true,
  language: 'auto',
  codexHome: '',
  logFile: '',
  timeoutMs: 120000,
  tools: { js: true, reset: true, docs: true, status: true },
}

// Marker for "the approving pc_codex_js call ended while DSH was still asking".
const CALL_ENDED = Symbol('pc_codex_js call ended')

// Marker for "only the one-shot approval card can be used (no top-level agent)".
const DELEGATED = Symbol('delegated caller')

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

function defaultLogFile() {
  return join(homedir(), '.dsh', 'pc-use.log')
}

function imagesDirectory() {
  return join(homedir(), '.dsh', 'pc-use-images')
}

/** Flatten an MCP tool result into the canonical string value DSH renders for the model. */
function renderResult(result) {
  const items = Array.isArray(result?.content) ? result.content : []
  const parts = []
  for (const item of items) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    } else if (item?.type === 'image' && typeof item.data === 'string') {
      // The canonical value is a string, so keep the image reachable instead of dropping it.
      try {
        const file = saveImage(item, imagesDirectory())
        parts.push(`[image saved: ${file}]`)
      } catch {
        parts.push('[image could not be saved]')
      }
    } else if (item != null) {
      parts.push(JSON.stringify(item))
    }
  }
  const text = parts.join('\n')
  if (result?.isError === true) throw new Error(text || 'Codex computer-use tool returned an error')
  return text
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
  '- `node_repl` JavaScript runs through the `pc_codex_js` tool.',
  '- Reset the JavaScript session with `pc_codex_js_reset`.',
  '- Run the code from the Initialize section inside `pc_codex_js`.',
  '- Desktop approvals appear as DSH approval cards.',
].join('\n')

/**
 * @param {{enabled?: boolean, autoApprove?: boolean, computer?: boolean,
 *   rememberDesktopApprovals?: boolean, desktopApprovalChoices?: boolean,
 *   language?: string, codexHome?: string, logFile?: string, timeoutMs?: number,
 *   tools?: Record<string, boolean>}} raw
 */
export function apply(ctx, raw = {}) {
  const source = raw ?? {}
  if (unwrapConfigValue(source.enabled) === false) return

  const configuredHome = unwrapConfigValue(source.codexHome)
  const codexHome = typeof configuredHome === 'string' && configuredHome !== ''
    ? configuredHome
    : defaultCodexHome()

  const toolEnabled = (key) => {
    const tools = unwrapConfigValue(source.tools)
    const value = tools === null || tools === undefined ? undefined : unwrapConfigValue(tools[key])
    return value === undefined ? DEFAULTS.tools[key] : value
  }

  // Hot-updatable values are read through these getters at every use, never captured.
  const autoApproveEnabled = () => unwrapConfigValue(source.autoApprove) === true
  const computerEnabled = () => unwrapConfigValue(source.computer) === true
  const rememberEnabled = () => unwrapConfigValue(source.rememberDesktopApprovals) !== false
  const desktopApprovalChoicesEnabled = () => (
    unwrapConfigValue(source.desktopApprovalChoices) !== false
  )
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
      return DEFAULTS.timeoutMs
    }
    return value
  }

  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}\n`
    try {
      appendLogLine(configuredLogFile(), line)
    } catch (error) {
      console.warn(`dsh-pc-use: ${message} (log write failed: ${error.message})`)
    }
  }

  // An elicitation request carries no tool-call id, so a desktop approval is attributed
  // to the earliest-started `pc_codex_js` call that is still running; with none it is
  // declined. Only the exec fields the host needs are passed on, never logged.
  const activeCalls = []
  const readApprovalService = () => {
    if (typeof ctx.get !== 'function') return undefined
    try {
      return ctx.get('approval')
    } catch {
      return undefined
    }
  }
  const readQuestionsService = () => {
    if (typeof ctx.get !== 'function') return undefined
    try {
      return ctx.get('userQuestions')
    } catch {
      return undefined
    }
  }

  // Remembered desktop approvals: WeakMap(agent -> Set(appKey)). The agent object is a
  // process-local object, so entries disappear with the agent; bridge rebuilds reset it.
  let rememberedApps = new WeakMap()
  /** Forget every remembered desktop approval. O(1). */
  const resetRemembered = () => {
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

  /**
   * Ask DSH to approve one desktop app. The three-option question card is used when
   * the host allows it; otherwise the 0.4.1 one-shot approval card is used unchanged.
   * O(1) apart from waiting for the user.
   */
  const requestDesktopApproval = async ({ appName, meta }) => {
    const active = activeCalls[0]
    if (active === undefined || active.exec === undefined || active.exec === null) {
      return { action: DECLINE, reason: 'no active pc_codex_js call' }
    }
    const exec = active.exec
    if (exec.agent === undefined || exec.agent === null) {
      return { action: DECLINE, reason: 'no agent for this call' }
    }
    const remember = rememberEnabled()
    if (remember !== true) {
      resetRemembered()
    }
    const appKey = desktopAppKey(meta, appName)
    if (remember === true && appKey !== null && wasRemembered(exec.agent, appKey)) {
      return { action: APPROVE, reason: 'approved earlier in this DSH session' }
    }
    const approval = readApprovalService()
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
    const questions = readQuestionsService()
    const language = effectiveLanguage()
    if (canUseDesktopChoices(approval, questions, exec.agent)) {
      const decision = await requestDesktopChoice({
        questions,
        agent: exec.agent,
        appName,
        language,
        signal,
        ended,
        callSignal,
        sessionOption,
        remember,
        appKey,
      })
      if (decision !== DELEGATED) return decision
    }
    return requestLegacyDesktopApproval({
      approval, exec, appName, language, signal, ended, callSignal, remember, appKey, meta,
    })
  }

  /** True when the three-option question card may be used. O(1). */
  const canUseDesktopChoices = (approval, questions, agent) => {
    if (questions === undefined || questions === null) return false
    if (desktopApprovalChoicesEnabled() !== true) return false
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
        return { action: DECLINE, reason: 'pc_codex_js call ended' }
      }
      const decision = choiceDecision(answer, language, sessionOption)
      if (
        decision.action === APPROVE
        && decision.reason === 'approved for this DSH session'
        && remember === true
        && appKey !== null
      ) {
        rememberApp(agent, appKey)
      }
      return decision
    } catch (error) {
      if (callSignal.aborted) {
        return { action: DECLINE, reason: 'pc_codex_js call ended' }
      }
      if (error?.code === 'DELEGATED_CALLER') return DELEGATED
      return { action: DECLINE, reason: 'no valid choice' }
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
        return { action: DECLINE, reason: 'pc_codex_js call ended' }
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
        return { action: DECLINE, reason: 'pc_codex_js call ended' }
      }
      return { action: DECLINE, reason: 'approval request failed' }
    }
  }

  let bridge = null
  let connecting = null
  let activeComputer = null
  let activeSurfaces = null
  let activeServices = null
  let activeServicesFrom = null
  let lastSpec = null

  // F6: per-agent Codex session/turn identity, separate from remembered approvals.
  const agentTurns = new WeakMap()
  // Subagent sessions are keyed by the session object, so entries disappear with it.
  const subagentSessions = new WeakSet()
  let bridgeGeneration = 0
  /** Get (or refresh after a reconnect) this agent's Codex identity. O(1). */
  const turnStateFor = (agent) => {
    let state = agentTurns.get(agent)
    if (state === undefined) {
      state = {
        sessionId: randomUUID(),
        turnId: randomUUID(),
        used: false,
        generation: bridgeGeneration,
      }
      agentTurns.set(agent, state)
      return state
    }
    if (state.generation !== bridgeGeneration) {
      state.turnId = randomUUID()
      state.used = false
      state.generation = bridgeGeneration
    }
    return state
  }
  /** Send turn_ended on the existing connection; never starts one. O(1). */
  const reportTurnEnded = (hookEventName, state) => {
    const active = bridge
    if (active === null || active.alive !== true) return
    // D16: copy the identity before onSessionEvent rotates `state` in the same tick;
    // call() fixes its _meta from this snapshot before its first await.
    const identity = { sessionId: state.sessionId, turnId: state.turnId }
    active.call('turn_ended', {
      hook_event_name: hookEventName,
      session_id: identity.sessionId,
      turn_id: identity.turnId,
    }, 10_000, identity).then(
      () => log(`turn ended (${hookEventName})`),
      (error) => log(`turn_ended failed: ${error.message}`),
    )
  }
  /** Codex hook name for a finished DSH turn. O(1). */
  const turnEndedHookName = (event, subagent) => {
    if (subagent === true) return 'SubagentStop'
    const kind = event?.data?.reason?.kind
    if (kind === 'aborted' || kind === 'interrupted') return 'Interrupt'
    return 'Stop'
  }
  /** Track subagent sessions and report finished turns. O(1). */
  const onSessionEvent = (agents, session, event) => {
    if (event?.type === 'subagent/descriptor') {
      subagentSessions.add(session)
      return
    }
    if (event?.type !== 'turn/end') return
    const agent = agents?.get(session.id)
    if (agent === undefined || agent === null) return
    const state = agentTurns.get(agent)
    if (state === undefined) return
    const hookEventName = turnEndedHookName(event, subagentSessions.has(session))
    if (state.used === true && state.generation === bridgeGeneration) {
      reportTurnEnded(hookEventName, state)
    }
    state.turnId = randomUUID()
    state.used = false
    state.generation = bridgeGeneration
  }

  /** Stop the current bridge and forget its active fields. O(1). */
  const dropBridge = () => {
    if (bridge !== null) bridge.stop()
    bridge = null
    activeComputer = null
    activeSurfaces = null
    activeServices = null
    activeServicesFrom = null
  }

  /** Re-resolve the launch spec; null when Codex's config cannot be read. O(file size). */
  const resolveSpecOrNull = () => {
    try {
      const spec = resolveCodexServer({ codexHome })
      return spec.ok === true ? spec : null
    } catch {
      return null
    }
  }

  const ensureBridge = async () => {
    if (connecting !== null) {
      await connecting
    }
    // Read after a possible wait, so a switch flipped during the handshake is honoured.
    const computer = computerEnabled()
    if (rememberEnabled() !== true) {
      resetRemembered()
    }
    // D15: Codex rewrites .mcp.json on every app start, so re-read the launch spec
    // before reusing a live bridge. O(file size): one config.toml + .mcp.json read.
    let keepCurrent = false
    if (bridge !== null && bridge.alive && connecting === null) {
      const fresh = resolveSpecOrNull()
      if (fresh === null) {
        log('Codex server re-check failed; keeping the current connection')
        keepCurrent = true
      } else {
        const changed = lastSpec === null ? [] : changedSpecFields(lastSpec, fresh)
        if (changed.length > 0) {
          // Log the field names only: the values contain paths and pipe names.
          log(`Codex server changed (${changed.join(', ')}); reconnecting`)
          dropBridge()
        }
      }
    }
    if (bridge !== null && bridge.alive) {
      if (keepCurrent === true || activeComputer === computer) return bridge
      // The `computer` switch changed while connected: stop the old server, then connect
      // again with the new surfaces. The concurrent first call still shares `connecting`.
      dropBridge()
    }
    if (bridge !== null) {
      dropBridge()
    }
    const spec = resolveCodexServer({ codexHome })
    if (!spec.ok) throw new Error(`dsh-pc-use: ${spec.reason}`)
    const env = { ...spec.env }
    const surfaces = computer
      ? enableComputerSurface(env.CUA_REPL_ENABLED_SURFACES)
      : (env.CUA_REPL_ENABLED_SURFACES ?? null)
    if (computer) {
      env.CUA_REPL_ENABLED_SURFACES = surfaces
    }
    const trusted = mergeTrustedServices(env.NODE_REPL_TRUSTED_SERVICES, computer)
    if (trusted.value !== undefined) {
      env.NODE_REPL_TRUSTED_SERVICES = trusted.value
    }
    // A new connection is a new approval lifetime: remembered apps start empty and
    // old turns are not reported; agents get a fresh turn id on their next call.
    resetRemembered()
    bridgeGeneration += 1
    const created = new McpBridge({
      command: spec.command,
      args: spec.args,
      env,
      cwd: spec.cwd,
      // Bridge-level session id for calls without an agent: generated in memory on
      // every new bridge; no state file is read or written.
      sessionId: `dsh-pc-${randomUUID()}`,
      shouldApprove: autoApproveEnabled,
      isComputerEnabled: computerEnabled,
      requestDesktopApproval,
      log,
    })
    lastSpec = spec
    bridge = created
    // One promise for the whole handshake: a second call during the first handshake
    // reuses this connection instead of spawning another server.
    connecting = created.start().then(
      () => {
        connecting = null
        activeComputer = computer
        activeSurfaces = surfaces
        activeServices = trusted.names
        activeServicesFrom = trusted.source
        log(`connected via ${spec.source}`)
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

  const call = async (method, args, timeoutMs = configuredTimeoutMs(), agent = null) => {
    const active = await ensureBridge()
    const turn = agent === null || agent === undefined ? null : turnStateFor(agent)
    if (turn !== null) turn.used = true
    return renderResult(await active.call(method, args, timeoutMs, turn))
  }

  const definitions = {
    js: () => tool({
      name: 'pc_codex_js',
      description:
        'Drive the user\'s real Chrome through Codex Computer Use (cua_repl). Runs JavaScript with the ' +
        '`cua` API: `cua.listBrowsers()`, `cua.createBrowserTab("chrome", url)`, `cua.getTab(...)`, ' +
        '`cua.getState()`; tabs expose `getAXState()`, `click(index)`, `getScreenshot()`, `goto()`, ' +
        '`markDeliverable()`. Use it to open pages, read them, click and type. On the first call of a ' +
        'session run exactly one API call, then read the returned documentation and UI state. ' +
        'The code runs as one persistent REPL unit: top-level `await` is allowed, a top-level ' +
        '`return` is not; the value of the last expression is returned, or use `console.log`. ' +
        'With `computer` enabled, control Windows apps via `const { sky } = await ' +
        'import("@oai/sky")`, e.g. `sky.list_windows()` or ' +
        '`sky.get_window_state({ window: { app, id } })`; the rest of the API is in the ' +
        'first-call notes. Before controlling Windows apps, call `pc_codex_docs` for `skill`, ' +
        '`guidance` and `confirmations`; call it for `api` when you need method signatures.',
      parameters: {
        code: { type: 'string', required: true, description: 'JavaScript to run in the persistent cua_repl kernel.' },
        title: { type: 'string', required: true, description: 'Short user-facing description of what the code does.' },
        timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds (default 30000).' },
      },
      output,
      async execute(args, exec) {
        // Desktop approvals are attributed to the earliest-started call still running,
        // so a call must be registered for its whole lifetime and removed in `finally`.
        const agent = exec?.agent
        const registration = { exec, controller: new AbortController() }
        activeCalls.push(registration)
        try {
          const timeoutMs = configuredTimeoutMs()
          const requested = args.timeout_ms
          const execTimeout = Number.isFinite(requested)
            ? Math.max(requested + 30_000, timeoutMs)
            : timeoutMs
          return await call('js', {
            code: args.code,
            title: args.title,
            ...(Number.isFinite(requested) ? { timeout_ms: requested } : {}),
          }, execTimeout, agent)
        } finally {
          const position = activeCalls.indexOf(registration)
          if (position >= 0) activeCalls.splice(position, 1)
          // Ending the call must also end its pending desktop approval.
          registration.controller.abort()
        }
      },
    }),
    reset: () => tool({
      name: 'pc_codex_js_reset',
      description: 'Reset the persistent cua_repl JavaScript kernel. Bindings are discarded; browser tabs and apps are not closed.',
      parameters: {},
      output,
      async execute(_args, exec) {
        // Same turn identity as pc_codex_js, so a reset-only turn still reports turn_ended.
        return call('js_reset', {}, configuredTimeoutMs(), exec?.agent ?? null)
      },
    }),
    docs: () => tool({
      name: 'pc_codex_docs',
      description:
        'Read Codex\'s own Computer Use documentation from the local Codex installation. Topics: ' +
        '`skill` (entry point: initialization and which document to read), `guidance` (runtime ' +
        'rules, target windows, screenshots, recovery), `api` (the full `sky` API), and ' +
        '`confirmations` (actions that need user confirmation). Read `skill`, `guidance` and ' +
        '`confirmations` before controlling Windows apps; read `api` when you need method ' +
        'signatures.',
      parameters: {
        topic: {
          type: 'string',
          required: true,
          description: 'One of skill, guidance, api, confirmations.',
        },
      },
      output,
      async execute(args) {
        const topic = args.topic
        if (!COMPUTER_USE_DOC_TOPICS.includes(topic)) {
          throw new Error(
            `pc_codex_docs topic must be one of: ${COMPUTER_USE_DOC_TOPICS.join(', ')}`,
          )
        }
        const spec = lastSpec ?? resolveCodexServer({ codexHome })
        const preferVersion = spec.ok === true ? versionFromSource(spec.source) : null
        const resolved = resolveComputerUseDocs({ codexHome, preferVersion })
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
        'Report how this plugin resolved Codex Computer Use: config source, launch command, native pipe, ' +
        'connection state. Use it first when a pc_ tool fails.',
      parameters: {},
      output,
      async execute() {
        const spec = lastSpec ?? resolveCodexServer({ codexHome })
        const connected = bridge !== null && bridge.alive
        return JSON.stringify({
          backends: {
            codex: {
              resolved: spec.ok === true,
              reason: spec.ok === true ? undefined : spec.reason,
              source: spec.ok === true ? spec.source : undefined,
              command: spec.ok === true ? spec.command : undefined,
              cwd: spec.ok === true ? spec.cwd : undefined,
              nativePipe: spec.ok === true ? spec.pipeDirectory : undefined,
              connected,
              autoApprove: autoApproveEnabled(),
              computer: connected ? activeSurfaces : null,
              services: connected ? activeServices : null,
              servicesFrom: connected ? activeServicesFrom : null,
              codexHome,
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

  // F6: DSH session events. `ctx.inject` waits for the `agents` service and the
  // subscription is owned by this plugin context (removed on unload).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents'], (scope) => {
      scope.on('session/event', (session, event) => onSessionEvent(scope.agents, session, event))
    })
  }

  ctx.effect(() => () => {
    resetRemembered()
    if (bridge !== null) bridge.stop()
  }, 'dsh-pc-use: computer-use bridge')
}
