import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { definePortableTool } from '../lib/define-tool.js'

const platform = process.env.DSH_TOOLS_TEST_MODULE
  ? await import(process.env.DSH_TOOLS_TEST_MODULE) : null

function register(config = {}) {
  const tools = new Map()
  apply({
    tools: { register(tool) {
      assert.equal(tools.has(tool.name), false)
      tools.set(tool.name, tool)
    } },
    effect(factory) { factory()() },
  }, config)
  return tools
}

test('every registered tool publishes an object JSON Schema', () => {
  const tools = register()
  assert.deepEqual([...tools.keys()], [
    'codex_js', 'codex_js_reset', 'codex_js_add_node_module_dir', 'codex_status',
  ])
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
  assert.deepEqual(tools.get('codex_js').parameters.required, ['code', 'title'])
  assert.deepEqual(tools.get('codex_js_add_node_module_dir').parameters.required, ['path'])
  assert.deepEqual(tools.get('codex_js_reset').parameters.properties, {})
  assert.deepEqual(tools.get('codex_status').parameters.properties, {})
})

test('bad arguments are rejected before any bridge starts', async () => {
  const tools = register()
  const js = tools.get('codex_js')
  for (const args of [null, [], {}, { code: '1' }, { code: 1, title: 'x' },
    { code: '1', title: 'x', timeout_ms: '30000' },
    { code: '1', title: 'x', timeout_ms: Infinity }]) {
    await assert.rejects(() => js.execute(args, {}))
  }
  await assert.rejects(() => tools.get('codex_js_add_node_module_dir').execute({}, {}))
})

test('fallback agrees with the bundled defineTool and validates before dispatch', async () => {
  let calls = 0
  const spec = {
    name: 'fixture', description: 'Primitive tool fixture',
    parameters: {
      code: { type: 'string', required: true, description: 'Source' },
      timeout_ms: { type: 'number', description: 'Timeout' },
    },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(args) { calls++; return args.code },
  }
  const fallback = definePortableTool(spec)
  if (platform) {
    const native = definePortableTool(spec, platform.defineTool)
    assert.deepEqual(fallback.parameters, native.parameters)
    assert.deepEqual(fallback.output.schema, native.output.schema)
    for (const args of [{}, { code: 3 }, { code: 'x', timeout_ms: '3' }]) {
      assert.ok(platform.validateJsonSchemaValue(fallback.parameters, args, '').length)
      await assert.rejects(() => native.execute(args, {}))
    }
  }
  assert.equal(calls, 0)
  assert.equal(await fallback.execute({ code: 'ok', timeout_ms: 30000 }, {}), 'ok')
  assert.equal(calls, 1)
  assert.throws(() => definePortableTool({ ...spec, parameters: { nested: { type: 'object' } } }))
})

test('plugin and individual tool switches still work', () => {
  assert.equal(register({ enabled: false }).size, 0)
  assert.deepEqual([...register({ tools: { js: false } }).keys()],
    ['codex_js_reset', 'codex_js_add_node_module_dir', 'codex_status'])
})
