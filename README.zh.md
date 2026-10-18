# dsh-pc-use

[English](README.md) | 中文

## 改名说明（0.4.0）

- 包名与插件 id：`dsh-codex-cu` → `dsh-pc-use`，`id: codex-cu` → `id: pc-use`；
- 工具名：`codex_js` / `codex_js_reset` / `codex_js_add_node_module_dir` / `codex_status`
  改为 `pc_codex_js` / `pc_codex_js_reset` / `pc_codex_js_add_node_module_dir` / `pc_status`，
  并新增 `pc_codex_docs`；
- 默认日志 `~/.dsh/codex-cu.log` → `~/.dsh/pc-use.log`，默认截图目录
  `~/.dsh/codex-cu-images` → `~/.dsh/pc-use-images`；
- **profile 里的覆盖要改 id：**`- id: codex-cu` 必须改成 `- id: pc-use`，否则不再生效；
- 0.4.1 起不再使用状态文件；旧日志与截图目录不迁移；
- 没有采用 `dsh-computer-use`：npm 上已有同名的其他 DSH 插件，插件市场按包名查更新时
  可能误替换，所以改名为 `dsh-pc-use`。

0.4.0 新增：改名为 `dsh-pc-use`；新增 `pc_codex_docs` 读取 Codex 自带文档；按包名加载并补上
显示名与图标；`pc_status` 改为按后端分组（`backends`）。

0.6.0 把“界面文字”的原生下拉框换成 DSH 官方的 primitives Menu（圆角按钮、向下箭头与 hover
样式，style 只注入一次）；拿不到 primitives/Menu 时退回原生 select。同时删去
`desktopApprovalChoices` 开关——这是公共配置 API 的不兼容修改——桌面授权固定用三选项卡片，
只保留拿不到提问服务与策略不是 `ask` 的两种降级。仍带旧字段的 profile 照常加载：DSH 的非
strict schema 会保留这个未知键，插件不再读取它，可以留待以后清理。页面顶部改为照官方“通用”页：
不再有页标题和说明，“已保存”只留给读屏软件，冲突提示仍然可见。同时修复实测问题：用 Codex
原生管道结束桌面轮次以收起光圈；补上“不要重试”“去掉顶层 return”“任务结束关闭应用”的提示；
`pc_status` 每次重读启动配置并给出 `reconnectPending`；记录日志写入失败；设置页跟随“界面文字”；
“恢复默认”只在值不同时显示；清空文本框提交 `unset`；测试结束删除临时目录。

0.5.5 精简设置页文字：第一行改为“启用桌面操控”，页说明与页脚各留一句；“界面文字”移到最后的
“通用”组。

0.5.4 把设置页间距对齐 DSH 自带设置页：页标题 16/500/24、说明 14/22、行标题与行说明设行高、
组间 12 px、行间无空隙、每组最后一行不画分隔线。

0.5.3 去掉四个开关行的“恢复默认”（开关拨回去即可）；开关拨回默认值时改为删除已保存的覆盖，
而不是再写一条同样的值。

0.5.2 把“已保存”移到设置标题同一行的右侧，把“恢复默认”移到控件左边：提示出现时不再推动
选项，各行控件的右边缘对齐。

0.5.1 修正设置页开关：滑块改用 DSH 主题里真实存在的变量，开与关清晰可见；开关不再被“恢复默认”
挤窄。

0.5.0 把浏览器与桌面拆成两个服务器，按 Codex 应用的方式分别启动：浏览器用 `cua_repl`，桌面用
`node_repl`。新增桌面工具 `pc_codex_desktop_js`、`pc_codex_desktop_js_reset` 与
`pc_codex_desktop_js_add_node_module_dir`（开关 `tools.desktopJs` / `tools.desktopReset` /
`tools.desktopAddNodeModuleDir`，默认全开）；`pc_status` 改为分别报告 `browser` 与 `desktop`，
删除 `servicesFrom`；两个服务器各用自己的启动环境。

0.4.3 新增：DSH 设置侧栏“插件市场”下方的“电脑操控”设置页，可改桌面操控、三选项卡片、记住授权、
界面文字、浏览器自动授权、调用超时、Codex 配置目录与日志路径；`codexHome` 改为 volatile，改完下一次
调用即重新解析并换到新目录，插件不重新挂载。

0.4.2：修复三处实测问题——`turn_ended` 的 `_meta` 用了下一轮 turn id、等待授权的时间计入
调用超时、Codex 重启后仍连着旧桌面助手管道；桌面授权改为三选项卡片（授权策略为“完全权限”时
沿用原一次性卡片）；加入英文支持（`language` 控制插件
自己显示的文字，默认 `auto` 跟随 DSH 界面语言）。

0.4.1 修正：删除 `pc_codex_js_add_node_module_dir` 工具、`tools.addNodeModuleDir` 与
`stateFile` 配置项；桥接级 `session_id` 改为内存随机生成，不再读写状态文件；旧配置里的这些键
照常加载。

0.3.2 修正：同一 DSH 会话内按应用记住桌面授权（`rememberDesktopApprovals`）；每轮结束通知
Codex `turn_ended`，收起“正在使用你的电脑”的橙色光圈。

0.3.1 修正：补充桌面授权与 DSH 权限模式的说明；`codex_status`（现为 `pc_status`）增加
`servicesFrom`；测试夹具移入 `test/fixtures`。

0.3.0 新增：Windows 桌面操控（`computer`，默认关闭；桌面授权交给 DSH 的审批策略）。

0.2.0 修正：

- 参数 schema 兜底：拿不到宿主 `defineTool` 时把参数 DSL 转成对象 JSON Schema，并在执行前校验参数；
- volatile 配置修复：正确解包加载器传入的 `Volatile` 配置值，`autoApprove` / `logFile` / `timeoutMs` 改完即生效；
- 审批默认 fail-closed：`autoApprove` 默认 `false`，且只自动接受浏览器访问授权，其他 elicitation 审批一律 decline；
- 审批日志：每一次审批都记录原始文案、决定（accept/decline）和原因，默认写入 `~/.dsh/pc-use.log`；
- 截图清理：工具返回的截图保存到 `~/.dsh/pc-use-images`，扩展名按 mimeType 决定，目录只保留最新的 50 个文件；
- 握手失败清理：initialize 出错、超时或 spawn 失败时结束子进程，不会把没握手的连接当成可用；
- 客户端版本号取自 `package.json`，不再硬编码。

`npm test` 运行离线回归检查；`npm run test:smoke` 会连接 Codex 并操作浏览器。

把 **Codex Computer Use** 做成 DeepSeek Harness 的原生工具插件：用本机 Codex 通过浏览器服务器
（`cua_repl`）操作真实的 Chrome，通过桌面服务器（`node_repl`）操作 Windows 桌面应用，不需要任何
手工 MCP 配置。目前后端是 Codex，以后会增加其他后端（见“后端”一节）。

装好之后，每个 agent preset 自动拥有：

| 工具 | 服务器 | 作用 |
|---|---|---|
| `pc_codex_js` | 浏览器 | 首选：在持久 `cua_repl` 内核里执行一段带检查的程序，读无障碍值并用 `cua` API 操作网页 |
| `pc_codex_js_reset` | 浏览器 | 重置浏览器 JS 内核（不关闭标签页） |
| `pc_codex_desktop_js` | 桌面 | 首选：在持久 `node_repl` 内核里执行一段带检查的程序，读无障碍值并用 `sky` API 操作桌面应用 |
| `pc_codex_desktop_js_reset` | 桌面 | 重置桌面 JS 内核（不关闭应用） |
| `pc_codex_desktop_js_add_node_module_dir` | 桌面 | 把 Node 模块目录加入桌面 `node_repl` |
| `pc_codex_observe` | 浏览器 / 桌面 | 只读输出完整无障碍树/文本，用于了解全貌；截图默认关闭 |
| `pc_codex_run_plan` | 浏览器 / 桌面 | 备选：需要逐步状态或失败后自动观察时执行 1–20 步 |
| `pc_codex_docs` | 无 | 读取本机 Codex 自带的 Computer Use 文档（`skill` / `guidance` / `api` / `confirmations`） |
| `pc_status` | 无 | 报告两个服务器的解析结果和连接状态；其他工具失败时先看它 |

### 选择工具

1. **首选**：把已知的连续步骤写进 `pc_codex_js` 或 `pc_codex_desktop_js` 的同一段程序；
   用 `if`、循环和断言检查中间结果，检查不成立就 `throw` 并说明原因；结束时只用
   `nodeRepl.write(...)` 或 `console.log(...)` 打印下一步决策需要的信息。
2. 在代码里读无障碍树的值（按钮是否可用、输入框的值、当前选中项等）做判断，不要依赖
   截图；浏览器用 `tab.getAXState`，桌面用 `sky.get_window_state` 返回的 accessibility
   数据。在代码里过滤，只打印需要的字段。
3. 改变界面的步骤之后，下一段代码先重新读取状态，不沿用旧的元素索引或坐标。
4. `pc_codex_run_plan` 是备选：需要逐步状态报告、或失败后仍自动观察时使用；每步的
   code 本身也可以包含条件和断言。每一步、每个 check 分别受单次调用超时限制。
5. 需要看完整界面时用 `pc_codex_observe`。

## 为什么需要这个插件

Codex 的两个 computer-use 服务器——浏览器用的 `cua_repl` 与桌面用的 `node_repl`——依赖三件只有
Codex 自己的客户端才会做的事，普通 MCP 客户端接不了：

1. 每次 `tools/call` 要带 `_meta["x-codex-turn-metadata"]`，否则服务端直接拒绝；
2. `initialize` 要声明 `elicitation` 能力，否则浏览器/应用授权请求发不出去；
3. 服务端反向发来的 `elicitation/create` 授权请求要被应答，否则报
   `The approval request did not return a valid decision`。

另外 Codex 每次重启都会改写 `codex-computer-use-<GUID>` 管道名和运行时哈希，配置写死必然失效。

本插件把这几件事都内置了（`lib/mcp-bridge.js` + `lib/codex-config.js`），每次使用前重读对应服务器
的来源。启动环境原样传入：浏览器用 `.mcp.json` 里的值，桌面用 `config.toml` 里的值，与 Codex
应用的启动方式一致。

## 安装

按官方流程（[打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)）：包声明了 `dsh.bundle`，用 `dsh plugin` 装进 profile 即可。

```powershell
dsh plugin --profile desktop add C:\Users\<你>\...\plugins\dsh-pc-use
```

`dsh plugin add` 会把包写进 profile 的 `dependencies`，并追加到 `dsh.profile.bundles`；bundle 自带的 `cordis.patch.yml` 负责插入 `pc-use` 这一行。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-pc-use
```

### 要改配置，别重复 insert

bundle 层已经插入过 `pc-use` 了。在 profile 的 `cordis.patch.yml` 里**只能按 id 覆盖**，不要再 `insert` 一次——同一个 id 插两行会让 loader 挂载失败，插件就静默不出现：

```yaml
- id: pc-use
  config:
    autoApprove: true   # 只自动接受浏览器访问授权，其余审批仍会 decline 并写日志
    logFile: 'C:\Users\<你>\.dsh\pc-use.log'
    # 注意：patch 是整块替换 config，不是深合并；没写的键会回到上表的默认值
```

`dsh --profile desktop --dump-config` 在 Electron 托管的 profile 上会被拒绝，验证层顺序请改用桌面端的插件面板。

## 配置

全部字段都可选，写在 `cordis.patch.yml` 的 `config:` 里。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 则不注册任何工具 |
| `autoApprove` | `false` | 只自动接受浏览器访问授权；其他 elicitation 审批一律 decline（fail-closed） |
| `computer` | `false` | 开启 Windows 桌面应用操控（Codex Computer Use）；是否弹卡片由 DSH 的权限模式决定 |
| `rememberDesktopApprovals` | `true` | 同一个 DSH 会话里，某个应用经你允许一次后不再询问；拒绝不会被记住 |
| `language` | `'auto'` | 插件界面文字的语言：`auto` 跟随 DSH 界面语言，或强制 `zh` / `en` |
| `codexHome` | `''` | 空表示 `%USERPROFILE%\.codex` |
| `logFile` | `''` | 桥接日志路径；空表示 `~/.dsh/pc-use.log` |
| `timeoutMs` | `120000` | 单次调用超时 |
| `tools` | 全开 | `{ js, reset, desktopJs, desktopReset, desktopAddNodeModuleDir, observe, runPlan, docs, status }` 逐项开关 |
| `tools.desktopJs` | `true` | 注册 `pc_codex_desktop_js`：在桌面 `node_repl` 里执行 JS（需要 `computer: true`） |
| `tools.desktopReset` | `true` | 注册 `pc_codex_desktop_js_reset`：重置桌面 JS 内核 |
| `tools.desktopAddNodeModuleDir` | `true` | 注册 `pc_codex_desktop_js_add_node_module_dir`：把 Node 模块目录加入桌面 `node_repl` |
| `tools.observe` | `true` | 注册 `pc_codex_observe`：输出完整无障碍树，例行判断在代码里取值 |
| `tools.runPlan` | `true` | 注册 `pc_codex_run_plan`：备选；需要逐步状态或失败后自动观察时使用 |
| `tools.docs` | `true` | 注册 `pc_codex_docs`：读取 Codex 自带的 Computer Use 文档（不需要 Codex 连接） |

`autoApprove` / `computer` / `rememberDesktopApprovals` / `language` /
`codexHome` / `logFile` / `timeoutMs` 可以热更新（volatile）：改完对之后的调用生效，不会重新挂载
插件。loader 会通知 volatile 写入：关闭 `computer` 时立即停掉桌面服务器，浏览器连接不受影响；
重新打开后，下一次桌面调用才启动桌面服务器。`codexHome` 改变后，两个服务器各自在下一次调用时重新
解析并重连。`enabled`、`tools.*` 不是 volatile，改动会重新挂载插件并按新配置注册工具。三个桌面
工具开关默认 `true`，不在设置页上。

`language` 只影响插件自己显示的文字（三选项卡片、一次性卡片的 `displayReason` 与审计 `reason` 的
中英两套）：`auto` 先尝试读取 DSH 宿主公开的界面语言偏好，读不到时用系统语言（`zh` 开头为中文，
否则英文）；也可以强制 `zh` / `en`。一次性授权卡片的 `displayReason` 同时携带中英两种文字，
无论 `language` 是什么，都由 DSH 客户端按界面语言选择显示。

每一次审批都会写进日志（`logFile` 为空时写入 `~/.dsh/pc-use.log`，不再只走 `console.warn`），记录原始文案、决定和原因，例如：

```
approval "Allow Browser use to access https://www.bilibili.com?" -> accept (browser access auto-approved)
```

- `autoApprove: false`（默认）：浏览器授权一律 decline，原因记为 `auto-approve is off`；
- `autoApprove: true`：只有浏览器访问授权会 accept（原因 `browser access auto-approved`），其他审批一律 decline，原因记为 `not a browser-access approval`；
- 桌面授权不适用 `autoApprove`：`computer: false` 时一律 decline（`computer use is off`）；`computer: true` 时交给 DSH 审批，结果写进日志（`approved in DSH` / `rejected in DSH` / `approval cancelled` / `approval unavailable`），没有审批服务或没有进行中的 `pc_codex_desktop_js` 调用时 decline。

如果 Codex 改掉授权文案，浏览器授权和桌面授权都会被拒绝——这是安全的失败方式。

## 设置页（0.4.3）

DSH 设置侧栏的“插件市场”下方有“电脑操控”页（条目 id `pc-use`，只在 Host 提供该条目时显示）。可以改：

- **桌面操控**：`computer`、`rememberDesktopApprovals`；
- **浏览器**：`autoApprove`；
- **通用**：`language`、`timeoutMs`（秒，10–3600，按毫秒保存）、`codexHome`、`logFile`。

开关和下拉框改完立即保存，文本框与数字在失焦或回车时保存；每项在改过后出现“恢复默认”。
`enabled` 与 `tools.*` 不在页面上：启用插件请到“内置插件”或插件管理，工具开关改 profile。三个
桌面工具开关（`tools.desktopJs`、`tools.desktopReset`、`tools.desktopAddNodeModuleDir`）与其他
`tools.*` 一样不在页面上。`codexHome` 是 volatile：改完下一次调用会重新解析并换到新的 Codex
目录，插件不重新挂载。

## 桌面操控

Windows 桌面应用操控默认关闭。0.5.0 起浏览器与桌面是两个 Codex 服务器，按 Codex 应用的方式
分别启动：

- **浏览器服务器**是 Codex 的 `cua_repl`，来源为
  `<codexHome>/plugins/cache/openai-bundled/unified-computer-use/<版本>/.mcp.json`；
- **桌面服务器**是 Codex 的 `node_repl`，来源为 `<codexHome>/config.toml` 的
  `[mcp_servers.node_repl]`。

`pc_codex_js` / `pc_codex_js_reset` 走浏览器服务器；`pc_codex_desktop_js` /
`pc_codex_desktop_js_reset` / `pc_codex_desktop_js_add_node_module_dir` 走桌面服务器。两者都是
懒启动：桌面服务器在第一次桌面调用时才启动，`computer` 为 `false` 时永不启动；关闭 `computer`
立即停掉桌面服务器（由 loader 的 volatile 更新事件触发），浏览器服务器继续运行。每次调用前插件
都会重读该服务器自己的来源，所以 Codex 重启后按服务器分别更新。启动环境原样传入——浏览器用
`.mcp.json` 里的值，桌面用 `config.toml`
里的值——与 Codex 应用的启动方式一致；0.4.x 改写环境的做法已经删除。

开启方式：在 profile 的 `cordis.patch.yml` 里设置，改完重启桌面版。实测 DSH 桌面版
0.2.1-rc.2 的“设置 → 内置插件”页只显示插件状态，不显示配置表单。该 patch 的
`config:` 会整体替换配置，要把原有的键一起写上。

```yaml
- id: pc-use
  config:
    computer: true
```

首次用 `sky` 操作某个桌面应用时，Codex 会发来授权请求。插件识别两种桌面授权文案：
`Allow Codex to use <应用名>?`（桌面版实测所用）和 `Allow Computer Use to use "<应用名>"?`。
录音请求 `Allow Computer Use to record computer audio?` 不在识别范围内，会被拒绝。桌面授权归到
最早开始、仍在运行的 `pc_codex_desktop_js` 或 `pc_codex_desktop_js_add_node_module_dir` 调用；
没有这类调用时直接拒绝，日志原因写为 `no active pc_codex_desktop_js call`。一个服务器收到不属于
它的授权类型时一律拒绝并记日志（`unexpected approval for the browser server` /
`unexpected approval for the desktop server`）。插件把桌面授权转成 DSH 的提示（三选项卡片，
或一次性审批卡片，见下）；`autoApprove` 对桌面授权不起作用。

插件会记住你在同一个 DSH 会话内的桌面授权：同一个应用经你允许一次后，后续请求不再询问，
日志原因写为 `approved earlier in this DSH session`。只记住“允许”，拒绝、取消或失败
不会被记住。以下情况会重新询问：桌面桥接重连（例如切换 `computer`、`node_repl` 变化或进程
重启）、新开一个 DSH 会话、或把 `rememberDesktopApprovals` 设为 `false`（关闭期间的下一次
调用或授权请求会清空记录）。浏览器桥接重连不会清空记住的桌面授权。想立刻重新询问，最可靠的
办法是新开会话或切换一次 `computer`。注意：之后把权限模式改严，本会话内已经记住的应用仍会
放行。

桌面授权默认显示 DSH 的三选项卡片：`允许这一次`（只批准这一步，不记住）、`本次会话内允许`（同一
agent、同一应用在本次 DSH 会话内不再询问，重新连接或重启后失效）和 `拒绝`。第二项只在
`rememberDesktopApprovals` 开启且请求的 `_meta.persist` 含 `session` 时出现；授权策略为 `never`
（“完全权限”）或拿不到提问服务时，沿用一次性的 DSH 授权卡片。
用户填写自定义文字、没有选择、选择未知文字或提问出错都按拒绝处理。卡片文字跟随 `language`；
旧的一次性卡片由 DSH 客户端按界面语言显示其中英文字。

每轮 DSH 轮次结束时，插件会用同一 agent 的 Codex `session_id` / `turn_id` 调用
`turn_ended`（正常结束为 `Stop`，中途停止为 `Interrupt`，子 agent 为 `SubagentStop`），对本轮
用过且仍然连接着的每个服务器各发一次。这会让 Codex 收起屏幕上“正在使用你的电脑”的橙色光圈，
并结束那一轮。本轮没用过的服务器、该服务器桥接未连接或插件已卸载时不会补发；桥接重连后从新的
`turn_id` 开始，重建前的轮次不会补给新连接。

### 先读 Codex 自带的文档：`pc_codex_docs`

Codex 的 computer-use 插件自带一份 skill 和三份文档。插件不复制、不打包这些文件；
`pc_codex_docs` 每次调用都从本机 Codex 安装
（`<codexHome>/plugins/cache/openai-bundled/computer-use/`）读取原文并原样返回，前面附一行
来源和 DSH 工具对照。Codex 更新后内容随之更新；目录或文件不存在时，错误会写出期望的路径。
这些文档属于 OpenAI（Proprietary），只在本机读取，不随插件分发。

`topic` 取 `skill`（入口）、`guidance`（运行规则、目标窗口、截图、恢复）、
`confirmations`（需要用户确认的动作）、`api`（完整 `sky` API）。这个工具不需要 Codex
连接，`computer: false` 时也会注册。

在 `pc_codex_desktop_js` 里使用（`computer: true` 且桌面连接建立之后）：

```js
const { sky } = await import('@oai/sky');
await sky.list_apps();
```

`sky` 还提供截屏、点击、输入等桌面操作，具体 API 见 `pc_codex_docs` 的 `api` 文档。

**风险提示：** 桌面操控的权限大于浏览器——它可以读取屏幕、移动鼠标并向任意应用发送
输入。默认关闭；只在你确有必要时开启。桌面授权交给 DSH 的审批策略：在“完全权限”模式下
DSH 不询问、直接放行；要逐次确认，请使用“仅可查看”或“工作区内修改”。Codex 也可能记住
以前的授权而不再询问。`autoApprove` 对桌面授权不起作用。

## 后端

目前只有 Codex 后端：`pc_codex_*` 工具通过本机 Codex 桌面应用执行。命名已为其他后端预留：
只属于 Codex 的工具用 `pc_codex_` 前缀，以后 Claude 的 computer use 会以 `pc_claude_`
前缀与之并列；`pc_status` 的顶层按 `backends` 分组，当前只有 `backends.codex`，其内部再分别
报告 `browser` 与 `desktop` 两个服务器。配置键暂时保持扁平（`codexHome` 等），等第二个后端有
具体设计后再决定是否分组。

## 前置条件

- Codex 桌面应用必须正在运行（两个服务器连的都是它的原生管道）；
- Chrome 插件已连接，`pc_codex_js` 里 `await cua.listBrowsers()` 能看到 `Chrome / type=extension`；
- 桌面操控要求 `<codexHome>/config.toml` 里有 `[mcp_servers.node_repl]` 节；缺少时只有桌面工具
  报错，错误会写出节名；
- 只在 Windows 上验证过（Codex 的 Computer Use 在 Windows 上走 `sky` 原生管道）。

## 验证

```js
await cua.listBrowsers();
```

或先调 `pc_status`，看 `backends.codex`：它包含 `codexHome`、`autoApprove`、`computer`，以及
`browser` 与 `desktop` 两节。每节报告 `resolved`、`reason`、`source`、`command`、`cwd`、
`nativePipe`、`connected` 与 `services`。第一次连接之前 `connected` 为 `false`、`services` 为
`null`，这是正常的；来源解析失败时 `resolved` 为 `false`，`reason` 写出缺失的 `.mcp.json` 或
`config.toml` 节。旧的 `servicesFrom` 字段在 0.5.0 已删除。命令行冒烟测试：

```powershell
npm run test:smoke
```

冒烟测试会连接 Codex 并操作真实 Chrome。

## 实现

- `index.js` — cordis 插件：`defineTool` + `parameters` DSL 声明工具、导出 Schemastery `Config`、两个懒启动的桥接（浏览器与桌面）、按服务器分开的授权与轮次、`ctx.effect` 清理
- `client.js` — 浏览器半侧：“电脑操控”设置页（`settings.section`）、控件与中英文界面字典
- `lib/text.js` — 插件自己显示的中英文字（三选项卡片、`displayReason`、审计 reason、配置说明），两套键一致
- `lib/config-value.js` — 解包 cordis 加载器传入的 `Volatile` 配置值
- `lib/define-tool.js` — `defineTool` 的可移植兜底：把参数 DSL 转成对象 JSON Schema，并在 `execute` 前校验参数
- `lib/images.js` — 保存工具结果里的截图：按 mimeType 取扩展名，保存后只保留最新 50 个文件
- `lib/codex-config.js` — 解析两套启动配置：`resolveBrowserServer` 读最新的 `cua_repl` `.mcp.json`，`resolveDesktopServer` 读 `config.toml` 的 `[mcp_servers.node_repl]`；每次调用前重读
- `lib/mcp-bridge.js` — 极简 MCP stdio 客户端：注入 turn metadata、声明 elicitation、按策略应答审批、超时后通知取消
- `lib/approval.js` — 审批判定：浏览器授权按 `autoApprove`，桌面授权交给 DSH 确认，其余一律拒绝并给出原因
- `locale/en.json` / `locale/zh.json` — 插件管理页的显示名与描述（`PC Use` / `电脑操控`）
- `icon.svg` — 原创的窗口加指针图标，不引用外部资源
- `cordis.patch.yml` — bundle 层，按包名把插件插进每个 preset

进程是**懒启动**的：加载插件本身不会 spawn 任何东西，Codex 没装也不会影响 profile 启动，错误只在真正调用工具时暴露。浏览器服务器在第一次浏览器调用时启动，桌面服务器在第一次桌面调用时启动。

## 为什么 `defineTool` 要有兜底

`dsh plugin add` 安装的是 `link:` 目录，插件从**工作区路径**加载。DSH 桌面版 0.2.1-rc.2 的 profile 设置了 `autoInstallPeers: false`，也没有通用的 `@deepseek-ai` 解析钩子，因此以 `link:` 安装时插件解析不到宿主包（`@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` / `@deepseek-ai/cordis`），始终走 `lib/define-tool.js` 的兜底分支。兜底分支已与宿主原生 `defineTool` 核对一致：把参数 DSL 转成对象 JSON Schema，并在执行前校验参数。

0.1.0 在这里踩过坑：拿不到 `defineTool` 时直接把参数 DSL（`{ code: { type: 'string', required: true } }`）当成 JSON Schema 注册，模型请求里出现了非法 schema（属性里带 `required`、根缺 `type: object`），DeepSeek 直接拒绝**整轮**请求。`npm test` 会在离线环境断言七个工具都发布合法的对象 JSON Schema。

只有插件目录里装了 `@deepseek-ai/schemastery` 之后，设置界面才会出现这些开关——这是插件自己的 devDependency 带来的效果（本地 `npm install` 后插件目录里才会有一份）。发布和安装方式需要留意这一点。
桌面版 0.2.1-rc.2 实测不显示配置表单，`computer` 等配置仍需改 profile 的 `cordis.patch.yml`。
三个桌面工具开关也只能在 profile 里改。

## 已知限制

- 非官方用法，Codex 更新可能改变 `.mcp.json` 或 `config.toml` 结构或管道机制；失效先看
  `pc_status` 和 `logFile`。
- 自动审批只认 `Allow Browser use to access <origin>?` 这条文案；Codex 改文案后浏览器授权会被拒绝（fail-closed），被拒绝的原文会写进日志。
- 桌面授权只认 `Allow Computer Use to use "<名称>"?` 和 `Allow Codex to use <名称>?` 两种文案，
  改文案后会被拒绝；桌面操控默认关闭，是否弹卡片由 DSH 的权限模式决定（“完全权限”直接放行，
  “仅可查看”/“工作区内修改”逐次确认），Codex 也可能记住授权而不再询问。
- 每个服务器最多维持一个连接（浏览器一个、桌面一个）；插件被卸载或进程退出时两个子进程会一起结束。
- 兜底分支只支持 `string` / `number` / `boolean` 三种原始参数；需要嵌套对象时必须在宿主里真正拿到 `defineTool`。
