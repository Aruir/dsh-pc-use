// Shared fixtures: temp directories, a fake Codex home, a plugin harness and polling
// helpers. The fake MCP server lives in test/fixtures so the test suite is self-contained.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { after } from 'node:test'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

export const FAKE_SERVER = process.env.CODEX_CU_FAKE_SERVER
  ?? fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url))

const createdTempDirs = new Set()

/**
 * Remove one temp directory, retrying while Windows still holds it.
 * Returns true when removed. On failure, report and return false.
 * O(size) per try, at most `budgetMs / 100` tries.
 */
export async function removeTempDir(directory, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs
  while (true) {
    try {
      rmSync(directory, { recursive: true, force: true })
      return true
    } catch (error) {
      if (Date.now() >= deadline) {
        console.error(`could not remove temp dir ${directory}: ${error.code ?? error.message}`)
        return false
      }
      await new Promise((done) => setTimeout(done, 100))
    }
  }
}

// Each test file that imports this module gets one `after` hook: every tempDir it created
// is removed when that file's tests finish, including on failure. Windows may keep a child
// process's cwd busy for a while after dispose, so removal retries on a budget.
try {
  after(async () => {
    for (const directory of createdTempDirs) {
      await removeTempDir(directory)
    }
    createdTempDirs.clear()
  })
} catch {}

/** Create a temp dir owned by the current test file; removed by the module-level hook. */
export function tempDir(prefix = 'pc-use-test-') {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  createdTempDirs.add(directory)
  return directory
}

/** Point `os.homedir()` at `home`; returns a restore function. */
export function useHome(home) {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  return () => {
    for (const key of ['HOME', 'USERPROFILE']) {
      if (previous[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previous[key]
      }
    }
  }
}

/**
 * Throw unless `os.homedir()` is inside `os.tmpdir()`. Cache-writing tests call this before
 * any plugin work so a forgotten `useHome()` can never touch the user's real home. O(1).
 */
export function assertTempHome() {
  const relativeHome = relative(tmpdir(), homedir())
  if (relativeHome === '' || relativeHome.startsWith('..') || isAbsolute(relativeHome)) {
    throw new Error(`test HOME must be inside the OS temp directory; got ${homedir()}`)
  }
}

/** One TOML basic string; JSON escaping is a valid subset of TOML's. O(1). */
function tomlString(value) {
  return JSON.stringify(value)
}

/** The fake `[mcp_servers.node_repl]` table Codex's desktop resolver reads. O(bytes). */
function desktopSection({ args, env, envVars }) {
  const lines = [
    '[mcp_servers.node_repl]',
    `command = ${tomlString(process.execPath)}`,
    `args = ${JSON.stringify(args)}`,
    `env_vars = ${JSON.stringify(envVars)}`,
  ]
  const entries = Object.entries(env ?? {})
  if (entries.length > 0) {
    lines.push('', '[mcp_servers.node_repl.env]')
    for (const [key, value] of entries) lines.push(`${key} = ${tomlString(value)}`)
  }
  return `${lines.join('\n')}\n`
}

/** Append TOML text to `<codexHome>/config.toml`, creating the directory if needed. O(bytes). */
function appendConfigToml(codexHome, text) {
  mkdirSync(codexHome, { recursive: true })
  const file = join(codexHome, 'config.toml')
  const existing = existsSync(file) ? readFileSync(file, 'utf8').replace(/\n*$/, '\n') : ''
  const separator = existing === '' || text.startsWith('\n') ? '' : '\n'
  writeFileSync(file, `${existing}${separator}${text.endsWith('\n') ? text : `${text}\n`}`)
}

/**
 * Write the fake Codex home the resolvers read. Defaults write only the browser
 * `.mcp.json` (v0.4.3 behaviour). `options.browser === false` omits it, `options.mcpJson`
 * replaces the `cua_repl` entry, `options.desktop` adds `[mcp_servers.node_repl]`, and
 * `options.toml` appends raw TOML. O(bytes).
 */
export function writeCodexHome(codexHome, args, env = {}, options = {}) {
  if (options.browser !== false) {
    const directory = join(
      codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '26.1013.31256',
    )
    mkdirSync(directory, { recursive: true })
    const entry = options.mcpJson ?? {
      command: process.execPath,
      args,
      env: { ...env },
      env_vars: [],
    }
    writeFileSync(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: entry } }))
  }
  if (options.desktop) {
    const desktop = options.desktop === true ? {} : options.desktop
    appendConfigToml(codexHome, desktopSection({
      args: desktop.args ?? args,
      env: desktop.env ?? env,
      envVars: desktop.envVars ?? [],
    }))
  }
  if (typeof options.toml === 'string' && options.toml !== '') {
    appendConfigToml(codexHome, options.toml)
  }
}

/**
 * Apply the plugin against a minimal cordis context; returns the registered tools.
 * `options.services` is what the fake `ctx.get(name)` returns (e.g. an approval service);
 * `inject()` and the returned `emit()` let tests drive `session/event` subscriptions.
 */
export function registerPlugin(config, options = {}) {
  // r25 P1-1: a test that forgot useHome() must still never write the user's real ~/.dsh
  // (the plugin writes its server-docs cache under homedir() when it connects).
  const relativeHome = relative(tmpdir(), homedir())
  if (relativeHome.startsWith('..') || isAbsolute(relativeHome)) {
    const guarded = tempDir('pc-use-home-guard-')
    process.env.HOME = guarded
    process.env.USERPROFILE = guarded
  }
  const tools = new Map()
  const disposers = []
  const handlers = []
  const services = options.services ?? {}
  const fiber = options.fiber ?? { id: 'plugin-fiber' }
  const ctx = {
    fiber,
    tools: {
      register(tool) {
        if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    effect(factory) {
      disposers.push(factory())
    },
    on(event, handler) {
      const entry = { event, handler }
      handlers.push(entry)
      return () => {
        const index = handlers.indexOf(entry)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    get(name) {
      return services[name]
    },
    inject(names, callback) {
      if (names.some((name) => services[name] === undefined)) return
      const created = []
      const scope = {
        ...services,
        effect(factory) {
          disposers.push(factory())
        },
        on(event, handler) {
          const entry = { event, handler }
          created.push(entry)
          handlers.push(entry)
          return () => {
            const index = handlers.indexOf(entry)
            if (index >= 0) handlers.splice(index, 1)
          }
        },
      }
      callback(scope)
      disposers.push(() => {
        for (const entry of created) {
          const index = handlers.indexOf(entry)
          if (index >= 0) handlers.splice(index, 1)
        }
      })
    },
  }
  // r25: existing tests must not pre-connect at apply time; the server-docs tests opt in.
  const pluginConfig = config === null || typeof config !== 'object'
    ? config
    : { prefetchServerDocs: false, ...config }
  apply(ctx, pluginConfig)
  return {
    tools,
    fiber,
    emit(event, ...args) {
      for (const entry of handlers.filter((item) => item.event === event)) {
        entry.handler(...args)
      }
    },
    dispose() {
      for (const disposer of disposers) {
        disposer()
      }
      disposers.length = 0
      handlers.length = 0
    },
  }
}

/** Native Codex result header added by the plugin (r29). O(1). */
const WALL_TIME_HEADER = /^Wall time: \d+\.\d{4} seconds\nOutput:\n/

/**
 * Remove the native wall-time header from one tool result so a test can compare the body
 * byte for byte. Non-strings pass through unchanged. O(1).
 */
export function stripWallTime(value) {
  return typeof value === 'string' ? value.replace(WALL_TIME_HEADER, '') : value
}

/** Poll `predicate` until it returns true or the deadline passes, then ask once more. O(n) + wait. */
export async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  // The last sleep can cover the moment the predicate became true, so check it once more.
  return Boolean(await predicate())
}

export async function waitForProcessExit(pid, timeoutMs = 5000) {
  return waitFor(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, timeoutMs)
}
