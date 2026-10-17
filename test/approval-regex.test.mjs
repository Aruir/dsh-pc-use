// F2: desktop approval prompts are matched as whole lines and the app name is extracted.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyApproval } from '../lib/approval.js'

test('computer approval prompts are recognised with the app name', () => {
  assert.deepEqual(
    classifyApproval('Allow Computer Use to use "记事本"?'),
    { kind: 'computer', appName: '记事本' },
  )
  assert.deepEqual(
    classifyApproval('Allow Codex to use Notepad?'),
    { kind: 'computer', appName: 'Notepad' },
  )
  assert.deepEqual(
    classifyApproval('Allow Codex to use Visual Studio Code?'),
    { kind: 'computer', appName: 'Visual Studio Code' },
  )
})

test('browser prompts keep their own kind', () => {
  assert.deepEqual(
    classifyApproval('Allow Browser use to access https://example.com?'),
    { kind: 'browser' },
  )
})

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
