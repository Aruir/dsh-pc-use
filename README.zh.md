# dsh-pc-use

[English](README.md) | 中文

本插件把 **Codex Computer Use** 接入 DeepSeek Harness，作为原生工具使用。插件通过浏览器服务器
（`cua_repl`）调用本机 Codex，操作真实的 Chrome；通过桌面服务器（`node_repl`）操作 Windows
桌面应用。使用前不需要手工配置 MCP。目前提供方为 Codex，以后会增加其他提供方，见“提供方”一节。
截图与页面内容会发送给模型服务商。

## 插件用途

Codex 提供两个 computer-use 服务器：浏览器使用 `cua_repl`，桌面应用使用 `node_repl`。这两个
服务器依赖三项行为，而这三项行为只有 Codex 客户端实现。因此，普通 MCP 客户端无法连接：

1. 每次 `tools/call` 必须携带 `_meta["x-codex-turn-metadata"]`，否则服务器拒绝请求；
2. `initialize` 必须声明 `elicitation` 能力，否则浏览器与应用授权请求无法发送；
3. 服务端返回的 `elicitation/create` 授权请求必须被应答，否则服务端报告
   `The approval request did not return a valid decision`。

另外，Codex 每次重启都会改写 `codex-computer-use-<GUID>` 管道名和运行时哈希。因此，写死的
配置必然失效。

本插件内置上述行为（`lib/mcp-bridge.js` + `lib/codex-config.js`），并在每次使用前重新读取对应
服务器的源码。启动环境原样传入：浏览器服务器使用 `.mcp.json` 的值，桌面服务器使用
`config.toml` 的值；启动方式与 Codex 应用一致。

`initialize` 与原生 Codex 一致：协议版本为 `2025-06-18`，elicitation 同时声明 `form` 与
`url` 两种能力。插件没有供用户打开网址的界面，因此 `url` 形式的授权请求一律拒绝；
`clientInfo` 仍为 `dsh-pc-use` 与插件版本。

## 前置条件

- Codex 桌面应用必须正在运行。两个服务器都连接该应用的原生管道。
- Chrome 扩展必须已连接，使 `pc_codex_js` 中的 `await cua.listBrowsers()` 能看到
  `Chrome / type=extension`。
- 桌面操控要求 `<codexHome>/config.toml` 包含 `[mcp_servers.node_repl]` 节。缺少该节时，只有
  桌面工具报错，错误信息会写出节名。
- 仅在 Windows 上验证过。Codex 的 Computer Use 在 Windows 上使用 `sky` 原生管道。

## 安装

按官方流程（[打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)）：包已声明 `dsh.bundle`，因此用 `dsh plugin` 安装到 profile 即可。

```powershell
dsh plugin --profile desktop add C:\Users\<你>\...\plugins\dsh-pc-use
```

`dsh plugin add` 将包写入 profile 的 `dependencies`，并追加到 `dsh.profile.bundles`。bundle 自带的
`cordis.patch.yml` 负责插入 `pc-use` 行。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-pc-use
```

### 修改配置时不得再次插入

bundle 层已经插入 `pc-use`。在 profile 的 `cordis.patch.yml` 中，**只能按 id 覆盖**，不得再次
`insert`。同一个 id 出现两行会使加载器失败，插件不显示且不报错：

```yaml
- id: pc-use
  config:
    autoApprove: true   # 只自动接受浏览器访问授权，其余审批仍会 decline 并写日志
    logFile: 'C:\Users\<你>\.dsh\pc-use.log'
    # 注意：patch 是整块替换 config，不是深合并；没写的键会回到上表的默认值
```

`dsh --profile desktop --dump-config` 在 Electron 托管的 profile 上会被拒绝。验证层顺序请使用
桌面端的插件面板。

## 配置

全部字段可选，写入 `cordis.patch.yml` 的 `config:` 块。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 值为 `false` 时不注册任何工具 |
| `autoApprove` | `false` | 只自动接受浏览器访问授权请求；其他 elicitation 请求一律拒绝（fail-closed） |
| `computer` | `false` | 开启 Windows 桌面应用操控（Codex Computer Use）；是否显示卡片由 DSH 的权限模式决定 |
| `rememberDesktopApprovals` | `true` | 同一个 DSH 会话内，用户允许某个应用一次后，后续请求不再询问；拒绝不会记住 |
| `language` | `'auto'` | 插件界面文字的语言：`auto` 跟随 DSH 界面语言，或强制使用 `zh` / `en` |
| `codexHome` | `''` | 空值表示 `%USERPROFILE%\.codex` |
| `logFile` | `''` | 桥接日志路径；空值表示 `~/.dsh/pc-use.log` |
| `timeoutMs` | `120000` | 单次调用超时 |
| `attachImages` | `true` | 模型声明支持图片输入时，将截图作为图片附加；截图会发送给模型服务商，按 DSH 0.2.1-rc.2 源码默认经 Files API 上传，有效期为 7 天，DSH 会话结束时不删除；本机 DSH 附件库另存一份；不需要上传时关闭 |
| `keepImageFiles` | `false` | 附加图片时，同时在本机 `~/.dsh/pc-use-images` 保存一份；默认只由 DSH 附件库保存 |
| `allowUserTabs` | `false` | 允许读取用户的浏览器标签页与浏览历史；覆盖的入口见下文 |
| `prefetchServerDocs` | `true` | 缓存缺失或过期时启动后预取说明；下次启动生效 |
| `tools` | 全开 | `{ js, reset, desktopJs, desktopReset, desktopAddNodeModuleDir, observe, runPlan, docs, status }` 逐项开关 |
| `tools.desktopJs` | `true` | 注册 `pc_codex_desktop_js`：在桌面 `node_repl` 中执行 JS（需要 `computer: true`） |
| `tools.desktopReset` | `true` | 注册 `pc_codex_desktop_js_reset`：重置桌面 JS 内核 |
| `tools.desktopAddNodeModuleDir` | `true` | 注册 `pc_codex_desktop_js_add_node_module_dir`：将 Node 模块目录加入桌面 `node_repl` |
| `tools.observe` | `true` | 注册 `pc_codex_observe`：输出完整无障碍树；例行判断在代码中取值 |
| `tools.runPlan` | `true` | 注册 `pc_codex_run_plan`：回退实现；需要逐步状态或失败后自动观察时使用 |
| `tools.docs` | `true` | 注册 `pc_codex_docs`：读取 Codex 自带的 Computer Use 文档（不需要 Codex 连接） |

`prefetchServerDocs` 只在缓存的工具说明缺失或过期时，于 DSH 启动后在后台连接 Codex 服务器取说明；
与设置页开关一样只在启动时读取，改动在 DSH 下次启动时生效。

`allowUserTabs` 控制 `browser.user.openTabs`、`browser.user.claimTab`、
`browser.user.getTabContext`、`browser.history`、`cua.getTab`、`cua.getState`、
`browser.tabs.get` 与 `browser.tabs.content`。关闭时，前四项调用报错并说明原因；
`cua.getTab`、`browser.tabs.get`、`browser.tabs.content` 只接受插件标签页；
`cua.getState` 只列出插件标签页。`browser.tabs.list` 与 `browser.tabs.selected`
只涉及插件标签页，原样放行。插件标签页是浏览器内核本次启动后经本插件打开或认领的标签页；
`pc_codex_js_reset` 或浏览器重连后，之前的标签页不再算。同一个 DSH 进程里的所有 DSH 会话
共用同一份插件标签页。打开 `allowUserTabs` 后，标签页标题、网址、页面内容或历史会发送给模型
服务商；仅在用户明确要求时打开。

`autoApprove` / `computer` / `rememberDesktopApprovals` / `language` /
`codexHome` / `logFile` / `timeoutMs` / `attachImages` / `keepImageFiles` /
`allowUserTabs` 可以热更新（volatile）：修改后对之后的调用生效，插件不会重新加载。加载器会
通知 volatile 写入：关闭 `computer` 后，桌面服务器立即停止，浏览器连接不受影响；重新打开后，
下一次桌面调用才启动桌面服务器。`codexHome` 改变后，两个服务器分别在下次调用时重新解析并
重连。`enabled`、`tools.*` 不是 volatile；修改后会重新加载插件，并按新配置注册工具。三个
桌面工具开关默认 `true`，不在设置页上。

`language` 只影响插件显示的文字，包括三选项卡片、一次性卡片的 `displayReason` 和审计 `reason`
的中英两套。`auto` 先读取 DSH 宿主公开的界面语言偏好；读取失败时使用系统语言（`zh` 开头为
中文，否则为英文）。也可以强制使用 `zh` / `en`。一次性授权卡片的 `displayReason` 同时包含
中文与英文；无论 `language` 为何，DSH 客户端都按界面语言选择显示。

每一次审批都会写入日志。`logFile` 为空时，日志写入 `~/.dsh/pc-use.log`；插件不再只调用
`console.warn`。日志记录原始文案、决定与原因，例如：

```
approval "Allow Browser use to access https://www.bilibili.com?" -> accept (browser access auto-approved)
```

- `autoApprove: false`（默认）：浏览器授权请求一律拒绝，原因记为 `auto-approve is off`；
- `autoApprove: true`：只有浏览器访问授权请求会接受（原因 `browser access auto-approved`），
  其他请求一律拒绝，原因记为 `not a browser-access approval`；
- 桌面授权请求不适用 `autoApprove`：`computer: false` 时一律拒绝（`computer use is off`）；
  `computer: true` 时交由 DSH 审批，结果写入日志（`approved in DSH` / `rejected in DSH` /
  `approval cancelled` / `approval unavailable`）。没有审批服务，或没有正在运行的
  `pc_codex_desktop_js` 调用时，一律拒绝。

如果 Codex 修改授权请求文案，浏览器与桌面授权请求都会被拒绝。这是安全的失败方式。

## 工具与用法

安装后，每个 agent preset 自动拥有：

| 工具 | 服务器 | 作用 |
|---|---|---|
| `pc_codex_js` | 浏览器 | 首选：在持久 `cua_repl` 内核中执行一段带检查的程序，读取无障碍值并使用 `cua` API 操作网页 |
| `pc_codex_js_reset` | 浏览器 | 重置浏览器 JS 内核（不关闭标签页） |
| `pc_codex_desktop_js` | 桌面 | 首选：在持久 `node_repl` 内核中执行一段带检查的程序，读取无障碍值并使用 `sky` API 操作桌面应用 |
| `pc_codex_desktop_js_reset` | 桌面 | 重置桌面 JS 内核（不关闭应用） |
| `pc_codex_desktop_js_add_node_module_dir` | 桌面 | 将 Node 模块目录加入桌面 `node_repl` |
| `pc_codex_observe` | 浏览器 / 桌面 | 只读输出完整无障碍树或文本，用于了解整体界面；截图默认关闭 |
| `pc_codex_run_plan` | 浏览器 / 桌面 | 回退实现：需要逐步状态或失败后自动观察时，执行 1–20 步 |
| `pc_codex_docs` | 无 | 读取本机 Codex 自带的 Computer Use 文档（`skill` / `guidance` / `api` / `confirmations`） |
| `pc_status` | 无 | 报告两个服务器的解析结果与连接状态；其他工具失败时先检查该工具 |

与原生 MCP 调用一一对应的 5 个工具（`pc_codex_js`、`pc_codex_js_reset`、
`pc_codex_desktop_js`、`pc_codex_desktop_js_reset` 与
`pc_codex_desktop_js_add_node_module_dir`）会在服务器原文前加原生的结果头部：
`Wall time: <秒，四位小数> seconds` 与 `Output:`。插件不截断结果；DSH 的 spill-policy
已按 token 预算限制工具结果，并把全文存成文件供找回。`pc_codex_observe` 与
`pc_codex_run_plan` 是插件组合的工具，不加这个头部。

### 选择工具

1. **首选**：将已知的连续步骤写入 `pc_codex_js` 或 `pc_codex_desktop_js` 的同一段程序。程序
   使用 `if`、循环与断言检查中间结果；检查不成立时 `throw` 并说明原因；结束时只使用
   `nodeRepl.write(...)` 或 `console.log(...)` 打印下一步决策所需的信息。
2. 在代码中读取无障碍树的值（按钮是否可用、输入框的值、当前选中项等）并判断，不依赖
   截图。浏览器使用 `tab.getAXState`，桌面使用 `sky.get_window_state` 返回的 accessibility
   数据。程序在代码中过滤，只打印需要的字段。
3. 改变界面的步骤之后，下一段代码先重新读取状态，不沿用旧的元素索引或坐标。
4. `pc_codex_run_plan` 是回退实现：需要逐步状态报告，或失败后仍需自动观察时使用。每步的
   code 也可以包含条件与断言。每一步、每个 check 分别受单次调用超时限制。
5. 需要查看完整界面时，使用 `pc_codex_observe`。

### 工具说明来自 Codex 服务器

5 个 js 类工具（`pc_codex_js`、`pc_codex_js_reset`、`pc_codex_desktop_js`、
`pc_codex_desktop_js_reset` 与 `pc_codex_desktop_js_add_node_module_dir`）的说明来自 Codex
服务器：`initialize` 返回的 `instructions`、`tools/list` 中对应服务器工具的 `description`，
以及把它们映射为 DSH 工具名的插件规则。其余 4 个工具仍使用插件自己写的说明。插件把这些
文字缓存在 `~/.dsh/pc-use-server-docs.json`。缓存缺失或已过期（例如 Codex 更新后）时，
插件先用内置说明启动，服务器说明在 DSH 下次启动时生效。连接后发现服务器说明有变化时，
每个 DSH 会话在下一次成功的 `pc_codex_js` 或 `pc_codex_desktop_js` 结果末尾收到一次新说明。
`prefetchServerDocs`（默认开启）只在缓存缺失或过期时，于启动后在后台连接服务器取说明；
改动在 DSH 下次启动时生效。缓存只保存说明文字与哈希，不保存命令、参数、环境变量、路径或
管道名。

### Codex computer-use skill

当 `computer` 开启且桌面 js 工具（`tools.desktopJs`）启用时，插件把本机 Codex 安装中的
computer-use skill 以 `codex-computer-use` 的名字注册进 DSH 的 skill 目录。正文在 DSH
列出或加载该 skill 时从
`<codexHome>/plugins/cache/openai-bundled/computer-use/<版本>/skills/computer-use/SKILL.md`
读取，因此不会复制进本仓库。插件在正文后附加 DSH 说明：列出桌面工具名
（`pc_codex_desktop_js`、`pc_codex_desktop_js_reset`、`pc_codex_desktop_js_add_node_module_dir`），
并把 `docs/` 下的文档对应到 `pc_codex_docs` 的主题。

## 设置页

DSH 设置侧栏的“插件市场”下方有“电脑操控”页（条目 id `pc-use`；仅当 Host 提供该条目时
显示）。该页可以修改：

- **桌面操控**：`computer`、`rememberDesktopApprovals`；
- **浏览器**：`autoApprove`、`allowUserTabs`；
- **通用**：`language`、`timeoutMs`（秒，10–3600，按毫秒保存）、`attachImages`、
  `keepImageFiles`、`prefetchServerDocs`、`codexHome`、`logFile`。

开关与下拉框修改后立即保存；文本框与数字框在失焦或按回车时保存。文本与下拉行在用户修改后
显示“恢复默认”：`language`、`timeoutMs`、`codexHome`、`logFile`。开关行不显示该按钮；
0.5.3 已从 `computer`、`rememberDesktopApprovals`、`autoApprove`、`allowUserTabs` 四个开关行
移除，其他开关行也不渲染。`enabled` 与 `tools.*` 不在页面上：启用插件请前往“内置插件”或插件
管理器，工具开关请修改 profile。三个桌面工具开关（`tools.desktopJs`、`tools.desktopReset`、
`tools.desktopAddNodeModuleDir`）与其他 `tools.*` 一样不在页面上。`codexHome` 是 volatile：
修改后，下一次调用会重新解析并连接到新的 Codex 目录，插件不会重新加载。

设置读取完成前，该页显示骨架：分组、标题、行与控件外框均与读取完成后相同。读取完成后只
显示控件内容，布局不跳动。`unavailable` 或读取到非法值时，显示“读取失败”。

已知局限：`language` 不是 `auto` 时，读取完成后文字会切换为所选语言；文本或下拉行存在用户
覆盖值时，会出现“恢复默认”，该行控件区随之变宽。上述两种情况下，读取完成后行高或控件区宽度
可能变化，页面会移动。

## 桌面操控

Windows 桌面应用操控默认关闭。自 0.5.0 起，浏览器与桌面是两个 Codex 服务器，启动方式与
Codex 应用一致：

- **浏览器服务器**是 Codex 的 `cua_repl`，来源为
  `<codexHome>/plugins/cache/openai-bundled/unified-computer-use/<版本>/.mcp.json`；
- **桌面服务器**是 Codex 的 `node_repl`，来源为 `<codexHome>/config.toml` 的
  `[mcp_servers.node_repl]`。

`pc_codex_js` / `pc_codex_js_reset` 使用浏览器服务器；`pc_codex_desktop_js` /
`pc_codex_desktop_js_reset` / `pc_codex_desktop_js_add_node_module_dir` 使用桌面服务器。两者
均为懒启动：桌面服务器在第一次桌面调用时启动，`computer` 为 `false` 时永不启动。关闭
`computer` 后，桌面服务器立即停止（由加载器的 volatile 更新事件触发），浏览器服务器继续
运行。每次调用前，插件重新读取该服务器自身的来源，因此 Codex 重启后按服务器分别更新。启动
环境原样传入：浏览器环境来自 `.mcp.json`，桌面环境来自 `config.toml`，与 Codex 应用的启动
方式一致。0.4.x 改写环境的做法已删除。

开启方式：在 profile 的 `cordis.patch.yml` 中设置，修改后重启桌面应用。实测 DSH 桌面版
0.2.1-rc.2 的“设置 → 内置插件”页只显示插件状态，不显示配置表单。patch 会整体替换
`config:` 块，因此必须一并写入原有的键。

```yaml
- id: pc-use
  config:
    computer: true
```

首次用 `sky` 操作某个桌面应用时，Codex 会发送授权请求。插件识别两种桌面授权请求文案：
`Allow Codex to use <应用名>?`（桌面版实测所用）和 `Allow Computer Use to use "<应用名>"?`。
录音请求 `Allow Computer Use to record computer audio?` 不在识别范围内，会被拒绝。桌面授权
请求归属于最早开始且仍在运行的 `pc_codex_desktop_js` 或
`pc_codex_desktop_js_add_node_module_dir` 调用；没有这类调用时，直接拒绝，日志原因写为
`no active pc_codex_desktop_js call`。一个服务器收到不属于该服务器的授权请求类型时，一律拒绝并
记录日志（`unexpected approval for the browser server` /
`unexpected approval for the desktop server`）。插件将桌面授权请求转换为 DSH 提示（三选项
卡片或一次性审批卡片，见下文）；`autoApprove` 不适用于桌面授权请求。

插件会在同一个 DSH 会话内记住用户的桌面审批：用户允许某个应用一次后，后续请求不再询问，
日志原因写为 `approved earlier in this DSH session`。插件只记住“允许”；拒绝、取消或失败不会
记住。插件记住某个应用时，回复 Codex 也会带 `_meta: { persist: "session" }`，让服务器在同一
会话内也记住，此后到下一次桌面服务器启动前不再发来这些请求，这些使用也不会出现在授权日志
里。插件不提供“始终允许”。以下情况会重新询问：桌面桥接重连（例如切换 `computer`、
`node_repl` 变化或进程重启）、新建 DSH 会话，或将 `rememberDesktopApprovals` 设为 `false`；
关闭该开关会重启桌面服务器，插件与服务器两边的记忆都会清空（桌面 JS 内核也会重置）。
浏览器桥接重连不会清空已记住的桌面审批。若需立即重新询问，最可靠的方式是新建 DSH 会话或
切换一次 `computer`。注意：如果用户之后收紧权限模式，本 DSH 会话内已记住的应用仍会放行。

桌面审批默认显示 DSH 三选项卡片：`允许这一次`（仅批准这一步，不记住）、
`本次会话内允许`（同一 agent、同一应用在本次 DSH 会话内不再询问；重新连接或重启后失效）和
`拒绝`（拒绝）。第二项仅当 `rememberDesktopApprovals` 开启且请求的 `_meta.persist` 包含
`session` 时出现；审批策略为 `never`（“完全权限”）或无法获取提问服务时，使用一次性 DSH
审批卡片。用户输入自定义文字、未选择、选择未知文字或提问服务出错时，均按拒绝处理。卡片
文字跟随 `language`；旧的一次性卡片由 DSH 客户端按界面语言显示中文或英文。

每轮 DSH 轮次结束时，插件使用同一 agent 的 Codex `session_id` / `turn_id` 调用
`turn_ended`（正常结束为 `Stop`，中途停止为 `Interrupt`，子 agent 为 `SubagentStop`），对
每个仍连接的服务器各调用一次，不论本轮是否用过它——原生 Codex 也是如此。该调用使 Codex
收起屏幕上“正在使用你的电脑”的橙色光圈，并结束该轮。桥接未连接的服务器不发送该调用，也不会
为它启动服务器；插件卸载后不再发送。桥接重连后，下一轮从新的 `turn_id` 开始；重建的连接仍会
收到刚结束这一轮的调用。桌面光标只在“本轮用过桌面桥接且该桥接未重建”时关闭。

### 先读 Codex 自带文档：`pc_codex_docs`

Codex 的 computer-use 插件自带一份 skill 和三份文档。本插件不复制、不打包这些文件。
`pc_codex_docs` 每次调用都从本机 Codex 安装
（`<codexHome>/plugins/cache/openai-bundled/computer-use/`）读取原文，并在前面附加一行来源和
DSH 工具对照，原样返回。Codex 更新后内容随之更新；目录或文件不存在时，错误信息会写出期望
路径。这些文档属于 OpenAI（Proprietary），仅在本机读取，不随插件分发。

`topic` 取 `skill`（入口）、`guidance`（运行规则、目标窗口、截图、恢复）、
`confirmations`（需要用户确认的动作）、`api`（完整 `sky` API）。该工具不需要 Codex 连接，
`computer: false` 时也会注册。

在 `pc_codex_desktop_js` 中使用（需 `computer: true` 且桌面连接已建立）：

```js
const { sky } = await import('@oai/sky');
await sky.list_apps();
```

`sky` 还提供截屏、点击、输入等桌面操作；具体 API 见 `pc_codex_docs` 的 `api` 文档。

**风险提示：** 桌面操控的权限大于浏览器：桌面操控可以读取屏幕、移动鼠标，并向任意应用发送输入。
该功能默认关闭，仅在用户要求时开启。桌面审批遵循 DSH 的审批策略：在“完全权限”模式下，
DSH 不询问并直接放行；如需逐次确认，请使用“仅可查看”或“工作区内修改”。Codex 也可能记住
此前的授权而不再询问。`autoApprove` 不适用于桌面授权请求。

## 截图与隐私

仅当 `attachImages` 开启且当前模型声明支持图片输入时，Codex 返回的截图才会作为图片附加；
否则退回本机路径文字。`pc_codex_run_plan` 失败后留下的图片也按路径文字保存，原因写为
`tool call failed`。

附加图片会将截图发送给模型服务商。按 DSH 0.2.1-rc.2 源码，默认经 Files API 上传：文件
有效期为 7 天，DSH 会话结束时不删除。DSH 本机附件库还会保存一份；保持 `keepImageFiles: false`
（默认）可避免在 `~/.dsh/pc-use-images` 再保存第二份。

每张图片约消耗 184–1024 个输入 token；历史中的图片每轮都会重新发送。可在 DSH 设置中使用
`imagePixelBudget` 限制图片大小；插件不修改该设置。如果截图不能离开本机，请关闭
`attachImages`。

## 提供方

目前只有 Codex 提供方：`pc_codex_*` 工具通过本机 Codex 桌面应用执行。命名已为其他提供方预留：
只属于 Codex 的工具使用 `pc_codex_` 前缀，以后 Claude 的 computer use 会以 `pc_claude_`
前缀与之并列。`pc_status` 的顶层按 `providers` 分组，当前只有 `providers.codex`；其内部再
分别报告 `browser` 与 `desktop` 两个服务器。配置键暂时保持扁平（`codexHome` 等）；等第二个
提供方有具体设计后，再决定是否分组。

## 工具调用元数据

每次 `tools/call`（`turn_ended` 除外）都携带一个 `_meta`，其中只填写 DSH 能如实给出的值。
字段集合依据 Codex 0.163.0-alpha.10.2 的源码分析。r1 的 capture-native 没有录到线上 Codex 的
`tools/call`，因此**这些结论来自源码，未经线上核实。**

需要发送的字段：

- `x-codex-turn-metadata.session_id` / `.thread_id`：插件为每个 agent 生成的 UUID（原生根线程的
  `thread_id` 等于 `session_id`）。
- `x-codex-turn-metadata.turn_id`：当前 DSH 轮次的 UUID；DSH 轮次结束时轮换。
- `x-codex-turn-metadata.turn_started_at_unix_ms`：该 turn 身份创建时刻的 Unix 毫秒（整数）；
  同一轮内不变，轮换后变大。
- `x-codex-turn-metadata.auto_review_enabled`、`.node_repl_auto_review_required`、
  `.node_repl_disabled`：恒为 `false`；DSH 没有 Guardian 审查，能够调用到这里说明没有禁用。
- `x-codex-turn-metadata.model`：DSH 当前 agent 的模型 id，取自 DSH agent 循环为最近一次请求
  记录的请求头；无法获取时省略。
- `x-codex-turn-metadata.reasoning_effort`：同一请求头中的推理强度；无法获取时省略。
- `threadId` / `sessionId`：同一 agent 身份，按原生 camelCase 放在顶层。
- `callId`：DSH 的工具调用 id（`exec.callId`）；执行上下文没有该值时省略。
  `pc_codex_run_plan` 的每个步骤和 check 使用同一个 id。

以下字段**不发送**：DSH 没有可如实填写的值；编造这些值会冒充 Codex，或清除服务器自身的
默认值。字段为：`codex_version`、`sandbox`、`sandbox_mode`、`plugin_id`、`windowId`、
`itemId`、`forked_from_thread_id`、`parent_thread_id`、`subagent_kind`、`thread_source`、
`turn_trigger`、`workspaces`、`user_input_requested_during_turn`、`traceparent`、
`tracestate`、`codex_bridge_mcp_call_id`、`openai/readOnly`、`openai/entitlementContext`、
`_codex_apps`、`codex/sandbox-launcher`、`openai/confirmation_policies`、
`codex/sandbox-state`、`codex/sandbox-state-meta`。其中，发送
`openai/confirmation_policies: {}` 会清除服务器启动时的确认策略默认值；填写
`codex/sandbox-state` 等于替 DSH 声明一个服务器会如何使用并不清楚的沙箱状态。

`turn_ended` 使用原生 `_meta`：只有 `threadId`（该 agent 的 Codex 会话 id），没有
`x-codex-turn-metadata`。

## 验证

```js
await cua.listBrowsers();
```

也可以先调用 `pc_status`，查看 `providers.codex`。该对象包含 `codexHome`、`autoApprove`、
`computer`，以及 `browser` 与 `desktop` 两节。每节报告 `resolved`、`reason`、`source`、
`command`、`cwd`、`nativePipe`、`connected`、`services`、`serverInfo`、`pluginVersion` 与
`nativePipeState`。`serverInfo` 是 `initialize` 返回的 MCP 库名称与版本（未连接时为 null，
每个值最多 200 个字符）；Codex 的两个服务器目前都报 `rmcp`，因此它不是 Computer Use 的
版本；
浏览器插件的版本看 `pluginVersion`（即 `unified-computer-use/<版本>` 目录，桌面侧或来源
解析失败时为 null）。`nativePipeState` 不会连接管道本身，取值为 `present`、`missing`、
`check failed`，未配置管道时为 null；它描述下一次连接会用的管道。桌面调用报
`native pipe is unavailable`，或 `nativePipeState` 为 `missing` 时，请完全退出并重新打开
Codex 应用；不要手改配置里的管道。第一次连接之前，`connected` 为
`false`，`services` 为 `null`，这属于正常状态；来源解析失败时，`resolved` 为 `false`，
`reason` 写出缺失的 `.mcp.json` 或 `config.toml` 节。旧的 `servicesFrom` 字段已在 0.5.0
删除。命令行冒烟测试：

```powershell
npm run test:smoke
```

冒烟测试会连接 Codex，并操作真实 Chrome。

`npm test` 运行离线回归检查；`npm run test:smoke` 会连接 Codex，并操作浏览器。

## 实现

- `index.js`：cordis 插件：`defineTool` + `parameters` DSL 声明工具、导出
  Schemastery `Config`、两个懒启动的桥接（浏览器与桌面）、按服务器分开的审批与轮次、
  `ctx.effect` 清理
- `client.js`：浏览器侧：“电脑操控”设置页（`settings.section`）、控件与中英文界面字典
- `lib/text.js`：插件自己显示的中英文字（三选项卡片、`displayReason`、审计 reason、配置说明），两套键一致
- `lib/config-value.js`：解包 cordis 加载器传入的 `Volatile` 配置值
- `lib/define-tool.js`：`defineTool` 的可移植回退实现：将参数 DSL 转换为对象 JSON Schema，并在 `execute` 前校验参数
- `lib/images.js`：保存工具结果中的截图：按 mimeType 取扩展名，保存后只保留最新 50 个文件
- `lib/codex-config.js`：解析两套启动配置：`resolveBrowserServer` 读取最新的 `cua_repl`
  `.mcp.json`，`resolveDesktopServer` 读取 `config.toml` 的 `[mcp_servers.node_repl]`；
  每次调用前重新读取
- `lib/mcp-bridge.js`：极简 MCP stdio 客户端：注入 turn metadata、声明 elicitation、按策略应答授权请求、超时后通知取消
- `lib/approval.js`：审批判定：浏览器授权请求按 `autoApprove` 处理，桌面授权请求交给 DSH，其余请求一律拒绝并给出原因
- `locale/en.json` / `locale/zh.json`：插件管理页的显示名与描述（`PC Use` / `电脑操控`）
- `icon.svg`：原创的窗口加指针图标，不引用外部资源
- `cordis.patch.yml`：bundle 层，按包名将插件插入每个 preset

进程采用**懒启动**方式：加载插件本身不会 spawn 任何进程；Codex 未安装也不会影响 profile
启动；错误只在真正调用工具时出现。浏览器服务器在第一次浏览器调用时启动，桌面服务器在第一
次桌面调用时启动。

## `defineTool` 的回退实现

`dsh plugin add` 安装的是 `link:` 目录，插件从**工作区路径**加载。DSH 桌面版 0.2.1-rc.2 的
profile 设置了 `autoInstallPeers: false`，也没有通用的 `@deepseek-ai` 解析钩子。因此，以
`link:` 安装时，插件无法解析宿主包（`@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` /
`@deepseek-ai/cordis`），始终使用 `lib/define-tool.js` 的回退实现。该回退实现已与宿主原生
`defineTool` 核对一致：将参数 DSL 转换为对象 JSON Schema，并在执行前校验参数。

0.1.0 曾出现以下问题：无法获取 `defineTool` 时，插件直接将参数 DSL
（`{ code: { type: 'string', required: true } }`）作为 JSON Schema 注册。模型请求中出现非法
schema（属性带有 `required`，根缺少 `type: object`），DeepSeek 直接拒绝**整轮**请求。
`npm test` 会在离线环境断言每个已注册工具都发布合法的对象 JSON Schema。

只有插件目录中安装了 `@deepseek-ai/schemastery` 后，设置界面才会显示这些开关。这是插件自身
devDependency 带来的效果：本地执行 `npm install` 后，插件目录中才会有一份。发布与安装方式
需要考虑这一点。桌面版 0.2.1-rc.2 实测不显示配置表单，`computer` 等配置仍需在 profile 的
`cordis.patch.yml` 中修改。三个桌面工具开关也只能在 profile 中修改。

## 已知限制

- 非官方用法：Codex 更新可能改变 `.mcp.json` 或 `config.toml` 的结构，或改变管道机制。失效
  时先检查 `pc_status` 和 `logFile`。
- 部分 Windows 版本上，Codex 对某些应用（例如记事本、计算器）不返回无障碍树，即使
  `include_text: true` 也是如此（openai/codex#52319）。此时插件提示模型改用截图；模型不得
  为查找原因而读取日志、配置或在磁盘上搜索；截图不足时，模型应停止并告知用户。
- 浏览器 `cua.listTabs()` 受守卫包装：只返回插件标签页，用户的其他标签页会被过滤。插件标签页
  是浏览器内核本次启动后经本插件打开或认领的标签页；`pc_codex_js_reset` 或浏览器重连后，
  之前的标签页不再算；同一个 DSH 进程里的所有 DSH 会话共用同一份插件标签页。守卫只防误用，
  不是安全边界；前置守卫也会使模型代码报错的行号发生偏移。
- `allowUserTabs`（默认关闭）覆盖经 `cua.getBrowser` 或
  `cua.browsers.{get,getDefault,getForUrl}` 得到的 `Browser` 上的
  `browser.user.openTabs`、`claimTab`、`getTabContext`、`browser.history`，以及
  `cua.getTab`、`cua.getState`、`browser.tabs.get`、`browser.tabs.content`。
  `browser.tabs.list` 与 `browser.tabs.selected` 只涉及插件标签页，原样放行。
  该守卫只防误用，不是安全边界：模型代码可以改写包装读取的 Symbol。对象被冻结时，关闭开关
  后读取 `browser.user` 或 `browser.history` 会直接报拦截错误。
- 自动审批只识别 `Allow Browser use to access <origin>?` 这一文案。Codex 修改文案后，浏览器
  授权请求会被拒绝（fail-closed），被拒绝的原文会写入日志。
- 对桌面授权请求，插件只识别 `Allow Computer Use to use "<名称>"?` 和
  `Allow Codex to use <名称>?` 两种文案。文案修改后，请求会被拒绝。桌面操控默认关闭；是否显示卡片由 DSH 的权限模式决定：
  “完全权限”直接放行，“仅可查看”/“工作区内修改”逐次确认；Codex 也可能记住授权而不再
  询问。
- 每个服务器最多维持一个连接（浏览器一个、桌面一个）。插件被卸载或进程退出时，两个子进程
  会一起结束。
- 回退实现接受 `string`、`number`、`boolean`、`array`、`object`；仅校验传入值是否为声明的顶层
  类型（`number` 还要求有限）。不校验数组元素或对象内部字段；需要嵌套校验时，必须在宿主中
  真正获取 `defineTool`。

## 变更记录

变更记录见 [CHANGELOG.zh.md](CHANGELOG.zh.md)，英文版为 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

Apache-2.0。版权行：Copyright 2026 Aruir。

见 [LICENSE](LICENSE)。
