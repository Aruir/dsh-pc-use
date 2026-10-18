// Standalone smoke test: apply the plugin against a fake cordis context and drive
// Codex Computer Use through the registered tools. Run: node test/smoke.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-pc-use-'))
const logFile = join(stateDir, 'bridge.log')
const stateFile = join(stateDir, 'state.json')
const tools = new Map()
const disposers = []

const ctx = {
  tools: {
    register(tool) {
      if (tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered in this scope`)
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
  },
  effect(factory) {
    disposers.push(factory())
  },
}

apply(ctx, { autoApprove: true, logFile, stateFile })

console.log('registered tools:', [...tools.keys()].join(', '))
if (tools.size === 0) {
  console.error('FAIL: no tools registered')
  process.exit(1)
}

const status = tools.get('pc_status')
console.log('\n--- pc_status ---')
console.log(await status.execute({}, {}))

const js = tools.get('pc_codex_js')
console.log('\n--- pc_codex_js: listBrowsers ---')
const listing = await js.execute({ code: 'await cua.listBrowsers();', title: 'list browsers' }, {})
console.log(listing.slice(0, 1500))

console.log('\n--- pc_codex_js: open bilibili ---')
const opened = await js.execute({
  code: 'let smkTab = await cua.createBrowserTab("chrome", "https://www.bilibili.com", { sessionName: "🧪 smoke" });',
  title: 'open bilibili',
  timeout_ms: 60000,
}, {})
console.log(opened.slice(0, 1200))

console.log('\n--- pc_codex_js: screenshot the tab ---')
const shot = await js.execute({
  code: 'await smkTab.getScreenshot();',
  title: 'screenshot bilibili',
  timeout_ms: 60000,
}, {})
console.log(shot.slice(0, 400))

console.log(`\nlog: ${logFile}`)
for (const dispose of disposers) dispose()
