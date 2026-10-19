# 变更记录

[English](CHANGELOG.md) | 中文

## 未发布

`pc_status` 的顶层键 `backends` 改名为 `providers`，这是不兼容修改。文档与工具说明改用术语表中
的叫法（提供方、插件标签页、DSH 会话），并说明内核重置或浏览器重连后之前的标签页不再算插件
标签页。

## 0.8.0

0.8.0 新增 `allowUserTabs` 开关（默认关闭，修改后对之后的调用生效），并让读取用户标签页与
浏览历史的全部入口都受它控制：关闭时，`browser.user.openTabs`、`browser.user.claimTab`、
`browser.user.getTabContext` 与 `browser.history` 报错并说明原因；`cua.getTab`、
`browser.tabs.get`、`browser.tabs.content` 只接受本会话的标签页；`cua.getState` 只列出
本会话的标签页。守卫改为返回 Proxy 视图，在调用时读取开关与原方法，因为运行时对象首次
读取时会缓存方法包装，改写方法在真实服务器上没有效果。设置页在读取设置时显示与读完后
相同布局的骨架。`initialize` 与原生 Codex 一致：协议版本 `2025-06-18`，elicitation 能力
同时声明 `form` 与 `url`；`url` 形式的请求在分类前拒绝，日志只记主机名。改用 Apache-2.0
许可证，新增 SECURITY.md；两份 README 改用书面语言，并修正五处与实现不符的说法。

## 0.7.0

0.7.0 新增两个工具，各有开关，默认开启：`pc_codex_observe` 一次只读地观察浏览器标签页或
桌面窗口；`pc_codex_run_plan` 依次运行 1–20 步，每步可带检查，遇到第一个失败就停。js 工具的
说明改为每次调用写一个带检查的程序；顶层 return 的提示改为“值不会自动返回”。四个写代码的工具
返回的截图改为以图片交给模型（`attachImages`，默认开启；截图会发到模型服务商）；
`keepImageFiles`（默认关闭）开启时，另在 `~/.dsh/pc-use-images` 存一份。桌面窗口没有
无障碍树时，工具会说明这一点，并让模型改看截图。浏览器的每次 js 调用都包住
`cua.listTabs`，只返回本会话打开的标签页。除 `turn_ended` 以外，每次 `tools/call` 的
`_meta` 都带上 Codex 的轮次元数据与调用身份（见“工具调用元数据”；依据源码，未经线上核实）。

## 0.6.0

0.6.0 把“界面文字”的原生下拉框换成 DSH 官方的 primitives Menu（圆角按钮、向下箭头与 hover
样式，style 只注入一次）；拿不到 primitives/Menu 时退回原生 select。同时删去
`desktopApprovalChoices` 开关——这是公共配置 API 的不兼容修改——桌面授权固定用三选项卡片，
只保留拿不到提问服务与策略不是 `ask` 的两种降级。仍带旧字段的 profile 照常加载：DSH 的非
strict schema 会保留这个未知键，插件不再读取它，可以留待以后清理。页面顶部改为照官方“通用”页：
不再有页标题和说明，“已保存”只留给读屏软件，冲突提示仍然可见。同时修复实测问题：用 Codex
原生管道结束桌面轮次以收起光圈；补上“不要重试”“去掉顶层 return”“任务结束关闭应用”的提示；
`pc_status` 每次重读启动配置并给出 `reconnectPending`；记录日志写入失败；设置页跟随“界面文字”；
“恢复默认”只在值不同时显示；清空文本框提交 `unset`；测试结束删除临时目录。

## 0.5.5

0.5.5 精简设置页文字：第一行改为“启用桌面操控”，页说明与页脚各留一句；“界面文字”移到最后的
“通用”组。

## 0.5.4

0.5.4 把设置页间距对齐 DSH 自带设置页：页标题 16/500/24、说明 14/22、行标题与行说明设行高、
组间 12 px、行间无空隙、每组最后一行不画分隔线。

## 0.5.3

0.5.3 去掉四个开关行的“恢复默认”（开关拨回去即可）；开关拨回默认值时改为删除已保存的覆盖，
而不是再写一条同样的值。

## 0.5.2

0.5.2 把“已保存”移到设置标题同一行的右侧，把“恢复默认”移到控件左边：提示出现时不再推动
选项，各行控件的右边缘对齐。

## 0.5.1

0.5.1 修正设置页开关：滑块改用 DSH 主题里真实存在的变量，开与关清晰可见；开关不再被“恢复默认”
挤窄。

## 0.5.0

0.5.0 把浏览器与桌面拆成两个服务器，按 Codex 应用的方式分别启动：浏览器用 `cua_repl`，桌面用
`node_repl`。新增桌面工具 `pc_codex_desktop_js`、`pc_codex_desktop_js_reset` 与
`pc_codex_desktop_js_add_node_module_dir`（开关 `tools.desktopJs` / `tools.desktopReset` /
`tools.desktopAddNodeModuleDir`，默认全开）；`pc_status` 改为分别报告 `browser` 与 `desktop`，
删除 `servicesFrom`；两个服务器各用自己的启动环境。

## 0.4.3

0.4.3 新增：DSH 设置侧栏“插件市场”下方的“电脑操控”设置页，可改桌面操控、三选项卡片、记住授权、
界面文字、浏览器自动授权、调用超时、Codex 配置目录与日志路径；`codexHome` 改为 volatile，改完下一次
调用即重新解析并换到新目录，插件不重新挂载。

## 0.4.2

0.4.2：修复三处实测问题——`turn_ended` 的 `_meta` 用了下一轮 turn id、等待授权的时间计入
调用超时、Codex 重启后仍连着旧桌面助手管道；桌面授权改为三选项卡片（授权策略为“完全权限”时
沿用原一次性卡片）；加入英文支持（`language` 控制插件
自己显示的文字，默认 `auto` 跟随 DSH 界面语言）。

## 0.4.1

0.4.1 修正：删除 `pc_codex_js_add_node_module_dir` 工具、`tools.addNodeModuleDir` 与
`stateFile` 配置项；桥接级 `session_id` 改为内存随机生成，不再读写状态文件；旧配置里的这些键
照常加载。

## 0.4.0

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

## 0.3.2

0.3.2 修正：同一 DSH 会话内按应用记住桌面授权（`rememberDesktopApprovals`）；每轮结束通知
Codex `turn_ended`，收起“正在使用你的电脑”的橙色光圈。

## 0.3.1

0.3.1 修正：补充桌面授权与 DSH 权限模式的说明；`codex_status`（现为 `pc_status`）增加
`servicesFrom`；测试夹具移入 `test/fixtures`。

## 0.3.0

0.3.0 新增：Windows 桌面操控（`computer`，默认关闭；桌面授权交给 DSH 的审批策略）。

## 0.2.0

0.2.0 修正：

- 参数 schema 兜底：拿不到宿主 `defineTool` 时把参数 DSL 转成对象 JSON Schema，并在执行前校验参数；
- volatile 配置修复：正确解包加载器传入的 `Volatile` 配置值，`autoApprove` / `logFile` / `timeoutMs` 改完即生效；
- 审批默认 fail-closed：`autoApprove` 默认 `false`，且只自动接受浏览器访问授权，其他 elicitation 审批一律 decline；
- 审批日志：每一次审批都记录原始文案、决定（accept/decline）和原因，默认写入 `~/.dsh/pc-use.log`；
- 截图清理：工具返回的截图保存到 `~/.dsh/pc-use-images`，扩展名按 mimeType 决定，目录只保留最新的 50 个文件；
- 握手失败清理：initialize 出错、超时或 spawn 失败时结束子进程，不会把没握手的连接当成可用；
- 客户端版本号取自 `package.json`，不再硬编码。
