// Shared fixtures: temp directories, a fake Codex home, a plugin harness and polling
// helpers. The fake MCP server lives in the review directory so the tests run against
// exactly the fixture the review used.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

export const FAKE_SERVER = process.env.CODEX_CU_FAKE_SERVER
  ?? fileURLToPath(new URL('../../dsh-codex-cu-review/repro/fake-server.mjs', import.meta.url))

export function tempDir(prefix = 'codex-cu-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
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

/** Write the `.mcp.json` that `resolveCodexServer` reads, pointing at the fake server. */
export function writeCodexHome(codexHome, args, env = {}) {
  const directory = join(
    codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '26.1013.31256',
  )
  mkdirSync(directory, { recursive: true })
  const config = {
    mcpServers: {
      cua_repl: {
        command: process.execPath,
        args,
        env,
        env_vars: [],
      },
    },
  }
  writeFileSync(join(directory, '.mcp.json'), JSON.stringify(config))
}

/**
 * Apply the plugin against a minimal cordis context; returns the registered tools.
 * `options.services` is what the fake `ctx.get(name)` returns (e.g. an approval service).
 */
export function registerPlugin(config, options = {}) {
  const tools = new Map()
  const disposers = []
  const services = options.services ?? {}
  const ctx = {
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
    get(name) {
      return services[name]
    },
  }
  apply(ctx, config)
  return {
    tools,
    dispose() {
      for (const disposer of disposers) {
        disposer()
      }
      disposers.length = 0
    },
  }
}

/** Poll `predicate` until it returns true or the deadline passes. */
export async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
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
