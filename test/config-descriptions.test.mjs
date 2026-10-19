// r23: every configuration description in the schema must come from the plugin text table,
// so the schema and lib/text.js cannot drift apart again (r18 left four different literals).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config } from '../index.js'
import { TEXT } from '../lib/text.js'

/** The default text of one Schemastery description field (LocalizedText or a string). O(1). */
function defaultText(description) {
  return typeof description === 'string' ? description : description?.['']
}

/** The 11 top-level configuration fields; `tools` is a group, checked separately. O(1). */
function topLevelFields() {
  return Object.keys(Config.dict).filter((key) => key !== 'tools')
}

/** The 9 tool switches inside the `tools` group. O(1). */
function toolFields() {
  return Object.keys(Config.dict.tools.dict)
}

test('the configuration schema keeps 12 fields and 9 tool switches', () => {
  assert.ok(Config, 'the configuration schema must build')
  // r25 added prefetchServerDocs, so the top-level field count grew from 11 to 12.
  assert.equal(topLevelFields().length, 12)
  assert.equal(toolFields().length, 9)
})

test('every configuration description matches the plugin text table', () => {
  const config = TEXT.zh.config
  assert.equal(defaultText(Config.meta.description), config.description, 'description')
  for (const field of topLevelFields()) {
    assert.equal(defaultText(Config.dict[field].meta.description), config[field], field)
  }
  assert.equal(defaultText(Config.dict.tools.meta.description), config.tools.description)
  for (const field of toolFields()) {
    assert.equal(
      defaultText(Config.dict.tools.dict[field].meta.description),
      config.tools[field],
      `tools.${field}`,
    )
  }
})
