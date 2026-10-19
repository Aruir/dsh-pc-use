// r16: argument parsing for `pc_codex_observe` and `pc_codex_run_plan`. These parsers read no
// plugin state, so they live outside apply(): each one validates one tool call's arguments and
// returns normalized values, or throws the same first error as before.

/** Targets both tools accept. */
const OBSERVE_TARGETS = ['browser', 'desktop']
const SUBJECT_PATTERN = /^[A-Za-z_$][\w$]*$/

/** Validate one observe target or throw before any code is sent. O(1). */
function parseTarget(target) {
  if (!OBSERVE_TARGETS.includes(target)) {
    throw new Error('target must be "browser" or "desktop"')
  }
  return target
}

/** Validate a REPL global variable name before interpolating it into code. O(1). */
function parseSubject(subject) {
  if (typeof subject !== 'string' || !SUBJECT_PATTERN.test(subject)) {
    throw new Error('subject must be a JavaScript identifier')
  }
  return subject
}

/** Read an optional boolean argument with a default. O(1). */
function parseBoolean(value, name, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

/** Validate one optional observe descriptor. O(1). */
function parseObserve(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('observe must be an object')
  }
  return {
    subject: parseSubject(value.subject),
    screenshot: parseBoolean(value.screenshot, 'observe.screenshot', false),
  }
}

/** Validate ordered plan steps before executing any of them. O(steps). */
function parseSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) {
    throw new Error('steps must contain 1 to 20 items')
  }
  return steps.map((step, index) => {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      throw new Error(`steps[${index}] must be an object`)
    }
    if (typeof step.title !== 'string' || step.title.trim() === '') {
      throw new Error(`steps[${index}].title must be a non-empty string`)
    }
    if (typeof step.code !== 'string' || step.code.trim() === '') {
      throw new Error(`steps[${index}].code must be a non-empty string`)
    }
    if (step.check !== undefined && typeof step.check !== 'string') {
      throw new Error(`steps[${index}].check must be a string`)
    }
    return { title: step.title, code: step.code, check: step.check }
  })
}

/**
 * Parse `pc_codex_observe` arguments in the same order as before: target, subject, then the
 * optional `screenshot`, `full` and `text` booleans. The `text` result field is `textMode`. O(1).
 */
export function parseObserveArgs(args) {
  const target = parseTarget(args.target)
  const subject = parseSubject(args.subject)
  const screenshot = parseBoolean(args.screenshot, 'screenshot', false)
  const full = parseBoolean(args.full, 'full', false)
  const textMode = parseBoolean(args.text, 'text', true)
  return { target, subject, screenshot, full, textMode }
}

/**
 * Parse `pc_codex_run_plan` arguments in the same order as before: target, steps, then the
 * optional observe descriptor. O(steps).
 */
export function parsePlanArgs(args) {
  const target = parseTarget(args.target)
  const steps = parseSteps(args.steps)
  const observe = parseObserve(args.observe)
  return { target, steps, observe }
}
