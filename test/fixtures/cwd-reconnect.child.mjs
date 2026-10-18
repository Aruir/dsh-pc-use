// Runs under `node --experimental-test-module-mocks --test` from reconnect.test.mjs:
// it mocks lib/codex-config.js so the resolved browser spec keeps every field but `cwd`
// constant. The plugin must notice the cwd change and start a second server process. It
// lives in a child process so the normal `npm test` command needs no experimental flag.
// The mock must cover every named export index.js imports (the desktop resolver is never
// reached here because only pc_codex_js is called).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, mock } from 'node:test'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PID_SERVER = fileURLToPath(new URL('./pid-server.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'pc-use-cwd-home-'))
const serverLog = join(home, 'server.log')
const pidFile = join(home, 'pids.txt')
const logFile = join(home, 'bridge.log')
writeFileSync(serverLog, '')
writeFileSync(pidFile, '')
const cwdA = mkdtempSync(join(tmpdir(), 'pc-use-cwd-a-'))
const cwdB = mkdtempSync(join(tmpdir(), 'pc-use-cwd-b-'))
let currentCwd = cwdA
const args = [PID_SERVER, pidFile, 'ok', serverLog]

mock.module(pathToFileURL(join(ROOT, 'lib', 'codex-config.js')).href, {
  namedExports: {
    COMPUTER_USE_DOC_TOPICS: [],
    defaultCodexHome: () => home,
    resolveBrowserServer: () => ({
      ok: true,
      command: process.execPath,
      args,
      env: { ...process.env },
      cwd: currentCwd,
      source: 'mocked-resolver',
      pipeDirectory: 'pipe-mock',
    }),
    resolveDesktopServer: () => ({ ok: false, reason: 'desktop is not used by this test' }),
    resolveComputerUseDocs: () => {
      throw new Error('pc_codex_docs is not used by this test')
    },
    versionFromSource: () => null,
  },
})
const { apply } = await import(pathToFileURL(join(ROOT, 'index.js')).href)

/** Minimal cordis-like context, matching test/helpers.mjs. O(1). */
function loadPlugin(config) {
  const tools = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    effect(factory) {
      disposers.push(factory())
    },
    get() {
      return undefined
    },
    inject() {},
  }
  apply(ctx, config)
  return {
    tools,
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}

function readPids(file) {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((done) => setTimeout(done, 25))
  }
  return false
}

function killAll(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid)
    } catch {}
  }
}

test('a changed resolved cwd starts a second server process', async () => {
  const plugin = loadPlugin({ codexHome: home, logFile })
  try {
    const js = plugin.tools.get('pc_codex_js')
    const exec = (callId) => ({ name: 'pc_codex_js', callId, signal: new AbortController().signal })
    const first = await js.execute({ code: '1', title: 'cwd-first' }, exec('call-a'))
    assert.equal(first, 'ran js')
    assert.equal(await waitFor(() => readPids(pidFile).length === 1), true)
    currentCwd = cwdB
    const second = await js.execute({ code: '2', title: 'cwd-second' }, exec('call-b'))
    assert.equal(second, 'ran js')
    assert.equal(await waitFor(() => readPids(pidFile).length === 2), true)
    assert.match(readFileSync(logFile, 'utf8'), /Codex server changed \(cwd\); reconnecting/)
  } finally {
    plugin.dispose()
    const stopped = await waitFor(() => readPids(pidFile).every((pid) => !isRunning(pid)), 2000)
    killAll(readPids(pidFile))
    assert.equal(stopped, true, 'every mocked server must exit after dispose')
  }
})
