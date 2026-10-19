// dsh-pc-use — browser half: the "PC Use" settings section under the plugin market.
//
// Registered through `settings.section` (order 41 sorts right after dshmarket's 40) and
// only while the Host serves the `pc-use` settings entry. Every visible string comes from the
// client locale dictionary, or from the page dictionary picked by the plugin's `language`
// setting; the controls use host theme tokens, React from the browser module table, and the
// optional DSH primitives menu (with a native <select> fallback).
window.__ModuleLoader__.load({
  id: 'dsh-pc-use',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // Optional official DSH primitives. Older hosts and the unit-test loader may not provide
    // them; the language row then falls back to the native <select>.
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }

    /** Client locale namespace owned by this plugin. */
    const NS = 'pc-use'
    /** Host settings entry id: the profile patch row id `pc-use`. */
    const ENTRY_ID = 'pc-use'
    /** dshmarket registers `settings.section` id `market` with order 40. */
    const SECTION_ORDER = 41
    const TIMEOUT_MIN_SECONDS = 10
    const TIMEOUT_MAX_SECONDS = 3600

    const zh = {
      nav: '电脑操控',
      groupDesktop: '桌面操控',
      groupBrowser: '浏览器',
      groupGeneral: '通用',
      computer: '启用桌面操控',
      computerDescription: '开启 Windows 桌面应用操控（Codex Computer Use）；桌面授权交给 DSH 的'
        + '审批策略，“完全权限”下直接放行。',
      rememberDesktopApprovals: '记住桌面授权',
      rememberDesktopApprovalsDescription: '同一个 DSH 会话里，某个应用经你允许一次后不再询问；'
        + '拒绝不会被记住。桥接重连或关闭此项后重新询问。',
      language: '界面文字',
      languageDescription: '插件自己显示的文字语言：跟随 DSH 界面语言，或固定为中文 / English。',
      languageAuto: '跟随 DSH 界面语言',
      languageZh: '中文',
      languageEn: 'English',
      autoApprove: '自动接受浏览器授权',
      autoApproveDescription: '自动接受 Codex 的浏览器访问授权；其他审批请求一律拒绝。'
        + '每次审批都会记录到日志。',
      timeoutMs: '调用超时',
      timeoutMsDescription: '单次工具调用超时，单位秒。',
      attachImages: '附图给模型',
      attachImagesDescription: '把工具返回的截图作为图片附给模型。截图会发到模型服务商；按 DSH 0.2.1-rc.2 源码默认经 '
        + 'Files API 上传，有效期 7 天，会话结束时不删除；本机 DSH 附件库另存一份。'
        + '不想上传就关闭。',
      keepImageFiles: '本机保留附图',
      keepImageFilesDescription: '附图时同时在本机 ~/.dsh/pc-use-images 再存一份；默认只由 DSH 附件库保存。',
      allowUserTabs: '允许读取用户标签页',
      allowUserTabsDescription: '允许模型读取用户标签页和浏览历史（`browser.user.openTabs`、'
        + '`claimTab`、`getTabContext`、`browser.history`、`cua.getTab`、`cua.getState`、'
        + '`browser.tabs.get`、`browser.tabs.content`）。关闭时前四项直接报错；'
        + '`cua.getTab`、`browser.tabs.get`、`browser.tabs.content` 只接受插件标签页'
        + '（经本插件打开或认领的标签页），`cua.getState` 只列出插件标签页。打开后，'
        + '标签页标题、网址、页面内容或历史会发给模型服务商。',
      timeoutInvalid: '请输入 10 到 3600 之间的整数秒。',
      secondsUnit: '秒',
      codexHome: 'Codex 配置目录',
      codexHomeDescription: '留空表示默认目录 %USERPROFILE%\\.codex。',
      codexHomePlaceholder: '%USERPROFILE%\\.codex',
      logFile: '桥接日志',
      logFileDescription: '留空表示默认路径 ~/.dsh/pc-use.log。',
      logFilePlaceholder: '~/.dsh/pc-use.log',
      reset: '恢复默认',
      saved: '已保存',
      conflict: '设置已被其他地方修改，已载入最新值',
      readFailed: '读取失败',
      writeRejected: '写入被拒绝：该配置项可能被 profile 的其它层覆盖。',
      footer: '启用插件请到“内置插件”或插件管理中操作。',
      loading: '正在读取设置…',
    }

    const en = {
      nav: 'PC Use',
      groupDesktop: 'Desktop control',
      groupBrowser: 'Browser',
      groupGeneral: 'General',
      computer: 'Enable desktop control',
      computerDescription: 'Enable Windows desktop app control (Codex Computer Use); desktop '
        + 'approvals follow DSH\'s approval policy (allowed directly under "full access").',
      rememberDesktopApprovals: 'Remember desktop approvals',
      rememberDesktopApprovalsDescription: 'Within one DSH session, an app you allowed once '
        + 'is not asked about again; denials are not remembered. A bridge reconnect or turning '
        + 'this off asks again.',
      language: 'Interface text',
      languageDescription: 'Language of the text this plugin shows: follow the DSH interface '
        + 'language, or force Chinese / English.',
      languageAuto: 'Follow DSH interface language',
      languageZh: '中文',
      languageEn: 'English',
      autoApprove: 'Auto-accept browser approvals',
      autoApproveDescription: 'Automatically accept Codex browser-access approvals; all other '
        + 'approval requests are declined. Every approval is logged.',
      timeoutMs: 'Call timeout',
      timeoutMsDescription: 'Timeout for one tool call, in seconds.',
      attachImages: 'Attach screenshots',
      attachImagesDescription: 'Attach screenshots returned by the tools as images. '
        + 'Screenshots are sent to the model provider; per DSH 0.2.1-rc.2 source they use '
        + 'the Files API by default, expire '
        + 'after 7 days, and are not deleted when the session ends; the local DSH '
        + 'attachment store also keeps a copy. Turn this off to avoid uploading.',
      keepImageFiles: 'Keep local image files',
      keepImageFilesDescription: 'Also save attached images under ~/.dsh/pc-use-images; '
        + 'by default only the DSH attachment store keeps them.',
      allowUserTabs: 'Allow reading user tabs',
      allowUserTabsDescription: 'Allow the model to read user tabs and browsing history '
        + '(`browser.user.openTabs`, `claimTab`, `getTabContext`, `browser.history`, '
        + '`cua.getTab`, `cua.getState`, `browser.tabs.get`, `browser.tabs.content`). While '
        + 'off, the first four fail with an error; `cua.getTab`, `browser.tabs.get` and '
        + '`browser.tabs.content` only accept plugin tabs (tabs opened or claimed through '
        + 'this plugin), and `cua.getState` lists only plugin tabs. While on, tab titles, '
        + 'URLs, page content or history are sent to the model provider.',
      timeoutInvalid: 'Enter an integer between 10 and 3600 seconds.',
      secondsUnit: 'seconds',
      codexHome: 'Codex home',
      codexHomeDescription: 'Leave empty for the default %USERPROFILE%\\.codex.',
      codexHomePlaceholder: '%USERPROFILE%\\.codex',
      logFile: 'Bridge log',
      logFileDescription: 'Leave empty for the default ~/.dsh/pc-use.log.',
      logFilePlaceholder: '~/.dsh/pc-use.log',
      reset: 'Restore default',
      saved: 'Saved',
      conflict: 'These settings were changed elsewhere; the latest values were loaded',
      readFailed: 'Failed to read settings',
      writeRejected: 'Write refused: another profile layer probably overrides this field.',
      footer: 'Enable the plugin in "Built-in plugins" or the plugin manager.',
      loading: 'Reading settings…',
    }

    /**
     * Translator for the page text. The plugin's `language` setting picks the dictionary;
     * `auto` (or an unknown value) keeps the DSH interface language through `fallback`.
     * Saving `language` updates `state.values`, so the next render switches dictionaries. O(1).
     */
    function translateFor(language, fallback) {
      const dictionary = language === 'zh' ? zh : language === 'en' ? en : null
      if (dictionary === null) return fallback
      return (key) => dictionary[key] ?? fallback(key)
    }

    /** Fields shown on the page, in render order within their groups. O(1). */
    const FIELDS = [
      'computer', 'rememberDesktopApprovals',
      'autoApprove', 'allowUserTabs',
      'language', 'timeoutMs', 'attachImages', 'keepImageFiles', 'codexHome', 'logFile',
    ]

    /** Initial page state before the first configuration read. O(1). */
    function initialState() {
      return {
        status: 'loading',
        readFailed: false,
        writable: false,
        revision: undefined,
        values: {},
        base: {},
        user: {},
        drafts: {},
        readOnly: {},
        errors: {},
        notice: null,
        saving: {},
      }
    }

    /** Milliseconds to displayed whole seconds. O(1). */
    function toSeconds(milliseconds) {
      const value = Number(milliseconds)
      return Number.isFinite(value) ? String(Math.round(value / 1000)) : ''
    }

    /**
     * Page model over one `configForms` entry. It reads the form snapshot, keeps the user's
     * uncommitted text, writes single fields with the revision it read, and exposes a
     * subscribe/getSnapshot pair for React. O(1) per state change.
     */
    function createPage(form) {
      let state = initialState()
      let mounted = false
      let unsubscribeForm = null
      const listeners = new Set()

      const emit = () => {
        for (const listener of [...listeners]) listener()
      }

      const refresh = () => {
        let snapshot
        try {
          snapshot = form.getSnapshot()
        } catch {
          snapshot = undefined
        }
        // Loading is the first-read state, not a failure: it renders the skeleton page.
        if (snapshot !== undefined && snapshot.status === 'loading') {
          state = { ...initialState(), status: 'loading' }
          emit()
          return
        }
        if (snapshot === undefined || snapshot.status !== 'ready'
          || typeof snapshot.value !== 'object' || snapshot.value === null) {
          state = { ...initialState(), status: 'failed', readFailed: true }
          emit()
          return
        }
        const values = {}
        for (const field of FIELDS) {
          if (Object.hasOwn(snapshot.value, field)) values[field] = snapshot.value[field]
        }
        state = {
          status: 'ready',
          readFailed: false,
          writable: snapshot.writable === true,
          revision: snapshot.revision,
          values,
          base: snapshot.base !== null && typeof snapshot.base === 'object'
            && !Array.isArray(snapshot.base) ? snapshot.base : {},
          user: snapshot.user ?? {},
          drafts: { ...state.drafts },
          readOnly: { ...state.readOnly },
          errors: { ...state.errors },
          notice: state.notice,
          saving: { ...state.saving },
        }
        emit()
      }

      const write = async (field, op, displayValue) => {
        if (state.status !== 'ready' || state.writable !== true) return false
        if (state.readOnly[field] !== undefined) return false
        const revision = state.revision
        state = { ...state, saving: { ...state.saving, [field]: true } }
        emit()
        let accepted = false
        try {
          accepted = await form.mutate([op], revision)
        } catch {
          accepted = false
        }
        if (accepted === true) {
          const values = { ...state.values }
          if (op.op === 'set') values[field] = op.value
          if (displayValue !== undefined) values[field] = displayValue
          const drafts = { ...state.drafts }
          delete drafts[field]
          const errors = { ...state.errors }
          delete errors[field]
          const saving = { ...state.saving }
          delete saving[field]
          state = { ...state, values, drafts, errors, saving, notice: 'saved' }
          emit()
          return true
        }
        refresh()
        if (state.revision !== undefined && revision !== undefined
          && state.revision !== revision) {
          state = { ...state, notice: 'conflict' }
        } else {
          state = {
            ...state,
            notice: null,
            readOnly: { ...state.readOnly, [field]: 'writeRejected' },
          }
        }
        emit()
        return false
      }

      const page = {
        getSnapshot: () => state,

        /** Subscribe to page state changes; returns the unsubscribe function. O(1). */
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },

        /** Follow the Host form while mounted. O(1). */
        mount() {
          if (mounted) return
          mounted = true
          if (typeof form.subscribe === 'function') {
            unsubscribeForm = form.subscribe(() => refresh())
          }
          // Read once after subscribing so a change between render and mount is not lost.
          refresh()
        },

        /** Drop every listener and the form subscription. O(1). */
        dispose() {
          mounted = false
          listeners.clear()
          if (unsubscribeForm !== null) {
            unsubscribeForm()
            unsubscribeForm = null
          }
        },

        refresh,

        /** Immediate write for switches and the language select. O(1) + the write. */
        setToggle(field, value) {
          const base = state.base[field]
          const atBase = typeof base === 'boolean' && base === value
          return write(field, atBase
            ? { op: 'unset', path: [field] }
            : { op: 'set', path: [field], value }, value)
        },

        setLanguage(value) {
          return write('language', { op: 'set', path: ['language'], value })
        },

        /** Keep text input content until blur / Enter. O(1). */
        editText(field, text) {
          state = { ...state, drafts: { ...state.drafts, [field]: String(text) } }
          emit()
        },

        /**
         * Save one text or number field; invalid timeouts stay unsaved, and a text field
         * emptied down to whitespace clears its override instead of storing "". O(1) + the write.
         */
        async commitText(field) {
          const draft = state.drafts[field]
          if (draft === undefined) return false
          if (field === 'timeoutMs') {
            const seconds = Number(draft.trim())
            const valid = Number.isInteger(seconds)
              && seconds >= TIMEOUT_MIN_SECONDS && seconds <= TIMEOUT_MAX_SECONDS
            if (valid !== true) {
              state = { ...state, errors: { ...state.errors, timeoutMs: 'timeoutRange' } }
              emit()
              return false
            }
            return write(field, { op: 'set', path: [field], value: seconds * 1000 })
          }
          const value = draft.trim()
          // Clearing a path field means "use the default", like the Restore default button.
          if (value === '') return write(field, { op: 'unset', path: [field] })
          return write(field, { op: 'set', path: [field], value })
        },

        /** Clear one user override. O(1) + the write. */
        resetField(field) {
          return write(field, { op: 'unset', path: [field] })
        },
      }

      refresh()
      return page
    }

    const rowStyle = {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 24,
      padding: '16px 0',
      borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
    }
    const footerStyle = {
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
    }
    const titleStyle = {
      margin: 0,
      fontSize: 14,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary)',
    }
    const descriptionStyle = {
      margin: '4px 0 0',
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const controlStyle = {
      color: 'var(--dsw-alias-label-primary)',
      background: 'transparent',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 6,
      padding: '4px 8px',
      fontSize: 13,
      minWidth: 160,
    }
    // Reuse the real input metrics and only swap the paint, so the skeleton box matches.
    const skeletonInputStyle = {
      ...controlStyle,
      background: 'var(--dsw-alias-bg-skeleton)',
      borderColor: 'transparent',
    }
    const buttonStyle = {
      color: 'var(--dsw-alias-label-primary)',
      background: 'transparent',
      border: 'none',
      padding: '4px 0',
      fontSize: 12,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    const languageSelectorStyle = {
      borderRadius: 'var(--dsw-radius-md)',
      background: 'var(--dsw-alias-bg-module-platform)',
      height: 36,
      font: 'inherit',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
      border: 'none',
      alignItems: 'center',
      gap: 12,
      padding: '0 14px',
      fontSize: 14,
      lineHeight: '22px',
      display: 'inline-flex',
    }
    const SELECTOR_CSS_ID = 'dsh-pc-use/settings.css'
    const SELECTOR_HOVER_CSS = '.pc-use-selector:hover { '
      + 'background: var(--dsw-alias-interactive-bg-hover); }'
    // The icon component only accepts size/className/strokeWidth, so flex lives in a class.
    const SELECTOR_CHEVRON_CSS = '.pc-use-chevron { flex: none; }'
    // Same pulse as the host's ListSkeleton; the class only animates the painted fill.
    const SKELETON_CSS = '.pc-use-skeleton { animation: pc-use-skeleton 2s '
      + 'cubic-bezier(0.36, 0, 0.64, 1) infinite; }\n'
      + '@keyframes pc-use-skeleton { 0% { opacity: 1; } 40% { opacity: 0.6; } '
      + '80%, 100% { opacity: 1; } }\n'
      + '@media (prefers-reduced-motion: reduce) { .pc-use-skeleton { animation: none; } }'
    /** Inject the hover and skeleton rules once; inline styles cannot express them. O(1). */
    function ensureSelectorCss() {
      if (typeof document === 'undefined' || document === null) return
      const selector = `style[data-plugin-css="${SELECTOR_CSS_ID}"]`
      if (document.querySelector(selector) !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', SELECTOR_CSS_ID)
      style.textContent = `${SELECTOR_HOVER_CSS}\n${SELECTOR_CHEVRON_CSS}\n${SKELETON_CSS}`
      document.head.appendChild(style)
    }
    const noticeStyle = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
    // Same visually-hidden recipe as the host's wCInkW_hiddenLabel: the live region exists
    // for screen readers but does not take part in layout or spacing.
    const visuallyHiddenStyle = {
      position: 'absolute',
      width: 1,
      height: 1,
      overflow: 'hidden',
      clip: 'rect(0 0 0 0)',
      whiteSpace: 'nowrap',
    }
    const groupStyle = { display: 'flex', flexDirection: 'column' }
    const headingStyle = {
      margin: 0,
      fontSize: 14,
      fontWeight: 500,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const pageStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      maxWidth: 760,
      color: 'var(--dsw-alias-label-primary)',
    }

    /** One labeled row with its control and optional reset action. O(1). */
    function Row({ id, label, description, resetLabel, showReset, onReset, last, children }) {
      const style = last === true ? { ...rowStyle, borderBottom: 'none' } : rowStyle
      return h('div', { style }, [
        h('div', { key: 'text', style: { minWidth: 0 } }, [
          h('label', { key: 'label', id: `${id}-label`, htmlFor: id, style: titleStyle }, label),
          h('p', { key: 'description', style: descriptionStyle }, description),
        ]),
        h(
          'div',
          {
            key: 'control',
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 12,
              flexShrink: 0,
            },
          },
          showReset === true
            ? h('button', {
              key: 'reset',
              type: 'button',
              style: buttonStyle,
              onClick: onReset,
            }, resetLabel)
            : null,
          children,
        ),
      ])
    }

    /** A theme-token switch with the host's role/aria contract. O(1). */
    function Switch({ id, label, checked, disabled, onChange }) {
      const track = {
        boxSizing: 'border-box',
        flex: '0 0 auto',
        width: 36,
        height: 20,
        padding: 2,
        border: 0,
        borderRadius: 999,
        cursor: disabled === true ? 'default' : 'pointer',
        background: checked === true
          ? 'var(--dsw-alias-brand-primary)'
          : 'var(--dsw-alias-border-l3)',
        opacity: disabled === true ? 0.5 : 1,
      }
      const knob = {
        display: 'block',
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: checked === true
          ? 'var(--dsw-alias-label-primary-foreground)'
          : 'var(--dsw-alias-switch-thumb)',
        transform: checked === true ? 'translateX(16px)' : 'none',
        transition: 'transform .12s ease',
      }
      return h('button', {
        id,
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        disabled: disabled === true,
        style: track,
        onClick: () => onChange(checked !== true),
      }, h('span', { style: knob }))
    }

    /** Official-style language menu; only rendered when primitives.Menu exists. O(1). */
    function LanguagePicker({ value, items, disabled, label, onSelect }) {
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => {
        ensureSelectorCss()
      }, [])
      const selected = items.find((item) => item.id === value) ?? items[0]
      const Icon = primitives.IconChevronDownOutlineRegular
      const anchor = h('button', {
        type: 'button',
        id: 'pc-use-language',
        className: 'pc-use-selector',
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-label': label,
        disabled: disabled === true,
        style: {
          ...languageSelectorStyle,
          cursor: disabled === true ? 'default' : 'pointer',
        },
        onClick: () => {
          if (disabled === true) return
          setOpen(!open)
        },
      }, selected.label, Icon === undefined ? null : h(Icon, { className: 'pc-use-chevron' }))
      return h(primitives.Menu, {
        open,
        onClose: () => setOpen(false),
        items,
        selectedId: value,
        onSelect: (id) => {
          setOpen(false)
          onSelect(id)
        },
        align: 'end',
        portal: true,
        anchor,
      })
    }

    /** A text input saving on blur or Enter; shows an inline error. O(1). */
    function TextField({ id, label, value, placeholder, inputMode, disabled, onChange, onCommit,
      errorText, errorId }) {
      const input = h('input', {
        id,
        type: 'text',
        inputMode,
        value,
        placeholder,
        disabled: disabled === true,
        'aria-label': label,
        'aria-describedby': errorText === undefined ? undefined : errorId,
        'aria-invalid': errorText !== undefined,
        style: controlStyle,
        onChange: (event) => onChange(event.target.value),
        onBlur: onCommit,
        onKeyDown: (event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          onCommit()
        },
      })
      if (errorText === undefined) return input
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        input,
        h('span', {
          key: 'error',
          id: errorId,
          style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
        }, errorText),
      )
    }

    /** 36x20 switch-shaped fill; inert, unfocusable and hidden from assistive tech. O(1). */
    function SkeletonSwitch({ id }) {
      return h('span', {
        id,
        className: 'pc-use-skeleton',
        'aria-hidden': 'true',
        style: {
          display: 'block',
          boxSizing: 'border-box',
          flex: '0 0 auto',
          width: 36,
          height: 20,
          border: 0,
          borderRadius: 999,
          background: 'var(--dsw-alias-bg-skeleton)',
        },
      })
    }

    /** Text-input-shaped fill with the real input's metrics and an empty value. O(1). */
    function SkeletonInput({ id }) {
      return h('input', {
        id,
        type: 'text',
        readOnly: true,
        disabled: true,
        value: '',
        tabIndex: -1,
        className: 'pc-use-skeleton',
        'aria-hidden': 'true',
        style: skeletonInputStyle,
      })
    }

    /**
     * Language control stand-in. The selected "auto" label and the chevron stay in the flow
     * (painted transparent) so the skeleton keeps the ready control's width. O(1).
     */
    function SkeletonLanguage({ id, label, options, withMenu }) {
      const autoLabel = options[0][1]
      if (withMenu !== true) {
        return h('select', {
          id,
          className: 'pc-use-skeleton',
          'aria-hidden': 'true',
          'aria-label': label,
          tabIndex: -1,
          disabled: true,
          value: 'auto',
          style: {
            ...controlStyle,
            minWidth: 180,
            background: 'var(--dsw-alias-bg-skeleton)',
            borderColor: 'transparent',
            color: 'transparent',
          },
        }, options.map(([value, text]) => h('option', { key: value, value }, text)))
      }
      const Icon = primitives.IconChevronDownOutlineRegular
      return h('span', {
        id,
        className: 'pc-use-skeleton',
        'aria-hidden': 'true',
        style: { position: 'relative', display: 'inline-flex' },
      }, h('span', {
        style: {
          ...languageSelectorStyle,
          background: 'var(--dsw-alias-bg-skeleton)',
          color: 'transparent',
          cursor: 'default',
        },
      }, autoLabel, Icon === undefined ? null : h('span', {
        key: 'chevron',
        style: { visibility: 'hidden', display: 'inline-flex' },
      }, h(Icon, { className: 'pc-use-chevron' }))))
    }

    /**
     * The settings page component. `localeT` follows the DSH interface language; the page
     * picks the zh/en dictionary from the `language` setting (`auto` keeps `localeT`).
     * O(1) hooks plus the rendered rows.
     */
    function SettingsPage({ form, t: localeT }) {
      const page = React.useMemo(() => createPage(form), [form])
      const state = React.useSyncExternalStore(
        page.subscribe,
        page.getSnapshot,
        page.getSnapshot,
      )
      React.useEffect(() => {
        page.mount()
        return () => page.dispose()
      }, [page])
      // The skeleton pulse lives in the shared stylesheet, so inject it for the loading page
      // too; the language picker's own effect only runs after the page is ready.
      React.useEffect(() => {
        ensureSelectorCss()
      }, [])
      const t = translateFor(state.values.language, localeT)
      if (state.status === 'failed') {
        return h('div', { style: pageStyle }, [
          h('p', { key: 'failed', style: noticeStyle }, t('readFailed')),
        ])
      }
      const loading = state.status === 'loading'
      const disabled = state.writable !== true
      const isReadOnly = (field) => disabled || state.readOnly[field] !== undefined
      // The host writes the base value into the profile when it handles `unset`, so compare
      // with the base: an override equal to the default must not offer "Restore default".
      const changed = (field) => state.user[field] !== undefined
        && state.user[field] !== state.base[field]
      const reset = (field) => () => page.resetField(field)
      const booleanRow = (field, last) => h(Row, {
        key: field,
        id: `pc-use-${field}`,
        label: t(field),
        description: t(`${field}Description`),
        last,
      }, loading
        ? h(SkeletonSwitch, { id: `pc-use-${field}` })
        : h(Switch, {
          id: `pc-use-${field}`,
          label: t(field),
          checked: state.values[field] === true,
          disabled: isReadOnly(field),
          onChange: (value) => page.setToggle(field, value),
        }))
      const languageValue = state.values.language ?? 'auto'
      const languageOptions = [
        ['auto', t('languageAuto')],
        ['zh', t('languageZh')],
        ['en', t('languageEn')],
      ]
      const menuAvailable = primitives !== null && typeof primitives.Menu === 'function'
      const languageControl = loading
        ? h(SkeletonLanguage, {
          id: 'pc-use-language',
          label: t('language'),
          options: languageOptions,
          withMenu: menuAvailable,
        })
        : menuAvailable
          ? h(LanguagePicker, {
            value: languageValue,
            items: languageOptions.map(([id, label]) => ({ id, label })),
            disabled: isReadOnly('language'),
            label: t('language'),
            onSelect: (id) => page.setLanguage(id),
          })
          : h('select', {
            id: 'pc-use-language',
            'aria-label': t('language'),
            value: languageValue,
            disabled: isReadOnly('language'),
            style: { ...controlStyle, minWidth: 180 },
            onChange: (event) => page.setLanguage(event.target.value),
          }, languageOptions.map(([value, label]) => h('option', { key: value, value }, label)))
      const languageRow = h(Row, {
        key: 'language',
        id: 'pc-use-language',
        label: t('language'),
        description: t('languageDescription'),
        resetLabel: t('reset'),
        showReset: loading !== true && changed('language'),
        onReset: reset('language'),
      }, languageControl)
      const timeoutDraft = state.drafts.timeoutMs
        ?? toSeconds(state.values.timeoutMs)
      const timeoutControl = loading
        ? h(SkeletonInput, { id: 'pc-use-timeoutMs' })
        : h(TextField, {
          id: 'pc-use-timeoutMs',
          label: t('timeoutMs'),
          value: timeoutDraft,
          inputMode: 'numeric',
          disabled: isReadOnly('timeoutMs'),
          onChange: (text) => page.editText('timeoutMs', text),
          onCommit: () => page.commitText('timeoutMs'),
          errorText: state.errors.timeoutMs === undefined ? undefined : t('timeoutInvalid'),
          errorId: 'pc-use-timeoutMs-error',
        })
      const timeoutRow = h(Row, {
        key: 'timeoutMs',
        id: 'pc-use-timeoutMs',
        label: t('timeoutMs'),
        description: `${t('timeoutMsDescription')} (${TIMEOUT_MIN_SECONDS}–${TIMEOUT_MAX_SECONDS} `
          + `${t('secondsUnit')})`,
        resetLabel: t('reset'),
        showReset: loading !== true && changed('timeoutMs'),
        onReset: reset('timeoutMs'),
      }, timeoutControl)
      const textRow = (field, placeholderKey, last) => h(Row, {
        key: field,
        id: `pc-use-${field}`,
        label: t(field),
        description: t(`${field}Description`),
        resetLabel: t('reset'),
        showReset: loading !== true && changed(field),
        onReset: reset(field),
        last,
      }, loading
        ? h(SkeletonInput, { id: `pc-use-${field}` })
        : h(TextField, {
          id: `pc-use-${field}`,
          label: t(field),
          value: state.drafts[field] ?? String(state.values[field] ?? ''),
          placeholder: t(placeholderKey),
          disabled: isReadOnly(field),
          onChange: (text) => page.editText(field, text),
          onCommit: () => page.commitText(field),
        }))
      const group = (key, headingKey, rows) => h('div', {
        key: `group-${key}`,
        style: groupStyle,
      }, [
        h('h3', { key: `${key}-heading`, style: headingStyle }, t(headingKey)),
        ...rows,
      ])
      const groups = [
        group('desktop', 'groupDesktop', [
          booleanRow('computer'),
          booleanRow('rememberDesktopApprovals', true),
        ]),
        group('browser', 'groupBrowser', [
          booleanRow('autoApprove'),
          booleanRow('allowUserTabs', true),
        ]),
        group('general', 'groupGeneral', [
          languageRow,
          timeoutRow,
          booleanRow('attachImages'),
          booleanRow('keepImageFiles'),
          textRow('codexHome', 'codexHomePlaceholder'),
          textRow('logFile', 'logFilePlaceholder', true),
        ]),
      ]
      // The live region stays in the DOM so screen readers announce later updates, but the
      // official General page shows no page-level success text; only conflicts stay visible.
      const notice = h('p', {
        key: 'notice',
        role: 'status',
        style: visuallyHiddenStyle,
      }, loading ? t('loading') : (state.notice === null ? '' : t(state.notice)))
      const conflictNotice = loading !== true && state.notice === 'conflict'
        ? h('p', { key: 'conflict', style: noticeStyle }, t('conflict'))
        : null
      const readOnlyNotice = loading !== true && Object.keys(state.readOnly).length > 0
        ? h('p', { key: 'readonly', style: noticeStyle }, t('writeRejected'))
        : null
      // The loading page keeps the ready page's box structure; only the controls are fills.
      return h('div', {
        style: pageStyle,
        ...(loading ? { 'aria-busy': 'true' } : {}),
      }, [
        notice,
        conflictNotice,
        readOnlyNotice,
        ...groups,
        h('p', { key: 'footer', style: footerStyle }, t('footer')),
      ])
    }

    /** Register the dictionaries and the settings section once the Host serves it. O(1). */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pc-use: settings dictionaries')
      ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => {
        const form = ctx.configForms.get(ENTRY_ID)
        return ctx.slots.register({
          name: 'settings.section',
          id: 'pc-use',
          order: SECTION_ORDER,
          label: () => t('nav'),
          locale: NS,
        }, (props = {}) => h(SettingsPage, { ...props, form, t }))
      }), 'pc-use: settings section')
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply,
      copy: { zh, en },
      internals: {
        NS,
        ENTRY_ID,
        SECTION_ORDER,
        TIMEOUT_MIN_SECONDS,
        TIMEOUT_MAX_SECONDS,
        createPage,
      },
    }
  },
})
