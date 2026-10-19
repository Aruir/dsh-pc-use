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
import { isDeepStrictEqual } from 'node:util'

import {
  COMPUTER_USE_DOC_TOPICS, defaultCodexHome, resolveBrowserServer, resolveComputerUseDocs,
  resolveDesktopServer, versionFromSource,
} from './lib/codex-config.js'
import { unwrapConfigValue } from './lib/config-value.js'
import { createDesktopApprovals } from './lib/desktop-approvals.js'
import { fallbackPlaceholders, prepareImageProjection } from './lib/image-projection.js'
import { saveImage } from './lib/images.js'
import { appendLogLine, checkLogWritable } from './lib/log-file.js'
import { endTurn } from './lib/native-pipe.js'
import { McpBridge } from './lib/mcp-bridge.js'
import { definePortableTool } from './lib/define-tool.js'
import { tabGuardSource } from './lib/tab-guard.js'
import { createTargetBridge } from './lib/target-bridge.js'
import {
  CONFIG_I18N, closeAppsNote, declineNote, illegalReturnNote, noAccessibilityTreeNote,
  resolveLanguage, systemLocale,
} from './lib/text.js'
import { createTurnTracker } from './lib/turn-tracker.js'

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
 *   attachImages: boolean, keepImageFiles: boolean, allowUserTabs: boolean,
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
      attachImages: schema.boolean().default(true)
        .description('把工具返回的截图作为图片附给模型。截图会发到模型服务商；'
          + '按 DSH 0.2.1-rc.2 源码，默认经 Files API 上传，有效期 7 天，'
          + '会话结束时不删除；本机另有 DSH 附件库保存。不想上传就关闭。')
        .volatile(),
      keepImageFiles: schema.boolean().default(false)
        .description('附图时同时在本机 ~/.dsh/pc-use-images 再存一份；'
          + '默认只由 DSH 附件库保存。')
        .volatile(),
      allowUserTabs: schema.boolean().default(false)
        .description('允许模型读取用户标签页和浏览历史（`browser.user.openTabs`、'
          + '`claimTab`、`getTabContext`、`browser.history`、`cua.getTab`、`cua.getState`、'
          + '`browser.tabs.get`、`browser.tabs.content`）。关闭时前四项直接报错；'
          + '`cua.getTab`、`browser.tabs.get`、`browser.tabs.content` 只接受插件标签页'
          + '（经本插件打开或认领的标签页），`cua.getState` 只列出插件标签页。打开后，'
          + '标签页标题、网址、页面内容或历史会发给模型服务商。')
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
  attachImages: true,
  keepImageFiles: false,
  allowUserTabs: false,
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

const RESOLVERS = { browser: resolveBrowserServer, desktop: resolveDesktopServer }

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
  /** The user-tabs switch is re-read on every browser call, so changing it is hot. O(1). */
  const allowUserTabsEnabled = () => unwrapConfigValue(source.allowUserTabs) === true

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

  // r14: desktop approvals live in their own module; it only receives the DSH services and
  // the current remember/language switches.
  const approvals = createDesktopApprovals({
    approvalService: readApprovalService,
    questionsService: readQuestionsService,
    rememberEnabled,
    language: effectiveLanguage,
  })

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
  const servers = {
    browser: createTargetBridge({
      target: 'browser',
      resolveSpec: (home) => RESOLVERS.browser({ codexHome: home }),
      codexHome,
      createBridge: bridgeFor('browser'),
      log,
    }),
    desktop: createTargetBridge({
      target: 'desktop',
      resolveSpec: (home) => RESOLVERS.desktop({ codexHome: home }),
      codexHome,
      createBridge: bridgeFor('desktop'),
      onStop: () => approvals.forgetAll(),
      log,
    }),
  }

  // r13: turn tracking lives in its own module; it only needs each server's generation,
  // so a bridge rebuilt mid-turn never receives the old turn.
  const turns = createTurnTracker({ generationOf: (kind) => servers[kind].generation() })

  /** Send turn_ended on one server's existing connection; never starts one. O(1). */
  const reportTurnEnded = (kind, hookEventName, identity) => {
    const active = servers[kind].liveBridge()
    if (active === null) return
    // D16: the identity is a snapshot taken before the turn tracker rotated the turn; call()
    // fixes its _meta from that snapshot before its first await. metaMode keeps the
    // turn_ended `_meta` byte for byte as before the r1 meta-fields work (r3
    // turn-ended-align owns it).
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
  /** Report one finished turn to every server it used, then close the desktop overlay. O(1). */
  const reportEndedTurn = (ended) => {
    for (const kind of ended.kinds) {
      reportTurnEnded(kind, ended.hookEventName, ended.identity)
    }
    if (ended.kinds.includes('desktop')) closeDesktopTurn(ended.identity)
  }

  /** The `computer` switch is read on every use: off always stops the desktop server. O(1). */
  const syncComputerSwitch = () => {
    if (computerEnabled() !== true && servers.desktop.started()) servers.desktop.stop()
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
   * its first await. O(1).
   */
  const callOn = async (kind, method, args, timeoutMs, exec, collector = null) => {
    const active = await servers[kind].ensure()
    const identity = turns.beginCall(exec, kind)
    const guarded = kind === 'browser' && method === 'js' && typeof args?.code === 'string'
      ? {
        ...args,
        code: `${allowUserTabsEnabled() ? TAB_GUARD_USER_TABS_ON : TAB_GUARD_USER_TABS_OFF}\n`
          + `${args.code}`,
      }
      : args
    return renderResult(await active.call(method, guarded, timeoutMs, identity), collector)
  }

  /** Append language-aware hints to a successful tool result. O(1). */
  const withToolNotes = (text, registration = null, noTreeMarker = null, screenshot = false) => {
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
    if (noTreeMarker !== null && text.includes(noTreeMarker)) {
      result = result.replaceAll(noTreeMarker, '[no accessibility tree for this window]')
      result += `\n\n${noAccessibilityTreeNote(language, screenshot)}`
    }
    return result
  }

  /** Append the same hints when Codex returned isError (the real rejection path). O(1). */
  const withToolErrorNotes = (error, registration = null, noTreeMarker = null,
    screenshot = false) => {
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
    if (noTreeMarker !== null && message.includes(noTreeMarker)) {
      result = result.replaceAll(noTreeMarker, '[no accessibility tree for this window]')
      result += `\n\n${noAccessibilityTreeNote(language, screenshot)}`
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
      // Capture the plugin's own decline record before withToolNotes clears it.
      // Browsers have no per-call decline record; an isError is their only signal.
      const declined = registration?.declinedApp !== undefined
        && registration?.declinedApp !== null
      return { text: withToolNotes(text, registration), declined }
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
        'needs with nodeRepl.write(...) or console.log(...). When reading values only, ' +
        'call `getAXState({ emit: false })` and print only the needed fields. Store ' +
        '`cua.createBrowserTab(...)` in `globalThis`, for example ' +
        '`globalThis.tab = await cua.createBrowserTab(...)`, so later calls and ' +
        '`pc_codex_observe` can use it. `cua.listTabs()` returns only plugin tabs; other ' +
        'user tabs are filtered out, so check your own tab by id. A plugin tab is a Chrome ' +
        'tab opened or claimed through this plugin since the current browser kernel started; ' +
        'after `pc_codex_js_reset` or a browser reconnect, earlier tabs no longer count, and ' +
        'all DSH sessions share the same plugin tabs. `cua.getTab(...)` only accepts ids of ' +
        'plugin tabs, and `cua.getState()` lists only plugin tabs. ' +
        '`browser.tabs.get` and `browser.tabs.content` follow the same rule; ' +
        '`browser.tabs.list` and `browser.tabs.selected` cover only plugin tabs. ' +
        '`browser.user.openTabs()`, `claimTab`, `getTabContext` and `browser.history()` ' +
        'are blocked by default by the `allowUserTabs` setting; only with that switch on ' +
        'can you access user tabs, and then only when the user explicitly asks. ' +
        'Browser tasks do not need `pc_codex_docs`. When the tree is available, judge UI ' +
        'state by reading values ' +
        '(button enabled, input value, selected item), not screenshots; if it is not, ' +
        'use a screenshot. After a UI-changing step, read state first and do not reuse ' +
        'old indexes or coordinates. Fallback: use `pc_codex_run_plan` when you need ' +
        'step-by-step status or automatic observation after a failure. Use ' +
        '`pc_codex_observe` to see the whole interface. To operate Windows desktop apps, ' +
        'use `pc_codex_desktop_js`.',
      parameters: {
        code: { type: 'string', required: true, description: 'JavaScript to run in the persistent cua_repl kernel.' },
        title: { type: 'string', required: true, description: 'Short user-facing description of what the code does.' },
        timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds (default 30000).' },
      },
      output,
      projectContent: projectImageContent,
      async execute(args, exec) {
        syncComputerSwitch()
        const collector = createImageCollector()
        try {
          const text = await callOn('browser', 'js', {
            code: args.code,
            title: args.title,
            ...(Number.isFinite(args.timeout_ms) ? { timeout_ms: args.timeout_ms } : {}),
          }, jsTimeoutMs(args.timeout_ms), exec, collector)
          return await finishImages(exec, withToolNotes(text), collector)
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
        return callOn('browser', 'js_reset', {}, configuredTimeoutMs(), exec)
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
        'nodeRepl.write(...) or console.log(...). When the tree is available, judge UI ' +
        'state by reading accessibility-tree values in code (desktop: ' +
        'sky.get_window_state; button enabled, input value, selected item), not ' +
        'screenshots. Some apps return `accessibility: null` even with ' +
        '`include_text: true` (Notepad, Calculator). For those, use a screenshot: if ' +
        'this result carries one, judge from it; otherwise call `pc_codex_observe` with ' +
        '`screenshot: true`. Do not use run_plan checks to read UI values for that ' +
        'window. Do not read logs or configuration files, and do not search the disk ' +
        'for the reason; if the screenshot is not enough, stop and tell the user. After ' +
        'a UI-changing step, read state first and do not reuse old indexes or ' +
        'coordinates. Fallback: use `pc_codex_run_plan` when you need step-by-step ' +
        'status or automatic observation after a failure. Use `pc_codex_observe` for ' +
        'the whole interface. ' +
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
      projectContent: projectImageContent,
      async execute(args, exec) {
        syncComputerSwitch()
        requireComputer()
        // Every desktop call is registered for its whole lifetime so approvals reach it.
        return approvals.withCall(exec, async (registration) => {
          const collector = createImageCollector()
          try {
            const text = await callOn('desktop', 'js', {
              code: args.code,
              title: args.title,
              ...(Number.isFinite(args.timeout_ms) ? { timeout_ms: args.timeout_ms } : {}),
            }, jsTimeoutMs(args.timeout_ms), exec, collector)
            return await finishImages(exec, withToolNotes(text, registration), collector)
          } catch (error) {
            throw withToolErrorNotes(error, registration)
          }
        })
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
        return callOn('desktop', 'js_reset', {}, configuredTimeoutMs(), exec)
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
        return approvals.withCall(exec, async (registration) => {
          try {
            const text = await callOn('desktop', 'js_add_node_module_dir', { path: args.path },
              configuredTimeoutMs(), exec)
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
        const target = parseTarget(args.target)
        const subject = parseSubject(args.subject)
        const screenshot = parseBoolean(args.screenshot, 'screenshot', false)
        const full = parseBoolean(args.full, 'full', false)
        const textMode = parseBoolean(args.text, 'text', true)
        syncComputerSwitch()
        if (target === 'desktop') requireComputer()
        const collector = createImageCollector()
        if (target === 'browser') {
          const text = await runObserve(
            target, subject, screenshot, full, textMode, exec, null, collector,
          )
          return await finishImages(exec, text, collector)
        }
        return approvals.withCall(exec, async (registration) => {
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
        const target = parseTarget(args.target)
        const steps = parseSteps(args.steps)
        const observe = parseObserve(args.observe)
        syncComputerSwitch()
        if (target === 'desktop') requireComputer()
        const collector = createImageCollector()
        const run = async (registration) => {
          const result = await executePlan(
            target, steps, observe, exec, registration, collector,
          )
          const text = await finishImages(exec, result.text, collector, result.failed)
          if (result.failed) throw new Error(text)
          return text
        }
        if (target === 'browser') return run(null)
        return approvals.withCall(exec, run)
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

  // S1.4: the loader emits `loader/volatile-update` after writing volatile fields into the
  // running plugin. Turning `computer` off must stop the desktop server immediately, not on
  // the next tool call; the browser server is untouched. syncComputerSwitch stays as a
  // fallback for a host that never emits the event.
  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('loader/volatile-update', () => {
      if (computerEnabled() !== true && servers.desktop.started()) {
        log('computer turned off; stopping the desktop server')
        servers.desktop.stop()
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
      scope.on('session/event', (session, event) => {
        const ended = turns.onSessionEvent(scope.agents, session, event)
        if (ended !== null) reportEndedTurn(ended)
      })
    })
  }

  ctx.effect(() => () => {
    // Stop both servers; only the desktop bridge's onStop forgets remembered approvals.
    servers.browser.stop()
    servers.desktop.stop()
  }, 'dsh-pc-use: computer-use bridges')
}
