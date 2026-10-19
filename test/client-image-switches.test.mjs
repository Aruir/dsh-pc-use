// r22: the settings page must show the real state of the two image switches. FIELDS used to
// omit attachImages and keepImageFiles, so both always rendered as off after a refresh.
// The helpers below are copied from test/client.test.mjs so that file stays unchanged.
import assert from 'node:assert/strict'
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

function findNode(tree, predicate) {
  return elements(tree).find(predicate)
}

/** One fake config form with the fields the settings host exposes. O(1). */
class FakeForm {
  constructor(overrides = {}) {
    this.snapshot = {
      status: 'ready',
      value: {
        computer: false,
        rememberDesktopApprovals: true,
        language: 'auto',
        autoApprove: false,
        timeoutMs: 120000,
        allowUserTabs: false,
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

/** Render the settings section for one form object. O(n). */
function renderForm(form, module = client) {
  const context = fakeCtx({ form })
  context.configForms.setServed(['pc-use'])
  module.apply(context.ctx)
  const entry = context.registrations.find((item) => item.options.name === 'settings.section')
  assert.ok(entry, 'settings.section must be registered')
  return { context, renderer: createRenderer(entry.Component) }
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

/** Render the settings section for one form snapshot. O(n). */
function renderSection(overrides = {}) {
  return renderForm(readyForm(overrides))
}

const PAGE_VALUES = {
  computer: false,
  rememberDesktopApprovals: true,
  language: 'auto',
  autoApprove: false,
  timeoutMs: 120000,
  allowUserTabs: false,
  attachImages: true,
  keepImageFiles: false,
  codexHome: '',
  logFile: '',
}

/** The rendered switch for one settings field, or undefined. O(n). */
function switchOf(tree, field) {
  return findNode(tree, (node) => (
    node.type === 'button' && node.props.role === 'switch'
    && node.props.id === `pc-use-${field}`
  ))
}

/** The switch's on/off state as the page renders it. O(n). */
function switchValue(tree, field) {
  const node = switchOf(tree, field)
  assert.ok(node, `missing switch for ${field}`)
  return node.props['aria-checked']
}

test('both image switches show their true snapshot values', () => {
  const { renderer } = renderSection({
    value: { ...PAGE_VALUES, attachImages: true, keepImageFiles: true },
  })
  const tree = renderer.getTree()
  assert.equal(switchValue(tree, 'attachImages'), true)
  assert.equal(switchValue(tree, 'keepImageFiles'), true)
})

test('both image switches show off when the snapshot has false', () => {
  const { renderer } = renderSection({
    value: { ...PAGE_VALUES, attachImages: false, keepImageFiles: false },
  })
  const tree = renderer.getTree()
  assert.equal(switchValue(tree, 'attachImages'), false)
  assert.equal(switchValue(tree, 'keepImageFiles'), false)
})

test('a switch keeps the written value after the next form refresh', async () => {
  const { renderer, context } = renderSection({
    value: { ...PAGE_VALUES, attachImages: false },
  })
  const form = context.configForms.get('pc-use')
  assert.equal(switchValue(renderer.getTree(), 'attachImages'), false)
  switchOf(renderer.getTree(), 'attachImages').props.onClick()
  await new Promise((done) => setTimeout(done, 0))
  renderer.render()
  assert.deepEqual(form.mutations.at(-1).ops,
    [{ op: 'set', path: ['attachImages'], value: true }])
  assert.equal(switchValue(renderer.getTree(), 'attachImages'), true)
  // The Host answered the write; its next snapshot carries the new value and notifies listeners.
  form.update({ value: { ...PAGE_VALUES, attachImages: true } })
  renderer.render()
  assert.equal(switchValue(renderer.getTree(), 'attachImages'), true)
})
