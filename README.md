# dsh-pc-use

## 改名说明（0.4.0）

- 包名与插件 id：`dsh-codex-cu` → `dsh-pc-use`，`id: codex-cu` → `id: pc-use`；
- 工具名：`codex_js` / `codex_js_reset` / `codex_js_add_node_module_dir` / `codex_status`
  改为 `pc_codex_js` / `pc_codex_js_reset` / `pc_codex_js_add_node_module_dir` / `pc_status`，
  并新增 `pc_codex_docs`；
- 默认日志 `~/.dsh/codex-cu.log` → `~/.dsh/pc-use.log`，默认状态文件
  `~/.dsh/codex-cu-state.json` → `~/.dsh/pc-use-state.json`，默认截图目录
  `~/.dsh/codex-cu-images` → `~/.dsh/pc-use-images`；
- **profile 里的覆盖要改 id：**`- id: codex-cu` 必须改成 `- id: pc-use`，否则不再生效；
- 旧状态文件只在默认路径下迁移一次会话 id，旧文件不删；旧日志与截图目录不迁移；
- 没有采用 `dsh-computer-use`：npm 上已有同名的其他 DSH 插件，插件市场按包名查更新时
  可能误替换，所以改名为 `dsh-pc-use`。

0.4.0 新增：改名为 `dsh-pc-use`；新增 `pc_codex_docs` 读取 Codex 自带文档；按包名加载并补上
显示名与图标；`pc_status` 改为按后端分组（`backends`）。

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

把 **Codex Computer Use**（`cua_repl`）做成 DeepSeek Harness 的原生工具插件：用本机 Codex
操作真实的 Chrome 与 Windows 桌面应用，不需要任何手工 MCP 配置。目前后端是 Codex，
以后会增加其他后端（见“后端”一节）。

装好之后，每个 agent preset 自动拥有：

| 工具 | 作用 |
|---|---|
| `pc_codex_js` | 在持久的 `cua_repl` 内核里执行 JS，用 `cua` API 打开/读取/操作网页，或用 `sky` 操作桌面应用 |
| `pc_codex_js_reset` | 重置 JS 内核（不关闭标签页和应用） |
| `pc_codex_js_add_node_module_dir` | 给内核增加一个 `node_modules` 解析目录 |
| `pc_codex_docs` | 读取本机 Codex 自带的 Computer Use 文档（`skill` / `guidance` / `api` / `confirmations`） |
| `pc_status` | 报告解析结果和连接状态；其他工具失败时先看它 |

## 为什么需要这个插件

Codex 的 `cua_repl` 依赖三件只有 Codex 自己的客户端才会做的事，普通 MCP 客户端接不了：

1. 每次 `tools/call` 要带 `_meta["x-codex-turn-metadata"]`，否则服务端直接拒绝；
2. `initialize` 要声明 `elicitation` 能力，否则浏览器/应用授权请求发不出去；
3. 服务端反向发来的 `elicitation/create` 授权请求要被应答，否则报
   `The approval request did not return a valid decision`。

另外 Codex 每次重启都会改写 `codex-computer-use-<GUID>` 管道名和运行时哈希，配置写死必然失效。

本插件把这几件事都内置了（`lib/mcp-bridge.js` + `lib/codex-config.js`），每次启动重读 Codex 配置。

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
| `codexHome` | `''` | 空表示 `%USERPROFILE%\.codex` |
| `stateFile` | `''` | 会话状态文件路径；空表示 `~/.dsh/pc-use-state.json` |
| `logFile` | `''` | 桥接日志路径；空表示 `~/.dsh/pc-use.log` |
| `timeoutMs` | `120000` | 单次调用超时 |
| `tools` | 全开 | `{ js, reset, addNodeModuleDir, docs, status }` 逐项开关 |
| `tools.docs` | `true` | 注册 `pc_codex_docs`：读取 Codex 自带的 Computer Use 文档（不需要 Codex 连接） |

`autoApprove` / `computer` / `rememberDesktopApprovals` / `logFile` / `timeoutMs` 可以热更新（volatile）：改完对之后的调用生效，不会重新挂载插件；`computer` 改变后，下一次调用会先停掉旧连接再按新值重连。`enabled`、`codexHome`、`stateFile`、`tools.*` 不是 volatile，改动会重新挂载插件并按新配置注册工具。

每一次审批都会写进日志（`logFile` 为空时写入 `~/.dsh/pc-use.log`，不再只走 `console.warn`），记录原始文案、决定和原因，例如：

```
approval "Allow Browser use to access https://www.bilibili.com?" -> accept (browser access auto-approved)
```

- `autoApprove: false`（默认）：浏览器授权一律 decline，原因记为 `auto-approve is off`；
- `autoApprove: true`：只有浏览器访问授权会 accept（原因 `browser access auto-approved`），其他审批一律 decline，原因记为 `not a browser-access approval`；
- 桌面授权不适用 `autoApprove`：`computer: false` 时一律 decline（`computer use is off`）；`computer: true` 时交给 DSH 审批，结果写进日志（`approved in DSH` / `rejected in DSH` / `approval cancelled` / `approval unavailable`），没有审批服务或没有进行中的 `pc_codex_js` 调用时 decline。

如果 Codex 改掉授权文案，浏览器授权和桌面授权都会被拒绝——这是安全的失败方式。

`stateFile` 保存一个持久的 `session_id`，重启后沿用同一个 id；它是否让 Codex 按 session_id 跨会话保留已授予的授权，**未验证**。冒烟测试会传入临时路径，避免测试产生的状态和授权写进日常使用的那一份。

## 桌面操控

Windows 桌面应用操控默认关闭。Codex 的 `cua_repl` 用环境变量 `CUA_REPL_ENABLED_SURFACES`
决定启用哪些能力，`.mcp.json` 里写死为 `browser`；插件只在子进程的 env 里追加
`computer`（得到 `browser,computer`），不修改任何 Codex 文件。桌面能力还需要 `sky`
可信服务：`.mcp.json` 已经把 `NODE_REPL_TRUSTED_SERVICES` 写死，启动器不会按 surfaces
重新生成，所以插件同时在该变量里加入 `"sky": "@oai/sky/service"`（已有的 `sky` 不覆盖）；
原值不是 JSON 对象时插件拒绝启动并报错。

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
录音请求 `Allow Computer Use to record computer audio?` 不在识别范围内，会被拒绝。
插件把桌面授权转成 DSH 的审批提示（例如“允许 Codex Computer Use 操作“记事本”？”），
交给 DSH 的审批策略处理；`autoApprove` 对桌面授权不起作用。

插件会记住你在同一个 DSH 会话内的桌面授权：同一个应用经你允许一次后，后续请求不再询问，
日志原因写为 `approved earlier in this DSH session`。只记住“允许”，拒绝、取消或失败
不会被记住。以下情况会重新询问：桥接重连（例如切换 `computer`、`.mcp.json` 变化或进程
重启）、新开一个 DSH 会话、或把 `rememberDesktopApprovals` 设为 `false`（关闭期间的下一次
调用或授权请求会清空记录）。想立刻重新询问，最可靠的办法是新开会话或切换一次 `computer`。
注意：之后把权限模式改严，本会话内已经记住的应用仍会放行。

每轮 DSH 轮次结束时，插件会用同一 agent 的 Codex `session_id` / `turn_id` 调用
`turn_ended`（正常结束为 `Stop`，中途停止为 `Interrupt`，子 agent 为 `SubagentStop`）。
这会让 Codex 收起屏幕上“正在使用你的电脑”的橙色光圈，并结束那一轮。本轮没有调用过
`pc_codex_js`、桥接未连接或插件已卸载时不会补发；桥接重连后从新的 `turn_id` 开始。

### 先读 Codex 自带的文档：`pc_codex_docs`

Codex 的 computer-use 插件自带一份 skill 和三份文档。插件不复制、不打包这些文件；
`pc_codex_docs` 每次调用都从本机 Codex 安装
（`<codexHome>/plugins/cache/openai-bundled/computer-use/`）读取原文并原样返回，前面附一行
来源和 DSH 工具对照。Codex 更新后内容随之更新；目录或文件不存在时，错误会写出期望的路径。
这些文档属于 OpenAI（Proprietary），只在本机读取，不随插件分发。

`topic` 取 `skill`（入口）、`guidance`（运行规则、目标窗口、截图、恢复）、
`confirmations`（需要用户确认的动作）、`api`（完整 `sky` API）。这个工具不需要 Codex
连接，`computer: false` 时也会注册。

在 `pc_codex_js` 里使用（`computer: true` 且连接建立之后）：

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
前缀与之并列；`pc_status` 的顶层按 `backends` 分组，当前只有 `backends.codex`。配置键
暂时保持扁平（`codexHome` 等），等第二个后端有具体设计后再决定是否分组。

## 前置条件

- Codex 桌面应用必须正在运行（插件连的是它的原生管道）；
- Chrome 插件已连接，`pc_codex_js` 里 `await cua.listBrowsers()` 能看到 `Chrome / type=extension`；
- 只在 Windows 上验证过（Codex 的 Computer Use 在 Windows 上走 `sky` 原生管道）。

## 验证

```js
await cua.listBrowsers();
```

或先调 `pc_status`，看 `backends.codex`。第一次 `pc_codex_js` 建立连接之前，
`backends.codex.computer`、`services`、`servicesFrom` 都是 `null`，这是正常的（尚未连接）。
连接后 `servicesFrom` 为 `env` 或 `launcher`：`launcher` 表示 `.mcp.json` 没写
`NODE_REPL_TRUSTED_SERVICES`、由 Codex 启动器生成，此时 `services` 为 `null`，插件不知道
具体内容。命令行冒烟测试：

```powershell
npm run test:smoke
```

冒烟测试会连接 Codex 并操作真实 Chrome。

## 实现

- `index.js` — cordis 插件：`defineTool` + `parameters` DSL 声明工具、导出 Schemastery `Config`、懒连接、`ctx.effect` 清理
- `lib/config-value.js` — 解包 cordis 加载器传入的 `Volatile` 配置值
- `lib/define-tool.js` — `defineTool` 的可移植兜底：把参数 DSL 转成对象 JSON Schema，并在 `execute` 前校验参数
- `lib/images.js` — 保存工具结果里的截图：按 mimeType 取扩展名，保存后只保留最新 50 个文件
- `lib/codex-config.js` — 从 `.mcp.json` / `config.toml` 解析启动参数，易变值以 config.toml 为准
- `lib/mcp-bridge.js` — 极简 MCP stdio 客户端：注入 turn metadata、声明 elicitation、按策略应答审批、超时后通知取消
- `lib/approval.js` — 审批判定：浏览器授权按 `autoApprove`，桌面授权交给 DSH 确认，其余一律拒绝并给出原因
- `lib/surfaces.js` — 合并 `CUA_REPL_ENABLED_SURFACES`（追加桌面能力、去重）与 `NODE_REPL_TRUSTED_SERVICES`（开启 `computer` 时加入 `sky`）
- `locale/en.json` / `locale/zh.json` — 插件管理页的显示名与描述（`PC Use` / `电脑操控`）
- `icon.svg` — 原创的窗口加指针图标，不引用外部资源
- `cordis.patch.yml` — bundle 层，按包名把插件插进每个 preset

进程是**懒启动**的：加载插件本身不会 spawn 任何东西，Codex 没装也不会影响 profile 启动，错误只在真正调用工具时暴露。

## 为什么 `defineTool` 要有兜底

`dsh plugin add` 安装的是 `link:` 目录，插件从**工作区路径**加载。DSH 桌面版 0.2.1-rc.2 的 profile 设置了 `autoInstallPeers: false`，也没有通用的 `@deepseek-ai` 解析钩子，因此以 `link:` 安装时插件解析不到宿主包（`@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` / `@deepseek-ai/cordis`），始终走 `lib/define-tool.js` 的兜底分支。兜底分支已与宿主原生 `defineTool` 核对一致：把参数 DSL 转成对象 JSON Schema，并在执行前校验参数。

0.1.0 在这里踩过坑：拿不到 `defineTool` 时直接把参数 DSL（`{ code: { type: 'string', required: true } }`）当成 JSON Schema 注册，模型请求里出现了非法 schema（属性里带 `required`、根缺 `type: object`），DeepSeek 直接拒绝**整轮**请求。`npm test` 会在离线环境断言五个工具都发布合法的对象 JSON Schema。

只有插件目录里装了 `@deepseek-ai/schemastery` 之后，设置界面才会出现这些开关——这是插件自己的 devDependency 带来的效果（本地 `npm install` 后插件目录里才会有一份）。发布和安装方式需要留意这一点。
桌面版 0.2.1-rc.2 实测不显示配置表单，`computer` 等配置仍需改 profile 的 `cordis.patch.yml`。

## 已知限制

- 非官方用法，Codex 更新可能改变 `.mcp.json` 结构或管道机制；失效先看 `pc_status` 和 `logFile`。
- 自动审批只认 `Allow Browser use to access <origin>?` 这条文案；Codex 改文案后浏览器授权会被拒绝（fail-closed），被拒绝的原文会写进日志。
- 桌面授权只认 `Allow Computer Use to use "<名称>"?` 和 `Allow Codex to use <名称>?` 两种文案，
  改文案后会被拒绝；桌面操控默认关闭，是否弹卡片由 DSH 的权限模式决定（“完全权限”直接放行，
  “仅可查看”/“工作区内修改”逐次确认），Codex 也可能记住授权而不再询问。
- 同一时间只维持一个 Codex 连接；插件被卸载或进程退出时子进程会一起结束。
- 兜底分支只支持 `string` / `number` / `boolean` 三种原始参数；需要嵌套对象时必须在宿主里真正拿到 `defineTool`。
