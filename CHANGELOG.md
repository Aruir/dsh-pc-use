# Changelog

[中文](CHANGELOG.zh.md) | English

## Unreleased

The plugin description in DSH no longer says which provider is used or that more providers are
planned.

The five js tools now take their descriptions from the Codex servers: the `initialize`
instructions, the `tools/list` description of the matching server tool, and the plugin rules
that map those tools to DSH names. The plugin caches the descriptions in
`~/.dsh/pc-use-server-docs.json`; when the cache is missing or out of date (for example after a
Codex update), it uses the built-in descriptions and applies the server ones at the next DSH
start. If a connection finds changed server documentation, each DSH session receives it once at
the end of its next successful js tool result, and `pc_status` reports the documentation source,
hashes and whether it is stale. The new `prefetchServerDocs` switch (default on) connects to the
servers in the background only when the cache is missing or out of date, and takes effect at the
next DSH start. The cache stores only description text and hashes, never commands, arguments,
environment variables, paths or pipe names.

The plugin now registers Codex's computer-use skill in DSH's skill catalog as
`codex-computer-use` while `computer` is on and the desktop js tool is enabled. The skill
body is read from the local Codex installation when DSH lists or loads it, so it is never
copied into the repository; the plugin appends DSH notes that name the desktop tools and map
the `docs/` files to `pc_codex_docs` topics.

The descriptions of the settings page's "Codex home" and "Bridge log" rows now point at
`pc_status` for the reason when the path cannot be used or the log cannot be written.

The plugin now sends `turn_ended` the way native Codex does: at the end of a turn it calls
every connected server, whether or not that turn used it, with a `_meta` that contains only
`threadId`. The desktop cursor is still closed only when the turn used the desktop bridge and
that bridge was not rebuilt since.

The five tools that correspond one-to-one to a native MCP call (`pc_codex_js`,
`pc_codex_js_reset`, `pc_codex_desktop_js`, `pc_codex_desktop_js_reset` and
`pc_codex_desktop_js_add_node_module_dir`) now prefix the server text with native Codex's
result header: `Wall time: <seconds, four decimals> seconds` and `Output:`. The plugin does
not truncate results; DSH's spill policy already bounds tool results by token budget and
keeps the full text recoverable. `pc_codex_observe` and `pc_codex_run_plan` outputs are
unchanged.

`pc_status` now reports two more fields per server: `serverInfo`, the `{ name, version }` from
the server's MCP `initialize` (null until connected, values capped at 200 characters), and
`pluginVersion`, the `unified-computer-use` version directory from the browser source path
(null for the desktop side or when the source does not resolve).

## 0.9.1

The settings page now shows the real state of "Attach screenshots" and "Keep local image
files". Before, both switches always looked off after the page read the settings, although
screenshots were attached by default. Four tool switches in the configuration schema now use the
same Chinese descriptions as the plugin's text table. Internally, duplicated code in the tool
dispatch, approval reasons, configuration lookup, bridge shutdown, logging and the tab guard was
merged; the behavior of the plugin does not change otherwise.

## 0.9.0

0.9.0 renames the top-level `pc_status` key `backends` to `providers`; this is a breaking change
for anything that reads `pc_status`. The documentation and the tool descriptions now use the
terms of the new glossary (provider, plugin tabs, DSH session) and state that after a kernel reset
or a browser reconnect, earlier tabs no longer count as plugin tabs. Internally, turn tracking,
desktop approvals, the bridge of each target and the argument parsing of `pc_codex_observe` and
`pc_codex_run_plan` moved out of `index.js` into their own modules with direct tests; the
behavior of the plugin does not change.

## 0.8.0

0.8.0 adds the `allowUserTabs` switch (default off; a change applies to later calls) and puts
every entrance that reads the user's own tabs and history behind it: while the switch is off,
`browser.user.openTabs`, `browser.user.claimTab`, `browser.user.getTabContext` and
`browser.history` fail with an explanatory error, `cua.getTab`, `browser.tabs.get` and
`browser.tabs.content` accept only the tabs of this session, and `cua.getState` lists only those
tabs. The guard now returns Proxy views and reads the switch and the original method at call
time, because the runtime objects cache a method wrapper on first read, so redefining the method
had no effect on a real server. The settings page shows a skeleton with the same layout while
settings load. `initialize` matches native Codex: protocol version `2025-06-18` and `form` plus
`url` elicitation capabilities, with `url` requests declined before classification and logged by
host name only. The package is licensed under Apache-2.0, SECURITY.md is new, and both READMEs use
formal language and correct five statements that did not match the implementation.

## 0.7.0

0.7.0 adds two tools, each with a switch (default on): `pc_codex_observe` reads a browser
tab or desktop window in one read-only call, and `pc_codex_run_plan` runs 1 to 20 steps with
optional checks and stops at the first failure. The js tool descriptions now ask for one
checked program per call, and the top-level return hint now says that values are not
returned automatically. Screenshots from the four code tools reach the model as images
(`attachImages`, default on; screenshots go to the model provider); `keepImageFiles`
(default off) also keeps them under `~/.dsh/pc-use-images`. When a desktop window has no
accessibility tree, the tools say so and tell the model to judge by screenshot. Every
browser js call wraps `cua.listTabs` so that it returns only the tabs this session opened.
Every `tools/call` except `turn_ended` carries Codex turn metadata and call identities in
`_meta` (see "Tool-call metadata"; derived from source, not verified on the wire).

## 0.6.0

0.6.0 replaced the language row's native select with DSH's official primitives Menu (rounded
button, chevron and hover style, injected once through a style element), falling back to the native
select when the primitives module or Menu is unavailable. It also removed the
`desktopApprovalChoices` switch — an incompatible change to the public config API — so desktop
approvals always use the three-option card; only the missing question service and non-`ask` policy
fallbacks remain. A profile that still carries the old field keeps loading: DSH's non-strict schema
passes the unknown key through and the plugin ignores it, so the field can be left for later
cleanup. The page top now follows the official "General" page: no page title or intro, the saved
status is only exposed to screen readers, and conflict notices stay visible. It also fixes the
live-testing issues: closes the desktop turn over Codex's native pipe so the cursor overlay
disappears, adds no-retry / top-level-return / close-apps guidance, re-reads server config in
`pc_status` (`reconnectPending`), records log write failures, follows the language setting on the
settings page, shows "Restore default" only when the value differs, submits `unset` for emptied
text fields, and removes test temp directories.

## 0.5.5

0.5.5 shortened the settings page text: the first switch row is "Enable desktop control", the
intro and footer keep one sentence each, and the interface-language row moved into a new "General"
group at the end.

## 0.5.4

0.5.4 aligned the settings page spacing with the built-in DSH settings pages: page title
16/500/24, intro 14/22, row titles and descriptions with line heights, 12 px between groups, no
gaps between rows, and no divider under the last row of a group.

## 0.5.3

0.5.3 removed "Restore default" from the four switch rows (a switch can always be flipped
back) and made a switch that returns to its default value remove the stored override instead of
writing it again.

## 0.5.2

0.5.2 moved "Saved" to the settings title row and "Restore default" to the left of each
control, so the status text no longer shifts the options and each row's control stays aligned.

## 0.5.1

0.5.1 fixed the settings page switches: the thumb now uses a real DSH theme token, so on and off
are visible, and the switch is no longer squeezed by "Restore default".

## 0.5.0

0.5.0 split the browser and the desktop into two servers, started the way the Codex app starts them:
`cua_repl` for the browser and `node_repl` for Windows desktop apps. New desktop tools
`pc_codex_desktop_js`, `pc_codex_desktop_js_reset` and
`pc_codex_desktop_js_add_node_module_dir` (switches `tools.desktopJs` / `tools.desktopReset` /
`tools.desktopAddNodeModuleDir`, all on by default); `pc_status` now reports `browser` and `desktop`
sections and drops `servicesFrom`; each server keeps its own launch environment.

## 0.4.3

0.4.3 added: a "PC Use" settings page in the DSH settings sidebar right below the plugin market,
with desktop control, three-option card, remembered approvals, interface text, browser auto-approval,
call timeout, Codex home and bridge log fields; `codexHome` became volatile, so the next call
reconnects to the new Codex directory without remounting the plugin.

## 0.4.2

0.4.2: fixed three issues found in live testing — `turn_ended` `_meta` used the next turn's turn id,
waiting for an approval counted against the call timeout, and the plugin kept the old desktop helper
pipe after Codex restarted; desktop approvals now use a three-option card (the approval policy
"full access" keeps the original one-shot card);
English support was added (`language` controls the text the plugin shows, `auto` by default
following the DSH interface language).

## 0.4.1

0.4.1 fixed: removed the `pc_codex_js_add_node_module_dir` tool, `tools.addNodeModuleDir` and the
`stateFile` option; the bridge-level `session_id` is now generated randomly in memory and no state
file is read or written; old profiles with those keys still load.

## 0.4.0

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

## 0.3.2

0.3.2 fixed: desktop approvals are remembered per app within one DSH session
(`rememberDesktopApprovals`); each finished turn notifies Codex via `turn_ended`, clearing the orange
"using your computer" glow.

## 0.3.1

0.3.1 fixed: documented desktop approvals and the DSH permission modes; `codex_status` (now
`pc_status`) gained `servicesFrom`; test fixtures moved into `test/fixtures`.

## 0.3.0

0.3.0 added: Windows desktop control (`computer`, off by default; desktop approvals follow DSH's
approval policy).

## 0.2.0

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
