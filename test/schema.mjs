import assert from 'node:assert/strict'
import { tempDir } from './helpers.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Point the platform home at an empty temp directory so nothing here can read or start
// the user's real Codex installation.
const home = tempDir('dsh-pc-use-schema-')
process.env.HOME = home
process.env.USERPROFILE = home

const { apply } = await import('../index.js')
const { definePortableTool } = await import('../lib/define-tool.js')

const platform = process.env.DSH_TOOLS_TEST_MODULE
  ? await import(process.env.DSH_TOOLS_TEST_MODULE) : null

const BAD_ARGUMENTS = /Missing required parameter|Invalid parameter|must be an object/
const REGISTERED = [
  'pc_codex_js',
  'pc_codex_js_reset',
  'pc_codex_desktop_js',
  'pc_codex_desktop_js_reset',
  'pc_codex_desktop_js_add_node_module_dir',
  'pc_codex_observe',
  'pc_codex_run_plan',
  'pc_codex_docs',
  'pc_status',
]

function register(config = {}) {
  const tools = new Map()
  apply({
    tools: {
      register(tool) {
        assert.equal(tools.has(tool.name), false)
        tools.set(tool.name, tool)
      },
    },
    effect(factory) {
      factory()()
    },
  }, config)
  return tools
}

function fixtureSpec(onCall = () => {}) {
  return {
    name: 'fixture',
    description: 'Primitive tool fixture',
    parameters: {
      code: { type: 'string', required: true, description: 'Source' },
      timeout_ms: { type: 'number', description: 'Timeout' },
    },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(args) {
      onCall(args)
      return args.code
    },
  }
}

test('every registered tool publishes an object JSON Schema', () => {
  const tools = register()
  assert.deepEqual([...tools.keys()], REGISTERED)
  for (const tool of tools.values()) {
    const schema = JSON.parse(JSON.stringify(tool.parameters))
    assert.equal(schema.type, 'object', tool.name)
    assert.equal(typeof schema.properties, 'object', tool.name)
    assert.ok(!schema.required || Array.isArray(schema.required))
    for (const property of Object.values(schema.properties)) {
      assert.equal(Object.hasOwn(property, 'required'), false)
    }
    if (platform) platform.assertSupportedJsonSchema(schema)
  }
  assert.deepEqual(tools.get('pc_codex_js').parameters.required, ['code', 'title'])
  assert.deepEqual(tools.get('pc_codex_js_reset').parameters.properties, {})
  assert.deepEqual(tools.get('pc_status').parameters.properties, {})
  assert.deepEqual(tools.get('pc_codex_desktop_js').parameters.required, ['code', 'title'])
  assert.deepEqual(tools.get('pc_codex_desktop_js_reset').parameters.properties, {})
  assert.deepEqual(
    tools.get('pc_codex_desktop_js_add_node_module_dir').parameters.required,
    ['path'],
  )
  assert.equal(
    tools.get('pc_codex_desktop_js_add_node_module_dir').parameters.properties.path.type,
    'string',
  )
  assert.equal(tools.has('pc_codex_js_add_node_module_dir'), false)
  assert.deepEqual(tools.get('pc_codex_docs').parameters.required, ['topic'])
  assert.deepEqual(tools.get('pc_codex_docs').parameters.properties.topic.type, 'string')
  const observe = tools.get('pc_codex_observe').parameters
  assert.deepEqual(observe.required, ['target', 'subject'])
  assert.equal(observe.properties.target.type, 'string')
  assert.equal(observe.properties.screenshot.type, 'boolean')
  assert.equal(observe.properties.full.type, 'boolean')
  assert.equal(observe.properties.text.type, 'boolean')
  const plan = tools.get('pc_codex_run_plan').parameters
  assert.deepEqual(plan.required, ['target', 'steps'])
  assert.equal(plan.properties.steps.type, 'array')
  assert.equal(plan.properties.observe.type, 'object')
})

test('bad arguments are rejected with a TypeError before any bridge starts', async () => {
  const tools = register()
  const js = tools.get('pc_codex_js')
  for (const args of [null, [], {}, { code: '1' }, { code: 1, title: 'x' },
    { code: '1', title: 'x', timeout_ms: '30000' },
    { code: '1', title: 'x', timeout_ms: Infinity }]) {
    await assert.rejects(() => js.execute(args, {}), (error) => {
      assert.ok(error instanceof TypeError, `expected a TypeError for ${String(args)}`)
      assert.match(error.message, BAD_ARGUMENTS)
      return true
    })
  }
  await assert.rejects(() => tools.get('pc_codex_docs').execute({}, {}), (error) => {
    assert.ok(error instanceof TypeError, 'expected a TypeError for a missing topic')
    assert.match(error.message, BAD_ARGUMENTS)
    return true
  })
})

test('the fallback validates before dispatch', async () => {
  let calls = 0
  const spec = fixtureSpec(() => { calls++ })
  const fallback = definePortableTool(spec)
  for (const args of [null, {}, { code: 3 }, { code: 'x', timeout_ms: '3' },
    { code: 'x', timeout_ms: Infinity }]) {
    await assert.rejects(() => fallback.execute(args, {}), (error) => {
      assert.ok(error instanceof TypeError, `expected a TypeError for ${String(args)}`)
      assert.match(error.message, BAD_ARGUMENTS)
      return true
    })
  }
  assert.equal(calls, 0)
  assert.equal(await fallback.execute({ code: 'ok', timeout_ms: 30000 }, {}), 'ok')
  assert.equal(calls, 1)
  assert.throws(() => definePortableTool({
    ...fixtureSpec(),
    parameters: { nested: { type: 'function' } },
  }), TypeError)
})

test('the fallback agrees with the host defineTool', async (t) => {
  if (platform === null) {
    return t.skip('DSH_TOOLS_TEST_MODULE is not set; the bundled defineTool cannot be compared')
  }
  let calls = 0
  const spec = fixtureSpec(() => { calls++ })
  const fallback = definePortableTool(spec)
  const native = definePortableTool(spec, platform.defineTool)
  assert.deepEqual(fallback.parameters, native.parameters)
  assert.deepEqual(fallback.output.schema, native.output.schema)
  for (const args of [{}, { code: 3 }, { code: 'x', timeout_ms: '3' }]) {
    assert.ok(platform.validateJsonSchemaValue(fallback.parameters, args, '').length)
    await assert.rejects(() => native.execute(args, {}))
  }
  assert.equal(calls, 0)
})

test('plugin and individual tool switches still work', () => {
  assert.equal(register({ enabled: false }).size, 0)
  assert.deepEqual([...register({ tools: { js: false } }).keys()], [
    'pc_codex_js_reset', 'pc_codex_desktop_js', 'pc_codex_desktop_js_reset',
    'pc_codex_desktop_js_add_node_module_dir', 'pc_codex_observe',
    'pc_codex_run_plan', 'pc_codex_docs', 'pc_status',
  ])
  assert.deepEqual([...register({ tools: { desktopJs: false } }).keys()], [
    'pc_codex_js', 'pc_codex_js_reset', 'pc_codex_desktop_js_reset',
    'pc_codex_desktop_js_add_node_module_dir', 'pc_codex_observe',
    'pc_codex_run_plan', 'pc_codex_docs', 'pc_status',
  ])
})
