// Every user-visible string of this plugin, in both supported languages. The two
// language trees must keep identical keys (locked by test/language.test.js), and the
// localized objects follow DSH's LocalizedText rules: lowercase language ids with `en`.
//
// The machine-facing text (tool descriptions, docs mapping, error messages) stays in
// English where it is used and is deliberately not part of this module.

import {
  APPROVE, DECLINE, REASON_NO_CHOICE, REASON_REJECTED, REASON_SESSION,
} from './approval.js'

/** Placeholder replaced with the desktop app's display name. */
const APP = '{app}'

export const TEXT = {
  zh: {
    config: {
      description: 'dsh-pc-use 的功能开关与默认值。',
      enabled: '注册 Codex 工具。关闭后本插件不提供任何工具（相当于停用）。',
      autoApprove: '自动接受 Codex 的浏览器访问授权；其他审批请求一律拒绝。每次审批都会记录到日志。',
      computer: '开启 Windows 桌面应用操控（Codex Computer Use）；桌面授权交给 DSH 的审批策略，'
        + '“完全权限”下直接放行。',
      rememberDesktopApprovals: '同一个 DSH 会话里，某个应用经你允许一次后不再询问；拒绝不会被记住。'
        + '桥接重连或关闭此项后重新询问。关闭时会重启桌面服务器，已记住的授权全部失效，'
        + '桌面 JS 内核里的变量也会清空。正在运行的桌面调用会中断。',
      language: '插件界面文字的语言：auto 跟随 DSH 界面语言，或强制 zh / en。',
      codexHome: 'Codex 配置目录；留空表示 %USERPROFILE%\\.codex。',
      logFile: '桥接日志路径；留空则写入 ~/.dsh/pc-use.log。',
      timeoutMs: '单次工具调用超时（毫秒）。',
      attachImages: '把工具返回的截图作为图片附给模型。截图会发到模型服务商；按 DSH 0.2.1-rc.2 源码，'
        + '默认经 Files API 上传，有效期 7 天，会话结束时不删除；本机另有 DSH 附件库保存。'
        + '不想上传就关闭。',
      keepImageFiles: '附图时同时在本机 ~/.dsh/pc-use-images 再存一份；默认只由 DSH 附件库保存。',
      allowUserTabs: '允许模型读取用户标签页和浏览历史（`browser.user.openTabs`、'
        + '`claimTab`、`getTabContext`、`browser.history`、`cua.getTab`、`cua.getState`、'
        + '`browser.tabs.get`、`browser.tabs.content`）。关闭时前四项直接报错；'
        + '`cua.getTab`、`browser.tabs.get`、`browser.tabs.content` 只接受插件标签页'
        + '（经本插件打开或认领的标签页），`cua.getState` 只列出插件标签页。打开后，'
        + '标签页标题、网址、页面内容或历史会发给模型服务商。',
      prefetchServerDocs: 'DSH 启动时，如果本机缓存的 Codex 工具说明缺失或已过期，'
        + '就在后台提前连接服务器取说明。改动在 DSH 下次启动时生效。',
      tools: {
        description: '要注册哪些工具。',
        js: '注册 `pc_codex_js`：在持久的 cua_repl 内核中执行 JS。',
        reset: '注册 `pc_codex_js_reset`：重置 JS 内核。',
        desktopJs: '注册 `pc_codex_desktop_js`：在 Codex 的 node_repl 内核里执行 JS，'
          + '用于操控 Windows 桌面应用。',
        desktopReset: '注册 `pc_codex_desktop_js_reset`：重置桌面 node_repl 的 JS 内核。',
        desktopAddNodeModuleDir: '注册 `pc_codex_desktop_js_add_node_module_dir`：'
          + '把 Node 模块目录加入桌面 node_repl。',
        docs: '注册 `pc_codex_docs`：读取 Codex 自带的 Computer Use 文档。',
        status: '注册 `pc_status`：报告解析结果与连接状态。',
        observe: '注册 `pc_codex_observe`：输出完整无障碍树/文本供了解全貌；'
          + '例行判断应在 js 代码里读取具体值、只打印需要的部分。',
        runPlan: '注册 `pc_codex_run_plan`：备选；需要逐步状态或失败后自动观察时使用。',
      },
    },
    card: {
      header: '桌面授权',
      question: 'Codex Computer Use 请求操作“{app}”，是否允许？',
      allowOnce: {
        label: '允许这一次',
        description: '只允许这一步操作，下次操作该应用时再询问。',
      },
      allowSession: {
        label: '本次会话内允许',
        description: '在本次 DSH 会话中操作“{app}”时不再询问；重新连接或重启后失效。',
      },
      deny: {
        label: '拒绝',
        description: '不允许这一步操作。',
      },
    },
    legacyDisplayReason: '允许 Codex Computer Use 操作“{app}”？',
    serverDocsChanged: '【dsh-pc-use】DSH 载入工具列表后，Codex 服务器对这个工具的说明'
      + '有了变化。下面是服务器当前的说明；工具说明中的 DSH 插件规则仍然适用。',
    auditReason: 'Codex Computer Use 请求操作桌面应用：{app}',
    notes: {
      decline: '用户在 DSH 中没有批准对“{app}”的操作。不要重试，也不要换写法绕过；'
        + '如需继续，请先询问用户。',
      illegalReturn: '去掉顶层 return。结果不会自动返回：用 nodeRepl.write(...) 或 '
        + 'console.log(...) 输出要返回的文字。',
      nativePipeUnavailable: 'Codex 的原生管道不可用。可能是 Codex 应用没有运行，或配置里的'
        + '管道属于已经退出的 Codex 应用实例。不要重试，不要修改配置文件，也不要改用别的管道；'
        + '请告诉用户完全退出并重新打开 Codex 应用，然后再试。`pc_status` 里对应目标的 '
        + '`nativePipeState` 显示管道是否存在。',
      closeApps: '任务完成后，关闭本次由它打开的应用，除非用户要求保留；不要关闭用户原本就开着的窗口。',
      noAccessibilityTreeScreenshot: '这个窗口没有返回无障碍树（有些 Windows 应用，例如记事本、'
        + '计算器，会这样）。请按本次附带的截图判断状态；不要用 run_plan 的 check 读取界面值。'
        + '不要读日志、配置文件，也不要在磁盘上搜索原因；截图也不够时，停下并告诉用户。',
      noAccessibilityTreeNoScreenshot: '这个窗口没有返回无障碍树（有些 Windows 应用，例如'
        + '记事本、计算器，会这样）。请用 pc_codex_observe 加 screenshot: true 重新观察，'
        + '再按截图判断；不要用 run_plan 的 check 读取界面值。不要读日志、配置文件，也不要在'
        + '磁盘上搜索原因；截图也不够时，停下并告诉用户。',
    },
  },
  en: {
    config: {
      description: 'Feature switches and defaults for dsh-pc-use.',
      enabled: 'Register the Codex tools. When off, this plugin provides no tools '
        + '(equivalent to disabling it).',
      autoApprove: 'Automatically accept Codex browser-access approvals; all other approval '
        + 'requests are declined. Every approval is logged.',
      computer: 'Enable Windows desktop app control (Codex Computer Use); desktop approvals '
        + 'follow DSH\'s approval policy (allowed directly under "full access").',
      rememberDesktopApprovals: 'Within one DSH session, an app you allowed once is not asked '
        + 'about again; denials are not remembered. A bridge reconnect or turning this off '
        + 'asks again. Turning it off restarts the desktop server: remembered approvals end '
        + 'and the desktop JS kernel\'s variables are cleared. A desktop call that is '
        + 'running fails.',
      language: 'Language of the plugin interface text: auto follows the DSH interface '
        + 'language, or force zh / en.',
      codexHome: 'Codex configuration directory; empty means %USERPROFILE%\\.codex.',
      logFile: 'Bridge log path; empty means ~/.dsh/pc-use.log.',
      timeoutMs: 'Timeout for one tool call (milliseconds).',
      attachImages: 'Attach screenshots returned by the tools as images. Screenshots are '
        + 'sent to the model provider; per DSH 0.2.1-rc.2 source they use the Files API '
        + 'by default, '
        + 'expire after 7 days, and are not deleted when the session ends; the local DSH '
        + 'attachment store also keeps a copy. Turn this off to avoid uploading.',
      keepImageFiles: 'Also save attached images under ~/.dsh/pc-use-images; by default '
        + 'only the DSH attachment store keeps them.',
      allowUserTabs: 'Allow the model to read user tabs and browsing history '
        + '(`browser.user.openTabs`, `claimTab`, `getTabContext`, `browser.history`, '
        + '`cua.getTab`, `cua.getState`, `browser.tabs.get`, `browser.tabs.content`). While '
        + 'off, the first four fail with an error; `cua.getTab`, `browser.tabs.get` and '
        + '`browser.tabs.content` only accept plugin tabs (tabs opened or claimed through '
        + 'this plugin), and `cua.getState` lists only plugin tabs. While on, tab titles, '
        + 'URLs, page content or history are sent to the model provider.',
      prefetchServerDocs: 'When DSH starts and the cached Codex tool documentation is '
        + 'missing or out of date, connect to the servers in the background to fetch it. '
        + 'Takes effect at the next DSH start.',
      tools: {
        description: 'Which tools to register.',
        js: 'Register `pc_codex_js`: run JavaScript in the persistent cua_repl kernel.',
        reset: 'Register `pc_codex_js_reset`: reset the JavaScript kernel.',
        desktopJs: 'Register `pc_codex_desktop_js`: run JavaScript in Codex\'s node_repl '
          + 'kernel for Windows desktop apps.',
        desktopReset: 'Register `pc_codex_desktop_js_reset`: reset the desktop node_repl '
          + 'JavaScript kernel.',
        desktopAddNodeModuleDir: 'Register `pc_codex_desktop_js_add_node_module_dir`: add a Node '
          + 'module directory to the desktop node_repl.',
        docs: 'Register `pc_codex_docs`: read Codex\'s bundled Computer Use docs.',
        status: 'Register `pc_status`: report resolved configuration and connection state.',
        observe: 'Register `pc_codex_observe`: show the complete accessibility tree/text; '
          + 'routine checks should read specific values in js code and print only what is needed.',
        runPlan: 'Register `pc_codex_run_plan`: fallback for step-by-step status or '
          + 'automatic observation after a failure.',
      },
    },
    card: {
      header: 'Desktop approval',
      question: 'Codex Computer Use wants to operate “{app}”. Allow?',
      allowOnce: {
        label: 'Allow this time',
        description: 'Allow this step only; ask again the next time this app is used.',
      },
      allowSession: {
        label: 'Allow for this session',
        description: 'Don\'t ask again for “{app}” in this DSH session; this ends on reconnect '
          + 'or restart.',
      },
      deny: {
        label: 'Deny',
        description: 'Don\'t allow this step.',
      },
    },
    legacyDisplayReason: 'Allow Codex Computer Use to operate “{app}”?',
    serverDocsChanged: '[dsh-pc-use] The Codex server changed its documentation for this '
      + 'tool after DSH loaded the tool list. The current server documentation follows; '
      + 'the DSH plugin rules in the tool description still apply.',
    auditReason: 'Codex Computer Use requests access to the desktop app: {app}',
    notes: {
      decline: 'The user did not approve operating "{app}" in DSH. Do not retry or try '
        + 'to bypass this; ask the user first if you need to continue.',
      illegalReturn: 'Remove the top-level `return`. Values are not returned automatically; '
        + 'print what you need with `nodeRepl.write(...)` or `console.log(...)`.',
      nativePipeUnavailable: 'The Codex native pipe is unavailable. The Codex app may not be '
        + 'running, or the pipe in its configuration may belong to a Codex app instance that '
        + 'has exited. Do not retry, do not edit configuration files and do not switch to '
        + 'another pipe; ask the user to fully quit and reopen the Codex app, then try again. '
        + '`nativePipeState` for this target in `pc_status` shows whether the pipe exists.',
      closeApps: 'After finishing the task, close the apps it opened unless the user asks '
        + 'to keep them; do not close windows the user already had open.',
      noAccessibilityTreeScreenshot: 'This window returned no accessibility tree (some '
        + 'Windows apps, such as Notepad and Calculator, behave this way). Use the screenshot '
        + 'included in this result to judge state; do not use run_plan checks to read UI '
        + 'values here. Do not read logs or configuration files, and do not search the disk '
        + 'for the reason; if the screenshot is not enough, stop and tell the user.',
      noAccessibilityTreeNoScreenshot: 'This window returned no accessibility tree (some '
        + 'Windows apps, such as Notepad and Calculator, behave this way). Re-run '
        + 'pc_codex_observe with screenshot: true and judge from the screenshot; do not use '
        + 'run_plan checks to read UI values here. Do not read logs or configuration files, '
        + 'and do not search the disk for the reason; if the screenshot is not enough, stop '
        + 'and tell the user.',
    },
  },
}

/** Fill the `{app}` placeholder of one template. O(n), n = template length. */
function fill(template, appName) {
  return template.replaceAll(APP, appName)
}

/** Schemastery i18n messages for every configuration field, both languages. O(1). */
function configMessages(language) {
  const config = TEXT[language].config
  return {
    $description: config.description,
    enabled: config.enabled,
    autoApprove: config.autoApprove,
    computer: config.computer,
    rememberDesktopApprovals: config.rememberDesktopApprovals,
    language: config.language,
    codexHome: config.codexHome,
    logFile: config.logFile,
    timeoutMs: config.timeoutMs,
    attachImages: config.attachImages,
    keepImageFiles: config.keepImageFiles,
    allowUserTabs: config.allowUserTabs,
    prefetchServerDocs: config.prefetchServerDocs,
    tools: {
      $description: config.tools.description,
      js: config.tools.js,
      reset: config.tools.reset,
      desktopJs: config.tools.desktopJs,
      desktopReset: config.tools.desktopReset,
      desktopAddNodeModuleDir: config.tools.desktopAddNodeModuleDir,
      observe: config.tools.observe,
      runPlan: config.tools.runPlan,
      docs: config.tools.docs,
      status: config.tools.status,
    },
  }
}

/** Config schema messages; the language keys are the lowercase ids DSH reads. */
export const CONFIG_I18N = { zh: configMessages('zh'), en: configMessages('en') }

/** Map one BCP-47-style tag to a supported text language. O(1). */
export function languageFromLocale(locale) {
  const tag = typeof locale === 'string' ? locale.trim().toLowerCase() : ''
  return tag.startsWith('zh') ? 'zh' : 'en'
}

/** Resolve `auto` against a locale tag; explicit `zh` / `en` win. O(1). */
export function resolveLanguage(configured, locale) {
  if (configured === 'zh') return 'zh'
  if (configured === 'en') return 'en'
  return languageFromLocale(locale)
}

/** The host platform locale reported by Node's Intl; falls back to English. O(1). */
export function systemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return 'en'
  }
}

/** Options of the desktop card in one language, in order. O(1). */
function cardOptions(language, appName, sessionOption) {
  const card = TEXT[language].card
  const options = [{
    label: card.allowOnce.label,
    description: fill(card.allowOnce.description, appName),
  }]
  if (sessionOption === true) {
    options.push({
      label: card.allowSession.label,
      description: fill(card.allowSession.description, appName),
    })
  }
  options.push({ label: card.deny.label, description: card.deny.description })
  return options
}

/** The single-select desktop approval question in one language. O(1). */
export function desktopApprovalQuestion(language, appName, sessionOption) {
  const card = TEXT[language].card
  return {
    id: 'desktop-approval',
    header: card.header,
    question: fill(card.question, appName),
    options: cardOptions(language, appName, sessionOption),
    multiSelect: false,
  }
}

/** The option labels that answer one language's card. O(1). */
export function desktopApprovalLabels(language) {
  const card = TEXT[language].card
  return { once: card.allowOnce.label, session: card.allowSession.label, deny: card.deny.label }
}

/**
 * Map one answer batch to a decision. Only the labels of the displayed card count;
 * a custom answer, empty selection or foreign label is a denial. O(1).
 */
export function choiceDecision(answer, language, sessionOption) {
  const item = Array.isArray(answer?.answers) ? answer.answers[0] : null
  if (item === null || item === undefined) return { action: DECLINE, reason: REASON_NO_CHOICE }
  if (typeof item.custom === 'string' && item.custom !== '') {
    return { action: DECLINE, reason: REASON_NO_CHOICE }
  }
  const selected = Array.isArray(item.selected) ? item.selected : []
  if (selected.length !== 1) return { action: DECLINE, reason: REASON_NO_CHOICE }
  const labels = desktopApprovalLabels(language)
  if (selected[0] === labels.once) return { action: APPROVE, reason: 'approved once in DSH' }
  if (sessionOption === true && selected[0] === labels.session) {
    return { action: APPROVE, reason: REASON_SESSION }
  }
  if (selected[0] === labels.deny) return { action: DECLINE, reason: REASON_REJECTED }
  return { action: DECLINE, reason: REASON_NO_CHOICE }
}

/** LocalizedText for the one-shot approval card; the client picks by interface language. */
export function legacyDisplayReason(appName) {
  return {
    en: fill(TEXT.en.legacyDisplayReason, appName),
    zh: fill(TEXT.zh.legacyDisplayReason, appName),
  }
}

/** Audit reason string for `approval.request`, in the configured language. O(n). */
export function auditReason(language, appName) {
  return fill(TEXT[language].auditReason, appName)
}

/** The "user declined, do not retry" note in one language. O(n). */
export function declineNote(language, appName) {
  return fill(TEXT[language].notes.decline, appName)
}

/** The top-level `return` hint in one language. O(1). */
export function illegalReturnNote(language) {
  return TEXT[language].notes.illegalReturn
}

/** The native-pipe guidance in one language. O(1). */
export function nativePipeUnavailableNote(language) {
  return TEXT[language].notes.nativePipeUnavailable
}

/** The "close the apps you opened" instruction in one language. O(1). */
export function closeAppsNote(language) {
  return TEXT[language].notes.closeApps
}

/** The no-accessibility-tree guidance for one screenshot variant. O(1). */
export function noAccessibilityTreeNote(language, screenshot) {
  const notes = TEXT[language].notes
  return screenshot
    ? notes.noAccessibilityTreeScreenshot
    : notes.noAccessibilityTreeNoScreenshot
}

/** The one-time "server docs changed" note in one language. O(1). */
export function serverDocsChangedNote(language) {
  return TEXT[language].serverDocsChanged
}
