# dsh-pc-use

English | [中文](README.zh.md)

## Renaming (0.4.0)

- Package name and plugin id: `dsh-codex-cu` → `dsh-pc-use`, `id: codex-cu` → `id: pc-use`.
- Tool names: `codex_js` / `codex_js_reset` / `codex_js_add_node_module_dir` / `codex_status`
  became `pc_codex_js` / `pc_codex_js_reset` / `pc_codex_js_add_node_module_dir` / `pc_status`,
  and `pc_codex_docs` was added.
- Default log `~/.dsh/codex-cu.log` → `~/.dsh/pc-use.log`; default screenshot directory
  `~/.dsh/codex-cu-images` → `~/.dsh/pc-use-images`.
- **Profile overrides must use the new id:** `- id: codex-cu` has to become `- id: pc-use`,
  otherwise it no longer applies.
- State files are no longer used as of 0.4.1; old logs and screenshot directories are not migrated.
- `dsh-computer-use` was not chosen: another DSH plugin with that name exists on npm, so the
  marketplace could replace the wrong package when looking updates up by name. Hence `dsh-pc-use`.

0.4.0 added: the rename to `dsh-pc-use`; `pc_codex_docs` for Codex's own docs; loading by package
name with display name and icon; `pc_status` now groups by backend (`backends`).

0.5.3 removed "Restore default" from the four switch rows (a switch can always be flipped
back) and made a switch that returns to its default value remove the stored override instead of
writing it again.

0.5.2 moved "Saved" to the settings title row and "Restore default" to the left of each
control, so the status text no longer shifts the options and each row's control stays aligned.

0.5.1 fixed the settings page switches: the thumb now uses a real DSH theme token, so on and off
are visible, and the switch is no longer squeezed by "Restore default".

0.5.0 split the browser and the desktop into two servers, started the way the Codex app starts them:
`cua_repl` for the browser and `node_repl` for Windows desktop apps. New desktop tools
`pc_codex_desktop_js`, `pc_codex_desktop_js_reset` and
`pc_codex_desktop_js_add_node_module_dir` (switches `tools.desktopJs` / `tools.desktopReset` /
`tools.desktopAddNodeModuleDir`, all on by default); `pc_status` now reports `browser` and `desktop`
sections and drops `servicesFrom`; each server keeps its own launch environment.

0.4.3 added: a "PC Use" settings page in the DSH settings sidebar right below the plugin market,
with desktop control, three-option card, remembered approvals, interface text, browser auto-approval,
call timeout, Codex home and bridge log fields; `codexHome` became volatile, so the next call
reconnects to the new Codex directory without remounting the plugin.

0.4.2: fixed three issues found in live testing — `turn_ended` `_meta` used the next turn's turn id,
waiting for an approval counted against the call timeout, and the plugin kept the old desktop helper
pipe after Codex restarted; desktop approvals now use a three-option card (`desktopApprovalChoices`,
on by default; when off or the approval policy is "full access" the original one-shot card is used);
English support was added (`language` controls the text the plugin shows, `auto` by default
following the DSH interface language).

0.4.1 fixed: removed the `pc_codex_js_add_node_module_dir` tool, `tools.addNodeModuleDir` and the
`stateFile` option; the bridge-level `session_id` is now generated randomly in memory and no state
file is read or written; old profiles with those keys still load.

0.3.2 fixed: desktop approvals are remembered per app within one DSH session
(`rememberDesktopApprovals`); each finished turn notifies Codex via `turn_ended`, clearing the orange
"using your computer" glow.

0.3.1 fixed: documented desktop approvals and the DSH permission modes; `codex_status` (now
`pc_status`) gained `servicesFrom`; test fixtures moved into `test/fixtures`.

0.3.0 added: Windows desktop control (`computer`, off by default; desktop approvals follow DSH's
approval policy).

0.2.0 fixed:

- Parameter schema fallback: without the host `defineTool`, the parameter DSL becomes an object JSON
  Schema and arguments are validated before execution.
- Volatile config fix: values passed by the loader as `Volatile` are unwrapped correctly, so changes
  to `autoApprove` / `logFile` / `timeoutMs` take effect immediately.
- Fail-closed approvals: `autoApprove` defaults to `false` and only browser-access approvals are
  accepted automatically; every other elicitation is declined.
- Approval log: every approval records the original wording, the decision (accept/decline) and the
  reason, by default in `~/.dsh/pc-use.log`.
- Screenshot cleanup: screenshots returned by tools are saved to `~/.dsh/pc-use-images` with an
  extension chosen from the mimeType, and only the newest 50 files are kept.
- Handshake failure cleanup: an initialize error, timeout or spawn failure terminates the child
  process instead of treating an uninitialized connection as usable.
- The client version is read from `package.json` instead of being hard-coded.

`npm test` runs the offline regression checks; `npm run test:smoke` connects to Codex and drives the
browser.

This plugin turns **Codex Computer Use** into native DeepSeek Harness tools: it uses the local Codex
app to drive the real Chrome through the browser server (`cua_repl`) and Windows desktop apps
through the desktop server (`node_repl`), without any manual MCP configuration. The current backend
is Codex; more backends will follow (see "Backends").

Once installed, every agent preset automatically has:

| Tool | Server | Purpose |
|---|---|---|
| `pc_codex_js` | browser | Run JS in the persistent `cua_repl` kernel, using the `cua` API to open/read/drive pages |
| `pc_codex_js_reset` | browser | Reset the browser JS kernel (tabs stay open) |
| `pc_codex_desktop_js` | desktop | Run JS in Codex's persistent `node_repl` kernel, using the `sky` API to control desktop apps |
| `pc_codex_desktop_js_reset` | desktop | Reset the desktop JS kernel (apps stay open) |
| `pc_codex_desktop_js_add_node_module_dir` | desktop | Add a Node module directory to the desktop `node_repl` |
| `pc_codex_docs` | none | Read the Computer Use docs bundled with the local Codex installation (`skill` / `guidance` / `api` / `confirmations`) |
| `pc_status` | none | Report the resolved configuration and connection state of both servers; check it first when another tool fails |

## Why this plugin is needed

Codex's two computer-use servers — `cua_repl` for the browser and `node_repl` for desktop apps —
depend on three things only Codex's own client does; a vanilla MCP client cannot connect to them:

1. every `tools/call` must carry `_meta["x-codex-turn-metadata"]`, or the server rejects it;
2. `initialize` must advertise the `elicitation` capability, or browser/app approval requests cannot
   be sent;
3. the `elicitation/create` approval requests the server sends back must be answered, or it reports
   `The approval request did not return a valid decision`.

Codex also rewrites the `codex-computer-use-<GUID>` pipe name and the runtime hash on every restart,
so hard-coded configuration always goes stale.

The plugin builds all of this in (`lib/mcp-bridge.js` + `lib/codex-config.js`) and re-reads each
server's source before using it. The launch environment is passed through unchanged: the browser
server uses the values from `.mcp.json` and the desktop server those from `config.toml`, exactly as
the Codex app starts them.

## Installation

Use the official flow ([packaging and installing plugins](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)): the package declares `dsh.bundle`, so installing it into a profile with `dsh plugin` is enough.

```powershell
dsh plugin --profile desktop add C:\Users\<you>\...\plugins\dsh-pc-use
```

`dsh plugin add` writes the package into the profile's `dependencies` and appends it to
`dsh.profile.bundles`; the bundle's own `cordis.patch.yml` inserts the `pc-use` row.

Uninstall:

```powershell
dsh plugin --profile desktop remove dsh-pc-use
```

### To change the config, do not insert again

The bundle layer already inserts `pc-use`. In the profile's `cordis.patch.yml` you can **only override by id**;
do not `insert` it again — the same id in two rows makes the loader fail and the plugin silently
disappears:

```yaml
- id: pc-use
  config:
    autoApprove: true   # only browser access is auto-accepted; other approvals still decline and are logged
    logFile: 'C:\Users\<you>\.dsh\pc-use.log'
    # Note: a patch replaces the whole config block, it does not deep-merge; omitted keys fall back to the defaults above
```

`dsh --profile desktop --dump-config` is rejected on Electron-hosted profiles; use the desktop
plugin panel instead.

## Configuration

All fields are optional and go in the `config:` block of `cordis.patch.yml`.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` registers no tools at all |
| `autoApprove` | `false` | Only browser-access approvals are accepted automatically; other elicitations are declined (fail-closed) |
| `computer` | `false` | Enable Windows desktop app control (Codex Computer Use); whether a card appears is decided by DSH's permission mode |
| `rememberDesktopApprovals` | `true` | Within one DSH session an app you allowed once is not asked about again; denials are not remembered |
| `desktopApprovalChoices` | `true` | Desktop approvals use the three-option card (allow this time / allow for this session / deny); when off, the one-shot approval card is used |
| `language` | `'auto'` | Language of the plugin interface text: `auto` follows the DSH interface language, or force `zh` / `en` |
| `codexHome` | `''` | Empty means `%USERPROFILE%\.codex` |
| `logFile` | `''` | Bridge log path; empty means `~/.dsh/pc-use.log` |
| `timeoutMs` | `120000` | Timeout for one tool call |
| `tools` | all on | Per-tool switches: `{ js, reset, desktopJs, desktopReset, desktopAddNodeModuleDir, docs, status }` |
| `tools.desktopJs` | `true` | Register `pc_codex_desktop_js`: run JS in the desktop `node_repl` (needs `computer: true`) |
| `tools.desktopReset` | `true` | Register `pc_codex_desktop_js_reset`: reset the desktop JS kernel |
| `tools.desktopAddNodeModuleDir` | `true` | Register `pc_codex_desktop_js_add_node_module_dir`: add a Node module directory to the desktop `node_repl` |
| `tools.docs` | `true` | Register `pc_codex_docs`: read Codex's bundled Computer Use docs (no Codex connection needed) |

`autoApprove` / `computer` / `rememberDesktopApprovals` / `desktopApprovalChoices` / `language` /
`codexHome` / `logFile` / `timeoutMs` are hot-updatable (volatile): a change applies to later calls
without remounting the plugin. The loader announces volatile writes, so turning `computer` off
stops the desktop server immediately and leaves the browser connection alone; turning it on starts
the desktop server on the next desktop call. After `codexHome` changes both servers re-resolve and
reconnect on their next call. `enabled` and `tools.*` are not volatile;
changing one remounts the plugin and registers the tools again for the new configuration. The three
desktop switches default to `true` and are not on the settings page.

`language` only affects the text this plugin displays (the two sets — Chinese and English — of the
three-option card, the one-shot card's `displayReason` and the audit `reason`): `auto` first tries to
read the interface-language preference the DSH host exposes and falls back to the system language
(`zh` prefix means Chinese, otherwise English); you can also force `zh` / `en`. The one-shot approval
card's `displayReason` carries both Chinese and English text, and the DSH client picks the one matching
its interface language regardless of `language`.

Every approval is written to the log (when `logFile` is empty, into `~/.dsh/pc-use.log`; it no longer
only goes to `console.warn`), recording the original wording, the decision and the reason, for example:

```
approval "Allow Browser use to access https://www.bilibili.com?" -> accept (browser access auto-approved)
```

- `autoApprove: false` (default): browser approvals always decline, with reason `auto-approve is off`;
- `autoApprove: true`: only browser-access approvals are accepted (reason `browser access auto-approved`);
  all other approvals decline with reason `not a browser-access approval`;
- `autoApprove` does not apply to desktop approvals: with `computer: false` they always decline
  (`computer use is off`); with `computer: true` they go to DSH and the result is logged
  (`approved in DSH` / `rejected in DSH` / `approval cancelled` / `approval unavailable`); without an
  approval service or without a running `pc_codex_desktop_js` call they decline.

If Codex changes the approval wording, browser and desktop approvals are both declined — a safe
failure mode.

## Settings page (0.4.3)

The DSH settings sidebar shows a "PC Use" page right below "Plugin market" (entry id `pc-use`; it
only appears while the Host serves that entry). It can change:

- **Desktop control**: `computer`, `desktopApprovalChoices`, `rememberDesktopApprovals`, `language`;
- **Browser**: `autoApprove`;
- **Connection and logs**: `timeoutMs` (seconds, 10–3600, stored in milliseconds), `codexHome`,
  `logFile`.

Switches and the language select save immediately; text and number fields save on blur or Enter.
Every field shows "Restore default" once the user has changed it. `enabled` and `tools.*` are not on
the page: enable the plugin in "Built-in plugins" or the plugin manager, and change tool switches in
the profile. The three desktop tool switches (`tools.desktopJs`, `tools.desktopReset`,
`tools.desktopAddNodeModuleDir`) are not on the page either, like the other `tools.*` switches.
`codexHome` is volatile: the next call after a change re-resolves and reconnects to the new Codex
directory without remounting the plugin.

## Desktop control

Windows desktop app control is off by default. Since 0.5.0 the browser and the desktop are two Codex
servers, started the way the Codex app starts them:

- the **browser server** is Codex's `cua_repl`, launched from
  `<codexHome>/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`;
- the **desktop server** is Codex's `node_repl`, launched from `[mcp_servers.node_repl]` in
  `<codexHome>/config.toml`.

`pc_codex_js` / `pc_codex_js_reset` use the browser server; `pc_codex_desktop_js` /
`pc_codex_desktop_js_reset` / `pc_codex_desktop_js_add_node_module_dir` use the desktop server.
Both are started lazily: the desktop server starts on the first desktop call and never while
`computer` is `false`; turning `computer` off stops the desktop server immediately (the loader's
volatile-update event) and leaves the browser server running. Before each call the plugin re-reads
that server's own source, so a Codex restart is picked
up per server. The launch environment is passed through unchanged — the browser's comes from
`.mcp.json` and the desktop's from `config.toml` — exactly as the Codex app starts them; the 0.4.x
env rewriting is gone.

How to enable: set it in the profile's `cordis.patch.yml` and restart the desktop app. On the tested
DSH desktop 0.2.1-rc.2 the "Settings → Built-in plugins" page only shows plugin status, not the
config form. A patch replaces the whole `config:` block, so include the keys that were already
there.

```yaml
- id: pc-use
  config:
    computer: true
```

The first time `sky` operates a desktop app, Codex sends an approval request. The plugin recognizes
two wordings: `Allow Codex to use <app name>?` (what the desktop app sends) and
`Allow Computer Use to use "<app name>"?`. The recording request
`Allow Computer Use to record computer audio?` is not recognized and is declined.
Desktop approvals are attributed to the earliest running `pc_codex_desktop_js` or
`pc_codex_desktop_js_add_node_module_dir` call; when no such call is running they are declined with
log reason `no active pc_codex_desktop_js call`. A server that receives an approval of the other
kind declines it and logs `unexpected approval for the browser server` or
`unexpected approval for the desktop server`. The plugin turns desktop approvals into DSH prompts
(the three-option card or the one-shot card, see below); `autoApprove` does not apply to desktop
approvals.

The plugin remembers your desktop approvals within one DSH session: once you allowed an app, later
requests are not asked again and the log reason reads `approved earlier in this DSH session`. Only
"allow" is remembered; denials, cancellations and failures are not. You are asked again after the
desktop bridge reconnects (for example switching `computer`, a `node_repl` change or a process
restart), in a new DSH session, or after setting `rememberDesktopApprovals` to `false` (the next
call or approval request while it is off clears the memory). A browser bridge reconnect does not
clear remembered desktop approvals. To be asked again immediately, the most reliable way is to start
a new session or toggle `computer` once. Note: if you tighten the permission mode later, apps
already remembered in this session still pass.

Desktop approvals show the DSH three-option card by default: `允许这一次` (allow this step only, not
remembered), `本次会话内允许` (don't ask again for the same agent and app in this DSH session; it
ends on reconnect or restart) and `拒绝` (deny). The second option appears only when
`rememberDesktopApprovals` is on and the request's `_meta.persist` contains `session`; when the
approval policy is `never` ("full access"), no question service is available, or
`desktopApprovalChoices: false`, the one-shot DSH approval card is used instead. A custom-typed
answer, an empty selection, unknown wording or a failing question service all count as denial. The
card text follows `language`; the DSH client shows the Chinese or English text of the old one-shot
card according to its interface language.

When each DSH turn ends, the plugin calls `turn_ended` with the same agent's Codex `session_id` /
`turn_id` (`Stop` for a normal finish, `Interrupt` when stopped, `SubagentStop` for a subagent),
once for each server the turn used that is still connected. This makes Codex clear the orange
"using your computer" glow and end that turn. It is not sent to a server the turn did not use, when
that server's bridge is disconnected, or after the plugin is unloaded; after a bridge reconnect it
starts from a new `turn_id`, and a rebuilt bridge is not told about earlier turns.

### Read Codex's own docs first: `pc_codex_docs`

Codex's computer-use plugin ships one skill and three documents. The plugin neither copies nor bundles
them; `pc_codex_docs` reads the original files from the local Codex installation
(`<codexHome>/plugins/cache/openai-bundled/computer-use/`) on every call and returns them verbatim
after a source line and a mapping to the DSH tools. Codex updates are picked up automatically; when a
directory or file is missing the error names the expected path. These documents belong to OpenAI
(Proprietary); they are only read locally and are not distributed with the plugin.

`topic` is `skill` (entry point), `guidance` (runtime rules, target windows, screenshots, recovery),
`confirmations` (actions that need user confirmation) or `api` (the full `sky` API). This tool needs no
Codex connection and is registered even with `computer: false`.

Use it inside `pc_codex_desktop_js` (with `computer: true` and a live desktop connection):

```js
const { sky } = await import('@oai/sky');
await sky.list_apps();
```

`sky` also offers screenshots, clicks, typing and other desktop operations; see the `api` document via
`pc_codex_docs`.

**Risk notice:** desktop control has more power than the browser — it can read the screen, move the
mouse and send input to any app. It is off by default; enable it only when you really need it. Desktop
approvals follow DSH's approval policy: under "full access" DSH does not ask and allows them directly;
to confirm every time, use "read only" or "workspace write". Codex may also remember earlier grants
and stop asking. `autoApprove` does not apply to desktop approvals.

## Backends

Only the Codex backend exists today: the `pc_codex_*` tools run through the local Codex desktop app.
The naming already reserves room for other backends: tools exclusive to Codex use the `pc_codex_`
prefix, and Claude's computer use will sit next to it under `pc_claude_`; the top level of `pc_status`
groups by `backends`, currently only `backends.codex`, which reports its `browser` and `desktop`
servers separately. Config keys stay flat for now (`codexHome` etc.); whether to group them will be
decided once a second backend has a concrete design.

## Prerequisites

- The Codex desktop app must be running (both servers connect to its native pipes);
- The Chrome extension must be connected, so `await cua.listBrowsers()` inside `pc_codex_js` lists
  `Chrome / type=extension`;
- `<codexHome>/config.toml` must have an `[mcp_servers.node_repl]` section for desktop control;
  when it is missing, only the desktop tools fail, and the error names the section;
- Only Windows has been verified (Codex's Computer Use uses the `sky` native pipe on Windows).

## Verification

```js
await cua.listBrowsers();
```

Or call `pc_status` first and look at `backends.codex`: it has `codexHome`, `autoApprove`, `computer`
and a `browser` and a `desktop` section. Each section reports `resolved`, `reason`, `source`,
`command`, `cwd`, `nativePipe`, `connected` and `services`. Before the first connection
`connected` is `false` and `services` is `null`, which is normal; when a source cannot be resolved,
`resolved` is `false` and `reason` names the missing `.mcp.json` or `config.toml` section. The old
`servicesFrom` field was removed in 0.5.0. Command-line smoke test:

```powershell
npm run test:smoke
```

The smoke test connects to Codex and drives the real Chrome.

## Implementation

- `index.js` — the cordis plugin: `defineTool` + `parameters` DSL, the Schemastery `Config`, two lazily started bridges (browser and desktop), per-server approvals and turns, and `ctx.effect` cleanup
- `client.js` — the browser half: the "PC Use" settings section (`settings.section`), its controls and the zh/en client dictionaries
- `lib/text.js` — the Chinese and English text the plugin displays itself (three-option card, `displayReason`, audit reason, config descriptions); both key sets match
- `lib/config-value.js` — unwraps the `Volatile` config values passed by the cordis loader
- `lib/define-tool.js` — portable fallback for `defineTool`: converts the parameter DSL to object JSON Schema and validates arguments before `execute`
- `lib/images.js` — saves screenshots from tool results: extension from the mimeType, only the newest 50 files kept
- `lib/codex-config.js` — resolves the two launch specs: `resolveBrowserServer` reads the newest `cua_repl` `.mcp.json`, `resolveDesktopServer` reads `[mcp_servers.node_repl]` from `config.toml`; both are re-read per call
- `lib/mcp-bridge.js` — a minimal MCP stdio client: injects turn metadata, advertises elicitation, answers approvals by policy, notifies cancellation on timeout
- `lib/approval.js` — approval decisions: browser approvals follow `autoApprove`, desktop approvals go to DSH, everything else is declined with a reason
- `locale/en.json` / `locale/zh.json` — display name and description for the plugin manager (`PC Use` / `电脑操控`)
- `icon.svg` — an original window-and-pointer icon with no external resources
- `cordis.patch.yml` — the bundle layer that inserts the plugin into every preset by package name

Processes are **lazily started**: loading the plugin spawns nothing, a missing Codex does not affect
profile startup, and errors only surface when a tool is actually called. The browser server starts on
the first browser call and the desktop server on the first desktop call.

## Why `defineTool` needs a fallback

`dsh plugin add` installs a `link:` directory, so the plugin is loaded from its **workspace path**. The
DSH desktop 0.2.1-rc.2 profile sets `autoInstallPeers: false` and has no generic `@deepseek-ai`
resolution hook, so a `link:` install cannot resolve the host packages (`@deepseek-ai/dsh-tools` /
`@deepseek-ai/schemastery` / `@deepseek-ai/cordis`) and always takes the `lib/define-tool.js` fallback.
That fallback has been checked against the host's native `defineTool`: it converts the parameter DSL to
object JSON Schema and validates arguments before execution.

0.1.0 tripped here: without `defineTool`, the parameter DSL (`{ code: { type: 'string', required: true } }`)
was registered directly as JSON Schema, producing an invalid schema in the model request (properties
carrying `required`, root missing `type: object`), and DeepSeek rejected the **whole turn**. `npm test`
asserts offline that all seven tools publish valid object JSON Schema.

The switches only appear in the settings page once `@deepseek-ai/schemastery` is installed in the
plugin directory — that is a side effect of the plugin's own devDependency (a local `npm install` puts
a copy there). Keep this in mind when publishing and installing.
The tested DSH desktop 0.2.1-rc.2 does not show the config form; options such as `computer` still have
to be set in the profile's `cordis.patch.yml`. The three desktop tool switches are only available in
the profile as well.

## Known limitations

- Unofficial usage: Codex updates may change the `.mcp.json` or `config.toml` shape or the pipe
  mechanism; on failure check `pc_status` and `logFile` first.
- Automatic approval only recognizes the exact wording `Allow Browser use to access <origin>?`; if
  Codex changes it, browser approvals are declined (fail-closed) and the declined wording is logged.
- Desktop approvals only recognize `Allow Computer Use to use "<name>"?` and `Allow Codex to use <name>?`;
  other wordings are declined. Desktop control is off by default, and whether a card appears is decided
  by DSH's permission mode ("full access" allows directly, "read only" / "workspace write" ask each
  time); Codex may also remember grants and stop asking.
- At most one connection per server is kept (one browser, one desktop); unloading the plugin or
  exiting the process terminates both child processes.
- The fallback only supports the `string` / `number` / `boolean` primitive parameters; nested objects
  require the host's real `defineTool`.
