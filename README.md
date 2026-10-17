# dsh-codex-cu

0.2.0 修正：

- 参数 schema 兜底：拿不到宿主 `defineTool` 时把参数 DSL 转成对象 JSON Schema，并在执行前校验参数；
- volatile 配置修复：正确解包加载器传入的 `Volatile` 配置值，`autoApprove` / `logFile` / `timeoutMs` 改完即生效；
- 审批默认 fail-closed：`autoApprove` 默认 `false`，且只自动接受浏览器访问授权，其他 elicitation 审批一律 decline；
- 审批日志：每一次审批都记录原始文案、决定（accept/decline）和原因，默认写入 `~/.dsh/codex-cu.log`；
- 截图清理：工具返回的截图保存到 `~/.dsh/codex-cu-images`，扩展名按 mimeType 决定，目录只保留最新的 50 个文件；
- 握手失败清理：initialize 出错、超时或 spawn 失败时结束子进程，不会把没握手的连接当成可用；
- 客户端版本号取自 `package.json`，不再硬编码。

`npm test` 运行离线回归检查；`npm run test:smoke` 会连接 Codex 并操作浏览器。

把 **Codex Computer Use**（`cua_repl`）做成 DeepSeek Harness 的原生工具插件：用 Codex 的浏览器扩展驱动你真实的 Chrome，不需要任何手工 MCP 配置。

装好之后，每个 agent preset 自动拥有：

| 工具 | 作用 |
|---|---|
| `codex_js` | 在持久的 `cua_repl` 内核里执行 JS，用 `cua` API 打开/读取/操作网页 |
| `codex_js_reset` | 重置 JS 内核（不关闭标签页和应用） |
| `codex_js_add_node_module_dir` | 给内核增加一个 `node_modules` 解析目录 |
| `codex_status` | 报告解析结果和连接状态；`codex_js` 失败时先看它 |

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
dsh plugin --profile desktop add C:\Users\<你>\...\plugins\dsh-codex-cu
```

`dsh plugin add` 会把包写进 profile 的 `dependencies`，并追加到 `dsh.profile.bundles`；bundle 自带的 `cordis.patch.yml` 负责插入 `codex-cu` 这一行。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-codex-cu
```

### 要改配置，别重复 insert

bundle 层已经插入过 `codex-cu` 了。在 profile 的 `cordis.patch.yml` 里**只能按 id 覆盖**，不要再 `insert` 一次——同一个 id 插两行会让 loader 挂载失败，插件就静默不出现：

```yaml
- id: codex-cu
  config:
    autoApprove: true   # 只自动接受浏览器访问授权，其余审批仍会 decline 并写日志
    logFile: 'C:\Users\<你>\.dsh\codex-cu.log'
    # 注意：patch 是整块替换 config，不是深合并；没写的键会回到上表的默认值
```

`dsh --profile desktop --dump-config` 在 Electron 托管的 profile 上会被拒绝，验证层顺序请改用桌面端的插件面板。

## 配置

全部字段都可选，写在 `cordis.patch.yml` 的 `config:` 里。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 则不注册任何工具 |
| `autoApprove` | `false` | 只自动接受浏览器访问授权；其他 elicitation 审批一律 decline（fail-closed） |
| `codexHome` | `''` | 空表示 `%USERPROFILE%\.codex` |
| `stateFile` | `''` | 会话状态文件路径；空表示 `~/.dsh/codex-cu-state.json` |
| `logFile` | `''` | 桥接日志路径；空表示 `~/.dsh/codex-cu.log` |
| `timeoutMs` | `120000` | 单次调用超时 |
| `tools` | 全开 | `{ js, reset, addNodeModuleDir, status }` 逐项开关 |

`autoApprove` / `logFile` / `timeoutMs` 可以热更新（volatile）：改完对之后的调用生效，不会重新挂载插件。`enabled`、`codexHome`、`stateFile`、`tools.*` 不是 volatile，改动会重新挂载插件并按新配置注册工具。

每一次审批都会写进日志（`logFile` 为空时写入 `~/.dsh/codex-cu.log`，不再只走 `console.warn`），记录原始文案、决定和原因，例如：

```
approval "Allow Browser use to access https://www.bilibili.com?" -> accept (browser access auto-approved)
```

- `autoApprove: false`（默认）：一律 decline，原因记为 `auto-approve is off`；
- `autoApprove: true`：只有浏览器访问授权会 accept（原因 `browser access auto-approved`），其他审批一律 decline，原因记为 `not a browser-access approval`。

如果 Codex 改掉授权文案，浏览器授权会被拒绝——这是安全的失败方式。

`stateFile` 保存一个持久的 `session_id`，重启后沿用同一个 id；它是否让 Codex 按 session_id 跨会话保留已授予的授权，**未验证**。冒烟测试会传入临时路径，避免测试产生的状态和授权写进日常使用的那一份。

## 前置条件

- Codex 桌面应用必须正在运行（插件连的是它的原生管道）；
- Chrome 插件已连接，`codex_js` 里 `await cua.listBrowsers()` 能看到 `Chrome / type=extension`；
- 只在 Windows 上验证过（Codex 的 Computer Use 在 Windows 上走 `sky` 原生管道）。

## 验证

```js
await cua.listBrowsers();
```

或先调 `codex_status`。命令行冒烟测试：

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
- `lib/approval.js` — 审批判定：只自动接受浏览器访问授权，其余一律拒绝并给出原因
- `cordis.patch.yml` — bundle 层，把插件插进每个 preset

进程是**懒启动**的：加载插件本身不会 spawn 任何东西，Codex 没装也不会影响 profile 启动，错误只在真正调用工具时暴露。

## 为什么 `defineTool` 要有兜底

`dsh plugin add` 安装的是 `link:` 目录，插件从**工作区路径**加载。DSH 桌面版 0.2.1-rc.2 的 profile 设置了 `autoInstallPeers: false`，也没有通用的 `@deepseek-ai` 解析钩子，因此以 `link:` 安装时插件解析不到宿主包（`@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` / `@deepseek-ai/cordis`），始终走 `lib/define-tool.js` 的兜底分支。兜底分支已与宿主原生 `defineTool` 核对一致：把参数 DSL 转成对象 JSON Schema，并在执行前校验参数。

0.1.0 在这里踩过坑：拿不到 `defineTool` 时直接把参数 DSL（`{ code: { type: 'string', required: true } }`）当成 JSON Schema 注册，模型请求里出现了非法 schema（属性里带 `required`、根缺 `type: object`），DeepSeek 直接拒绝**整轮**请求。`npm test` 会在离线环境断言四个工具都发布合法的对象 JSON Schema。

只有插件目录里装了 `@deepseek-ai/schemastery` 之后，设置界面才会出现这些开关——这是插件自己的 devDependency 带来的效果（本地 `npm install` 后插件目录里才会有一份）。发布和安装方式需要留意这一点。

## 已知限制

- 非官方用法，Codex 更新可能改变 `.mcp.json` 结构或管道机制；失效先看 `codex_status` 和 `logFile`。
- 自动审批只认 `Allow Browser use to access <origin>?` 这条文案；Codex 改文案后浏览器授权会被拒绝（fail-closed），被拒绝的原文会写进日志。
- 只启用浏览器能力。原生应用控制（`sky`）走的是另一条路径，需要额外的 turn-ended 处理来收掉橙色光标。
- 同一时间只维持一个 Codex 连接；插件被卸载或进程退出时子进程会一起结束。
- 兜底分支只支持 `string` / `number` / `boolean` 三种原始参数；需要嵌套对象时必须在宿主里真正拿到 `defineTool`。
