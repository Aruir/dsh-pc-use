// Shared harness for the 0.5.0 two-server tests: a fake Codex home with a browser
// `.mcp.json` source and a desktop `[mcp_servers.node_repl]` source, plus parsers for the
// JSON lines the fake servers record.
//
// The tests assert exact env pass-through, so the two Codex-owned variables are removed
// from this test process first; every fake source writes its own values.
delete process.env.CUA_REPL_ENABLED_SURFACES
delete process.env.NODE_REPL_TRUSTED_SERVICES
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerPlugin, tempDir, useHome, waitFor } from '../helpers.mjs'

export const DUAL_SERVER = fileURLToPath(new URL('./fake-dual-server.mjs', import.meta.url))
export const COMPUTER_SERVER = fileURLToPath(
  new URL('../fake-computer-server.mjs', import.meta.url),
)
export const UNIFIED_VERSION = '26.1013.31256'

export const BROWSER_ENV = {
  CUA_REPL_ENABLED_SURFACES: 'browser',
  NODE_REPL_TRUSTED_SERVICES: '{"browser":"/fake/browser"}',
  SKY_CUA_NATIVE_PIPE_DIRECTORY: 'pipe-browser',
}
export const DESKTOP_ENV = {
  NODE_REPL_TRUSTED_SERVICES: '{"sky":"/fake/sky"}',
}

/** The `.mcp.json` path the browser resolver reads. O(1). */
export function mcpJsonPath(codexHome) {
  return join(
    codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use',
    UNIFIED_VERSION, '.mcp.json',
  )
}

/** Write only the browser `.mcp.json` source. O(bytes). */
export function writeBrowserSource(codexHome, args, env = BROWSER_ENV) {
  const file = mcpJsonPath(codexHome)
  mkdirSync(dirname(file), { recursive: true })
  const entry = { command: process.execPath, args, env: { ...env }, env_vars: [] }
  writeFileSync(file, JSON.stringify({ mcpServers: { cua_repl: entry } }))
}

/** Write only the desktop `config.toml` source. O(bytes). */
export function writeDesktopSource(codexHome, args, env = DESKTOP_ENV) {
  mkdirSync(codexHome, { recursive: true })
  const lines = [
    '[mcp_servers.node_repl]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify(args)}`,
    'env_vars = []',
  ]
  const entries = Object.entries(env)
  if (entries.length > 0) {
    lines.push('', '[mcp_servers.node_repl.env]')
    for (const [key, value] of entries) lines.push(`${key} = ${JSON.stringify(value)}`)
  }
  writeFileSync(join(codexHome, 'config.toml'), `${lines.join('\n')}\n`)
}

/** Read the JSON lines one fake server wrote; empty when the file is missing. O(n). */
export function records(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
}

/** Records of one type from one server log. O(n). */
export function recordsOf(file, type) {
  return records(file).filter((entry) => entry.type === type)
}

/**
 * Create a temp home with both sources and register the plugin.
 * `options.browser` / `options.desktop` are args overrides: `{ server, mode, env, args }`;
 * pass `false` to omit that source. `options.config` is merged into the plugin config.
 * O(bytes).
 */
export function startServers(options = {}) {
  const home = tempDir('pc-use-servers-')
  const restore = useHome(home)
  const codexHome = join(home, 'codex')
  const logs = {
    browser: join(home, 'browser.log'),
    desktop: join(home, 'desktop.log'),
  }
  writeFileSync(logs.browser, '')
  writeFileSync(logs.desktop, '')
  const browser = options.browser === false ? null : {
    server: options.browser?.server ?? DUAL_SERVER,
    mode: options.browser?.mode ?? 'ok',
    env: options.browser?.env ?? BROWSER_ENV,
    args: options.browser?.args ?? null,
  }
  const desktop = options.desktop === false ? null : {
    server: options.desktop?.server ?? DUAL_SERVER,
    mode: options.desktop?.mode ?? 'ok',
    env: options.desktop?.env ?? DESKTOP_ENV,
    args: options.desktop?.args ?? null,
  }
  if (browser !== null) {
    const args = browser.args ?? [browser.server, 'browser', browser.mode, logs.browser]
    writeBrowserSource(codexHome, args, browser.env)
  }
  if (desktop !== null) {
    const args = desktop.args ?? [desktop.server, 'desktop', desktop.mode, logs.desktop]
    writeDesktopSource(codexHome, args, desktop.env)
  }
  const plugin = registerPlugin({
    codexHome,
    logFile: join(home, 'bridge.log'),
    ...options.config,
  }, { services: options.services ?? {} })
  return {
    home,
    codexHome,
    logs,
    logFile: join(home, 'bridge.log'),
    plugin,
    restore,
    browserStart: () => recordsOf(logs.browser, 'start'),
    desktopStart: () => recordsOf(logs.desktop, 'start'),
    browserInit: () => recordsOf(logs.browser, 'init'),
    desktopInit: () => recordsOf(logs.desktop, 'init'),
    browserCalls: () => recordsOf(logs.browser, 'call'),
    desktopCalls: () => recordsOf(logs.desktop, 'call'),
    allPids() {
      const pids = []
      for (const log of [logs.browser, logs.desktop]) {
        for (const entry of recordsOf(log, 'start')) pids.push(entry.pid)
      }
      return pids
    },
  }
}

/** True when the pid is still alive. O(1). */
export function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Kill only the fake-server pids a test recorded. O(n). */
export function killPids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {}
  }
}

/**
 * Dispose the plugin and wait in two stages. The first wait requires every recorded fake
 * server to exit on its own within `timeoutMs`; that is the return value, so leftovers are
 * still reported as a failure. After it, any pid that is left is killed and waited for
 * (at most 5000 ms) so a leaked server cannot keep a temp cwd busy; the second wait does not
 * change the return value. O(n) + wait.
 */
export async function stopServers(context, timeoutMs = 10_000) {
  const pids = context.allPids()
  context.plugin.dispose()
  const stopped = await waitFor(() => pids.every((pid) => !isRunning(pid)), timeoutMs)
  if (!stopped) {
    const alive = pids.filter((pid) => isRunning(pid))
    console.error(`stopServers: still running after ${timeoutMs}ms: ${alive.join(', ')}`)
  }
  killPids(pids)
  await waitFor(() => pids.every((pid) => !isRunning(pid)), 5000)
  context.restore()
  return stopped
}
