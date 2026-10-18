// Client half of 0.4.3: load the browser bundle with a fake module loader and fake React,
// then drive the settings page model and slot registration without a browser.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))

// The bundle registers itself through window.__ModuleLoader__; capture the definition.
const definitions = []
globalThis.window = { __ModuleLoader__: { load: (definition) => definitions.push(definition) } }
await import(pathToFileURL(join(root, 'client.js')).href)
const definition = definitions.find((entry) => entry.id === 'dsh-pc-use')
assert.ok(definition, 'client.js must register the dsh-pc-use module')

// Minimal React replacement: createElement builds plain { type, props } nodes and the
// three hooks the page uses are stubbed, so the component can be rendered in Node.
let hooks = null

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } }
  },
  useMemo(factory, deps) {
    const slot = hooks.memo[hooks.index]
    hooks.index += 1
    if (slot !== undefined && sameDeps(slot.deps, deps)) return slot.value
    const value = factory()
    hooks.memo[hooks.index - 1] = { deps, value }
    return value
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    const current = hooks
    current.index += 1
    subscribe(() => {
      current.dirty.value = true
    })
    return getSnapshot()
  },
  useEffect(effect) {
    hooks.index += 1
    hooks.effects.push(effect)
  },
  useState(initial) {
    const current = hooks
    const index = current.index
    current.index += 1
    if (current.states[index] === undefined) {
      current.states[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = current.states[index]
    const set = (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
      current.dirty.value = true
    }
    return [slot.value, set]
  },
}

/** Compare a hook's dependency list element by element. O(n). */
function sameDeps(previous, next) {
  return previous.length === next.length
    && previous.every((value, index) => Object.is(value, next[index]))
}

/** Render one component with the stub hooks; render() re-reads after state changes. O(n). */
function createRenderer(Component, props = {}) {
  const memo = []
  const states = []
  const dirty = { value: false }
  const cleanups = []

  const expand = (node) => {
    if (Array.isArray(node)) return node.flatMap(expand)
    if (node === null || node === undefined || node === false || node === true) return []
    if (typeof node !== 'object') return [node]
    if (typeof node.type === 'function') return expand(node.type({ ...node.props }))
    return [{
      type: node.type,
      props: { ...node.props, children: expand(node.props.children) },
    }]
  }

  let tree = []
  const render = () => {
    do {
      dirty.value = false
      hooks = { index: 0, memo, states, effects: [], dirty }
      const rendered = expand(Component({ ...props }))
      const effects = hooks.effects
      hooks = null
      for (const effect of effects) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      tree = rendered
    } while (dirty.value)
    return tree
  }
  render()
  return {
    render,
    getTree: () => tree,
    unmount() {
      hooks = null
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
}

/** Depth-first list of rendered elements. O(n). */
function elements(tree, out = []) {
  if (Array.isArray(tree)) {
    for (const item of tree) elements(item, out)
    return out
  }
  if (tree === null || typeof tree !== 'object') return out
  out.push(tree)
  elements(tree.props?.children ?? [], out)
  return out
}

/** Text content of a rendered tree. O(n). */
function renderedText(tree) {
  if (Array.isArray(tree)) return tree.map(renderedText).join('')
  if (tree === null || tree === undefined || tree === false) return ''
  if (typeof tree !== 'object') return String(tree)
  return renderedText(tree.props?.children ?? [])
}

function findNode(tree, predicate) {
  return elements(tree).find(predicate)
}

function mergeScan(target, source) {
  for (const label of source.labels) target.labels.add(label)
  target.resets += source.resets
  target.rows.push(...source.rows)
}

/**
 * Field ids whose rendered row contains a "Restore default" button. The deepest div with
 * exactly one label and one reset button is the row; clearing after recording keeps an
 * ancestor page container from being reported again. O(n²) on a small tree.
 */
function rowsWithReset(tree) {
  const resetLabel = '恢复默认'
  const scan = (node) => {
    if (Array.isArray(node)) {
      const acc = { labels: new Set(), resets: 0, rows: [] }
      for (const child of node) mergeScan(acc, scan(child))
      return acc
    }
    if (node === null || typeof node !== 'object') {
      return { labels: new Set(), resets: 0, rows: [] }
    }
    const acc = { labels: new Set(), resets: 0, rows: [] }
    if (node.type === 'label' && typeof node.props.htmlFor === 'string') {
      acc.labels.add(node.props.htmlFor)
    }
    for (const child of node.props.children ?? []) mergeScan(acc, scan(child))
    if (node.type === 'button' && renderedText(node).includes(resetLabel)) acc.resets += 1
    if (node.type === 'div' && acc.labels.size === 1 && acc.resets === 1) {
      acc.rows.push([...acc.labels][0])
      acc.labels.clear()
      acc.resets = 0
    }
    return acc
  }
  return scan(tree).rows
}

/** Load the bundle; `primitives` simulates the optional DSH primitives module. O(1). */
function loadClient(primitives = null) {
  return definition.factory((id) => {
    if (id === 'react') return reactStub
    if (id === '@deepseek-ai/dsh-client-ui-primitives' && primitives !== null) return primitives
    throw new Error(`unexpected browser module ${id}`)
  })
}

const client = loadClient()

/** Render the settings section; `module` lets a test use a client loaded with primitives. O(n). */
function renderSection(overrides = {}, module = client) {
  const context = fakeCtx({ form: readyForm(overrides) })
  context.configForms.setServed(['pc-use'])
  module.apply(context.ctx)
  const entry = context.registrations.find((item) => item.options.name === 'settings.section')
  assert.ok(entry, 'settings.section must be registered')
  return { context, renderer: createRenderer(entry.Component) }
}

/** Fake DSH primitives: Menu records its props and renders the anchor; icon is a stub. O(1). */
function fakePrimitives({ menu = true, icon = true } = {}) {
  const calls = []
  const iconCalls = []
  const primitives = { calls, iconCalls }
  if (menu) {
    primitives.Menu = (props) => {
      calls.push(props)
      return props.anchor
    }
  }
  if (icon) {
    primitives.IconChevronDownOutlineRegular = (iconProps) => {
      iconCalls.push(iconProps)
      return { type: 'icon', props: { ...iconProps, children: [] } }
    }
  }
  return primitives
}

/** Fake `document` that records injected `<style>` elements. O(1). */
function fakeDocument() {
  const styles = []
  const document = {
    querySelector(selector) {
      const match = /^style\[data-plugin-css="(.+)"\]$/.exec(selector)
      if (match === null) return null
      return styles.find((style) => (
        style.attributes['data-plugin-css'] === match[1]
      )) ?? null
    },
    createElement(tagName) {
      return {
        tagName,
        attributes: {},
        textContent: '',
        setAttribute(name, value) {
          this.attributes[name] = value
        },
      }
    },
    head: {
      appendChild(node) {
        styles.push(node)
      },
    },
  }
  return { document, styles }
}

/** All rendered switch / input / select controls. O(n). */
function renderedControls(tree) {
  return elements(tree).filter((node) => (
    node.type === 'input' || node.type === 'select'
    || (node.type === 'button' && node.props.role === 'switch')
  ))
}

/** One fake config form with the fields the settings host exposes. O(1). */
class FakeForm {
  constructor(overrides = {}) {
    this.snapshot = {
      status: 'ready',
      value: {
        computer: false,
        desktopApprovalChoices: true,
        rememberDesktopApprovals: true,
        language: 'auto',
        autoApprove: false,
        timeoutMs: 120000,
        codexHome: '',
        logFile: '',
      },
      base: {},
      user: {},
      revision: 7,
      writable: true,
      ...overrides,
    }
    this.mutations = []
    this.listeners = []
    this.behavior = null
  }

  getSnapshot() {
    return this.snapshot
  }

  subscribe(listener) {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index >= 0) this.listeners.splice(index, 1)
    }
  }

  countSubscriptions() {
    return this.listeners.length
  }

  async mutate(ops, revision) {
    this.mutations.push({ ops, revision })
    if (this.behavior !== null) return this.behavior(ops, revision, this)
    return true
  }

  update(patch) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}

function fakeLocale() {
  const dictionaries = new Map()
  const locale = {
    language: 'zh',
    revision: 0,
    register(namespace, dictionary) {
      dictionaries.set(namespace, dictionary)
      locale.revision += 1
      return () => {
        if (dictionaries.get(namespace) !== dictionary) return
        dictionaries.delete(namespace)
        locale.revision += 1
      }
    },
    bind(namespace) {
      return (key) => dictionaries.get(namespace)?.[locale.language]?.[key] ?? key
    },
    getSnapshot() {
      return { revision: locale.revision }
    },
    subscribe() {
      return () => {}
    },
  }
  return { locale, dictionaries }
}

/** Fake configForms with the whileServed contract the real provider implements. O(1). */
function fakeConfigForms(form) {
  const configForms = {
    forms: new Map(),
    served: new Set(),
    getCalls: [],
    whileServedCalls: [],
    disposed: 0,
    sync: null,
    get(entryId) {
      this.getCalls.push(entryId)
      if (!this.forms.has(entryId)) this.forms.set(entryId, form)
      return this.forms.get(entryId)
    },
    whileServed(namespaces, register) {
      this.whileServedCalls.push([...namespaces])
      let off
      const sync = () => {
        const watched = namespaces.some((namespace) => this.served.has(namespace))
        if (watched && off === undefined) off = register(new Set(this.served))
        else if (!watched && off !== undefined) {
          off()
          off = undefined
        }
      }
      this.sync = sync
      sync()
      return () => {
        off?.()
        off = undefined
        this.disposed += 1
      }
    },
  }
  configForms.setServed = (namespaces) => {
    configForms.served = new Set(namespaces)
    if (typeof configForms.sync === 'function') configForms.sync()
  }
  return configForms
}

function fakeCtx(options = {}) {
  const effects = []
  const disposers = []
  const registrations = []
  let registered = 0
  let unregistered = 0
  const { locale } = fakeLocale()
  const configForms = fakeConfigForms(options.form ?? new FakeForm())
  const slots = {
    injected: [],
    inject(owner, callback) {
      slots.injected.push(owner)
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    register(registration, Component) {
      registered += 1
      const entry = { options: registration, Component, disposed: false }
      registrations.push(entry)
      return () => {
        unregistered += 1
        entry.disposed = true
        const index = registrations.indexOf(entry)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  }
  const ctx = {
    slots,
    locale,
    configForms,
    effect(factory) {
      effects.push(factory)
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    get() {
      return undefined
    },
  }
  return {
    ctx, registrations, configForms, locale, effects, disposers,
    counts: () => ({ registered, unregistered }),
  }
}

function readyForm(overrides = {}) {
  return new FakeForm(overrides)
}

function pageFor(form) {
  return client.internals.createPage(form)
}

test('registers the pc-use settings section after the plugin market', () => {
  const context = fakeCtx()
  context.configForms.setServed(['pc-use'])
  client.apply(context.ctx)
  const entry = context.registrations.find((item) => item.options.name === 'settings.section')
  assert.ok(entry, 'settings.section must be registered')
  assert.equal(entry.options.id, 'pc-use')
  assert.equal(typeof entry.options.order, 'number')
  assert.ok(entry.options.order > 40, 'must sort after dshmarket order 40')
  context.locale.language = 'zh'
  assert.equal(entry.options.label(), '电脑操控')
  context.locale.language = 'en'
  assert.equal(entry.options.label(), 'PC Use')
})

test('whileServed only registers while the pc-use entry is served', () => {
  const context = fakeCtx()
  client.apply(context.ctx)
  assert.equal(context.registrations.length, 0)
  assert.deepEqual(context.configForms.whileServedCalls[0], ['pc-use'])
  context.configForms.setServed(['pc-use'])
  assert.equal(context.registrations.length, 1)
  context.configForms.setServed([])
  assert.equal(context.registrations.length, 0)
  context.configForms.setServed(['another-plugin'])
  assert.equal(context.registrations.length, 0)
})

test('controls write the right keys, units and read revision', async () => {
  const form = readyForm()
  const page = pageFor(form)
  assert.equal(page.getSnapshot().status, 'ready')
  assert.equal(page.getSnapshot().revision, 7)
  await page.setToggle('computer', true)
  assert.deepEqual(form.mutations[0], {
    ops: [{ op: 'set', path: ['computer'], value: true }],
    revision: 7,
  })
  await page.setToggle('desktopApprovalChoices', false)
  await page.setToggle('rememberDesktopApprovals', false)
  await page.setToggle('autoApprove', true)
  await page.setLanguage('en')
  assert.deepEqual(form.mutations[4].ops, [{ op: 'set', path: ['language'], value: 'en' }])
  page.editText('timeoutMs', '60')
  await page.commitText('timeoutMs')
  assert.deepEqual(form.mutations[5].ops, [{ op: 'set', path: ['timeoutMs'], value: 60000 }])
  assert.equal(form.mutations[5].revision, 7)
  await page.resetField('computer')
  assert.deepEqual(form.mutations[6].ops, [{ op: 'unset', path: ['computer'] }])
  assert.equal(form.mutations[6].revision, 7)
  page.editText('codexHome', '  C:\\codex  ')
  await page.commitText('codexHome')
  assert.deepEqual(form.mutations[7].ops, [{ op: 'set', path: ['codexHome'], value: 'C:\\codex' }])
  page.editText('logFile', 'C:\\log.txt')
  await page.commitText('logFile')
  assert.deepEqual(form.mutations[8].ops, [{ op: 'set', path: ['logFile'], value: 'C:\\log.txt' }])
})

test('a timeout outside 10-3600 seconds is not saved', async () => {
  const form = readyForm()
  const page = pageFor(form)
  for (const value of ['5', '3601', 'abc', '']) {
    page.editText('timeoutMs', value)
    await page.commitText('timeoutMs')
    assert.equal(page.getSnapshot().errors.timeoutMs, 'timeoutRange', value)
  }
  assert.equal(form.mutations.length, 0)
  page.editText('timeoutMs', '3600')
  await page.commitText('timeoutMs')
  assert.equal(form.mutations.length, 1)
  assert.equal(form.mutations[0].ops[0].value, 3600000)
})

test('a revision conflict keeps the input and refreshes the display', async () => {
  const form = readyForm()
  form.behavior = async (_ops, revision, self) => {
    self.update({ revision: revision + 1, value: { ...self.snapshot.value, timeoutMs: 180000 } })
    return false
  }
  const page = pageFor(form)
  page.editText('timeoutMs', '60')
  const accepted = await page.commitText('timeoutMs')
  assert.equal(accepted, false)
  const state = page.getSnapshot()
  assert.equal(state.notice, 'conflict')
  assert.equal(state.drafts.timeoutMs, '60')
  assert.equal(state.values.timeoutMs, 180000)
  assert.equal(state.revision, 8)
})

test('a read-only form is not written and a rejected field turns read-only', async () => {
  const readOnlyForm = readyForm({ writable: false })
  const readOnlyPage = pageFor(readOnlyForm)
  assert.equal(readOnlyPage.getSnapshot().writable, false)
  await readOnlyPage.setToggle('computer', true)
  assert.equal(readOnlyForm.mutations.length, 0)
  const form = readyForm()
  form.behavior = async () => false
  const page = pageFor(form)
  await page.setToggle('computer', true)
  const state = page.getSnapshot()
  assert.equal(state.readOnly.computer, 'writeRejected')
  await page.setToggle('computer', false)
  assert.equal(form.mutations.length, 1)
})

test('a failed read shows readFailed instead of default values', () => {
  const form = readyForm({ status: 'unavailable', value: undefined, revision: undefined })
  const page = pageFor(form)
  const state = page.getSnapshot()
  assert.equal(state.status, 'failed')
  assert.equal(state.readFailed, true)
  assert.equal('timeoutMs' in state.values, false)
  assert.equal('computer' in state.values, false)
})

test('the two client dictionaries have identical keys and no empty strings', () => {
  const zh = client.copy.zh
  const en = client.copy.en
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const [key, value] of Object.entries(zh)) assert.notEqual(String(value).trim(), '', key)
  for (const [key, value] of Object.entries(en)) assert.notEqual(String(value).trim(), '', key)
})

test('disposing the page module clears every registration and subscription', () => {
  const context = fakeCtx()
  context.configForms.setServed(['pc-use'])
  client.apply(context.ctx)
  assert.equal(context.effects.length, 2)
  const counts = context.counts()
  assert.equal(counts.registered, 1)
  for (const dispose of context.disposers) dispose()
  assert.deepEqual(context.counts(), { registered: 1, unregistered: 1 })
  assert.equal(context.configForms.disposed, 1)
  const form = readyForm()
  const page = pageFor(form)
  page.mount()
  assert.equal(form.countSubscriptions(), 1)
  const unsubscribe = page.subscribe(() => {})
  unsubscribe()
  page.dispose()
  assert.equal(form.countSubscriptions(), 0)
})

test('the rendered page shows the three groups', () => {
  const { renderer } = renderSection()
  const content = renderedText(renderer.getTree())
  for (const group of ['桌面操控', '浏览器', '通用']) {
    assert.ok(content.includes(group), `missing group ${group}`)
  }
})

test('"Restore default" only appears for fields with a user override', () => {
  const untouched = renderSection()
  assert.deepEqual(rowsWithReset(untouched.renderer.getTree()), [])
  const changed = renderSection({ user: { language: 'zh', timeoutMs: 60000 } })
  assert.deepEqual(rowsWithReset(changed.renderer.getTree()).sort(), [
    'pc-use-language',
    'pc-use-timeoutMs',
  ])
})

test('a failed read renders readFailed and no controls', () => {
  const { renderer } = renderSection({
    status: 'unavailable',
    value: undefined,
    revision: undefined,
  })
  assert.ok(renderedText(renderer.getTree()).includes('读取失败'))
  assert.equal(renderedControls(renderer.getTree()).length, 0)
})

test('an out-of-range timeout shows the error and aria-invalid on the input', () => {
  const { renderer } = renderSection()
  const input = findNode(renderer.getTree(), (node) => (
    node.type === 'input' && node.props.id === 'pc-use-timeoutMs'
  ))
  assert.ok(input)
  input.props.onChange({ target: { value: '5' } })
  input.props.onBlur()
  renderer.render()
  const invalid = findNode(renderer.getTree(), (node) => (
    node.type === 'input' && node.props.id === 'pc-use-timeoutMs'
  ))
  assert.equal(invalid.props['aria-invalid'], true)
  assert.ok(renderedText(renderer.getTree()).includes('请输入 10 到 3600 之间的整数秒。'))
})

test('a read-only form disables every control', () => {
  const { renderer } = renderSection({ writable: false })
  const controls = renderedControls(renderer.getTree())
  assert.equal(controls.length > 0, true)
  for (const control of controls) assert.equal(control.props.disabled, true)
})

// Variables verified in `dsh-client-ui-theme` (the built-in settings pages use them too).
const VERIFIED_THEME_VARIABLES = new Set([
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-brand-primary',
  '--dsw-alias-switch-thumb',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-secondary',
  '--dsw-radius-md',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-interactive-bg-hover',
])

test('client.js only uses verified DSH theme variables', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  const used = new Set(source.match(/--dsw-[a-z0-9-]+/g))
  for (const variable of used) {
    assert.ok(VERIFIED_THEME_VARIABLES.has(variable), `unverified theme variable ${variable}`)
  }
})

test('open and closed switches use different colors and thumb positions', () => {
  const BASE_VALUES = {
    computer: false,
    desktopApprovalChoices: true,
    rememberDesktopApprovals: true,
    language: 'auto',
    autoApprove: false,
    timeoutMs: 120000,
    codexHome: '',
    logFile: '',
  }
  const findSwitch = (tree) => elements(tree).find((node) => (
    node.type === 'button' && node.props.role === 'switch' && node.props.id === 'pc-use-computer'
  ))
  const findThumb = (button) => button.props.children.find(
    (child) => child && child.type === 'span',
  )

  const openForm = renderSection({ value: { ...BASE_VALUES, computer: true } })
  const open = findSwitch(openForm.renderer.getTree())
  const closedForm = renderSection({ value: { ...BASE_VALUES, computer: false } })
  const closed = findSwitch(closedForm.renderer.getTree())
  const openThumb = findThumb(open)
  const closedThumb = findThumb(closed)

  assert.equal(open.props.style.background, 'var(--dsw-alias-brand-primary)')
  assert.equal(closed.props.style.background, 'var(--dsw-alias-border-l3)')
  assert.equal(openThumb.props.style.background, 'var(--dsw-alias-label-primary-foreground)')
  assert.equal(closedThumb.props.style.background, 'var(--dsw-alias-switch-thumb)')
  assert.equal(openThumb.props.style.transform, 'translateX(16px)')
  assert.equal(closedThumb.props.style.transform, 'none')
})

test('the switch and its control keep their width', () => {
  const { renderer } = renderSection()
  const tree = renderer.getTree()
  const switchButton = elements(tree).find((node) => (
    node.type === 'button' && node.props.role === 'switch' && node.props.id === 'pc-use-computer'
  ))
  assert.equal(switchButton.props.style.flex, '0 0 auto')
  assert.equal(switchButton.props.style.width, 36)

  const controlColumn = elements(tree).find((node) => (
    node.type === 'div' && Array.isArray(node.props.children)
    && node.props.children.some((child) => child && child.type === 'button'
      && child.props.id === 'pc-use-computer')
  ))
  assert.equal(controlColumn.props.style.flexShrink, 0)
})

/** The page root of a ready settings page (the only root with maxWidth 760). O(n). */
function pageRoot(tree) {
  return elements(tree).find((node) => (
    node.type === 'div' && node.props.style && node.props.style.maxWidth === 760
  ))
}

/** Every `p[role="status"]` in a rendered tree. O(n). */
function statusLines(tree) {
  return elements(tree).filter((node) => node.type === 'p' && node.props.role === 'status')
}

/** The direct parent element of the first child matching `predicate`. O(n). */
function parentOf(tree, predicate) {
  let found = null
  const walk = (node) => {
    if (found !== null) return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node === null || typeof node !== 'object') return
    const children = node.props?.children ?? []
    if (children.some((child) => child && typeof child === 'object' && predicate(child))) {
      found = node
      return
    }
    for (const child of children) walk(child)
  }
  walk(tree)
  return found
}

test('the status line sits on the title row', () => {
  const { renderer } = renderSection()
  const tree = renderer.getTree()
  const lines = statusLines(tree)
  assert.equal(lines.length, 1)
  assert.equal(renderedText(lines[0]), '')
  const title = findNode(tree, (node) => (
    node.type === 'h2' && renderedText(node).includes('电脑操控')
  ))
  assert.ok(title)
  const header = parentOf(tree, (node) => node === lines[0])
  assert.ok(header)
  assert.equal(header.props.children.some((child) => child === title), true)
  assert.equal(header.props.children.length, 2)
  assert.equal(header.props.style.display, 'flex')
  assert.equal(header.props.style.justifyContent, 'space-between')
  assert.equal(header.props.style.alignItems, 'baseline')
})

test('saving changes only the status text', async () => {
  const { renderer } = renderSection()
  const beforeTree = renderer.getTree()
  assert.equal(statusLines(beforeTree).length, 1)
  const beforeCount = pageRoot(beforeTree).props.children.length
  const switchNode = findNode(beforeTree, (node) => (
    node.type === 'button' && node.props.role === 'switch' && node.props.id === 'pc-use-computer'
  ))
  switchNode.props.onClick()
  await new Promise((done) => setTimeout(done, 0))
  renderer.render()
  const tree = renderer.getTree()
  const lines = statusLines(tree)
  assert.equal(lines.length, 1)
  assert.equal(renderedText(lines[0]), '已保存')
  assert.equal(pageRoot(tree).props.children.length, beforeCount)
  const header = parentOf(tree, (node) => node === lines[0])
  assert.ok(header)
  assert.equal(header.props.children.length, 2)
})

test('"Restore default" sits before the control', () => {
  const { renderer } = renderSection({ user: { codexHome: 'C:\\codex' } })
  const tree = renderer.getTree()
  const control = elements(tree).find((node) => (
    node.type === 'div' && Array.isArray(node.props.children)
    && node.props.children.some((child) => child && child.type === 'input'
      && child.props.id === 'pc-use-codexHome')
  ))
  assert.ok(control)
  assert.equal(control.props.style.justifyContent, 'flex-end')
  const children = control.props.children.filter(Boolean)
  assert.equal(children.length, 2)
  assert.equal(children[0].type, 'button')
  assert.equal(renderedText(children[0]).includes('恢复默认'), true)
  assert.equal(children[0].props.style.whiteSpace, 'nowrap')
  assert.equal(children[1].props.id, 'pc-use-codexHome')
})

/** The page form's default values, used when a test replaces `value`. O(1). */
const PAGE_VALUES = {
  computer: false,
  desktopApprovalChoices: true,
  rememberDesktopApprovals: true,
  language: 'auto',
  autoApprove: false,
  timeoutMs: 120000,
  codexHome: '',
  logFile: '',
}

/** The rendered control column that directly contains the element with `id`. O(n). */
function controlOf(tree, id) {
  return elements(tree).find((node) => (
    node.type === 'div' && Array.isArray(node.props.children)
    && node.props.children.some((child) => child && child.props.id === id)
  ))
}

test('switch rows have no "Restore default"', () => {
  const user = {
    computer: true,
    desktopApprovalChoices: false,
    rememberDesktopApprovals: false,
    autoApprove: true,
  }
  const { renderer } = renderSection({ user })
  const tree = renderer.getTree()
  for (const field of ['computer', 'desktopApprovalChoices', 'rememberDesktopApprovals',
    'autoApprove']) {
    const control = controlOf(tree, `pc-use-${field}`)
    assert.ok(control, field)
    const reset = elements(control).find((node) => (
      node.type === 'button' && renderedText(node).includes('恢复默认')
    ))
    assert.equal(reset, undefined, field)
    assert.equal(control.props.children.filter(Boolean).length, 1, field)
  }
})

test('select and text rows keep "Restore default" and send unset', async () => {
  const user = { language: 'zh', timeoutMs: 60000, codexHome: 'C:\\codex' }
  const { renderer, context } = renderSection({ user })
  const form = context.configForms.get('pc-use')
  const cases = [
    ['pc-use-language', 'language'],
    ['pc-use-timeoutMs', 'timeoutMs'],
    ['pc-use-codexHome', 'codexHome'],
  ]
  for (const [id, field] of cases) {
    const control = controlOf(renderer.getTree(), id)
    assert.ok(control, id)
    const reset = elements(control).find((node) => (
      node.type === 'button' && renderedText(node).includes('恢复默认')
    ))
    assert.ok(reset, id)
    reset.props.onClick()
    await new Promise((done) => setTimeout(done, 0))
    renderer.render()
    assert.deepEqual(form.mutations.at(-1).ops, [{ op: 'unset', path: [field] }], field)
  }
})

test('toggling back to the base writes unset and shows the new value', async () => {
  const { renderer, context } = renderSection({
    base: { computer: false },
    value: { ...PAGE_VALUES, computer: true },
    user: { computer: true },
  })
  const form = context.configForms.get('pc-use')
  let switchNode = findNode(renderer.getTree(), (node) => (
    node.type === 'button' && node.props.role === 'switch' && node.props.id === 'pc-use-computer'
  ))
  assert.equal(switchNode.props['aria-checked'], true)
  switchNode.props.onClick()
  await new Promise((done) => setTimeout(done, 0))
  renderer.render()
  assert.deepEqual(form.mutations[0].ops, [{ op: 'unset', path: ['computer'] }])
  switchNode = findNode(renderer.getTree(), (node) => (
    node.type === 'button' && node.props.role === 'switch' && node.props.id === 'pc-use-computer'
  ))
  assert.equal(switchNode.props['aria-checked'], false)
  assert.ok(renderedText(renderer.getTree()).includes('已保存'))
})

test('toggling to a non-base value still writes set', async () => {
  const { renderer, context } = renderSection({
    base: { computer: false },
    value: { ...PAGE_VALUES, computer: false },
  })
  const form = context.configForms.get('pc-use')
  const switchNode = findNode(renderer.getTree(), (node) => (
    node.type === 'button' && node.props.role === 'switch' && node.props.id === 'pc-use-computer'
  ))
  switchNode.props.onClick()
  await new Promise((done) => setTimeout(done, 0))
  assert.deepEqual(form.mutations[0].ops, [{ op: 'set', path: ['computer'], value: true }])
})

test('without a usable base, toggling always writes set', async () => {
  for (const base of [undefined, null, 'nonsense', {}]) {
    const { renderer, context } = renderSection({ base, value: { ...PAGE_VALUES } })
    const form = context.configForms.get('pc-use')
    const switchNode = findNode(renderer.getTree(), (node) => (
      node.type === 'button' && node.props.role === 'switch'
      && node.props.id === 'pc-use-computer'
    ))
    switchNode.props.onClick()
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(
      form.mutations[0].ops,
      [{ op: 'set', path: ['computer'], value: true }],
      String(base),
    )
  }
})

/** The three group containers: column flex boxes that directly hold an `h3`. O(n). */
function groupContainers(tree) {
  return elements(tree).filter((node) => (
    node.type === 'div'
    && node.props.style
    && node.props.style.display === 'flex'
    && node.props.style.flexDirection === 'column'
    && Array.isArray(node.props.children)
    && node.props.children.some((child) => child && child.type === 'h3')
  ))
}

/** The rows directly inside one group container. O(n). */
function rowsOfGroup(group) {
  return group.props.children.filter((child) => (
    child && child.type === 'div' && child.props.style
    && child.props.style.padding === '16px 0'
  ))
}

test('the page title and intro use the native settings sizes', () => {
  const { renderer } = renderSection()
  const tree = renderer.getTree()
  const page = pageRoot(tree)
  assert.equal(page.props.style.gap, 12)
  const title = findNode(tree, (node) => node.type === 'h2')
  assert.equal(title.props.style.fontSize, 16)
  assert.equal(title.props.style.fontWeight, 500)
  assert.equal(title.props.style.lineHeight, '24px')
  const intro = findNode(tree, (node) => node.type === 'p' && node.props.key === 'intro')
  assert.equal(intro.props.style.fontSize, 14)
  assert.equal(intro.props.style.lineHeight, '22px')
  assert.equal(intro.props.style.color, 'var(--dsw-alias-label-tertiary)')
  assert.equal(intro.props.style.margin, 0)
})

test('rows inside a group have no vertical gap', () => {
  const { renderer } = renderSection()
  const groups = groupContainers(renderer.getTree())
  assert.equal(groups.length, 3)
  for (const group of groups) {
    assert.equal(group.props.style.gap === undefined || group.props.style.gap === 0, true)
  }
})

test('the last row in each group has no divider', () => {
  const { renderer } = renderSection()
  const groups = groupContainers(renderer.getTree())
  assert.equal(groups.length, 3)
  for (const group of groups) {
    const rows = rowsOfGroup(group)
    assert.equal(rows.length > 0, true)
    for (const [index, row] of rows.entries()) {
      const border = row.props.style.borderBottom
      if (index === rows.length - 1) {
        assert.equal(border, 'none', `last row of ${group.props.key} still has a divider`)
      } else {
        assert.equal(border, '0.5px solid var(--dsw-alias-border-l2)')
      }
    }
  }
})

test('row descriptions use label-secondary and the footer stays light', () => {
  const { renderer } = renderSection()
  const tree = renderer.getTree()
  const description = findNode(tree, (node) => (
    node.type === 'p' && node.props.key === 'description'
  ))
  assert.ok(description)
  assert.equal(description.props.style.color, 'var(--dsw-alias-label-secondary)')
  assert.equal(description.props.style.lineHeight, '18px')
  assert.equal(description.props.style.margin, '4px 0 0')
  const footer = findNode(tree, (node) => node.type === 'p' && node.props.key === 'footer')
  assert.equal(footer.props.style.color, 'var(--dsw-alias-label-tertiary)')
})

test('the verified theme whitelist includes label-secondary', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  assert.equal(VERIFIED_THEME_VARIABLES.has('--dsw-alias-label-secondary'), true)
  assert.equal(source.includes('--dsw-alias-label-secondary'), true)
})

test('group headings use the native section style', () => {
  const { renderer } = renderSection()
  const groups = groupContainers(renderer.getTree())
  assert.equal(groups.length, 3)
  for (const group of groups) {
    const heading = group.props.children.find((child) => child && child.type === 'h3')
    assert.ok(heading, group.props.key)
    assert.equal(heading.props.style.margin, 0)
    assert.equal(heading.props.style.fontSize, 14)
    assert.equal(heading.props.style.fontWeight, 500)
    assert.equal(heading.props.style.lineHeight, '20px')
    assert.equal(heading.props.style.color, 'var(--dsw-alias-label-secondary)')
  }
})

test('the read-only notice has no default paragraph margin', async () => {
  const { renderer, context } = renderSection()
  const form = context.configForms.get('pc-use')
  // A refused write with an unchanged revision turns the field read-only and shows the notice.
  form.behavior = async () => false
  const switchNode = findNode(renderer.getTree(), (node) => (
    node.type === 'button' && node.props.role === 'switch' && node.props.id === 'pc-use-computer'
  ))
  switchNode.props.onClick()
  await new Promise((done) => setTimeout(done, 0))
  renderer.render()
  const readonly = findNode(renderer.getTree(), (node) => (
    node.type === 'p' && node.props.key === 'readonly'
  ))
  assert.ok(readonly)
  assert.equal(readonly.props.style.margin, 0)
})

/** The `pc-use-*` control id inside one row (the label id ends with `-label`). O(n). */
function rowControlId(row) {
  const control = row.props.children[1]
  const found = elements(control).find((node) => (
    typeof node.props?.id === 'string'
    && node.props.id.startsWith('pc-use-')
    && node.props.id.endsWith('-label') === false
    && node.props.id.endsWith('-error') === false
  ))
  return found?.props.id
}

test('the first switch row is titled differently from its group', () => {
  const { renderer, context } = renderSection()
  const zhTree = renderer.getTree()
  const zhLabel = findNode(zhTree, (node) => (
    node.type === 'label' && node.props.htmlFor === 'pc-use-computer'
  ))
  assert.equal(renderedText(zhLabel), '启用桌面操控')
  assert.ok(renderedText(zhTree).includes('桌面操控'))
  context.locale.language = 'en'
  renderer.render()
  const enLabel = findNode(renderer.getTree(), (node) => (
    node.type === 'label' && node.props.htmlFor === 'pc-use-computer'
  ))
  assert.equal(renderedText(enLabel), 'Enable desktop control')
})

test('the intro is one sentence in both languages', () => {
  const { renderer, context } = renderSection()
  const intro = (tree) => renderedText(findNode(tree, (node) => (
    node.type === 'p' && node.props.key === 'intro'
  )))
  assert.equal(intro(renderer.getTree()), '改动会立即生效。')
  context.locale.language = 'en'
  renderer.render()
  assert.equal(intro(renderer.getTree()), 'Changes apply immediately.')
})

test('the groups and their rows have the new order', () => {
  const { renderer } = renderSection()
  const groups = groupContainers(renderer.getTree())
  assert.equal(groups.length, 3)
  const headings = groups.map((group) => renderedText(
    group.props.children.find((child) => child && child.type === 'h3'),
  ))
  assert.deepEqual(headings, ['桌面操控', '浏览器', '通用'])
  const ids = groups.map((group) => rowsOfGroup(group).map(rowControlId))
  assert.deepEqual(ids, [
    ['pc-use-computer', 'pc-use-desktopApprovalChoices', 'pc-use-rememberDesktopApprovals'],
    ['pc-use-autoApprove'],
    ['pc-use-language', 'pc-use-timeoutMs', 'pc-use-codexHome', 'pc-use-logFile'],
  ])
})

test('the new last rows are the ones without a divider', () => {
  const { renderer } = renderSection()
  const groups = groupContainers(renderer.getTree())
  const findRow = (group, id) => rowsOfGroup(group).find((row) => rowControlId(row) === id)
  const border = (group, id) => findRow(group, id).props.style.borderBottom
  assert.equal(border(groups[0], 'pc-use-computer'),
    '0.5px solid var(--dsw-alias-border-l2)')
  assert.equal(border(groups[0], 'pc-use-rememberDesktopApprovals'), 'none')
  assert.equal(border(groups[2], 'pc-use-language'),
    '0.5px solid var(--dsw-alias-border-l2)')
  assert.equal(border(groups[2], 'pc-use-logFile'), 'none')
})

test('the footer keeps only the first sentence', () => {
  const { renderer, context } = renderSection()
  const footer = (tree) => renderedText(findNode(tree, (node) => (
    node.type === 'p' && node.props.key === 'footer'
  )))
  const zh = footer(renderer.getTree())
  assert.equal(zh, '启用插件请到“内置插件”或插件管理中操作。')
  assert.equal(zh.includes('cordis.patch.yml'), false)
  context.locale.language = 'en'
  renderer.render()
  const en = footer(renderer.getTree())
  assert.equal(en, 'Enable the plugin in "Built-in plugins" or the plugin manager.')
  assert.equal(en.includes('cordis.patch.yml'), false)
})

/** A section rendered with fake DSH primitives. O(n). */
function menuSection(overrides = {}) {
  const primitives = fakePrimitives()
  const { context, renderer } = renderSection(overrides, loadClient(primitives))
  return { primitives, context, renderer }
}

/** The language trigger button. O(n). */
function languageButton(tree) {
  return findNode(tree, (node) => (
    node.type === 'button' && node.props.id === 'pc-use-language'
  ))
}

test('the language row uses the official menu when primitives are available', () => {
  const { primitives, renderer } = menuSection()
  const tree = renderer.getTree()
  assert.equal(primitives.calls.length > 0, true)
  const props = primitives.calls.at(-1)
  assert.deepEqual(props.items.map((item) => item.id), ['auto', 'zh', 'en'])
  assert.equal(props.selectedId, 'auto')
  assert.equal(props.align, 'end')
  assert.equal(props.portal, true)
  const button = languageButton(tree)
  assert.ok(button)
  assert.equal(button.props['aria-haspopup'], 'menu')
  assert.equal(button.props.style.height, 36)
  assert.equal(button.props.style.borderRadius, 'var(--dsw-radius-md)')
  assert.equal(button.props.style.background, 'var(--dsw-alias-bg-module-platform)')
  assert.equal(findNode(tree, (node) => node.type === 'select'), undefined)
  assert.equal(primitives.iconCalls.length > 0, true)
  assert.equal(primitives.iconCalls.at(-1).className, 'pc-use-chevron')
})

test('the menu closes when Menu asks to close', () => {
  const { primitives, renderer } = menuSection()
  languageButton(renderer.getTree()).props.onClick()
  renderer.render()
  assert.equal(primitives.calls.at(-1).open, true)
  primitives.calls.at(-1).onClose()
  renderer.render()
  assert.equal(primitives.calls.at(-1).open, false)
  assert.equal(languageButton(renderer.getTree()).props['aria-expanded'], false)
})

test('selecting a menu item saves the language and closes the menu', async () => {
  const { primitives, context, renderer } = menuSection()
  languageButton(renderer.getTree()).props.onClick()
  renderer.render()
  assert.equal(primitives.calls.at(-1).open, true)
  const props = primitives.calls.at(-1)
  props.onSelect('en')
  await new Promise((done) => setTimeout(done, 0))
  renderer.render()
  const form = context.configForms.get('pc-use')
  assert.deepEqual(form.mutations[0].ops, [{ op: 'set', path: ['language'], value: 'en' }])
  assert.equal(primitives.calls.at(-1).open, false)
})

test('the trigger opens the menu and stays closed when the page is read-only', () => {
  const { primitives, renderer } = menuSection()
  const button = languageButton(renderer.getTree())
  button.props.onClick()
  renderer.render()
  assert.equal(primitives.calls.at(-1).open, true)
  assert.equal(languageButton(renderer.getTree()).props['aria-expanded'], true)
  const readOnly = menuSection({ writable: false })
  const disabledButton = languageButton(readOnly.renderer.getTree())
  assert.equal(disabledButton.props.disabled, true)
  disabledButton.props.onClick()
  readOnly.renderer.render()
  assert.equal(readOnly.primitives.calls.at(-1).open, false)
})

test('a primitives module without Menu falls back to the native select', () => {
  const primitives = fakePrimitives({ menu: false })
  const { renderer } = renderSection({}, loadClient(primitives))
  const select = findNode(renderer.getTree(), (node) => (
    node.type === 'select' && node.props.id === 'pc-use-language'
  ))
  assert.ok(select)
})

test('the hover style is injected only once', () => {
  const fake = fakeDocument()
  globalThis.document = fake.document
  try {
    renderSection({}, loadClient(fakePrimitives()))
    renderSection({}, loadClient(fakePrimitives()))
    assert.equal(fake.styles.length, 1)
    const style = fake.styles[0]
    assert.equal(style.attributes['data-plugin-css'], 'dsh-pc-use/settings.css')
    assert.ok(style.textContent.includes('.pc-use-selector:hover'))
    assert.ok(style.textContent.includes('--dsw-alias-interactive-bg-hover'))
    assert.ok(style.textContent.includes('.pc-use-chevron'))
    assert.ok(style.textContent.includes('flex: none'))
  } finally {
    delete globalThis.document
  }
})

test('the whitelist includes the official menu variables', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  for (const variable of [
    '--dsw-radius-md',
    '--dsw-alias-bg-module-platform',
    '--dsw-alias-interactive-bg-hover',
  ]) {
    assert.equal(VERIFIED_THEME_VARIABLES.has(variable), true)
    assert.equal(source.includes(variable), true, variable)
  }
})
