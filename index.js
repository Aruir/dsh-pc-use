// dsh-codex-cu — Codex computer-use (cua_repl) as native DeepSeek Harness tools.
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

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { defaultCodexHome, resolveCodexServer } from './lib/codex-config.js'
import { McpBridge } from './lib/mcp-bridge.js'
import { definePortableTool } from './lib/define-tool.js'

export const name = 'codex-cu'
export const inject = ['tools']

// Both platform packages are supplied by the running harness. A soft import keeps
// this module loadable (tools use a JSON Schema adapter) if a future build moves
// them; a hard failure here would take every tool down at once.
let Schema = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  Schema = mod?.default?.object !== undefined ? mod.default : (mod?.object !== undefined ? mod : null)
} catch (error) {
  console.warn('dsh-codex-cu: @deepseek-ai/schemastery unavailable — config defaults are applied by hand', error)
}

let defineTool = null
try {
  defineTool = (await import('@deepseek-ai/dsh-tools')).defineTool ?? null
} catch (error) {
  console.warn('dsh-codex-cu: @deepseek-ai/dsh-tools unavailable — using the JSON Schema adapter')
}

const STATE_FILE = join(homedir(), '.dsh', 'codex-cu-state.json')

/** @typedef {{enabled: boolean, autoApprove: boolean, codexHome: string, logFile: string, timeoutMs: number, tools: {js: boolean, reset: boolean, addNodeModuleDir: boolean, status: boolean}}} Config */

/**
 * The plugin's configuration schema. Every leaf is `.volatile()` so a change can be
 * applied without remounting the plugin — that is also what makes the fields reach
 * `ctx.settings.describe()` and appear as switches in the settings UI.
 */
function buildConfig(schema) {
  if (schema === null) return undefined
  try {
    return schema.object({
      enabled: schema.boolean().default(true)
        .description('注册 Codex 工具。关闭后本插件不提供任何工具（相当于停用）。')
        .volatile(),
      autoApprove: schema.boolean().default(true)
        .description('自动应答 Codex 的浏览器/应用授权请求。每次审批都会写入 logFile；关闭则一律拒绝（fail-closed）。')
        .volatile(),
      codexHome: schema.string().default('')
        .description('Codex 配置目录；留空表示 %USERPROFILE%\\.codex。')
        .volatile(),
      logFile: schema.string().default('')
        .description('桥接日志路径；留空则只写到宿主控制台。')
        .volatile(),
      timeoutMs: schema.number().default(120000)
        .description('单次工具调用超时（毫秒）。')
        .volatile(),
      tools: schema.object({
        js: schema.boolean().default(true).description('注册 `codex_js`：在持久的 cua_repl 内核中执行 JS。').volatile(),
        reset: schema.boolean().default(true).description('注册 `codex_js_reset`：重置 JS 内核。').volatile(),
        addNodeModuleDir: schema.boolean().default(true).description('注册 `codex_js_add_node_module_dir`：增加模块解析目录。').volatile(),
        status: schema.boolean().default(true).description('注册 `codex_status`：报告解析结果与连接状态。').volatile(),
      }).description('要注册哪些工具。'),
    }).description('dsh-codex-cu 的功能开关与默认值。')
  } catch (error) {
    console.warn('dsh-codex-cu: building the Config schema failed — running on built-in defaults', error)
    return undefined
  }
}

export const Config = buildConfig(Schema)

const DEFAULTS = {
  enabled: true,
  autoApprove: true,
  codexHome: '',
  logFile: '',
  timeoutMs: 120000,
  tools: { js: true, reset: true, addNodeModuleDir: true, status: true },
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

/** A session id that survives restarts, so Codex keeps the approvals it already granted. */
function stableSessionId() {
  const state = readState()
  if (state?.session_id) return state.session_id
  const created = { session_id: `dsh-codex-${randomUUID()}`, created_at: new Date().toISOString() }
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, `${JSON.stringify(created, null, 2)}\n`)
  } catch {}
  return created.session_id
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
      const ext = item.mimeType === 'image/png' ? 'png' : 'jpg'
      const file = join(homedir(), '.dsh', 'codex-cu-images', `${randomUUID()}.${ext}`)
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, Buffer.from(item.data, 'base64'))
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

/** @param {{enabled?: boolean, autoApprove?: boolean, codexHome?: string, logFile?: string, timeoutMs?: number, tools?: Record<string, boolean>}} raw */
export function apply(ctx, raw = {}) {
  const config = {
    ...DEFAULTS,
    ...raw,
    tools: { ...DEFAULTS.tools, ...(raw?.tools ?? {}) },
  }
  if (config.enabled === false) return

  const codexHome = config.codexHome !== '' ? config.codexHome : defaultCodexHome()

  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}\n`
    if (config.logFile !== '') {
      try {
        mkdirSync(dirname(config.logFile), { recursive: true })
        appendFileSync(config.logFile, line)
        return
      } catch {}
    }
    console.warn(`dsh-codex-cu: ${message}`)
  }

  let bridge = null
  let lastSpec = null

  const ensureBridge = async () => {
    if (bridge !== null && bridge.alive) return bridge
    const spec = resolveCodexServer({ codexHome })
    if (!spec.ok) throw new Error(`dsh-codex-cu: ${spec.reason}`)
    bridge = new McpBridge({
      command: spec.command,
      args: spec.args,
      env: spec.env,
      cwd: spec.cwd,
      sessionId: stableSessionId(),
      autoApprove: config.autoApprove !== false,
      log,
    })
    lastSpec = spec
    await bridge.start()
    log(`connected via ${spec.source}`)
    return bridge
  }

  const call = async (method, args, timeoutMs) => {
    const active = await ensureBridge()
    return renderResult(await active.call(method, args, timeoutMs))
  }

  const definitions = {
    js: () => tool({
      name: 'codex_js',
      description:
        'Drive the user\'s real Chrome through Codex Computer Use (cua_repl). Runs JavaScript with the ' +
        '`cua` API: `cua.listBrowsers()`, `cua.createBrowserTab("chrome", url)`, `cua.getTab(...)`, ' +
        '`cua.getState()`; tabs expose `getAXState()`, `click(index)`, `getScreenshot()`, `goto()`, ' +
        '`markDeliverable()`. Use it to open pages, read them, click and type. On the first call of a ' +
        'session run exactly one API call, then read the returned documentation and UI state.',
      parameters: {
        code: { type: 'string', required: true, description: 'JavaScript to run in the persistent cua_repl kernel.' },
        title: { type: 'string', required: true, description: 'Short user-facing description of what the code does.' },
        timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds (default 30000).' },
      },
      output,
      async execute(args) {
        const execTimeout = Number.isFinite(args.timeout_ms) ? Math.max(args.timeout_ms + 30_000, config.timeoutMs) : config.timeoutMs
        return call('js', {
          code: args.code,
          title: args.title,
          ...(Number.isFinite(args.timeout_ms) ? { timeout_ms: args.timeout_ms } : {}),
        }, execTimeout)
      },
    }),
    reset: () => tool({
      name: 'codex_js_reset',
      description: 'Reset the persistent cua_repl JavaScript kernel. Bindings are discarded; browser tabs and apps are not closed.',
      parameters: {},
      output,
      async execute() {
        return call('js_reset', {})
      },
    }),
    addNodeModuleDir: () => tool({
      name: 'codex_js_add_node_module_dir',
      description: 'Add an absolute node_modules directory to the cua_repl package resolution. Survives js_reset.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute path to a node_modules directory.' },
      },
      output,
      async execute(args) {
        return call('js_add_node_module_dir', { path: args.path })
      },
    }),
    status: () => tool({
      name: 'codex_status',
      description:
        'Report how this plugin resolved Codex Computer Use: config source, launch command, native pipe, ' +
        'connection state. Use it first when a codex_ tool fails.',
      parameters: {},
      output,
      async execute() {
        const spec = lastSpec ?? resolveCodexServer({ codexHome })
        return JSON.stringify({
          resolved: spec.ok === true,
          reason: spec.ok === true ? undefined : spec.reason,
          source: spec.ok === true ? spec.source : undefined,
          command: spec.ok === true ? spec.command : undefined,
          cwd: spec.ok === true ? spec.cwd : undefined,
          nativePipe: spec.ok === true ? spec.pipeDirectory : undefined,
          connected: bridge !== null && bridge.alive,
          autoApprove: config.autoApprove !== false,
          codexHome,
        }, null, 2)
      },
    }),
  }

  // Registration is effect-based: disposing the plugin fiber unregisters the tools.
  for (const [key, factory] of Object.entries(definitions)) {
    if (config.tools[key] !== true) continue
    try {
      ctx.tools.register(factory())
    } catch (error) {
      console.error(`dsh-codex-cu: registering the ${key} tool failed`, error)
    }
  }

  ctx.effect(() => () => {
    if (bridge !== null) bridge.stop()
  }, 'dsh-codex-cu: computer-use bridge')
}
