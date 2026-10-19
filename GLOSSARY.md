# dsh-pc-use

dsh-pc-use 把 Codex Computer Use 接入 DeepSeek Harness（DSH），让 DSH 里的模型操作用户真实的 Chrome
与 Windows 桌面应用。本文只定义本项目特有的叫法。

## 执行结构

**提供方**（Computer Use provider）：
真正执行 Computer Use 的外部程序。目前只有 Codex。
_避免_：后端、backend、引擎

**目标**（target）：
提供方操作的对象，分为浏览器（用户的 Chrome）与桌面（Windows 桌面应用）两种。
_避免_：后端、侧、端

**服务器**（server）：
提供方为一个目标运行、由本插件连接的进程。Codex 有浏览器服务器（`cua_repl`）与桌面服务器（`node_repl`）。
_避免_：后端、backend、桥接

**桥接**（bridge）：
本插件与一个服务器之间的连接。桥接重连时服务器重新启动。
_避免_：用“桥接”称呼服务器本身

**内核**（kernel）：
服务器里保存 JS 变量与状态的运行环境，同一目标的多次调用共用。重置工具或服务器重启后重新开始。
_避免_：会话、上下文

**DSH 会话**（DSH session）：
DSH 里的一次对话；子代理各自是独立的 DSH 会话。记住的桌面审批按 DSH 会话分开。
_避免_：单独写“会话”“本会话”

**轮次**（turn）：
DSH 会话中从收到一条消息到模型答完的一段。轮次结束时，本插件通知提供方结束对应的操作。
_避免_：回合、一次调用

**模型服务商**（model provider）：
运行 DSH 所用模型的服务方。截图与页面内容会发送给它。
_避免_：提供方、provider（单独使用）

## 标签页

**插件标签页**（plugin tab）：
浏览器内核本次启动后，经本插件打开或认领的 Chrome 标签页。同一个 DSH 进程里的所有 DSH 会话共用同一份。
_避免_：本会话的标签页、自己的标签页、session tab

**用户标签页**（user tab）：
用户 Chrome 中插件标签页以外的标签页。
_避免_：用户自己的标签页、外部标签页

## 授权

**授权请求**（approval request）：
Codex 在访问网站或操作桌面应用前发来的、要求允许的请求。
_避免_：审批请求；正文中单独写 elicitation

**审批**（approval）：
对一条授权请求作出的允许或拒绝，以及向用户征求这一决定的 DSH 卡片。
_避免_：批准、单独写“授权”
