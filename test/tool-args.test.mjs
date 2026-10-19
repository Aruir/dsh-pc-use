// r16: the two argument parsers are pure: they validate one tool call's arguments and return
// normalized values, so these tests call them directly with no plugin process or temp directory.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseObserveArgs, parsePlanArgs } from '../lib/tool-args.js'

/** One valid plan step; extra options land on top. O(1). */
function step(overrides = {}) {
  return { title: 'one', code: '1', ...overrides }
}

test('observe defaults: screenshot and full false, textMode true', () => {
  assert.deepEqual(parseObserveArgs({ target: 'desktop', subject: 'targetWindow' }), {
    target: 'desktop',
    subject: 'targetWindow',
    screenshot: false,
    full: false,
    textMode: true,
  })
})

test('observe returns explicit booleans and rejects non-booleans', () => {
  assert.deepEqual(
    parseObserveArgs({
      target: 'browser', subject: 'tab', screenshot: true, full: true, text: false,
    }),
    { target: 'browser', subject: 'tab', screenshot: true, full: true, textMode: false },
  )
  for (const name of ['screenshot', 'full', 'text']) {
    assert.throws(
      () => parseObserveArgs({ target: 'browser', subject: 'tab', [name]: 'yes' }),
      { message: `${name} must be a boolean` },
    )
  }
})

test('target must be browser or desktop', () => {
  for (const target of [undefined, null, '', 'tablet', 'Browser']) {
    assert.throws(
      () => parseObserveArgs({ target, subject: 'tab' }),
      { message: 'target must be "browser" or "desktop"' },
    )
  }
})

test('subject must be a JavaScript identifier', () => {
  for (const subject of ['tab', '_x', '$w1']) {
    assert.equal(parseObserveArgs({ target: 'browser', subject }).subject, subject)
  }
  for (const subject of ['1tab', 'a-b', '', 'a b', 42, null, undefined]) {
    assert.throws(
      () => parseObserveArgs({ target: 'browser', subject }),
      { message: 'subject must be a JavaScript identifier' },
    )
  }
})

test('the first invalid observe argument wins', () => {
  assert.throws(
    () => parseObserveArgs({ target: 'tablet', subject: '1tab' }),
    { message: 'target must be "browser" or "desktop"' },
  )
  assert.throws(
    () => parseObserveArgs({ target: 'browser', subject: '1tab', screenshot: 'x' }),
    { message: 'subject must be a JavaScript identifier' },
  )
  assert.throws(
    () => parseObserveArgs({ target: 'browser', subject: 'tab', screenshot: 'x', full: 'y' }),
    { message: 'screenshot must be a boolean' },
  )
})

test('plan steps are validated and reduced to title, code and check', () => {
  for (const steps of [undefined, null, [], Array(21).fill(null), 'one']) {
    assert.throws(
      () => parsePlanArgs({ target: 'browser', steps }),
      { message: 'steps must contain 1 to 20 items' },
    )
  }
  assert.equal(parsePlanArgs({ target: 'browser', steps: [step()] }).steps.length, 1)
  assert.equal(parsePlanArgs({
    target: 'browser', steps: Array.from({ length: 20 }, () => step()),
  }).steps.length, 20)
  assert.deepEqual(parsePlanArgs({
    target: 'browser',
    steps: [{ title: 't', code: 'c', check: 'true', extra: 'dropped' }],
  }).steps, [{ title: 't', code: 'c', check: 'true' }])
  assert.deepEqual(parsePlanArgs({ target: 'browser', steps: [step()] }).steps, [
    { title: 'one', code: '1', check: undefined },
  ])
  for (const steps of [[null], ['x'], [42]]) {
    assert.throws(() => parsePlanArgs({ target: 'browser', steps }), {
      message: 'steps[0] must be an object',
    })
  }
  assert.throws(
    () => parsePlanArgs({ target: 'browser', steps: [{ title: '  ', code: '1' }] }),
    { message: 'steps[0].title must be a non-empty string' },
  )
  assert.throws(
    () => parsePlanArgs({ target: 'browser', steps: [{ title: 't', code: '' }] }),
    { message: 'steps[0].code must be a non-empty string' },
  )
  assert.throws(
    () => parsePlanArgs({ target: 'browser', steps: [{ ...step(), check: 1 }] }),
    { message: 'steps[0].check must be a string' },
  )
  assert.throws(
    () => parsePlanArgs({
      target: 'browser', steps: [step(), { title: '', code: '1' }],
    }),
    { message: 'steps[1].title must be a non-empty string' },
  )
})

test('plan observe accepts undefined/null and one descriptor', () => {
  assert.equal(
    parsePlanArgs({ target: 'browser', steps: [step()], observe: undefined }).observe,
    null,
  )
  assert.equal(
    parsePlanArgs({ target: 'browser', steps: [step()], observe: null }).observe,
    null,
  )
  for (const observe of ['one', [], 42]) {
    assert.throws(
      () => parsePlanArgs({ target: 'browser', steps: [step()], observe }),
      { message: 'observe must be an object' },
    )
  }
  assert.deepEqual(
    parsePlanArgs({
      target: 'desktop', steps: [step()], observe: { subject: 'targetWindow' },
    }).observe,
    { subject: 'targetWindow', screenshot: false },
  )
  assert.deepEqual(
    parsePlanArgs({
      target: 'desktop', steps: [step()], observe: { subject: '_w', screenshot: true },
    }).observe,
    { subject: '_w', screenshot: true },
  )
  assert.throws(
    () => parsePlanArgs({
      target: 'desktop', steps: [step()], observe: { subject: 'w', screenshot: 'yes' },
    }),
    { message: 'observe.screenshot must be a boolean' },
  )
  // The plan's observe reuses the same REPL identifier rule as the top-level subject.
  assert.throws(
    () => parsePlanArgs({
      target: 'desktop', steps: [step()], observe: { subject: '1bad' },
    }),
    { message: 'subject must be a JavaScript identifier' },
  )
})
