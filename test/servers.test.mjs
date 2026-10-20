// 0.5.0 S1/S2/S5: two MCP servers from their own Codex sources, nine tools, lazy
// desktop start, the `computer` gate, js_add_node_module_dir and the pc_status shape.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { stripWallTime, waitFor } from './helpers.mjs'
import {
  records, startServers, stopServers,
} from './fixtures/server-harness.mjs'

function execFor(agent, callId, name = 'pc_codex_desktop_js') {
  return { agent, name, callId, signal: new AbortController().signal }
}

function makeAgents() {
  const byId = new Map()
  return {
    add(id) {
      const session = { id }
      const agent = { id, session }
      byId.set(id, agent)
      return { agent, session }
    },
    get(id) {
      return byId.get(id)
    },
  }
}

async function runBrowser(context, exec = {}) {
  const result = await context.plugin.tools.get('pc_codex_js')
    .execute({ code: '1', title: 'browser' }, exec)
  return stripWallTime(result)
}

async function runDesktop(context, exec = {}) {
  const result = await context.plugin.tools.get('pc_codex_desktop_js')
    .execute({ code: '1', title: 'desktop' }, exec)
  return stripWallTime(result)
}

test('browser calls start cua_repl from .mcp.json', async () => {
  const context = startServers()
  try {
    const result = await runBrowser(context)
    assert.equal(result, 'ran js')
    assert.equal(context.browserStart().length, 1)
    const start = context.browserStart()[0]
    assert.equal(start.label, 'browser')
    assert.equal(start.env.CUA_REPL_ENABLED_SURFACES, 'browser')
    assert.equal(start.env.NODE_REPL_TRUSTED_SERVICES, '{"browser":"/fake/browser"}')
    assert.equal(records(context.logs.desktop).length, 0, 'the desktop server must not start')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('desktop calls start node_repl from config.toml', async () => {
  const context = startServers({ config: { computer: true } })
  try {
    const result = await runDesktop(context)
    assert.equal(result, 'ran js')
    assert.equal(context.desktopStart().length, 1)
    const start = context.desktopStart()[0]
    assert.equal(start.label, 'desktop')
    assert.equal(start.env.CUA_REPL_ENABLED_SURFACES, null)
    assert.equal(start.env.NODE_REPL_TRUSTED_SERVICES, '{"sky":"/fake/sky"}')
    assert.equal(records(context.logs.browser).length, 0, 'the browser server must not start')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('each server receives its own env without surfaces or trusted-service changes', async () => {
  const context = startServers({ config: { computer: true } })
  try {
    await runBrowser(context)
    await runDesktop(context)
    const browserEnv = context.browserStart()[0].env
    const desktopEnv = context.desktopStart()[0].env
    // The browser source keeps exactly what Codex wrote: no `computer` surface is added.
    assert.equal(browserEnv.CUA_REPL_ENABLED_SURFACES, 'browser')
    assert.equal(browserEnv.NODE_REPL_TRUSTED_SERVICES, '{"browser":"/fake/browser"}')
    // The desktop source is not given a surface and its trusted services are not rewritten.
    assert.equal(desktopEnv.CUA_REPL_ENABLED_SURFACES, null)
    assert.equal(desktopEnv.NODE_REPL_TRUSTED_SERVICES, '{"sky":"/fake/sky"}')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('desktop tools are registered by default and independent of computer', () => {
  const defaults = startServers()
  const off = startServers({ config: { computer: false } })
  try {
    const all = [
      'pc_codex_js', 'pc_codex_js_reset', 'pc_codex_desktop_js',
      'pc_codex_desktop_js_reset', 'pc_codex_desktop_js_add_node_module_dir',
      'pc_codex_observe', 'pc_codex_run_plan', 'pc_codex_docs', 'pc_status',
    ]
    assert.deepEqual([...defaults.plugin.tools.keys()], all)
    assert.deepEqual([...off.plugin.tools.keys()], all)
  } finally {
    defaults.plugin.dispose()
    off.plugin.dispose()
    defaults.restore()
    off.restore()
  }
})

test('browser-only calls never start the desktop server', async () => {
  const context = startServers({ config: { computer: true } })
  try {
    await runBrowser(context)
    await runBrowser(context)
    assert.equal(context.browserStart().length, 1)
    assert.equal(records(context.logs.desktop).length, 0)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('computer false rejects desktop calls without starting a process', async () => {
  const context = startServers({ config: { computer: false } })
  try {
    for (const [name, args] of [
      ['pc_codex_desktop_js', { code: '1', title: 'x' }],
      ['pc_codex_desktop_js_reset', {}],
      ['pc_codex_desktop_js_add_node_module_dir', { path: 'C:\\fake\\modules' }],
    ]) {
      await assert.rejects(
        () => context.plugin.tools.get(name).execute(args, {}),
        (error) => {
          assert.match(error.message, /computer use is off/, name)
          assert.match(error.message, /computer: true/, name)
          return true
        },
      )
    }
    assert.equal(records(context.logs.browser).length, 0)
    assert.equal(records(context.logs.desktop).length, 0)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('add_node_module_dir reaches node_repl with the same identity', async () => {
  const agents = makeAgents()
  const context = startServers({ config: { computer: true }, services: { agents } })
  try {
    const { agent, session } = agents.add('session-add-dir')
    await runDesktop(context, execFor(agent, 'call-js'))
    const added = await context.plugin.tools.get('pc_codex_desktop_js_add_node_module_dir')
      .execute({ path: 'C:\\fake\\modules' }, execFor(agent, 'call-add'))
    assert.equal(stripWallTime(added), 'ran js_add_node_module_dir')
    const calls = context.desktopCalls()
    assert.deepEqual(calls.map((call) => call.name), ['js', 'js_add_node_module_dir'])
    assert.deepEqual(calls[1].arguments, { path: 'C:\\fake\\modules' })
    assert.equal(calls[1].session_id, calls[0].session_id)
    assert.equal(calls[1].turn_id, calls[0].turn_id)
    // The browser source never sees the desktop-only tool.
    assert.equal(records(context.logs.browser).length, 0)
    // It counts as desktop use, so this turn ends on the desktop server.
    context.plugin.emit('session/event', session, {
      type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } },
    })
    assert.equal(await waitFor(
      () => context.desktopCalls().some((call) => call.name === 'turn_ended'),
    ), true)
    const turnEnded = context.desktopCalls().find((call) => call.name === 'turn_ended')
    assert.equal(turnEnded.arguments.session_id, calls[0].session_id)
    assert.equal(turnEnded.arguments.turn_id, calls[0].turn_id)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('the desktop tool applies the same timeout_ms margin as the browser tool', async () => {
  const context = startServers({
    desktop: { mode: 'hang' },
    config: { computer: true, timeoutMs: 100 },
  })
  let settled = null
  try {
    const call = context.plugin.tools.get('pc_codex_desktop_js')
      .execute({ code: '1', title: 'desktop', timeout_ms: 5000 }, {})
    call.then(() => { settled = 'resolved' }, () => { settled = 'rejected' })
    await new Promise((done) => setTimeout(done, 400))
    assert.equal(settled, null, 'timeout_ms must extend the call beyond timeoutMs')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('a missing node_repl section only breaks desktop', async () => {
  const context = startServers({ desktop: false, config: { computer: true } })
  // A readable config.toml without the node_repl table is the "section missing" case.
  writeFileSync(join(context.codexHome, 'config.toml'), '[other]\nkey = "value"\n')
  try {
    assert.equal(await runBrowser(context), 'ran js')
    await assert.rejects(
      () => runDesktop(context),
      (error) => {
        assert.match(error.message, /dsh-pc-use: /)
        assert.match(error.message, /mcp_servers\.node_repl/)
        assert.match(error.message, /config\.toml/)
        return true
      },
    )
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.equal(status.providers.codex.browser.resolved, true)
    assert.equal(status.providers.codex.desktop.resolved, false)
    assert.match(status.providers.codex.desktop.reason, /mcp_servers\.node_repl/)
    assert.equal(status.providers.codex.desktop.connected, false)
    assert.equal(status.providers.codex.desktop.services, null)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('pc_status reports null services on both sides while disconnected', async () => {
  const context = startServers()
  try {
    const status = JSON.parse(await context.plugin.tools.get('pc_status').execute({}, {}))
    assert.deepEqual(Object.keys(status), ['providers'])
    assert.deepEqual(
      Object.keys(status.providers.codex),
      ['codexHome', 'autoApprove', 'computer', 'serverDocs', 'browser', 'desktop', 'log'],
    )
    const codex = status.providers.codex
    assert.equal(codex.codexHome, context.codexHome)
    assert.equal(codex.autoApprove, false)
    assert.equal(codex.computer, false)
    for (const side of ['browser', 'desktop']) {
      const server = codex[side]
      assert.deepEqual(Object.keys(server), [
        'resolved', 'reason', 'source', 'command', 'cwd', 'nativePipe', 'connected', 'services',
        'connectedPipe', 'reconnectPending', 'serverInfo', 'pluginVersion',
        'nativePipeState',
      ], side)
      assert.equal(server.resolved, true, side)
      assert.equal(server.connected, false, side)
      assert.equal(server.services, null, side)
      assert.equal(server.nativePipe, side === 'browser' ? 'pipe-browser' : null, side)
      assert.equal(server.nativePipeState, side === 'browser' ? 'missing' : null, side)
      assert.equal(typeof server.source, 'string', side)
      assert.equal(server.command, process.execPath, side)
      assert.equal(server.cwd, context.home, side)
    }
    assert.equal(codex.browser.source, join(
      context.codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use',
      '26.1013.31256', '.mcp.json',
    ))
    assert.equal(codex.desktop.source, join(context.codexHome, 'config.toml'))
    assert.equal(codex.servicesFrom, undefined)
    assert.equal(codex.browser.reconnectPending, false)
    assert.equal(codex.desktop.reconnectPending, false)
    assert.equal(codex.log.path.endsWith('bridge.log'), true)
    assert.equal(codex.log.writable, true)
    assert.equal(codex.log.lastError, null)
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
