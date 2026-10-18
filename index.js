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
import { join } from 'node:path'

import {
  APPROVE, DECLINE, decisionFromHostOutcome, desktopAppKey, wantsSessionApproval,
} from './lib/approval.js'
import {
  COMPUTER_USE_DOC_TOPICS, defaultCodexHome, resolveBrowserServer, resolveComputerUseDocs,
  resolveDesktopServer, versionFromSource,
} from './lib/codex-config.js'
import { unwrapConfigValue } from './lib/config-value.js'
import { saveImage } from './lib/images.js'
import { appendLogLine, checkLogWritable } from './lib/log-file.js'
import { endTurn } from './lib/native-pipe.js'
import { McpBridge } from './lib/mcp-bridge.js'
import { definePortableTool } from './lib/define-tool.js'
import {
  CONFIG_I18N, auditReason, choiceDecision, closeAppsNote, declineNote,
  desktopApprovalQuestion, illegalReturnNote, legacyDisplayReason, resolveLanguage, systemLocale,
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
 *   rememberDesktopApprovals: boolean, language: string,
 *   codexHome: string, logFile: string, timeoutMs: number,
 *   tools: {js: boolean, reset: boolean, desktopJs: boolean, desktopReset: boolean,
 *     desktopAddNodeModuleDir: boolean, observe: boolean, runPlan: boolean,
 *     docs: boolean, status: boolean}}} Config
 */

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
      language: schema.union(['auto', 'zh', 'en']).default('auto')
        .description('插件界面文字的语言：auto 跟随 DSH 界面语言，或强制 zh / en。')
        .volatile(),
      codexHome: schema.string().default('')
        .description('Codex 配置目录；留空表示 %USERPROFILE%\\.codex。')
        .volatile(),
      logFile: schema.string().default('')
        .description('桥接日志路径；留空则写入 ~/.dsh/pc-use.log。')
        .volatile(),
      timeoutMs: schema.number().default(120000)
        .description('单次工具调用超时（毫秒）。')
        .volatile(),
      tools: schema.object({
        js: schema.boolean().default(true).description('注册 `pc_codex_js`：在持久的 cua_repl 内核中执行 JS。'),
        reset: schema.boolean().default(true).description('注册 `pc_codex_js_reset`：重置浏览器 JS 内核。'),
        desktopJs: schema.boolean().default(true)
          .description('注册 `pc_codex_desktop_js`：在持久的 node_repl 内核中执行 JS。'),
        desktopReset: schema.boolean().default(true)
          .description('注册 `pc_codex_desktop_js_reset`：重置桌面 JS 内核。'),
        desktopAddNodeModuleDir: schema.boolean().default(true)
          .description('注册 `pc_codex_desktop_js_add_node_module_dir`：为 node_repl 增加模块目录。'),
        docs: schema.boolean().default(true)
          .description('注册 `pc_codex_docs`：读取 Codex 自带的 Computer Use 文档。'),
        status: schema.boolean().default(true).description('注册 `pc_status`：报告解析结果与连接状态。'),
        observe: schema.boolean().default(true)
          .description('注册 `pc_codex_observe`：输出完整无障碍树/文本供了解全貌；'
            + '例行判断应在 js 代码里读取具体值、只打印需要的部分。'),
        runPlan: schema.boolean().default(true)
          .description('注册 `pc_codex_run_plan`：备选；需要逐步状态或失败后自动观察时使用。'),
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
  language: 'auto',
  codexHome: '',
  logFile: '',
  timeoutMs: 120000,
  tools: {
    js: true,
    reset: true,
    desktopJs: true,
    desktopReset: true,
    desktopAddNodeModuleDir: true,
    docs: true,
    status: true,
    observe: true,
    runPlan: true,
  },
}

// Marker for "the approving desktop call ended while DSH was still asking".
const CALL_ENDED = Symbol('pc_codex_desktop_js call ended')

// Marker for "only the one-shot approval card can be used (no top-level agent)".
const DELEGATED = Symbol('delegated caller')

const SPEC_FIELDS = ['command', 'args', 'cwd', 'pipeDirectory', 'source']
const SERVER_KINDS = ['browser', 'desktop']
const RESOLVERS = { browser: resolveBrowserServer, desktop: resolveDesktopServer }

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
  '- `node_repl` JavaScript runs through the `pc_codex_desktop_js` tool.',
  '- Reset the JavaScript session with `pc_codex_desktop_js_reset`.',
  '- Run the code from the Initialize section inside `pc_codex_desktop_js`.',
  '- Desktop approvals appear as DSH approval cards.',
  `- ${closeAppsNote('en')}`,
].join('\n')

/** What a desktop call reports when `computer` is off. O(1). */
const COMPUTER_OFF = 'dsh-pc-use: computer use is off; '
  + 'set computer: true in the dsh-pc-use configuration'
const OBSERVE_TARGETS = ['browser', 'desktop']
const SUBJECT_PATTERN = /^[A-Za-z_$][\w$]*$/
const CHECK_FAILED_MARKER = 'pc_codex_run_plan check failed'

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

  const toolEnabled = (key) => {
    const tools = unwrapConfigValue(source.tools)
    const value = tools === null || tools === undefined ? undefined : unwrapConfigValue(tools[key])
    return value === undefined ? DEFAULTS.tools[key] : value
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
      return DEFAULTS.timeoutMs
    }
    return value
  }

  // Last log write failure, kept for `pc_status.log`; a later successful write marks it
  // recovered instead of dropping the record (feature G chose "keep, mark recovered").
  let lastLogError = null
  const log = (message) => {
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

  // An elicitation request carries no tool-call id, so a desktop approval is attributed
  // to the earliest-started desktop call that is still running; with none it is declined.
  // Only desktop tools register here. Each registration also owns the app of a user-caused
  // denial for THIS call, so concurrent calls cannot steal each other's note (feature B).
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
  // process-local object, so entries disappear with the agent; a desktop bridge rebuild
  // resets it, a browser bridge rebuild does not.
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

  /** Remember a user-caused denial's app on the call registration it belongs to. O(1). */
  const rememberDecision = (decision, appName) => {
    const registration = activeCalls[0]
    // A call that is already ending may surface as "no valid choice"; that is not a user
    // decision, so it must not get the no-retry note.
    const callEnded = registration?.exec?.signal?.aborted === true
    if (callEnded !== true
      && decision.action === DECLINE
      && (decision.reason === 'rejected in DSH' || decision.reason === 'no valid choice')) {
      if (registration !== undefined) registration.declinedApp = appName
    }
    return decision
  }

  /**
   * Ask DSH to approve one desktop app. The three-option question card is used when
   * the host allows it; otherwise the 0.4.1 one-shot approval card is used unchanged.
   * O(1) apart from waiting for the user.
   */
  const requestDesktopApproval = async ({ appName, meta }) => {
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
      if (decision !== DELEGATED) return rememberDecision(decision, appName)
    }
    return rememberDecision(await requestLegacyDesktopApproval({
      approval, exec, appName, language, signal, ended, callSignal, remember, appKey, meta,
    }), appName)
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
        return { action: DECLINE, reason: 'pc_codex_desktop_js call ended' }
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
        return { action: DECLINE, reason: 'pc_codex_desktop_js call ended' }
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
        return { action: DECLINE, reason: 'pc_codex_desktop_js call ended' }
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
        return { action: DECLINE, reason: 'pc_codex_desktop_js call ended' }
      }
      return { action: DECLINE, reason: 'approval request failed' }
    }
  }

  /** One independently resolved, lazily started MCP server. O(1). */
  const makeServer = (kind) => ({
    kind,
    bridge: null,
    connecting: null,
    generation: 0,
    lastSpec: null,
    lastSpecHome: null,
    services: null,
  })
  const servers = { browser: makeServer('browser'), desktop: makeServer('desktop') }

  // F6: per-agent Codex session/turn identity, one identity shared by both servers.
  const agentTurns = new WeakMap()
  // Subagent sessions are keyed by the session object, so entries disappear with it.
  const subagentSessions = new WeakSet()

  /** A fresh per-agent turn identity. O(1). */
  const newTurnState = () => ({
    sessionId: randomUUID(),
    turnId: randomUUID(),
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
  /** Record that this turn used one server, with that bridge's generation. O(1). */
  const markServerUsed = (state, kind) => {
    state.used[kind] = true
    state.generations[kind] = servers[kind].generation
  }
  /** Send turn_ended on one server's existing connection; never starts one. O(1). */
  const reportTurnEnded = (kind, hookEventName, identity) => {
    const active = servers[kind].bridge
    if (active === null || active.alive !== true) return
    // D16: the identity was copied before onSessionEvent rotates it below; call() fixes
    // its _meta from this snapshot before its first await.
    active.call('turn_ended', {
      hook_event_name: hookEventName,
      session_id: identity.sessionId,
      turn_id: identity.turnId,
    }, 10_000, identity).then(
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
    const server = servers.desktop
    if (server.bridge === null || server.bridge.alive !== true) return
    const pipeDirectory = server.lastSpec?.pipeDirectory
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
  /** Codex hook name for a finished DSH turn. O(1). */
  const turnEndedHookName = (event, subagent) => {
    if (subagent === true) return 'SubagentStop'
    const kind = event?.data?.reason?.kind
    if (kind === 'aborted' || kind === 'interrupted') return 'Interrupt'
    return 'Stop'
  }
  /** Track subagent sessions and report finished turns to each used server. O(1). */
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
    const identity = { sessionId: state.sessionId, turnId: state.turnId }
    for (const kind of SERVER_KINDS) {
      if (state.used[kind] !== true) continue
      // A bridge rebuilt since this turn's call must not receive that turn.
      if (state.generations[kind] !== servers[kind].generation) continue
      reportTurnEnded(kind, hookEventName, identity)
    }
    // Same generation rule as above: only close the turn that this call actually used.
    if (state.used.desktop === true
      && state.generations.desktop === servers.desktop.generation) {
      closeDesktopTurn(identity)
    }
    state.turnId = randomUUID()
    state.used = { browser: false, desktop: false }
    state.generations = { browser: -1, desktop: -1 }
  }

  /** Re-resolve one server's launch spec; never throws. O(file size). */
  const resolveSpecOrNull = (kind, home) => {
    try {
      const spec = RESOLVERS[kind]({ codexHome: home })
      return spec.ok === true ? spec : null
    } catch {
      return null
    }
  }

  /** Last resolved spec only while codexHome is unchanged; else re-resolve. O(file size). */
  const statusSpec = (kind) => {
    const server = servers[kind]
    const home = codexHome()
    if (server.lastSpec !== null && server.lastSpecHome === home) return server.lastSpec
    try {
      return RESOLVERS[kind]({ codexHome: home })
    } catch (error) {
      return { ok: false, reason: error.message }
    }
  }

  /**
   * Stop one server and forget its live state. A desktop rebuild forgets remembered
   * approvals; a browser rebuild does not. O(1).
   */
  const dropServer = (kind) => {
    const server = servers[kind]
    if (server.bridge !== null) server.bridge.stop()
    server.bridge = null
    server.services = null
    if (kind === 'desktop') resetRemembered()
  }

  /** Lazy start, per-server D15 re-check and codexHome handling. O(file size) per call. */
  const ensureServer = async (kind) => {
    const server = servers[kind]
    if (server.connecting !== null) await server.connecting
    const home = codexHome()
    // A changed codexHome belongs to another directory: drop this server first and
    // resolve below, so a failure never keeps the old connection (0.4.3 behaviour).
    if (server.lastSpecHome !== null && server.lastSpecHome !== home) {
      log(`Codex home changed; reconnecting (${kind})`)
      dropServer(kind)
    }
    // D15: Codex rewrites its config on every app start, so re-read this server's
    // launch spec before reusing its live bridge. Only this server is re-resolved.
    if (server.bridge !== null && server.bridge.alive) {
      const fresh = resolveSpecOrNull(kind, home)
      if (fresh === null) {
        log('Codex server re-check failed; keeping the current connection')
        return server.bridge
      }
      const changed = server.lastSpec === null ? [] : changedSpecFields(server.lastSpec, fresh)
      if (changed.length === 0) return server.bridge
      // Log the field names only: the values contain paths and pipe names.
      log(`Codex server changed (${changed.join(', ')}); reconnecting (${kind})`)
      dropServer(kind)
    }
    if (server.bridge !== null) dropServer(kind)
    const spec = RESOLVERS[kind]({ codexHome: home })
    if (spec.ok !== true) throw new Error(`dsh-pc-use: ${spec.reason}`)
    const env = { ...spec.env }
    const created = new McpBridge({
      command: spec.command,
      args: spec.args,
      env,
      cwd: spec.cwd,
      // Bridge-level session id for calls without an agent: generated in memory on
      // every new bridge; no state file is read or written.
      sessionId: `dsh-pc-${randomUUID()}`,
      shouldApprove: autoApproveEnabled,
      isComputerEnabled: () => kind === 'desktop' && computerEnabled() === true,
      // Each server only accepts its own approval kinds; the other kind is declined
      // and logged with an explicit reason.
      unexpectedApprovalReason: (approvalKind) => {
        if (kind === 'browser' && approvalKind === 'computer') {
          return 'unexpected approval for the browser server'
        }
        if (kind === 'desktop' && approvalKind === 'browser') {
          return 'unexpected approval for the desktop server'
        }
        return null
      },
      requestDesktopApproval,
      log,
    })
    server.lastSpec = spec
    server.lastSpecHome = home
    server.bridge = created
    // One promise for the whole handshake: a second call during the first handshake
    // reuses this connection instead of spawning another server.
    server.connecting = created.start().then(
      () => {
        server.connecting = null
        server.generation += 1
        server.services = trustedServiceNames(spec.env)
        log(`connected via ${spec.source}`)
        return created
      },
      (error) => {
        server.connecting = null
        if (server.bridge === created) server.bridge = null
        throw error
      },
    )
    return server.connecting
  }

  /** The `computer` switch is read on every use: off always stops the desktop server. O(1). */
  const syncComputerSwitch = () => {
    if (computerEnabled() !== true && servers.desktop.bridge !== null) dropServer('desktop')
  }

  /** Reject a desktop call while `computer` is off, before any process could start. O(1). */
  const requireComputer = () => {
    if (computerEnabled() !== true) throw new Error(COMPUTER_OFF)
  }

  /** Run one MCP call on one server with the agent's shared turn identity. O(1). */
  const callOn = async (kind, method, args, timeoutMs, agent) => {
    const active = await ensureServer(kind)
    const turn = agent === null || agent === undefined ? null : turnStateFor(agent)
    if (turn !== null) markServerUsed(turn, kind)
    return renderResult(await active.call(method, args, timeoutMs, turn))
  }

  /** Append language-aware hints to a successful tool result. O(1). */
  const withToolNotes = (text, registration = null) => {
    const language = effectiveLanguage()
    let result = text
    // Only a user-caused denial sets this on the call's own registration; call-end
    // declines and automatic approvals leave it null.
    if (registration?.declinedApp !== undefined && registration?.declinedApp !== null) {
      result += `\n\n${declineNote(language, registration.declinedApp)}`
      registration.declinedApp = null
    }
    if (text.includes('Illegal return statement')) {
      result += `\n\n${illegalReturnNote(language)}`
    }
    return result
  }

  /** Append the same hints when Codex returned isError (the real rejection path). O(1). */
  const withToolErrorNotes = (error, registration = null) => {
    const message = error instanceof Error ? error.message : String(error)
    const language = effectiveLanguage()
    let result = message
    if (registration?.declinedApp !== undefined && registration?.declinedApp !== null) {
      result += `\n\n${declineNote(language, registration.declinedApp)}`
      registration.declinedApp = null
    }
    if (message.includes('Illegal return statement')) {
      result += `\n\n${illegalReturnNote(language)}`
    }
    return result === message ? error : new Error(result)
  }

  /** Timeout for a `js` call, honouring an explicit `timeout_ms`. O(1). */
  const jsTimeoutMs = (requested) => {
    const timeoutMs = configuredTimeoutMs()
    return Number.isFinite(requested) ? Math.max(requested + 30_000, timeoutMs) : timeoutMs
  }

  /** Validate one observe target or throw before any code is sent. O(1). */
  const parseTarget = (target) => {
    if (!OBSERVE_TARGETS.includes(target)) {
      throw new Error('target must be "browser" or "desktop"')
    }
    return target
  }

  /** Validate a REPL global variable name before interpolating it into code. O(1). */
  const parseSubject = (subject) => {
    if (typeof subject !== 'string' || !SUBJECT_PATTERN.test(subject)) {
      throw new Error('subject must be a JavaScript identifier')
    }
    return subject
  }

  /** Read an optional boolean argument with a default. O(1). */
  const parseBoolean = (value, name, fallback) => {
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
    return value
  }

  /** Validate one optional observe descriptor. O(1). */
  const parseObserve = (value) => {
    if (value === undefined || value === null) return null
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('observe must be an object')
    }
    return {
      subject: parseSubject(value.subject),
      screenshot: parseBoolean(value.screenshot, 'observe.screenshot', false),
    }
  }

  /** Validate ordered plan steps before executing any of them. O(steps). */
  const parseSteps = (steps) => {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) {
      throw new Error('steps must contain 1 to 20 items')
    }
    return steps.map((step, index) => {
      if (typeof step !== 'object' || step === null || Array.isArray(step)) {
        throw new Error(`steps[${index}] must be an object`)
      }
      if (typeof step.title !== 'string' || step.title.trim() === '') {
        throw new Error(`steps[${index}].title must be a non-empty string`)
      }
      if (typeof step.code !== 'string' || step.code.trim() === '') {
        throw new Error(`steps[${index}].code must be a non-empty string`)
      }
      if (step.check !== undefined && typeof step.check !== 'string') {
        throw new Error(`steps[${index}].check must be a string`)
      }
      return { title: step.title, code: step.code, check: step.check }
    })
  }

  /** Fixed observation code for one target; the methods print their own output. O(1). */
  const observeCode = (target, subject, screenshot, full, textMode) => {
    if (target === 'browser') {
      const method = screenshot ? 'getAXStateAndScreenshot' : 'getAXState'
      return `await ${subject}.${method}({ disableDiffing: ${full} });`
    }
    return `{
  const { sky } = await import("@oai/sky");
  globalThis.state = await sky.get_window_state({ window: ${subject}, ` +
    `include_screenshot: ${screenshot}, include_text: ${textMode} });
  globalThis.${subject} = state.window;
  nodeRepl.write(String(state.accessibility?.tree || state.accessibility?.document_text || ''));
}`
  }

  /** Run one observation through the normal js path. O(1) plus the wait. */
  const runObserve = async (target, subject, screenshot, full, textMode, exec,
    registration) => {
    try {
      const text = await callOn(target, 'js', {
        code: observeCode(target, subject, screenshot, full, textMode),
        title: `observe ${target}`,
      }, configuredTimeoutMs(), exec?.agent ?? null)
      return withToolNotes(text, registration)
    } catch (error) {
      throw withToolErrorNotes(error, registration)
    }
  }

  /** Run one descriptor through the normal js path, keeping the desktop registration. O(1). */
  const runTargetCode = async (target, code, title, exec, registration) => {
    try {
      const text = await callOn(target, 'js', { code, title },
        configuredTimeoutMs(), exec?.agent ?? null)
      // Capture the plugin's own decline record before withToolNotes clears it.
      // Browsers have no per-call decline record; an isError is their only signal.
      const declined = registration?.declinedApp !== undefined
        && registration?.declinedApp !== null
      return { text: withToolNotes(text, registration), declined }
    } catch (error) {
      throw withToolErrorNotes(error, registration)
    }
  }

  /** Keep a desktop registration for the whole observe/plan call. O(1). */
  const withDesktopRegistration = async (exec, task) => {
    const registration = { exec, controller: new AbortController(), declinedApp: null }
    activeCalls.push(registration)
    try {
      return await task(registration)
    } finally {
      const position = activeCalls.indexOf(registration)
      if (position >= 0) activeCalls.splice(position, 1)
      registration.controller.abort()
    }
  }

  /** Build and run a plan; returns the text plus whether any step failed. O(steps). */
  const executePlan = async (target, steps, observe, exec, registration) => {
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
          target, step.code, step.title, exec, registration)
        output = stepResult.text
        if (stepResult.declined) {
          status = 'error'
        }
        if (status === 'ok' && step.check !== undefined && exec?.signal?.aborted !== true) {
          const checkCode = `{ const ok = Boolean(await (async () => (\n${step.check}\n))()); `
            + `if (!ok) throw new Error('${CHECK_FAILED_MARKER}'); }`
          try {
            const checkResult = await runTargetCode(
              target, checkCode, `check ${step.title}`, exec, registration)
            output += `\ncheck: ${checkResult.text}`
            if (checkResult.declined) status = 'check_error'
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            status = message.includes(CHECK_FAILED_MARKER) ? 'check_failed' : 'check_error'
            output += `\n${message}`
          }
        }
      } catch (error) {
        status = 'error'
        output = error instanceof Error ? error.message : String(error)
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
          false, true, exec, registration)
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
        '`return` is not; print results with `nodeRepl.write(...)` or `console.log(...)`; ' +
        'observer methods output themselves. Preferred: put known consecutive steps in one ' +
        'program; use if/loops/assertions for intermediate results and throw with an ' +
        'explanation when a check fails; at the end print only what the next decision ' +
        'needs with nodeRepl.write(...) or console.log(...). Judge UI state by reading ' +
        'accessibility-tree values in code (button enabled, input value, selected item), ' +
        'not screenshots; filter and print only the fields you need. After a UI-changing ' +
        'step, the next program reads state first; do not reuse old indexes or coordinates. ' +
        'Fallback: use `pc_codex_run_plan` when you need step-by-step status or automatic ' +
        'observation after a failure. Use `pc_codex_observe` to see the whole interface. ' +
        'To operate Windows desktop apps, use `pc_codex_desktop_js`.',
      parameters: {
        code: { type: 'string', required: true, description: 'JavaScript to run in the persistent cua_repl kernel.' },
        title: { type: 'string', required: true, description: 'Short user-facing description of what the code does.' },
        timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds (default 30000).' },
      },
      output,
      async execute(args, exec) {
        syncComputerSwitch()
        try {
          const text = await callOn('browser', 'js', {
            code: args.code,
            title: args.title,
            ...(Number.isFinite(args.timeout_ms) ? { timeout_ms: args.timeout_ms } : {}),
          }, jsTimeoutMs(args.timeout_ms), exec?.agent ?? null)
          return withToolNotes(text)
        } catch (error) {
          throw withToolErrorNotes(error)
        }
      },
    }),
    reset: () => tool({
      name: 'pc_codex_js_reset',
      description: 'Reset the persistent cua_repl JavaScript kernel. Bindings are discarded; '
        + 'browser tabs and apps are not closed.',
      parameters: {},
      output,
      async execute(_args, exec) {
        // Same turn identity as pc_codex_js, so a reset-only turn still reports turn_ended.
        syncComputerSwitch()
        return callOn('browser', 'js_reset', {}, configuredTimeoutMs(), exec?.agent ?? null)
      },
    }),
    desktopJs: () => tool({
      name: 'pc_codex_desktop_js',
      description:
        'Drive Windows desktop apps through Codex Computer Use (node_repl). Runs ' +
        'JavaScript in the persistent node_repl kernel with the `sky` API: ' +
        '`const { sky } = await import("@oai/sky")`, e.g. `sky.list_windows()` or ' +
        '`sky.get_window_state({ window: { app, id } })`; the rest of the API is in ' +
        'the first-call notes. The code runs as one persistent REPL unit: top-level ' +
        '`await` is allowed, a top-level `return` is not; print results with ' +
        '`nodeRepl.write(...)` or `console.log(...)`; observer methods output ' +
        'themselves. Preferred: put known consecutive steps in one program; use ' +
        'if/loops/assertions for intermediate results and throw with an explanation when ' +
        'a check fails; at the end print only what the next decision needs with ' +
        'nodeRepl.write(...) or console.log(...). Judge UI state by reading ' +
        'accessibility-tree values in code (button enabled, input value, selected item), ' +
        'not screenshots; desktop: sky.get_window_state accessibility; browser: ' +
        'tab.getAXState; filter and print only needed fields. After a UI-changing step, ' +
        'the next program reads state first; do not reuse old indexes or coordinates. ' +
        'Fallback: use `pc_codex_run_plan` when you need step-by-step status or automatic ' +
        'observation after a failure. Use `pc_codex_observe` for the whole interface. ' +
        'Use it to control Windows ' +
        'applications; for browser pages use `pc_codex_js`. Before controlling ' +
        'Windows apps, call `pc_codex_docs` for `skill`, `guidance` and ' +
        '`confirmations`; call it for `api` when you need method signatures. ' +
        closeAppsNote('en'),
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
      async execute(args, exec) {
        syncComputerSwitch()
        requireComputer()
        // Desktop approvals are attributed to the earliest-started desktop call still
        // running, so every desktop call is registered for its whole lifetime.
        const registration = { exec, controller: new AbortController(), declinedApp: null }
        activeCalls.push(registration)
        try {
          const text = await callOn('desktop', 'js', {
            code: args.code,
            title: args.title,
            ...(Number.isFinite(args.timeout_ms) ? { timeout_ms: args.timeout_ms } : {}),
          }, jsTimeoutMs(args.timeout_ms), exec?.agent ?? null)
          return withToolNotes(text, registration)
        } catch (error) {
          throw withToolErrorNotes(error, registration)
        } finally {
          const position = activeCalls.indexOf(registration)
          if (position >= 0) activeCalls.splice(position, 1)
          // Ending the call must also end its pending desktop approval.
          registration.controller.abort()
        }
      },
    }),
    desktopReset: () => tool({
      name: 'pc_codex_desktop_js_reset',
      description: 'Reset the persistent node_repl JavaScript kernel. Bindings are discarded; '
        + 'desktop apps are not closed.',
      parameters: {},
      output,
      async execute(_args, exec) {
        syncComputerSwitch()
        requireComputer()
        return callOn('desktop', 'js_reset', {}, configuredTimeoutMs(), exec?.agent ?? null)
      },
    }),
    desktopAddNodeModuleDir: () => tool({
      name: 'pc_codex_desktop_js_add_node_module_dir',
      description:
        'Add a Node.js module directory to the persistent node_repl kernel so its ' +
        'packages can be imported. Passes `path` to Codex\'s `js_add_node_module_dir`.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Directory to add to the node_repl module search path.',
        },
      },
      output,
      async execute(args, exec) {
        syncComputerSwitch()
        requireComputer()
        // It uses the same agent identity as pc_codex_desktop_js and counts as desktop use.
        const registration = { exec, controller: new AbortController(), declinedApp: null }
        activeCalls.push(registration)
        try {
          const text = await callOn('desktop', 'js_add_node_module_dir', { path: args.path },
            configuredTimeoutMs(), exec?.agent ?? null)
          return withToolNotes(text, registration)
        } catch (error) {
          throw withToolErrorNotes(error, registration)
        } finally {
          const position = activeCalls.indexOf(registration)
          if (position >= 0) activeCalls.splice(position, 1)
          registration.controller.abort()
        }
      },
    }),
    observe: () => tool({
      name: 'pc_codex_observe',
      description:
        'Read-only observation of the browser or desktop target through the corresponding js ' +
        'kernel. Prints the complete accessibility tree (or text) for understanding the ' +
        'whole interface. Routine conditional checks should read specific accessibility ' +
        'values inside js code and print only what they need. screenshot defaults to false; ' +
        'enable it only when visual information is needed.',
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
      async execute(args, exec) {
        const target = parseTarget(args.target)
        const subject = parseSubject(args.subject)
        const screenshot = parseBoolean(args.screenshot, 'screenshot', false)
        const full = parseBoolean(args.full, 'full', false)
        const textMode = parseBoolean(args.text, 'text', true)
        syncComputerSwitch()
        if (target === 'desktop') requireComputer()
        if (target === 'browser') {
          return runObserve(target, subject, screenshot, full, textMode, exec, null)
        }
        return withDesktopRegistration(exec, (registration) => (
          runObserve(target, subject, screenshot, full, textMode, exec, registration)
        ))
      },
    }),
    runPlan: () => tool({
      name: 'pc_codex_run_plan',
      description:
        'Fallback plan runner: use when you need step-by-step status reporting or automatic ' +
        'observation after a failure. Runs 1 to 20 ordered steps through the browser or ' +
        'desktop js kernel, reusing the persistent REPL. Each step code may itself contain ' +
        'conditions and assertions. Only include steps whose inputs are already known or ' +
        'whose check verifies the plan; a check failure means the UI and plan differ, so ' +
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
      async execute(args, exec) {
        const target = parseTarget(args.target)
        const steps = parseSteps(args.steps)
        const observe = parseObserve(args.observe)
        syncComputerSwitch()
        if (target === 'desktop') requireComputer()
        const run = async (registration) => {
          const result = await executePlan(target, steps, observe, exec, registration)
          if (result.failed) throw new Error(result.text)
          return result.text
        }
        if (target === 'browser') return run(null)
        return withDesktopRegistration(exec, run)
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
        const spec = statusSpec('browser')
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
        /** One server's status section. O(file size). */
        const sectionFor = (kind) => {
          const server = servers[kind]
          let spec
          try {
            spec = RESOLVERS[kind]({ codexHome: codexHome() })
          } catch (error) {
            spec = { ok: false, reason: error.message }
          }
          const resolved = spec.ok === true
          const connected = server.bridge !== null && server.bridge.alive
          const changed = connected && resolved && server.lastSpec !== null
            ? changedSpecFields(server.lastSpec, spec) : []
          return {
            resolved,
            reason: resolved ? null : spec.reason,
            source: resolved ? spec.source : null,
            command: resolved ? spec.command : null,
            cwd: resolved ? spec.cwd : null,
            nativePipe: resolved ? spec.pipeDirectory : null,
            connected,
            services: connected ? server.services : null,
            // The pipe of the live connection, next to the freshly resolved one.
            connectedPipe: connected && server.lastSpec !== null
              ? server.lastSpec.pipeDirectory : null,
            reconnectPending: connected && (resolved !== true || changed.length > 0),
          }
        }
        return JSON.stringify({
          backends: {
            codex: {
              codexHome: codexHome(),
              autoApprove: autoApproveEnabled(),
              computer: computerEnabled(),
              browser: sectionFor('browser'),
              desktop: sectionFor('desktop'),
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

  // S1.4: the loader emits `loader/volatile-update` after writing volatile fields into the
  // running plugin. Turning `computer` off must stop the desktop server immediately, not on
  // the next tool call; the browser server is untouched. syncComputerSwitch stays as a
  // fallback for a host that never emits the event.
  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('loader/volatile-update', () => {
      if (computerEnabled() !== true && servers.desktop.bridge !== null) {
        log('computer turned off; stopping the desktop server')
        dropServer('desktop')
      }
    }), 'dsh-pc-use: computer switch')
  }

  // The settings page edits the volatile fields, so tell the settings service this
  // plugin provides its own page instead of a generated form. The service is optional.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (scope) => {
      scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
    })
  }

  // F6: DSH session events. `ctx.inject` waits for the `agents` service and the
  // subscription is owned by this plugin context (removed on unload).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents'], (scope) => {
      scope.on('session/event', (session, event) => onSessionEvent(scope.agents, session, event))
    })
  }

  ctx.effect(() => () => {
    // Stop both servers; only the desktop stop needs to forget remembered approvals,
    // which dropServer handles.
    dropServer('browser')
    dropServer('desktop')
  }, 'dsh-pc-use: computer-use bridges')
}
