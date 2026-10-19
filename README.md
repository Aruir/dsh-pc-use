# dsh-pc-use

English | [中文](README.zh.md)

This plugin turns **Codex Computer Use** into native DeepSeek Harness tools. It uses the local Codex
app to drive the real Chrome through the browser server (`cua_repl`) and Windows desktop apps
through the desktop server (`node_repl`), without manual MCP configuration. The current Computer Use
provider is Codex; other providers will be added later (see "Providers"). Screenshots and page
contents are sent to the model provider.

## Purpose

Codex provides two computer-use servers: `cua_repl` for the browser and `node_repl` for desktop
apps. Both servers depend on three behaviors that only the Codex client implements, so a standard
MCP client cannot connect to them:

1. every `tools/call` request must carry `_meta["x-codex-turn-metadata"]`, or the server rejects it;
2. `initialize` must advertise the `elicitation` capability, or browser and app approval requests
   cannot be sent;
3. the plugin must answer the `elicitation/create` approval requests that the server sends back, or
   the server reports `The approval request did not return a valid decision`.

Codex also rewrites the `codex-computer-use-<GUID>` pipe name and the runtime hash on every restart.
A hard-coded configuration therefore always becomes stale.

The plugin implements all of these behaviors (`lib/mcp-bridge.js` + `lib/codex-config.js`) and
re-reads the source of each server before use. The launch environment is passed through unchanged:
the browser server receives the values from `.mcp.json`, and the desktop server receives the values
from `config.toml`, in the same way that the Codex app starts them.

`initialize` matches native Codex: protocol version `2025-06-18`, with both `form` and `url`
elicitation capabilities. The plugin has no interface for opening a URL for the user, so it always
declines `url`-mode requests; `clientInfo` remains `dsh-pc-use` with the plugin version.

## Prerequisites

- The Codex desktop app must be running; both servers connect to its native pipes.
- The Chrome extension must be connected, so that `await cua.listBrowsers()` inside `pc_codex_js`
  lists `Chrome / type=extension`.
- `<codexHome>/config.toml` must contain an `[mcp_servers.node_repl]` section for desktop control.
  If the section is missing, only the desktop tools fail, and the error names the section.
- Only Windows has been verified; Codex's Computer Use uses the `sky` native pipe on Windows.

## Installation

Use the official flow ([packaging and installing plugins](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)): the package declares `dsh.bundle`, so installing it into a profile with `dsh plugin` is sufficient.

```powershell
dsh plugin --profile desktop add C:\Users\<you>\...\plugins\dsh-pc-use
```

`dsh plugin add` writes the package into the `dependencies` of the profile and appends it to
`dsh.profile.bundles`; the `cordis.patch.yml` of the bundle inserts the `pc-use` row.

Uninstall:

```powershell
dsh plugin --profile desktop remove dsh-pc-use
```

### Changing the configuration without a second insert

The bundle layer already inserts `pc-use`. In the `cordis.patch.yml` of the profile, the plugin
**can only be overridden by id**; it must not be inserted again by using `insert`. Two rows with
the same id make the loader fail, and the plugin then disappears without an error:

```yaml
- id: pc-use
  config:
    autoApprove: true   # only browser access is auto-accepted; other approvals still decline and are logged
    logFile: 'C:\Users\<you>\.dsh\pc-use.log'
    # Note: a patch replaces the whole config block, it does not deep-merge; omitted keys fall back to the defaults above
```

`dsh --profile desktop --dump-config` is rejected on Electron-hosted profiles; the desktop plugin
panel is used instead to check the layer order.

## Configuration

All fields are optional and belong in the `config:` block of `cordis.patch.yml`.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` registers no tools |
| `autoApprove` | `false` | Only browser-access approval requests are accepted automatically; other elicitation requests are declined (fail-closed) |
| `computer` | `false` | Enable Windows desktop app control (Codex Computer Use); DSH's permission mode decides whether a card appears |
| `rememberDesktopApprovals` | `true` | Within one DSH session, an app that the user allowed once is not asked about again; denials are not remembered |
| `language` | `'auto'` | Language of the plugin interface text: `auto` follows the DSH interface language, or the value forces `zh` / `en` |
| `codexHome` | `''` | An empty value means `%USERPROFILE%\.codex` |
| `logFile` | `''` | Bridge log path; an empty value means `~/.dsh/pc-use.log` |
| `timeoutMs` | `120000` | Timeout for one tool call |
| `attachImages` | `true` | Attach screenshots as images when the model declares image input; screenshots go to the model provider, the default Files API upload of DSH expires after 7 days and is not deleted at DSH session end, and the DSH attachment store keeps a local copy; turn it off to avoid uploads |
| `keepImageFiles` | `false` | Also keep attached images under `~/.dsh/pc-use-images`; by default only the DSH attachment store keeps them |
| `allowUserTabs` | `false` | Allow reading the tabs and history of the user; the covered entrances are listed below |
| `prefetchServerDocs` | `true` | Prefetch server docs when the cache is stale; next start |
| `tools` | all on | Per-tool switches: `{ js, reset, desktopJs, desktopReset, desktopAddNodeModuleDir, observe, runPlan, docs, status }` |
| `tools.desktopJs` | `true` | Register `pc_codex_desktop_js`: run JS in the desktop `node_repl` (needs `computer: true`) |
| `tools.desktopReset` | `true` | Register `pc_codex_desktop_js_reset`: reset the desktop JS kernel |
| `tools.desktopAddNodeModuleDir` | `true` | Register `pc_codex_desktop_js_add_node_module_dir`: add a Node module directory to the desktop `node_repl` |
| `tools.observe` | `true` | Register `pc_codex_observe`: output the complete accessibility tree; routine checks read values in code |
| `tools.runPlan` | `true` | Register `pc_codex_run_plan`: fallback for step-by-step status or automatic observation after a failure |
| `tools.docs` | `true` | Register `pc_codex_docs`: read the Computer Use docs bundled with Codex (no Codex connection needed) |

`prefetchServerDocs` connects to the Codex servers in the background at DSH start only when
the cached tool documentation is missing or out of date; like the settings page switch, it is
read once at startup, so a change takes effect at the next DSH start.

`allowUserTabs` governs `browser.user.openTabs`, `browser.user.claimTab`,
`browser.user.getTabContext`, `browser.history`, `cua.getTab`, `cua.getState`,
`browser.tabs.get` and `browser.tabs.content`. While it is off, the first four calls fail with an
explanatory error; `cua.getTab`, `browser.tabs.get` and `browser.tabs.content` only accept plugin
tabs; `cua.getState` lists only plugin tabs. `browser.tabs.list` and `browser.tabs.selected` only
see plugin tabs and pass through. A plugin tab is a Chrome tab opened or claimed through this
plugin since the current browser kernel started; after `pc_codex_js_reset` or a browser reconnect,
earlier tabs no longer count. All DSH sessions share the same plugin tabs. While `allowUserTabs`
is on, tab titles, URLs, page content and history are sent to the model provider, so it is enabled
only when the user has asked for that.

`autoApprove` / `computer` / `rememberDesktopApprovals` / `language` /
`codexHome` / `logFile` / `timeoutMs` / `attachImages` / `keepImageFiles` /
`allowUserTabs` are hot-updatable (volatile): a change applies to later calls
without remounting the plugin. The loader announces volatile writes, so turning `computer` off
stops the desktop server immediately and leaves the browser connection alone; turning it on starts
the desktop server on the next desktop call. After `codexHome` changes, both servers re-resolve and
reconnect on their next call. `enabled` and `tools.*` are not volatile;
changing one remounts the plugin and registers the tools again for the new configuration. The three
desktop switches default to `true` and are not on the settings page.

`language` affects only the text that the plugin displays: the Chinese and English sets of the
three-option card, the `displayReason` of the one-shot card and the audit `reason`. `auto` first
tries to read the interface-language preference that the DSH host exposes and falls back to the
system language (`zh` prefix means Chinese, otherwise English); the value can also force `zh` /
`en`. The `displayReason` of the one-shot approval card carries both Chinese and English text, and
the DSH client selects the text that matches its interface language regardless of `language`.

Every approval is written to the log (when `logFile` is empty, into `~/.dsh/pc-use.log`; it no
longer only goes to `console.warn`). The log records the original wording, the decision and the
reason, for example:

```
approval "Allow Browser use to access https://www.bilibili.com?" -> accept (browser access auto-approved)
```

- `autoApprove: false` (default): browser approval requests are always declined, with reason
  `auto-approve is off`;
- `autoApprove: true`: only browser-access approval requests are accepted (reason
  `browser access auto-approved`); all other approval requests are declined with reason
  `not a browser-access approval`;
- `autoApprove` does not apply to desktop approval requests: with `computer: false` they are always
  declined (`computer use is off`); with `computer: true` they go to DSH and the result is logged
  (`approved in DSH` / `rejected in DSH` / `approval cancelled` / `approval unavailable`); without an
  approval service or without a running `pc_codex_desktop_js` call they are declined.

If Codex changes the approval-request wording, browser and desktop approval requests are both
declined. This is a safe failure mode.

## Tools and usage

After installation, every agent preset automatically has:

| Tool | Server | Purpose |
|---|---|---|
| `pc_codex_js` | browser | Preferred: one checked program in the persistent `cua_repl` kernel, using accessibility values and the `cua` API |
| `pc_codex_js_reset` | browser | Reset the browser JS kernel (tabs stay open) |
| `pc_codex_desktop_js` | desktop | Preferred: one checked program in the persistent `node_repl` kernel, using accessibility values and the `sky` API |
| `pc_codex_desktop_js_reset` | desktop | Reset the desktop JS kernel (apps stay open) |
| `pc_codex_desktop_js_add_node_module_dir` | desktop | Add a Node module directory to the desktop `node_repl` |
| `pc_codex_observe` | browser / desktop | Read-only full accessibility tree or text for inspecting the whole interface; screenshot is opt-in |
| `pc_codex_run_plan` | browser / desktop | Fallback: 1–20 steps when step-by-step status or automatic observation after a failure is required |
| `pc_codex_docs` | none | Read the Computer Use docs bundled with the local Codex installation (`skill` / `guidance` / `api` / `confirmations`) |
| `pc_status` | none | Report the resolved configuration and connection state of both servers; check it first when another tool fails |

The five tools that map one-to-one to a native MCP call (`pc_codex_js`, `pc_codex_js_reset`,
`pc_codex_desktop_js`, `pc_codex_desktop_js_reset` and
`pc_codex_desktop_js_add_node_module_dir`) put native Codex's result header in front of the
server text: `Wall time: <seconds, four decimals> seconds` and `Output:`. The plugin does not
truncate the result; DSH's spill policy already bounds tool results by token budget and keeps
the full text in a file. `pc_codex_observe` and `pc_codex_run_plan` are plugin-composed tools
and do not add this header.

### Choosing a tool

1. **Preferred:** place the known consecutive steps in one program in `pc_codex_js` or
   `pc_codex_desktop_js`; the program uses `if`, loops and assertions, uses `throw` with an
   explanation when a check fails, and prints only what the next decision needs with
   `nodeRepl.write(...)` or `console.log(...)`.
2. Accessibility-tree values are read in code (button enabled, input value, selected item) rather
   than from screenshots; browser: `tab.getAXState`, desktop: `sky.get_window_state`
   accessibility data. The program filters and prints only the needed fields.
3. After a UI-changing step, the next program reads state first; old element indexes or
   coordinates are not reused.
4. `pc_codex_run_plan` is the fallback when step-by-step status or automatic observation after a
   failure is required; the code of each step can also contain conditions and assertions. Each
   step and each check is bounded by the single-call timeout.
5. `pc_codex_observe` is used when the whole interface must be inspected.

### Tool descriptions from the Codex servers

The descriptions of the five js tools (`pc_codex_js`, `pc_codex_js_reset`,
`pc_codex_desktop_js`, `pc_codex_desktop_js_reset` and
`pc_codex_desktop_js_add_node_module_dir`) come from the Codex servers: the
`initialize` instructions, the `tools/list` description of the matching server tool, and the
plugin rules that map the server tools to DSH tool names. The other four tools keep the plugin's
own descriptions. The plugin caches these texts in `~/.dsh/pc-use-server-docs.json`. When the
cache is missing or out of date (for example after a Codex update), it starts with the built-in
descriptions and applies the server ones at the next DSH start. When a connection finds
different server documentation, each DSH session gets it once, at the end of its next successful
`pc_codex_js` or `pc_codex_desktop_js` result. `prefetchServerDocs` (default on) connects to the
servers in the background at startup only when the cache is missing or out of date; a change
takes effect at the next DSH start. The cache stores only description text and hashes, never
commands, arguments, environment variables, paths or pipe names.

### The Codex computer-use skill

While `computer` is on and the desktop js tool (`tools.desktopJs`) is enabled, the plugin
registers the computer-use skill from the local Codex installation in DSH's skill catalog as
`codex-computer-use`. The body is read from
`<codexHome>/plugins/cache/openai-bundled/computer-use/<version>/skills/computer-use/SKILL.md`
when DSH lists or loads the skill, so it is never copied into this repository. The plugin
appends the DSH notes that name the desktop tools (`pc_codex_desktop_js`,
`pc_codex_desktop_js_reset`, `pc_codex_desktop_js_add_node_module_dir`) and map the
documents under `docs/` to `pc_codex_docs` topics.

## Settings page

The DSH settings sidebar shows a "PC Use" page immediately below "Plugin market" (entry id `pc-use`;
it appears only while the Host serves that entry). It can change:

- **Desktop control**: `computer`, `rememberDesktopApprovals`;
- **Browser**: `autoApprove`, `allowUserTabs`;
- **General**: `language`, `timeoutMs` (seconds, 10–3600, stored in milliseconds),
  `attachImages`, `keepImageFiles`, `prefetchServerDocs`, `codexHome`, `logFile`.

Switches and the language select save immediately; text and number fields save on blur or Enter.
Text and select rows show "Restore default" after the user has changed them: `language`,
`timeoutMs`, `codexHome` and `logFile`. Switch rows do not show it; 0.5.3 removed it from the four
switch rows `computer`, `rememberDesktopApprovals`, `autoApprove` and `allowUserTabs`, and the other
switch rows do not render it either. `enabled` and `tools.*`
are not on the page: the plugin is enabled in "Built-in plugins" or the plugin manager, and
tool switches are changed in the profile. The three desktop tool switches
(`tools.desktopJs`, `tools.desktopReset`, `tools.desktopAddNodeModuleDir`) are not on the page
either, like the other `tools.*` switches.
`codexHome` is volatile: the next call after a change re-resolves and reconnects to the new Codex
directory without remounting the plugin.

Before the settings finish loading, the section shows a skeleton with the same groups, headings,
rows and control boxes; only the control contents appear when loading completes, so the layout does
not jump. `unavailable` or an invalid read shows "Failed to read settings".

Known limitation: when `language` is not `auto`, the text changes to the chosen language after
loading; and a text or select row with a user override (which adds "Restore default") widens the
control area of that row. In those two cases, line height or control-area width may change after
loading, so the page moves.

## Desktop control

Windows desktop app control is off by default. Since 0.5.0, the browser and the desktop are two
Codex servers, started in the same way as the Codex app starts them:

- the **browser server** is Codex's `cua_repl`, launched from
  `<codexHome>/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`;
- the **desktop server** is Codex's `node_repl`, launched from `[mcp_servers.node_repl]` in
  `<codexHome>/config.toml`.

`pc_codex_js` / `pc_codex_js_reset` use the browser server; `pc_codex_desktop_js` /
`pc_codex_desktop_js_reset` / `pc_codex_desktop_js_add_node_module_dir` use the desktop server.
Both are started lazily: the desktop server starts on the first desktop call and never while
`computer` is `false`; turning `computer` off stops the desktop server immediately through the
volatile-update event of the loader and leaves the browser server running. Before each call, the
plugin re-reads
the source of that server, so a Codex restart is picked up per server. The launch environment is
passed through unchanged: the browser environment comes from `.mcp.json` and the desktop
environment from `config.toml`, in the same way that the Codex app starts them. The environment
rewriting of 0.4.x is gone.

How to enable: set it in the `cordis.patch.yml` of the profile and restart the desktop app. On the
tested DSH desktop 0.2.1-rc.2, the "Settings → Built-in plugins" page only shows plugin status, not
the config form. A patch replaces the whole `config:` block, so the keys that were already there
must be included.

```yaml
- id: pc-use
  config:
    computer: true
```

The first time `sky` operates a desktop app, Codex sends an approval request. The plugin recognizes
two wordings: `Allow Codex to use <app name>?` (what the desktop app sends) and
`Allow Computer Use to use "<app name>"?`. The recording request
`Allow Computer Use to record computer audio?` is not recognized and is declined.
Desktop approval requests are attributed to the earliest running `pc_codex_desktop_js` or
`pc_codex_desktop_js_add_node_module_dir` call; when no such call is running, they are declined
with log reason `no active pc_codex_desktop_js call`. A server that receives an approval request of
the other kind declines it and logs `unexpected approval for the browser server` or
`unexpected approval for the desktop server`. The plugin turns desktop approval requests into DSH
prompts (the three-option card or the one-shot card, see below); `autoApprove` does not apply to
desktop approval requests.

The plugin remembers the desktop approvals of the user within one DSH session: once the user has
allowed an app, later requests are not asked again, and the log reason reads
`approved earlier in this DSH session`. Only "allow" is remembered; denials, cancellations and
failures are not. The user is asked again after the desktop bridge reconnects (for example switching
`computer`, a `node_repl` change or a process restart), in a new DSH session, or after setting
`rememberDesktopApprovals` to `false` (the next call or approval request while it is off clears the
memory). A browser bridge reconnect does not clear remembered desktop approvals. To request a new
prompt immediately, the most reliable way is to start a new DSH session or toggle `computer` once.
Note: if the user tightens the permission mode later, apps that were already remembered in this DSH
session still pass.

Desktop approvals show the DSH three-option card by default: `允许这一次` (allow this step only, not
remembered), `本次会话内允许` (the same agent and app are not asked again in this DSH session; it
ends on reconnect or restart) and `拒绝` (deny). The second option appears only when
`rememberDesktopApprovals` is on and the `_meta.persist` of the request contains `session`; when the
approval policy is `never` ("full access") or no question service is available, the one-shot DSH
approval card is used instead. A custom-typed answer, an empty selection, unknown wording or a
failing question service all count as denial. The card text follows `language`; the DSH client shows
the Chinese or English text of the old one-shot card according to its interface language.

When each DSH turn ends, the plugin calls `turn_ended` with the Codex `session_id` / `turn_id`
of the same agent (`Stop` for a normal finish, `Interrupt` when stopped,
`SubagentStop` for a subagent), once for each server that is still connected, whether or not
the turn used it — native Codex does the same. This makes Codex clear the
orange "using your computer" glow and end that turn. The call is not sent to a server whose
bridge is disconnected, no server is started for it, and nothing is sent after the plugin is
unloaded; after a bridge reconnect the next turn starts from a new `turn_id`, and a rebuilt
bridge still receives the call for the turn that ended. The desktop cursor is closed only when
the turn used the desktop bridge and that bridge was not rebuilt since.

### Read the Codex documentation first: `pc_codex_docs`

The computer-use plugin of Codex ships one skill and three documents. The plugin neither copies nor
bundles them; `pc_codex_docs` reads the original files from the local Codex installation
(`<codexHome>/plugins/cache/openai-bundled/computer-use/`) on every call and returns them verbatim
after a source line and a mapping to the DSH tools. Codex updates are picked up automatically; when a
directory or file is missing, the error names the expected path. These documents belong to OpenAI
(Proprietary); they are only read locally and are not distributed with the plugin.

`topic` is `skill` (entry point), `guidance` (runtime rules, target windows, screenshots, recovery),
`confirmations` (actions that need user confirmation) or `api` (the full `sky` API). This tool needs
no Codex connection and is registered even with `computer: false`.

It is used inside `pc_codex_desktop_js` (with `computer: true` and a live desktop connection):

```js
const { sky } = await import('@oai/sky');
await sky.list_apps();
```

`sky` also offers screenshots, clicks, typing and other desktop operations; see the `api` document
via `pc_codex_docs`.

**Risk notice:** desktop control has more power than browser control: it can read the screen, move
the mouse and send input to any app. It is off by default; it is enabled only when it is genuinely
needed. Desktop approvals follow the approval policy of DSH: under "full access" DSH does not ask
and allows them directly; to confirm every time, use "read only" or "workspace write". Codex may
also remember earlier grants and stop asking. `autoApprove` does not apply to desktop approvals.

## Screenshots and privacy

Screenshots returned by Codex are attached as images only when `attachImages` is on and the current
model declares image input. If that fails, the plugin falls back to local path text. Images from a
failed `pc_codex_run_plan` are kept as path text with the reason `tool call failed`.

Attaching sends the screenshot to the model provider. Per DSH 0.2.1-rc.2 source, the default upload
path is the Files API: files expire after 7 days and are not deleted when the DSH session ends. The
local attachment store of DSH keeps another copy; `keepImageFiles: false` (the default) avoids a
second copy in `~/.dsh/pc-use-images`.

Each image costs roughly 184–1024 input tokens, and images in history are resent on every turn. To
cap image size, use the `imagePixelBudget` setting of DSH; the plugin does not change it.
`attachImages` is turned off if screenshots must not leave the machine.

## Providers

Only the Codex provider exists today: the `pc_codex_*` tools run through the local Codex desktop
app. The naming already reserves room for other providers: tools exclusive to Codex use the
`pc_codex_` prefix, and the computer use of Claude will sit next to it under `pc_claude_`; the top
level of `pc_status` groups by `providers`, currently only `providers.codex`, which reports its
`browser` and `desktop` servers separately. Config keys stay flat for now (`codexHome` etc.);
whether to group them will be decided once a second provider has a concrete design.

## Tool-call metadata

Every `tools/call` except `turn_ended` carries a `_meta` object built only from values that DSH can
truthfully give. The field set follows the Codex 0.163.0-alpha.10.2 source analysis in the r1
audit; capture-native never recorded a live Codex `tools/call`, so **this is source-derived and
has not been verified on the wire**:

Fields sent:

- `x-codex-turn-metadata.session_id` / `.thread_id`: the per-agent UUID of the plugin (a native root
  thread has `thread_id == session_id`).
- `x-codex-turn-metadata.turn_id`: the UUID of this DSH turn; it rotates when the DSH turn ends.
- `x-codex-turn-metadata.turn_started_at_unix_ms`: when that turn identity was created, in Unix
  ms (an integer). It stays fixed for the turn and grows after a rotation.
- `x-codex-turn-metadata.auto_review_enabled`, `.node_repl_auto_review_required` and
  `.node_repl_disabled`: always `false`; DSH has no Guardian review, and a call implies that the
  REPL is enabled.
- `x-codex-turn-metadata.model`: the current model id of the DSH agent, read from the request header
  that the DSH agent loop logged for its latest request; omitted when unavailable.
- `x-codex-turn-metadata.reasoning_effort`: the reasoning effort of that header; omitted when
  unavailable.
- `threadId` / `sessionId`: the same agent identity, top level in the native camelCase shape.
- `callId`: the DSH tool-call id (`exec.callId`); omitted when the execution has none. Every
  `pc_codex_run_plan` step and its check use the same id.

These fields are deliberately not sent, because DSH has no honest value for them and inventing one
would impersonate Codex or clear the server's own defaults: `codex_version`, `sandbox`,
`sandbox_mode`, `plugin_id`, `windowId`, `itemId`, `forked_from_thread_id`, `parent_thread_id`,
`subagent_kind`, `thread_source`, `turn_trigger`, `workspaces`,
`user_input_requested_during_turn`, `traceparent`, `tracestate`, `codex_bridge_mcp_call_id`,
`openai/readOnly`, `openai/entitlementContext`, `_codex_apps`, `codex/sandbox-launcher`,
`openai/confirmation_policies`, `codex/sandbox-state` and `codex/sandbox-state-meta`. In
particular, `openai/confirmation_policies: {}` would clear the confirmation defaults that the
server started with, and a filled `codex/sandbox-state` would declare a sandbox state for DSH while
how the server uses it is unknown.

`turn_ended` uses the native `_meta`: only `threadId` (the agent's Codex session id), with no
`x-codex-turn-metadata`.

## Verification

```js
await cua.listBrowsers();
```

Alternatively, call `pc_status` first and inspect `providers.codex`: it has `codexHome`,
`autoApprove`, `computer` and a `browser` and a `desktop` section. Each section reports `resolved`,
`reason`, `source`, `command`, `cwd`, `nativePipe`, `connected` and `services`. Before the first
connection, `connected` is `false` and `services` is `null`, which is normal; when a source cannot
be resolved, `resolved` is `false` and `reason` names the missing `.mcp.json` or `config.toml`
section. The old `servicesFrom` field was removed in 0.5.0. Command-line smoke test:

```powershell
npm run test:smoke
```

The smoke test connects to Codex and drives the real Chrome.

`npm test` runs the offline regression checks; `npm run test:smoke` connects to Codex and drives
the browser.

## Implementation

- `index.js`: the cordis plugin: `defineTool` + `parameters` DSL, the Schemastery `Config`,
  two lazily started bridges (browser and desktop), per-server approvals and turns, and
  `ctx.effect` cleanup
- `client.js`: the browser half: the "PC Use" settings section (`settings.section`), its
  controls and the zh/en client dictionaries
- `lib/text.js`: the Chinese and English text that the plugin displays itself (three-option
  card, `displayReason`, audit reason, config descriptions); both key sets match
- `lib/config-value.js`: unwraps the `Volatile` config values passed by the cordis loader
- `lib/define-tool.js`: portable fallback for `defineTool`: converts the parameter DSL to
  object JSON Schema and validates arguments before `execute`
- `lib/images.js`: saves screenshots from tool results: extension from the mimeType, only the
  newest 50 files kept
- `lib/codex-config.js`: resolves the two launch specs: `resolveBrowserServer` reads the newest
  `cua_repl` `.mcp.json`, `resolveDesktopServer` reads `[mcp_servers.node_repl]` from
  `config.toml`; both are re-read per call
- `lib/mcp-bridge.js`: a minimal MCP stdio client: injects turn metadata, advertises
  elicitation, answers approval requests by policy, notifies cancellation on timeout
- `lib/approval.js`: approval decisions: browser approval requests follow `autoApprove`, desktop
  approval requests go to DSH, everything else is declined with a reason
- `locale/en.json` / `locale/zh.json`: display name and description for the plugin manager
  (`PC Use` / `电脑操控`)
- `icon.svg`: an original window-and-pointer icon with no external resources
- `cordis.patch.yml`: the bundle layer that inserts the plugin into every preset by package name

Processes are started **lazily**: loading the plugin spawns nothing, a missing Codex does not
affect profile startup, and errors only surface when a tool is actually called. The browser server
starts on the first browser call and the desktop server on the first desktop call.

## The `defineTool` fallback

`dsh plugin add` installs a `link:` directory, so the plugin is loaded from its **workspace path**.
The DSH desktop 0.2.1-rc.2 profile sets `autoInstallPeers: false` and has no generic
`@deepseek-ai` resolution hook, so a `link:` install cannot resolve the host packages
(`@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` / `@deepseek-ai/cordis`) and always takes
the `lib/define-tool.js` fallback. That fallback has been checked against the native `defineTool` of
the host: it converts the parameter DSL to object JSON Schema and validates arguments before
execution.

0.1.0 failed at this point: without `defineTool`, the parameter DSL
(`{ code: { type: 'string', required: true } }`) was registered directly as JSON Schema,
producing an invalid schema in the model request (properties carrying `required`, root missing
`type: object`), and DeepSeek rejected the **whole turn**.
`npm test` asserts offline that every registered tool publishes valid object JSON Schema.

The switches only appear in the settings page once `@deepseek-ai/schemastery` is installed in the
plugin directory. This is a side effect of the devDependency of the plugin itself (a local
`npm install` puts a copy there). This point must be considered when publishing and installing.
The tested DSH desktop 0.2.1-rc.2 does not show the config form; options such as `computer` still
have to be set in the `cordis.patch.yml` of the profile. The three desktop tool switches are only
available in the profile as well.

## Known limitations

- Unofficial usage: Codex updates may change the shape of `.mcp.json` or `config.toml` or the pipe
  mechanism; on failure, check `pc_status` and `logFile` first.
- Some Windows versions return no accessibility tree for some apps, for example Notepad and
  Calculator, even with `include_text: true` (openai/codex#52319). The plugin tells the model to
  use a screenshot in that case; the model must not inspect logs, configuration or the disk for the
  cause, and must stop and tell the user if the screenshot is insufficient.
- Browser `cua.listTabs()` is guarded: it only returns plugin tabs; other user tabs are filtered
  out. A plugin tab is a Chrome tab opened or claimed through this plugin since the current browser
  kernel started; after `pc_codex_js_reset` or a browser reconnect, earlier tabs no longer count,
  and all DSH sessions share the same plugin tabs. The guard is misuse protection, not a security
  boundary; the prepended guard shifts line numbers in model-code errors.
- `allowUserTabs` (default off) covers `browser.user.openTabs`, `claimTab`,
  `getTabContext`, `browser.history`, `cua.getTab`, `cua.getState`, `browser.tabs.get`
  and `browser.tabs.content` on objects obtained through `cua.getBrowser` or
  `cua.browsers.{get,getDefault,getForUrl}`. `browser.tabs.list` and
  `browser.tabs.selected` only see plugin tabs and pass through. This is misuse
  protection, not a security boundary: model code can rewrite the Symbol that the wrapper
  reads. On a frozen Browser, reading `browser.user` or `browser.history` with the switch
  off throws the guard error.
- Automatic approval only recognizes the exact wording `Allow Browser use to access <origin>?`;
  if Codex changes it, browser approval requests are declined (fail-closed), and the declined
  wording is logged.
- For desktop approval requests, the plugin only recognizes
  `Allow Computer Use to use "<name>"?` and `Allow Codex to use <name>?`; other wordings are
  declined. Desktop control is off by default,
  and whether a card appears is decided by the permission mode of DSH ("full access" allows
  directly, "read only" /
  "workspace write" ask each time); Codex may also remember grants and stop asking.
- At most one connection per server is kept (one browser, one desktop); unloading the plugin or
  exiting the process terminates both child processes.
- The fallback accepts `string`, `number`, `boolean`, `array` and `object`; it checks that a present
  value has the declared top-level type (`number` must be finite). It does not validate array
  elements or fields inside an object; nested validation requires the real `defineTool` of the host.

## Changelog

Release history: [CHANGELOG.md](CHANGELOG.md) (Chinese:
[CHANGELOG.zh.md](CHANGELOG.zh.md)).

## License

Apache-2.0. Copyright 2026 Aruir.

See [LICENSE](LICENSE).
