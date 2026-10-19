# Security policy

## Reporting a vulnerability

Use the repository's private vulnerability reporting: open the Security tab, choose
"Report a vulnerability", and send the report there. Do not open a public issue. Do not send
reports by email.

## Supported versions

Only the latest release receives fixes.

## Data sent to the model provider

- Screenshots when `attachImages` is on.
- Browser page content and desktop window content read by the tools.
- When `allowUserTabs` is on: tab titles, URLs, page content and browsing history read
  through `browser.user.openTabs`, `claimTab`, `getTabContext` and `browser.history`.

## Local writes

- The bridge log at `logFile`, by default `~/.dsh/pc-use.log`.
- Screenshots under `~/.dsh/pc-use-images` when `keepImageFiles` is on.

## Boundaries

The tab guards only prevent misuse; they are not a security boundary. Model code runs in
Codex's `node_repl`, and permissions are decided by Codex and DSH approvals.

## 中文说明

报告漏洞时使用 GitHub 的私密漏洞报告：打开 Security 页，选择“Report a vulnerability”。不要开公开 issue，也不要发邮件。

只修复最新发布版。

插件发给模型服务商的内容：`attachImages` 打开时的截图；工具读到的浏览器页面与桌面窗口内容；
`allowUserTabs` 打开时的标签页标题、网址、页面内容和浏览历史。本机写入：日志 `logFile`，
以及 `keepImageFiles` 打开时的截图目录。

标签页守卫只防误用，不是安全边界。模型代码在 Codex 的 `node_repl` 里运行，权限由 Codex 与 DSH 的审批决定。
