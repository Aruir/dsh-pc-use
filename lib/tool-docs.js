// r25: the plugin-owned tool descriptions, moved out of index.js byte for byte, and the
// "DSH plugin rules" text appended after documentation fetched from a Codex server. On the
// built-in path the plugin registers these exact strings; on the server-cache path it uses
// composeDescription() from lib/server-docs.js with the rule text below.
import { closeAppsNote } from './text.js'

export const BROWSER_JS_DESCRIPTION =
  'Drive the user\'s real Chrome through Codex Computer Use (cua_repl). Runs JavaScript with the ' +
  '`cua` API: `cua.listBrowsers()`, `cua.createBrowserTab("chrome", url)`, `cua.getTab(...)`, ' +
  '`cua.getState()`; tabs expose `getAXState()`, `click(index)`, `getScreenshot()`, `goto()`, ' +
  '`markDeliverable()`. Use it to open pages, read them, click and type. On the first call of a ' +
  'session run exactly one API call, then read the returned documentation and UI state. ' +
  'The code runs as one persistent REPL unit: top-level `await` is allowed, a top-level ' +
  '`return` is not; print results with `nodeRepl.write(...)` or `console.log(...)`; ' +
  'observer methods output themselves. Preferred: put known consecutive steps in one ' +
  'program; use if/loops/assertions for intermediate results and throw with an ' +
  'explanation when a check fails; at the end print only what the next decision ' +
  'needs with nodeRepl.write(...) or console.log(...). When reading values only, ' +
  'call `getAXState({ emit: false })` and print only the needed fields. Store ' +
  '`cua.createBrowserTab(...)` in `globalThis`, for example ' +
  '`globalThis.tab = await cua.createBrowserTab(...)`, so later calls and ' +
  '`pc_codex_observe` can use it. `cua.listTabs()` returns only plugin tabs; other ' +
  'user tabs are filtered out, so check your own tab by id. A plugin tab is a Chrome ' +
  'tab opened or claimed through this plugin since the current browser kernel started; ' +
  'after `pc_codex_js_reset` or a browser reconnect, earlier tabs no longer count, and ' +
  'all DSH sessions share the same plugin tabs. `cua.getTab(...)` only accepts ids of ' +
  'plugin tabs, and `cua.getState()` lists only plugin tabs. ' +
  '`browser.tabs.get` and `browser.tabs.content` follow the same rule; ' +
  '`browser.tabs.list` and `browser.tabs.selected` cover only plugin tabs. ' +
  '`browser.user.openTabs()`, `claimTab`, `getTabContext` and `browser.history()` ' +
  'are blocked by default by the `allowUserTabs` setting; only with that switch on ' +
  'can you access user tabs, and then only when the user explicitly asks. ' +
  'Browser tasks do not need `pc_codex_docs`. When the tree is available, judge UI ' +
  'state by reading values ' +
  '(button enabled, input value, selected item), not screenshots; if it is not, ' +
  'use a screenshot. After a UI-changing step, read state first and do not reuse ' +
  'old indexes or coordinates. Fallback: use `pc_codex_run_plan` when you need ' +
  'step-by-step status or automatic observation after a failure. Use ' +
  '`pc_codex_observe` to see the whole interface. To operate Windows desktop apps, ' +
  'use `pc_codex_desktop_js`.'

export const BROWSER_JS_RESET_DESCRIPTION =
  'Reset the persistent cua_repl JavaScript kernel. Bindings are discarded; '
  + 'browser tabs and apps are not closed.'

export const DESKTOP_JS_DESCRIPTION =
  'Drive Windows desktop apps through Codex Computer Use (node_repl). Runs ' +
  'JavaScript in the persistent node_repl kernel with the `sky` API: ' +
  '`const { sky } = await import("@oai/sky")`, e.g. `sky.list_windows()` or ' +
  '`sky.get_window_state({ window: { app, id } })`; the rest of the API is in ' +
  'the first-call notes. The code runs as one persistent REPL unit: top-level ' +
  '`await` is allowed, a top-level `return` is not; print results with ' +
  '`nodeRepl.write(...)` or `console.log(...)`; observer methods output ' +
  'themselves. Preferred: put known consecutive steps in one program; use ' +
  'if/loops/assertions for intermediate results and throw with an explanation when ' +
  'a check fails; at the end print only what the next decision needs with ' +
  'nodeRepl.write(...) or console.log(...). When the tree is available, judge UI ' +
  'state by reading accessibility-tree values in code (desktop: ' +
  'sky.get_window_state; button enabled, input value, selected item), not ' +
  'screenshots. Some apps return `accessibility: null` even with ' +
  '`include_text: true` (Notepad, Calculator). For those, use a screenshot: if ' +
  'this result carries one, judge from it; otherwise call `pc_codex_observe` with ' +
  '`screenshot: true`. Do not use run_plan checks to read UI values for that ' +
  'window. Do not read logs or configuration files, and do not search the disk ' +
  'for the reason; if the screenshot is not enough, stop and tell the user. After ' +
  'a UI-changing step, read state first and do not reuse old indexes or ' +
  'coordinates. Fallback: use `pc_codex_run_plan` when you need step-by-step ' +
  'status or automatic observation after a failure. Use `pc_codex_observe` for ' +
  'the whole interface. ' +
  'Use it to control Windows ' +
  'applications; for browser pages use `pc_codex_js`. Before controlling ' +
  'Windows apps, call `pc_codex_docs` for `skill`, `guidance` and ' +
  '`confirmations`; call it for `api` when you need method signatures. ' +
  closeAppsNote('en')

export const DESKTOP_JS_RESET_DESCRIPTION =
  'Reset the persistent node_repl JavaScript kernel. Bindings are discarded; '
  + 'desktop apps are not closed.'

export const DESKTOP_ADD_NODE_MODULE_DIR_DESCRIPTION =
  'Add a Node.js module directory to the persistent node_repl kernel so its ' +
  'packages can be imported. Passes `path` to Codex\'s `js_add_node_module_dir`.'

/** Rules appended to the browser server's own `js` documentation. O(1). */
export const BROWSER_JS_RULES =
  'DSH plugin rules. They add to the server documentation above and take precedence where the '
  + "two differ. In DSH, this server's `js` tool is `pc_codex_js` and its `js_reset` tool is "
  + '`pc_codex_js_reset`; the plugin sends `turn_ended` itself. `title` is required: a short '
  + 'user-facing description of what the code does. '
  + BROWSER_JS_DESCRIPTION.slice(BROWSER_JS_DESCRIPTION.indexOf(
    'The code runs as one persistent REPL unit:',
  ))

/** Rules appended to the desktop server's own `js` documentation. O(1). */
export const DESKTOP_JS_RULES =
  'DSH plugin rules. They add to the server documentation above and take precedence where the '
  + "two differ. In DSH, this server's `js` tool is `pc_codex_desktop_js` and its `js_reset` "
  + 'tool is `pc_codex_desktop_js_reset`; the plugin sends `turn_ended` itself. `title` is '
  + 'required: a short user-facing description of what the code does. Its '
  + '`js_add_node_module_dir` tool is `pc_codex_desktop_js_add_node_module_dir`. '
  + DESKTOP_JS_DESCRIPTION

/** Rules appended to the browser server's own `js_reset` documentation. O(1). */
export const BROWSER_JS_RESET_RULES =
  'In DSH, this tool is `pc_codex_js_reset`; it acts on the kernel used by `pc_codex_js`.'

/** Rules appended to the desktop server's own `js_reset` documentation. O(1). */
export const DESKTOP_JS_RESET_RULES =
  'In DSH, this tool is `pc_codex_desktop_js_reset`; it acts on the kernel used by '
  + '`pc_codex_desktop_js`.'

/** Rules appended to the desktop server's `js_add_node_module_dir` documentation. O(1). */
export const DESKTOP_ADD_NODE_MODULE_DIR_RULES =
  'In DSH, this tool is `pc_codex_desktop_js_add_node_module_dir`; it acts on the kernel '
  + 'used by `pc_codex_desktop_js`.'
