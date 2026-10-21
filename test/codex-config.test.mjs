// S1: the two Codex launch sources resolve independently, and neither resolver rewrites the
// child environment. Self-contained on purpose (no helpers.mjs), so a broken index.js cannot
// mask a parsing failure and vice versa.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

import { resolveBrowserServer, resolveDesktopServer } from '../lib/codex-config.js'

const UNIFIED_ROOT = ['plugins', 'cache', 'openai-bundled', 'unified-computer-use']

const tempHomes = new Set()
after(() => {
  for (const directory of tempHomes) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {}
  }
  tempHomes.clear()
})

function tempHome() {
  const directory = mkdtempSync(join(tmpdir(), 'pc-use-codex-config-'))
  tempHomes.add(directory)
  return directory
}

function unifiedDir(codexHome, version) {
  return join(codexHome, ...UNIFIED_ROOT, version)
}

function configPath(codexHome) {
  return join(codexHome, 'config.toml')
}

/** Write one `.mcp.json` whose `mcpServers.cua_repl` is `entry`. O(bytes). */
function writeMcpJson(codexHome, version, entry) {
  const directory = unifiedDir(codexHome, version)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: entry } }))
}

function writeConfigToml(codexHome, text) {
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(configPath(codexHome), text)
}

/** A TOML string literal that the resolver's JSON-based parser accepts. O(1). */
function tomlString(value) {
  return JSON.stringify(value)
}

/** A minimal `[mcp_servers.node_repl]` table plus its env sub-table. O(bytes). */
function nodeReplToml({ command = process.execPath, args = [], envVars = [], env = {} } = {}) {
  const lines = [
    '[mcp_servers.node_repl]',
    `command = ${tomlString(command)}`,
    `args = ${JSON.stringify(args)}`,
    `env_vars = ${JSON.stringify(envVars)}`,
  ]
  const entries = Object.entries(env)
  if (entries.length > 0) {
    lines.push('', '[mcp_servers.node_repl.env]')
    for (const [key, value] of entries) lines.push(`${key} = ${tomlString(value)}`)
  }
  return `${lines.join('\n')}\n`
}

function browserEntry(overrides = {}) {
  return { command: process.execPath, args: [], env: {}, env_vars: [], ...overrides }
}

/** Set an env var for one test and restore it afterwards. O(1). */
function withEnv(key, value, run) {
  const previous = process.env[key]
  process.env[key] = value
  try {
    return run()
  } finally {
    if (previous === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previous
    }
  }
}

test('resolveBrowserServer does not fall back to node_repl', () => {
  const home = tempHome()
  writeConfigToml(home, nodeReplToml({ args: ['desktop-only'] }))
  const spec = resolveBrowserServer({ codexHome: home })
  assert.equal(spec.ok, false)
  assert.match(spec.reason, /\.mcp\.json/)
  assert.equal(spec.reason.includes('node_repl'), false)
})

test('resolveBrowserServer reports an unreadable config when there is no .mcp.json', () => {
  const home = tempHome()
  const spec = resolveBrowserServer({ codexHome: home })
  assert.equal(spec.ok, false)
  assert.equal(spec.reason, `cannot read ${configPath(home)}`)
})

test('resolveBrowserServer applies config.toml volatile env overrides', () => {
  const home = tempHome()
  writeMcpJson(home, '26.1013.1', browserEntry({
    env: {
      SKY_CUA_NATIVE_PIPE_DIRECTORY: 'pipe-old',
      CUA_REPL_NODE_REPL_PATH: 'node-old',
      CODEX_CLI_PATH: 'cli-old',
      PC_USE_TEST_KEEP: 'from-mcp',
    },
  }))
  writeConfigToml(home, nodeReplToml({
    env: {
      SKY_CUA_NATIVE_PIPE_DIRECTORY: 'pipe-new',
      CUA_REPL_NODE_REPL_PATH: 'node-new',
      CODEX_CLI_PATH: '',
      PC_USE_TEST_KEEP: 'from-config',
      PC_USE_TEST_CONFIG_ONLY: 'never-copied',
    },
  }))
  const spec = resolveBrowserServer({ codexHome: home })
  assert.equal(spec.ok, true)
  assert.equal(spec.env.SKY_CUA_NATIVE_PIPE_DIRECTORY, 'pipe-new')
  assert.equal(spec.pipeDirectory, 'pipe-new')
  assert.equal(spec.env.CUA_REPL_NODE_REPL_PATH, 'node-new')
  // An empty config value must not blank out the shipped one.
  assert.equal(spec.env.CODEX_CLI_PATH, 'cli-old')
  // Only the volatile list crosses over; other config keys never reach the browser server.
  assert.equal(spec.env.PC_USE_TEST_KEEP, 'from-mcp')
  assert.equal(spec.env.PC_USE_TEST_CONFIG_ONLY, undefined)
})

test('resolveDesktopServer reads [mcp_servers.node_repl] and its env', () => {
  const home = tempHome()
  const args = ['--fake-desktop-server']
  const inherited = 'PC_USE_TEST_DESKTOP_INHERITED'
  withEnv(inherited, 'from-parent', () => {
    writeConfigToml(home, nodeReplToml({
      args,
      envVars: [inherited],
      env: {
        PC_USE_TEST_DESKTOP_ENV: 'desktop-value',
        SKY_CUA_NATIVE_PIPE_DIRECTORY: 'pipe-desktop',
      },
    }))
    const spec = resolveDesktopServer({ codexHome: home })
    assert.equal(spec.ok, true)
    assert.equal(spec.command, process.execPath)
    assert.deepEqual(spec.args, args)
    assert.equal(spec.env.PC_USE_TEST_DESKTOP_ENV, 'desktop-value')
    assert.equal(spec.env[inherited], 'from-parent')
    assert.equal(spec.env.CODEX_HOME, home)
    assert.equal(spec.cwd, dirname(home))
    assert.equal(spec.source, configPath(home))
    assert.equal(spec.pipeDirectory, 'pipe-desktop')
  })
})

test('resolveDesktopServer lets inherited env_vars override config env', () => {
  const home = tempHome()
  const key = 'PC_USE_TEST_DESKTOP_OVERRIDE'
  withEnv(key, 'from-parent', () => {
    writeConfigToml(home, nodeReplToml({ envVars: [key], env: { [key]: 'from-config' } }))
    const spec = resolveDesktopServer({ codexHome: home })
    assert.equal(spec.ok, true)
    assert.equal(spec.env[key], 'from-parent')
  })
})

test('resolveDesktopServer keeps a CODEX_HOME from config.toml and fills an empty one', () => {
  const home = tempHome()
  writeConfigToml(home, nodeReplToml({ env: { CODEX_HOME: 'D:\\fake\\codex-home' } }))
  assert.equal(resolveDesktopServer({ codexHome: home }).env.CODEX_HOME, 'D:\\fake\\codex-home')
  const emptyHome = tempHome()
  writeConfigToml(emptyHome, nodeReplToml({ env: { CODEX_HOME: '' } }))
  assert.equal(resolveDesktopServer({ codexHome: emptyHome }).env.CODEX_HOME, emptyHome)
})

test('resolveDesktopServer defaults missing args and env_vars', () => {
  const home = tempHome()
  writeConfigToml(home, `[mcp_servers.node_repl]\ncommand = ${tomlString(process.execPath)}\n`)
  const previous = process.env.SKY_CUA_NATIVE_PIPE_DIRECTORY
  delete process.env.SKY_CUA_NATIVE_PIPE_DIRECTORY
  try {
    const spec = resolveDesktopServer({ codexHome: home })
    assert.equal(spec.ok, true)
    assert.deepEqual(spec.args, [])
    assert.equal(spec.pipeDirectory, null)
  } finally {
    if (previous !== undefined) process.env.SKY_CUA_NATIVE_PIPE_DIRECTORY = previous
  }
})

test('resolveDesktopServer reports a missing node_repl section with the config path', () => {
  const configs = [
    '',
    '[mcp_servers.other]\ncommand = "other"\n',
    '[mcp_servers.node_repl]\nargs = []\n',
  ]
  for (const text of configs) {
    const home = tempHome()
    writeConfigToml(home, text)
    const spec = resolveDesktopServer({ codexHome: home })
    assert.equal(spec.ok, false)
    assert.equal(spec.reason.includes(configPath(home)), true)
    assert.equal(spec.reason.includes('mcp_servers.node_repl'), true)
  }
})

test('resolveDesktopServer reports an unreadable config.toml', () => {
  const home = tempHome()
  const spec = resolveDesktopServer({ codexHome: home })
  assert.equal(spec.ok, false)
  assert.equal(spec.reason, `cannot read ${configPath(home)}`)
})

test('a missing server command is reported', () => {
  const home = tempHome()
  const missing = join(home, 'missing-server-binary.exe')
  writeMcpJson(home, '26.1013.1', browserEntry({ command: missing }))
  writeConfigToml(home, nodeReplToml({ command: missing }))
  const browser = resolveBrowserServer({ codexHome: home })
  assert.equal(browser.ok, false)
  assert.equal(browser.reason, `server command not found: ${missing}`)
  const desktop = resolveDesktopServer({ codexHome: home })
  assert.equal(desktop.ok, false)
  assert.equal(desktop.reason, `server command not found: ${missing}`)
})
