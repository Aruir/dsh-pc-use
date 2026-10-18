// Resolve everything needed to launch Codex's `cua_repl` MCP server.
//
// Codex rewrites volatile values into config.toml on every app restart (the
// `codex-computer-use-<GUID>` pipe name, the cua_node runtime hash), so nothing
// here is cached across starts: read, merge, return.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

const VOLATILE = [
  'SKY_CUA_NATIVE_PIPE_DIRECTORY',
  'CUA_REPL_NODE_REPL_PATH',
  'NODE_REPL_NODE_PATH',
  'NODE_REPL_NODE_MODULE_DIRS',
  'NODE_REPL_TRUSTED_CODE_PATHS',
  'CODEX_CLI_PATH',
]

export function defaultCodexHome() {
  return join(homedir(), '.codex')
}

function parseValue(raw) {
  raw = raw.trim()
  if (raw.startsWith("'")) return raw.slice(1, raw.lastIndexOf("'"))
  if (raw.startsWith('"') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = Number(raw)
  return Number.isFinite(n) && raw !== '' ? n : raw
}

/** Parse just enough TOML for Codex's config.toml: `[section]` tables and `key = value`. */
export function readTomlSections(text) {
  const sections = {}
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) {
      current = sections[header[1]] = {}
      continue
    }
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/)
    if (kv && current) current[kv[1]] = parseValue(kv[2])
  }
  return sections
}

function newestDir(root) {
  if (!existsSync(root)) return null
  const dirs = readdirSync(root).filter((n) => {
    if (!/^\d/.test(n)) return false
    try {
      return statSync(join(root, n)).isDirectory()
    } catch {
      return false
    }
  })
  dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return dirs[0] ? join(root, dirs[0]) : null
}

/** The `cua_repl` entry shipped in the unified-computer-use plugin, newest version. */
function readPluginServer(codexHome) {
  const version = newestDir(join(codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use'))
  if (version === null) return null
  const file = join(version, '.mcp.json')
  if (!existsSync(file)) return null
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    const entry = cfg?.mcpServers?.cua_repl
    if (!entry?.command) return null
    return {
      source: file,
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args : [],
      env: { ...(entry.env ?? {}) },
      envVars: Array.isArray(entry.env_vars) ? entry.env_vars : [],
    }
  } catch {
    return null
  }
}

/**
 * Build the launch spec for the Codex computer-use MCP server.
 * Returns `{ ok: true, command, args, env, cwd, source }` or `{ ok: false, reason }`.
 */
export function resolveCodexServer({ codexHome = defaultCodexHome(), cwd } = {}) {
  const configPath = join(codexHome, 'config.toml')
  let sections = {}
  let configReadable = false
  try {
    sections = readTomlSections(readFileSync(configPath, 'utf8'))
    configReadable = true
  } catch {
    configReadable = false
  }

  let launch = readPluginServer(codexHome)
  if (launch === null) {
    const repl = sections['mcp_servers.node_repl']
    if (!repl?.command) {
      return {
        ok: false,
        reason: configReadable
          ? `no cua_repl .mcp.json under ${join(codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use')} and no [mcp_servers.node_repl] in ${configPath}`
          : `cannot read ${configPath}`,
      }
    }
    launch = {
      source: configPath,
      command: repl.command,
      args: Array.isArray(repl.args) ? repl.args : [],
      env: { ...(sections['mcp_servers.node_repl.env'] ?? {}) },
      envVars: Array.isArray(repl.env_vars) ? repl.env_vars : [],
    }
  }

  // config.toml carries the values Codex just rewrote; prefer them.
  const configEnv = sections['mcp_servers.node_repl.env'] ?? {}
  for (const key of VOLATILE) {
    if (typeof configEnv[key] === 'string' && configEnv[key] !== '') launch.env[key] = configEnv[key]
  }
  launch.env.CODEX_HOME = launch.env.CODEX_HOME || codexHome

  // Vars the server expects to inherit from the parent process.
  for (const key of launch.envVars) {
    if (process.env[key] !== undefined) launch.env[key] = process.env[key]
  }

  if (!existsSync(launch.command)) {
    return { ok: false, reason: `server command not found: ${launch.command}` }
  }

  return {
    ok: true,
    command: launch.command,
    args: launch.args,
    env: { ...process.env, ...launch.env },
    // A \\wsl.localhost or missing cwd makes the Windows sandbox fail, so pin it
    // to the Codex home's parent (C:\Users\<name>).
    cwd: cwd || dirname(codexHome),
    source: launch.source,
    pipeDirectory: launch.env.SKY_CUA_NATIVE_PIPE_DIRECTORY ?? null,
  }
}

const COMPUTER_USE_DOC_FILES = {
  skill: ['skills', 'computer-use', 'SKILL.md'],
  guidance: ['docs', 'guidance.md'],
  api: ['docs', 'api.md'],
  confirmations: ['docs', 'confirmations.md'],
}

export const COMPUTER_USE_DOC_TOPICS = Object.freeze(Object.keys(COMPUTER_USE_DOC_FILES))

function computerUseRoot(codexHome) {
  return join(codexHome, 'plugins', 'cache', 'openai-bundled', 'computer-use')
}

function versionNames(root) {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root).filter((name) => {
      if (!/^\d/.test(name)) return false
      try {
        return statSync(join(root, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

function newestVersionName(names) {
  const sorted = [...names].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return sorted[0] ?? null
}

/**
 * Locate Codex's four computer-use docs inside the plugin version matching the
 * current `unified-computer-use`, else inside the newest installed version.
 * O(n + d), n = installed version dirs, d = four fixed paths; it only locates files.
 */
export function resolveComputerUseDocs({
  codexHome = defaultCodexHome(), preferVersion = null,
} = {}) {
  const root = computerUseRoot(codexHome)
  const names = versionNames(root)
  const preferred = typeof preferVersion === 'string' && names.includes(preferVersion)
  const version = preferred ? preferVersion : newestVersionName(names)
  if (version === null) {
    throw new Error(`Codex computer-use docs not found: ${root}`)
  }
  const dir = join(root, version)
  const files = {}
  for (const [topic, segments] of Object.entries(COMPUTER_USE_DOC_FILES)) {
    const file = join(dir, ...segments)
    const pathInside = relative(dir, file)
    if (pathInside.startsWith('..') || isAbsolute(pathInside)) {
      throw new Error(`Codex computer-use doc escapes its version directory: ${file}`)
    }
    files[topic] = file
  }
  return { version, dir, files }
}

/** Version directory name of a unified-computer-use `.mcp.json` source path. O(1). */
export function versionFromSource(source) {
  if (typeof source !== 'string' || source === '') return null
  const parent = basename(dirname(source))
  return /^\d/.test(parent) ? parent : null
}
