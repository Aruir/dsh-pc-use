// F2: desktop approval prompts are matched as whole lines and the app name is extracted.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyApproval } from '../lib/approval.js'

test('computer prompt boundaries fail closed', () => {
  const rejected = [
    ' Please Allow Computer Use to use "记事本"?',
    'Allow Computer Use to use "记事本"? please',
    'Allow Computer Use to use "记事本"? ',
    'Allow Computer Use to use "记事本"?\n',
    'Allow Computer Use to use Notepad?',
    'Allow Computer Use to use ""?',
    'Allow Codex to use ?',
    'Allow Codex to use   ?',
    'Allow Codex to control the Notepad app?',
    'allow Computer Use to use "记事本"?',
    '',
  ]
  for (const question of rejected) {
    assert.deepEqual(classifyApproval(question), { kind: 'other' }, JSON.stringify(question))
  }
  assert.deepEqual(classifyApproval(null), { kind: 'other' })
  assert.deepEqual(classifyApproval(undefined), { kind: 'other' })
})
