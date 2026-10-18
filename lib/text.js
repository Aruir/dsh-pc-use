// Every user-visible string of this plugin, in both supported languages. The two
// language trees must keep identical keys (locked by test/language.test.js), and the
// localized objects follow DSH's LocalizedText rules: lowercase language ids with `en`.
//
// The machine-facing text (tool descriptions, docs mapping, error messages) stays in
// English where it is used and is deliberately not part of this module.

import { APPROVE, DECLINE } from './approval.js'

export const LANGUAGES = ['auto', 'zh', 'en']

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
        + '桥接重连或关闭此项后重新询问。',
      desktopApprovalChoices: '桌面授权使用三选项卡片（允许这一次 / 本次会话内允许 / 拒绝）；'
        + '关闭后沿用一次性授权卡片。',
      language: '插件界面文字的语言：auto 跟随 DSH 界面语言，或强制 zh / en。',
      codexHome: 'Codex 配置目录；留空表示 %USERPROFILE%\\.codex。',
      logFile: '桥接日志路径；留空则写入 ~/.dsh/pc-use.log。',
      timeoutMs: '单次工具调用超时（毫秒）。',
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
    auditReason: 'Codex Computer Use 请求操作桌面应用：{app}',
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
        + 'asks again.',
      desktopApprovalChoices: 'Show the three-option card for desktop approvals (allow this '
        + 'time / allow for this session / deny); when off, use the one-shot approval card.',
      language: 'Language of the plugin interface text: auto follows the DSH interface '
        + 'language, or force zh / en.',
      codexHome: 'Codex configuration directory; empty means %USERPROFILE%\\.codex.',
      logFile: 'Bridge log path; empty means ~/.dsh/pc-use.log.',
      timeoutMs: 'Timeout for one tool call (milliseconds).',
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
    auditReason: 'Codex Computer Use requests access to the desktop app: {app}',
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
    desktopApprovalChoices: config.desktopApprovalChoices,
    language: config.language,
    codexHome: config.codexHome,
    logFile: config.logFile,
    timeoutMs: config.timeoutMs,
    tools: {
      $description: config.tools.description,
      js: config.tools.js,
      reset: config.tools.reset,
      desktopJs: config.tools.desktopJs,
      desktopReset: config.tools.desktopReset,
      desktopAddNodeModuleDir: config.tools.desktopAddNodeModuleDir,
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
  if (item === null || item === undefined) return { action: DECLINE, reason: 'no valid choice' }
  if (typeof item.custom === 'string' && item.custom !== '') {
    return { action: DECLINE, reason: 'no valid choice' }
  }
  const selected = Array.isArray(item.selected) ? item.selected : []
  if (selected.length !== 1) return { action: DECLINE, reason: 'no valid choice' }
  const labels = desktopApprovalLabels(language)
  if (selected[0] === labels.once) return { action: APPROVE, reason: 'approved once in DSH' }
  if (sessionOption === true && selected[0] === labels.session) {
    return { action: APPROVE, reason: 'approved for this DSH session' }
  }
  if (selected[0] === labels.deny) return { action: DECLINE, reason: 'rejected in DSH' }
  return { action: DECLINE, reason: 'no valid choice' }
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
