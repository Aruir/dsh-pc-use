// r29: the native result header on the five direct MCP-call tools: wall time (four
// decimals) plus `Output:`, followed by the server text exactly as received. Observe and
// run_plan are plugin-composed and keep their old output.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { startServers, stopServers } from './fixtures/server-harness.mjs'

const HEADER = /^Wall time: (\d+\.\d{4}) seconds\nOutput:\n/

/** The body after the native header; also fails when the header or its shape is missing. O(1). */
function bodyOf(value) {
  const match = HEADER.exec(value)
  assert.notEqual(match, null, `missing wall-time header: ${value.slice(0, 80)}`)
  return value.slice(match[0].length)
}

test('the five native tools put the header in front of the server text', async () => {
  const context = startServers({ config: { computer: true } })
  try {
    const tools = context.plugin.tools
    const browser = await tools.get('pc_codex_js').execute({ code: '1', title: 'h' }, {})
    assert.equal(bodyOf(browser), 'ran js')
    const browserReset = await tools.get('pc_codex_js_reset').execute({}, {})
    assert.equal(bodyOf(browserReset), 'ran js_reset')
    const desktop = await tools.get('pc_codex_desktop_js')
      .execute({ code: '1', title: 'h' }, {})
    assert.equal(bodyOf(desktop), 'ran js')
    const desktopReset = await tools.get('pc_codex_desktop_js_reset').execute({}, {})
    assert.equal(bodyOf(desktopReset), 'ran js_reset')
    const added = await tools.get('pc_codex_desktop_js_add_node_module_dir')
      .execute({ path: '/mnt/c/fake/modules' }, {})
    assert.equal(bodyOf(added), 'ran js_add_node_module_dir')
  } finally {
    assert.equal(await stopServers(context), true)
  }
})

test('an isError result throws an error whose message starts with the same header', async () => {
  const context = startServers({ browser: { mode: 'error' } })
  try {
    await assert.rejects(
      () => context.plugin.tools.get('pc_codex_js').execute({ code: '1', title: 'e' }, {}),
      (error) => {
        assert.match(error.message, HEADER)
        assert.equal(bodyOf(error.message), 'server error text')
        return true
      },
    )
  } finally {
    assert.equal(await stopServers(context), true)
  }
})
