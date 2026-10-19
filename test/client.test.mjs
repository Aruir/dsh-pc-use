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

/** Render the settings section for one form object. O(n). */
function renderForm(form, module = client) {
  const context = fakeCtx({ form })
  context.configForms.setServed(['pc-use'])
  module.apply(context.ctx)
  const entry = context.registrations.find((item) => item.options.name === 'settings.section')
  assert.ok(entry, 'settings.section must be registered')
  return { context, renderer: createRenderer(entry.Component) }
}

/** Render the settings section; `module` lets a test use a client loaded with primitives. O(n). */
function renderSection(overrides = {}, module = client) {
  return renderForm(readyForm(overrides), module)
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
  await page.setToggle('rememberDesktopApprovals', false)
  await page.setToggle('autoApprove', true)
  await page.setLanguage('en')
  assert.deepEqual(form.mutations[3].ops, [{ op: 'set', path: ['language'], value: 'en' }])
  page.editText('timeoutMs', '60')
  await page.commitText('timeoutMs')
  assert.deepEqual(form.mutations[4].ops, [{ op: 'set', path: ['timeoutMs'], value: 60000 }])
  assert.equal(form.mutations[4].revision, 7)
  await page.resetField('computer')
  assert.deepEqual(form.mutations[5].ops, [{ op: 'unset', path: ['computer'] }])
  assert.equal(form.mutations[5].revision, 7)
  page.editText('codexHome', '  C:\\codex  ')
  await page.commitText('codexHome')
  assert.deepEqual(form.mutations[6].ops, [{ op: 'set', path: ['codexHome'], value: 'C:\\codex' }])
  page.editText('logFile', 'C:\\log.txt')
  await page.commitText('logFile')
  assert.deepEqual(form.mutations[7].ops, [{ op: 'set', path: ['logFile'], value: 'C:\\log.txt' }])
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

test('"Restore default" only appears when the user value differs from the base', () => {
  const untouched = renderSection()
  assert.deepEqual(rowsWithReset(untouched.renderer.getTree()), [])
  // The host writes the base value back into the profile on `unset`, so an equal user value
  // must not offer "Restore default" again.
  const atBase = renderSection({
    base: { language: 'zh', timeoutMs: 60000 },
    user: { language: 'zh', timeoutMs: 60000 },
  })
  assert.deepEqual(rowsWithReset(atBase.renderer.getTree()), [])
  const differs = renderSection({
    base: { language: 'auto', timeoutMs: 120000, codexHome: '' },
    user: { language: 'zh', timeoutMs: 60000, codexHome: 'C:\\codex' },
  })
  assert.deepEqual(rowsWithReset(differs.renderer.getTree()).sort(), [
    'pc-use-codexHome',
    'pc-use-language',
    'pc-use-timeoutMs',
  ])
  // The base may not contain the field at all; a user override still differs from it.
  const missingBase = renderSection({ base: {}, user: { logFile: 'C:\\log.txt' } })
  assert.deepEqual(rowsWithReset(missingBase.renderer.getTree()), ['pc-use-logFile'])
})

test('screenshot privacy switches appear in the general group', () => {
  const { renderer } = renderSection()
  const tree = renderer.getTree()
  for (const field of ['attachImages', 'keepImageFiles']) {
    const control = findNode(tree, (node) => (
      node.type === 'button' && node.props.role === 'switch'
      && node.props.id === `pc-use-${field}`
    ))
    assert.ok(control, `missing ${field} switch`)
  }
  const text = renderedText(tree)
  assert.match(text, /截图会发到模型服务商/)
  assert.match(text, /Files API/)
  assert.match(text, /本机 DSH 附件库/)
})

test('the allowUserTabs switch sits after autoApprove in the browser group', () => {
  const { renderer, context } = renderSection()
  const tree = renderer.getTree()
  const control = findNode(tree, (node) => (
    node.type === 'button' && node.props.role === 'switch'
    && node.props.id === 'pc-use-allowUserTabs'
  ))
  assert.ok(control, 'missing allowUserTabs switch')
  const groups = groupContainers(tree)
  assert.deepEqual(rowsOfGroup(groups[1]).map(rowControlId),
    ['pc-use-autoApprove', 'pc-use-allowUserTabs'])
  assert.equal(rowsOfGroup(groups[2]).map(rowControlId).includes('pc-use-allowUserTabs'), false)
  const text = renderedText(tree)
  assert.match(text, /允许读取用户标签页/)
  assert.match(text, /browser\.user\.openTabs/)
  assert.match(text, /cua\.getTab/)
  assert.match(text, /cua\.getState/)
  assert.match(text, /browser\.tabs\.get/)
  assert.match(text, /关闭时前四项直接报错/)
  assert.match(text, /只接受插件标签页/)
  assert.match(text, /发给模型服务商/)
  context.locale.language = 'en'
  renderer.render()
  const enText = renderedText(renderer.getTree())
  assert.match(enText, /Allow reading user tabs/)
  assert.match(enText, /cua\.getTab/)
  assert.match(enText, /cua\.getState/)
  assert.match(enText, /browser\.tabs\.content/)
  assert.match(enText, /the first four fail with an error/)
  assert.match(enText, /only accept plugin tabs/)
  assert.match(enText, /sent to the model provider/)
})

test('the two path rows point at pc_status in both languages', () => {
  const { context, renderer } = renderSection()
  const pathRow = (id) => rowsOfGroup(groupContainers(renderer.getTree())[2])
    .find((row) => rowControlId(row) === id)
  for (const id of ['pc-use-codexHome', 'pc-use-logFile']) {
    assert.match(renderedText(pathRow(id)), /pc_status/, `${id} zh`)
  }
  context.locale.language = 'en'
  renderer.render()
  for (const id of ['pc-use-codexHome', 'pc-use-logFile']) {
    assert.match(renderedText(pathRow(id)), /pc_status/, `${id} en`)
  }
})

test('a failed read renders readFailed and no controls', () => {
  const { renderer } = renderSection({
    status: 'unavailable',
    value: undefined,
    revision: undefined,
  })
  assert.ok(renderedText(renderer.getTree()).includes('读取失败'))
  assert.equal(renderedControls(renderer.getTree()).length, 0)
  assert.equal(findNode(renderer.getTree(), (node) => node.type === 'h2'), undefined)
})

test('a loading snapshot renders the skeleton page with the ready layout', () => {
  const ready = renderSection()
  const { renderer } = renderForm(loadingForm())
  const tree = renderer.getTree()
  assert.equal(pageRoot(tree).props['aria-busy'], 'true')
  assert.deepEqual(pageTextLayout(tree), pageTextLayout(ready.renderer.getTree()))
  const groups = groupContainers(tree)
  assert.equal(groups.length, 3)
  for (const group of groups) {
    assert.equal(rowsOfGroup(group).at(-1).props.style.borderBottom, 'none')
  }
  assert.equal(findNode(tree, (node) => node.type === 'button'), undefined)
  for (const control of renderedControls(tree)) assert.equal(control.props.disabled, true)
  const placeholders = skeletonPlaceholders(tree)
  assert.equal(placeholders.length, 11)
  for (const placeholder of placeholders) {
    assert.equal(placeholder.props['aria-hidden'], 'true')
  }
  const switches = placeholders.filter((node) => node.props.style?.width === 36)
  assert.equal(switches.length, 7)
  for (const node of switches) {
    assert.equal(node.props.style.height, 20)
    assert.equal(node.props.style.boxSizing, 'border-box')
    assert.equal(node.props.style.borderRadius, 999)
    assert.equal(node.props.style.flex, '0 0 auto')
    assert.equal(node.props.style.background, 'var(--dsw-alias-bg-skeleton)')
  }
  const inputs = placeholders.filter((node) => node.type === 'input')
  assert.equal(inputs.length, 3)
  for (const input of inputs) {
    assert.equal(input.props.type, 'text')
    assert.equal(input.props.readOnly, true)
    assert.equal(input.props.disabled, true)
    assert.equal(input.props.value, '')
    assert.equal(input.props.placeholder, undefined)
    assert.equal(input.props.style.background, 'var(--dsw-alias-bg-skeleton)')
    assert.equal(input.props.style.borderColor, 'transparent')
    assert.equal(input.props.style.minWidth, 160)
  }
  const select = placeholders.find((node) => node.type === 'select')
  assert.ok(select)
  assert.equal(select.props.value, 'auto')
  assert.equal(select.props.disabled, true)
  assert.equal(select.props.children.length, 3)
  assert.equal(select.props.style.background, 'var(--dsw-alias-bg-skeleton)')
  assert.equal(select.props.style.color, 'transparent')
  const status = statusLines(tree)[0]
  assert.equal(renderedText(status), '正在读取设置…')
  assert.equal(status.props.style.position, 'absolute')
  assert.doesNotMatch(renderedText(tree), /读取失败/)
})

test('unavailable, unknown, throwing and invalid-ready snapshots show readFailed', () => {
  const throwing = readyForm({ value: undefined })
  throwing.getSnapshot = () => {
    throw new Error('snapshot boom')
  }
  const cases = [
    ['unavailable', readyForm({ status: 'unavailable', value: undefined, revision: undefined })],
    ['unknown', readyForm({ status: 'weird', value: undefined, revision: undefined })],
    ['throw', throwing],
    ['ready null', readyForm({ value: null })],
  ]
  for (const [name, form] of cases) {
    const { renderer } = renderForm(form)
    const tree = renderer.getTree()
    assert.ok(renderedText(tree).includes('读取失败'), name)
    assert.equal(renderedControls(tree).length, 0, name)
    assert.equal(skeletonPlaceholders(tree).length, 0, name)
  }
})

test('loading becomes ready without aria-busy or a skeleton', () => {
  const form = loadingForm()
  const { renderer } = renderForm(form)
  assert.equal(pageRoot(renderer.getTree()).props['aria-busy'], 'true')
  form.update({
    status: 'ready',
    value: { ...PAGE_VALUES },
    base: {},
    user: {},
    revision: 7,
    writable: true,
  })
  renderer.render()
  const tree = renderer.getTree()
  assert.equal(pageRoot(tree).props['aria-busy'], undefined)
  assert.equal(skeletonPlaceholders(tree).length, 0)
  assert.equal(renderedText(tree).includes('正在读取设置'), false)
  const controls = renderedControls(tree)
  assert.equal(controls.length > 0, true)
  assert.equal(controls.some((control) => control.props.disabled !== true), true)
})

test('a form that is already ready renders the full page on the first render', () => {
  const form = readyForm()
  const page = pageFor(form)
  assert.equal(page.getSnapshot().status, 'ready')
  const { renderer } = renderForm(form)
  const tree = renderer.getTree()
  assert.equal(pageRoot(tree).props['aria-busy'], undefined)
  assert.equal(skeletonPlaceholders(tree).length, 0)
  assert.equal(renderedText(tree).includes('正在读取设置'), false)
  assert.ok(findNode(tree, (node) => (
    node.type === 'button' && node.props.role === 'switch'
  )))
})

test('ready back to loading clears old values and shows the skeleton', () => {
  const form = readyForm({ value: { ...PAGE_VALUES, language: 'en', codexHome: 'C:\\old' } })
  const { renderer } = renderForm(form)
  assert.equal(renderedText(renderer.getTree()).includes('Desktop control'), true)
  form.update({
    status: 'loading',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
  })
  renderer.render()
  const tree = renderer.getTree()
  assert.equal(pageRoot(tree).props['aria-busy'], 'true')
  assert.equal(skeletonPlaceholders(tree).length, 11)
  assert.equal(renderedText(tree).includes('C:\\old'), false)
  for (const control of renderedControls(tree)) {
    if (control.type === 'input') assert.equal(control.props.value, '')
    if (control.type === 'select') assert.equal(control.props.value, 'auto')
  }
  assert.equal(pageTextLayout(tree)[0].heading, '桌面操控')
  assert.equal(renderedText(statusLines(tree)[0]), '正在读取设置…')
})

test('the skeleton page keeps the ready page row ids', () => {
  const loadingTree = renderForm(loadingForm()).renderer.getTree()
  const readyTree = renderSection().renderer.getTree()
  const ids = labelForIds(loadingTree)
  assert.deepEqual(ids, labelForIds(readyTree))
  assert.deepEqual(ids, [
    'pc-use-computer', 'pc-use-rememberDesktopApprovals',
    'pc-use-autoApprove', 'pc-use-allowUserTabs',
    'pc-use-language', 'pc-use-timeoutMs', 'pc-use-attachImages',
    'pc-use-keepImageFiles', 'pc-use-prefetchServerDocs', 'pc-use-codexHome',
    'pc-use-logFile',
  ])
})

test('skeleton placeholders have no handlers and never write', () => {
  const form = loadingForm()
  const { renderer, context } = renderForm(form)
  const placeholders = skeletonPlaceholders(renderer.getTree())
  assert.equal(placeholders.length, 11)
  for (const node of placeholders) {
    for (const handler of ['onClick', 'onChange', 'onBlur', 'onKeyDown', 'onCommit']) {
      assert.equal(node.props[handler], undefined, `${node.type} ${handler}`)
    }
    assert.equal(node.props.tabIndex !== undefined && node.props.tabIndex >= 0, false)
  }
  assert.equal(context.configForms.get('pc-use').mutations.length, 0)
})

test('loading with Menu primitives keeps a menu-shaped language placeholder', () => {
  const { renderer } = renderForm(loadingForm(), loadClient(fakePrimitives()))
  const tree = renderer.getTree()
  const placeholder = skeletonPlaceholders(tree).find((node) => (
    node.type === 'span'
    && node.props.style?.display === 'inline-flex'
    && node.props.style?.position === 'relative'
  ))
  assert.ok(placeholder)
  assert.equal(placeholder.props['aria-hidden'], 'true')
  const inner = elements(placeholder).find((node) => node.props?.style?.height === 36)
  assert.ok(inner)
  assert.equal(inner.props.style.padding, '0 14px')
  assert.equal(inner.props.style.color, 'transparent')
  assert.ok(renderedText(inner).includes('跟随 DSH 界面语言'))
  const icon = elements(inner).find((node) => node.type === 'icon')
  assert.ok(icon)
  assert.equal(icon.props.className, 'pc-use-chevron')
  const iconWrap = parentOf(inner, (node) => node.type === 'icon')
  assert.equal(iconWrap.props.style.visibility, 'hidden')
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
  '--dsw-alias-bg-skeleton',
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

/** The skeleton-filled placeholders of the loading page, in render order. O(n). */
function skeletonPlaceholders(tree) {
  return elements(tree).filter((node) => (
    typeof node.props?.className === 'string'
    && node.props.className.split(' ').includes('pc-use-skeleton')
  ))
}

/** Row ids as exposed by their labels, in render order. O(n). */
function labelForIds(tree) {
  return elements(tree)
    .filter((node) => node.type === 'label')
    .map((node) => node.props.htmlFor)
}

/** Group headings plus every row's label and description, in render order. O(n). */
function pageTextLayout(tree) {
  return groupContainers(tree).map((group) => ({
    heading: renderedText(group.props.children.find((child) => child && child.type === 'h3')),
    rows: rowsOfGroup(group).map((row) => {
      const [label, description] = row.props.children[0].props.children
      return { label: renderedText(label), description: renderedText(description) }
    }),
  }))
}

/** A form whose first snapshot is the Host's initial loading state. O(1). */
function loadingForm() {
  return readyForm({
    status: 'loading',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
  })
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

test('the saved status is only exposed to screen readers', async () => {
  const { renderer, context } = renderSection()
  let tree = renderer.getTree()
  let lines = statusLines(tree)
  assert.equal(lines.length, 1)
  assert.equal(renderedText(lines[0]), '')
  assert.equal(lines[0].props.style.position, 'absolute')
  assert.equal(lines[0].props.style.clip, 'rect(0 0 0 0)')
  const switchNode = findNode(tree, (node) => (
    node.type === 'button' && node.props.role === 'switch' && node.props.id === 'pc-use-computer'
  ))
  switchNode.props.onClick()
  await new Promise((done) => setTimeout(done, 0))
  renderer.render()
  tree = renderer.getTree()
  lines = statusLines(tree)
  assert.equal(lines.length, 1)
  assert.equal(renderedText(lines[0]), '已保存')
  assert.equal(lines[0].props.style.clip, 'rect(0 0 0 0)')
  const visibleSaved = elements(tree).filter((node) => (
    node !== lines[0] && node.type === 'p' && renderedText(node) === '已保存'
  ))
  assert.equal(visibleSaved.length, 0)
  context.locale.language = 'en'
  renderer.render()
  assert.equal(renderedText(statusLines(renderer.getTree())[0]), 'Saved')
})

test('the page has no title or intro in either language', () => {
  const { renderer, context } = renderSection()
  const check = (tree) => {
    assert.equal(findNode(tree, (node) => node.type === 'h2'), undefined)
    assert.equal(findNode(tree, (node) => (
      node.type === 'p' && node.props.key === 'intro'
    )), undefined)
  }
  check(renderer.getTree())
  context.locale.language = 'en'
  renderer.render()
  check(renderer.getTree())
  const failed = renderSection({
    status: 'unavailable',
    value: undefined,
    revision: undefined,
  })
  assert.ok(renderedText(failed.renderer.getTree()).includes('读取失败'))
  check(failed.renderer.getTree())
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
  rememberDesktopApprovals: true,
  language: 'auto',
  autoApprove: false,
  timeoutMs: 120000,
  allowUserTabs: false,
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
    rememberDesktopApprovals: false,
    autoApprove: true,
  }
  const { renderer } = renderSection({ user })
  const tree = renderer.getTree()
  for (const field of ['computer', 'rememberDesktopApprovals', 'autoApprove']) {
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

test('the page starts with the desktop group', () => {
  const { renderer } = renderSection()
  const page = pageRoot(renderer.getTree())
  const visible = page.props.children.filter((child) => (
    child && child.props.role !== 'status' && child.props.key !== 'conflict'
  ))
  assert.equal(visible[0].props.key, 'group-desktop')
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

test('a conflict shows a visible notice before the desktop group', async () => {
  const { renderer, context } = renderSection()
  const form = context.configForms.get('pc-use')
  form.behavior = async (_ops, revision, self) => {
    self.update({ revision: revision + 1 })
    return false
  }
  const switchNode = findNode(renderer.getTree(), (node) => (
    node.type === 'button' && node.props.role === 'switch' && node.props.id === 'pc-use-computer'
  ))
  switchNode.props.onClick()
  await new Promise((done) => setTimeout(done, 0))
  renderer.render()
  const tree = renderer.getTree()
  const conflict = findNode(tree, (node) => (
    node.type === 'p' && node.props.role !== 'status'
    && renderedText(node) === '设置已被其他地方修改，已载入最新值'
  ))
  assert.ok(conflict)
  assert.equal(conflict.props.style.position, undefined)
  const page = pageRoot(tree)
  const conflictIndex = page.props.children.findIndex((child) => child === conflict)
  const groupIndex = page.props.children.findIndex((child) => child?.props.key === 'group-desktop')
  assert.equal(conflictIndex >= 0, true)
  assert.equal(conflictIndex < groupIndex, true)
})

test('the browser group lists allowUserTabs right after autoApprove', () => {
  const { renderer } = renderSection()
  const groups = groupContainers(renderer.getTree())
  assert.equal(groups.length, 3)
  const headings = groups.map((group) => renderedText(
    group.props.children.find((child) => child && child.type === 'h3'),
  ))
  assert.deepEqual(headings, ['桌面操控', '浏览器', '通用'])
  const ids = groups.map((group) => rowsOfGroup(group).map(rowControlId))
  assert.deepEqual(ids, [
    ['pc-use-computer', 'pc-use-rememberDesktopApprovals'],
    ['pc-use-autoApprove', 'pc-use-allowUserTabs'],
    ['pc-use-language', 'pc-use-timeoutMs', 'pc-use-attachImages',
      'pc-use-keepImageFiles', 'pc-use-prefetchServerDocs', 'pc-use-codexHome',
      'pc-use-logFile'],
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
    assert.ok(style.textContent.includes('.pc-use-skeleton {'))
    assert.ok(style.textContent.includes('@keyframes pc-use-skeleton'))
    assert.ok(style.textContent.includes('prefers-reduced-motion: reduce'))
    assert.ok(style.textContent.includes('animation: none'))
  } finally {
    delete globalThis.document
  }
})

test('the loading page injects the skeleton styles once', () => {
  const fake = fakeDocument()
  globalThis.document = fake.document
  try {
    renderForm(loadingForm())
    renderForm(loadingForm())
    assert.equal(fake.styles.length, 1)
    assert.ok(fake.styles[0].textContent.includes('.pc-use-skeleton {'))
    assert.ok(fake.styles[0].textContent.includes('80%, 100% { opacity: 1; }'))
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

test('the desktop group has no three-option card row', () => {
  const { renderer } = renderSection({
    value: { ...PAGE_VALUES, desktopApprovalChoices: true },
  })
  const tree = renderer.getTree()
  const groups = groupContainers(tree)
  assert.equal(groups.length, 3)
  const ids = rowsOfGroup(groups[0]).map(rowControlId)
  assert.deepEqual(ids, ['pc-use-computer', 'pc-use-rememberDesktopApprovals'])
  const removed = elements(tree).find((node) => (
    node.props?.id === 'pc-use-desktopApprovalChoices'
  ))
  assert.equal(removed, undefined)
  const last = rowsOfGroup(groups[0]).at(-1)
  assert.equal(last.props.style.borderBottom, 'none')
})

/** The rendered text of one row label, e.g. 'pc-use-computer'. O(n). */
function rowLabel(tree, id) {
  const label = findNode(tree, (node) => (
    node.type === 'label' && node.props.htmlFor === id
  ))
  return label === undefined ? undefined : renderedText(label)
}

/** The rendered label of a native language `<option>`. O(n). */
function optionLabel(tree, value) {
  const option = findNode(tree, (node) => (
    node.type === 'option' && node.props.value === value
  ))
  return option === undefined ? undefined : renderedText(option)
}

test('the page follows the language setting over the DSH interface language', () => {
  const cases = [
    { setting: 'en', dsh: 'zh', expected: 'Enable desktop control' },
    { setting: 'zh', dsh: 'en', expected: '启用桌面操控' },
  ]
  for (const { setting, dsh, expected } of cases) {
    const { renderer, context } = renderSection({
      value: { ...PAGE_VALUES, language: setting },
    })
    context.locale.language = dsh
    renderer.render()
    assert.equal(rowLabel(renderer.getTree(), 'pc-use-computer'), expected, setting)
  }
})

test('"auto" follows the DSH interface language', () => {
  const { renderer, context } = renderSection()
  context.locale.language = 'zh'
  renderer.render()
  assert.equal(rowLabel(renderer.getTree(), 'pc-use-computer'), '启用桌面操控')
  context.locale.language = 'en'
  renderer.render()
  assert.equal(rowLabel(renderer.getTree(), 'pc-use-computer'), 'Enable desktop control')
})

test('changing the language on an open page switches the text immediately', async () => {
  const { renderer, context } = renderSection()
  context.locale.language = 'zh'
  renderer.render()
  const select = findNode(renderer.getTree(), (node) => (
    node.type === 'select' && node.props.id === 'pc-use-language'
  ))
  assert.ok(select)
  select.props.onChange({ target: { value: 'en' } })
  await new Promise((done) => setTimeout(done, 0))
  renderer.render()
  assert.equal(rowLabel(renderer.getTree(), 'pc-use-computer'), 'Enable desktop control')
  assert.ok(renderedText(renderer.getTree()).includes('General'))
  assert.equal(context.locale.language, 'zh', 'the DSH locale must not change')
  const changed = findNode(renderer.getTree(), (node) => (
    node.type === 'select' && node.props.id === 'pc-use-language'
  ))
  changed.props.onChange({ target: { value: 'zh' } })
  await new Promise((done) => setTimeout(done, 0))
  renderer.render()
  assert.equal(rowLabel(renderer.getTree(), 'pc-use-computer'), '启用桌面操控')
  // The production path uses the official menu; selecting there must switch the text too.
  const menu = menuSection()
  menu.context.locale.language = 'zh'
  menu.renderer.render()
  languageButton(menu.renderer.getTree()).props.onClick()
  menu.renderer.render()
  menu.primitives.calls.at(-1).onSelect('en')
  await new Promise((done) => setTimeout(done, 0))
  menu.renderer.render()
  assert.equal(rowLabel(menu.renderer.getTree(), 'pc-use-computer'), 'Enable desktop control')
})

test('the "auto" option names the DSH interface language in both dictionaries', () => {
  assert.equal(client.copy.zh.languageAuto, '跟随 DSH 界面语言')
  assert.equal(client.copy.en.languageAuto, 'Follow DSH interface language')
  assert.ok(client.copy.zh.languageDescription.includes('DSH 界面语言'))
  assert.ok(client.copy.en.languageDescription.includes('DSH interface language'))
  const zhPage = renderSection()
  assert.equal(optionLabel(zhPage.renderer.getTree(), 'auto'), '跟随 DSH 界面语言')
  const enPage = renderSection({ value: { ...PAGE_VALUES, language: 'en' } })
  assert.equal(optionLabel(enPage.renderer.getTree(), 'auto'), 'Follow DSH interface language')
})

test('clearing a text field submits unset instead of an empty string', async () => {
  const form = readyForm()
  const page = pageFor(form)
  page.editText('codexHome', '   ')
  await page.commitText('codexHome')
  assert.deepEqual(form.mutations.at(-1).ops, [{ op: 'unset', path: ['codexHome'] }])
  page.editText('logFile', '')
  await page.commitText('logFile')
  assert.deepEqual(form.mutations.at(-1).ops, [{ op: 'unset', path: ['logFile'] }])
  page.editText('codexHome', 'C:\\codex')
  await page.commitText('codexHome')
  assert.deepEqual(form.mutations.at(-1).ops, [
    { op: 'set', path: ['codexHome'], value: 'C:\\codex' },
  ])
})

test('blurring an emptied text input writes unset through the page', async () => {
  const { renderer, context } = renderSection()
  const input = findNode(renderer.getTree(), (node) => (
    node.type === 'input' && node.props.id === 'pc-use-logFile'
  ))
  input.props.onChange({ target: { value: '   ' } })
  renderer.render()
  const draft = findNode(renderer.getTree(), (node) => (
    node.type === 'input' && node.props.id === 'pc-use-logFile'
  ))
  draft.props.onBlur()
  await new Promise((done) => setTimeout(done, 0))
  const form = context.configForms.get('pc-use')
  assert.deepEqual(form.mutations.at(-1).ops, [{ op: 'unset', path: ['logFile'] }])
})
