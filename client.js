// dsh-pc-use — browser half: the "PC Use" settings section under the plugin market.
//
// Registered through `settings.section` (order 41 sorts right after dshmarket's 40) and
// only while the Host serves the `pc-use` settings entry. Every visible string comes from
// the client locale dictionary; the controls use host theme tokens and no external modules
// besides React from the browser module table.
window.__ModuleLoader__.load({
  id: 'dsh-pc-use',
  factory(require) {
    const React = require('react')
    const h = React.createElement

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
      title: '电脑操控',
      intro: '调整 PC Use 的桌面操控、浏览器授权、连接与日志设置；改动会立即生效。',
      groupDesktop: '桌面操控',
      groupBrowser: '浏览器',
      groupConnection: '连接与日志',
      computer: '桌面操控',
      computerDescription: '开启 Windows 桌面应用操控（Codex Computer Use）；桌面授权交给 DSH 的'
        + '审批策略，“完全权限”下直接放行。',
      desktopApprovalChoices: '三选项授权卡片',
      desktopApprovalChoicesDescription: '桌面授权使用三选项卡片（允许这一次 / 本次会话内允许 / 拒绝）；'
        + '关闭后沿用一次性授权卡片。',
      rememberDesktopApprovals: '记住桌面授权',
      rememberDesktopApprovalsDescription: '同一个 DSH 会话里，某个应用经你允许一次后不再询问；'
        + '拒绝不会被记住。桥接重连或关闭此项后重新询问。',
      language: '界面文字',
      languageDescription: '插件自己显示的文字语言：跟随 DSH 界面语言，或固定为中文 / English。',
      languageAuto: '跟随系统',
      languageZh: '中文',
      languageEn: 'English',
      autoApprove: '自动接受浏览器授权',
      autoApproveDescription: '自动接受 Codex 的浏览器访问授权；其他审批请求一律拒绝。'
        + '每次审批都会记录到日志。',
      timeoutMs: '调用超时',
      timeoutMsDescription: '单次工具调用超时，单位秒。',
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
      footer: '启用插件请到“内置插件”或插件管理中操作；工具开关在 profile 的 cordis.patch.yml 中修改。',
      loading: '正在读取设置…',
    }

    const en = {
      nav: 'PC Use',
      title: 'PC Use',
      intro: 'Desktop control, browser approval, connection and logging settings for PC Use; '
        + 'changes apply immediately.',
      groupDesktop: 'Desktop control',
      groupBrowser: 'Browser',
      groupConnection: 'Connection and logs',
      computer: 'Desktop control',
      computerDescription: 'Enable Windows desktop app control (Codex Computer Use); desktop '
        + 'approvals follow DSH\'s approval policy (allowed directly under "full access").',
      desktopApprovalChoices: 'Three-option approval card',
      desktopApprovalChoicesDescription: 'Show the three-option card for desktop approvals '
        + '(allow this time / allow for this session / deny); when off, use the one-shot card.',
      rememberDesktopApprovals: 'Remember desktop approvals',
      rememberDesktopApprovalsDescription: 'Within one DSH session, an app you allowed once '
        + 'is not asked about again; denials are not remembered. A bridge reconnect or turning '
        + 'this off asks again.',
      language: 'Interface text',
      languageDescription: 'Language of the text this plugin shows: follow the DSH interface '
        + 'language, or force Chinese / English.',
      languageAuto: 'Follow system',
      languageZh: '中文',
      languageEn: 'English',
      autoApprove: 'Auto-accept browser approvals',
      autoApproveDescription: 'Automatically accept Codex browser-access approvals; all other '
        + 'approval requests are declined. Every approval is logged.',
      timeoutMs: 'Call timeout',
      timeoutMsDescription: 'Timeout for one tool call, in seconds.',
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
      footer: 'Enable the plugin in "Built-in plugins" or the plugin manager; tool switches '
        + 'live in the profile cordis.patch.yml.',
      loading: 'Reading settings…',
    }

    /** Fields shown on the page, in render order within their groups. O(1). */
    const FIELDS = [
      'computer', 'desktopApprovalChoices', 'rememberDesktopApprovals', 'language',
      'autoApprove', 'timeoutMs', 'codexHome', 'logFile',
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

        /** Save one text or number field; invalid timeouts stay unsaved. O(1) + the write. */
        async commitText(field) {
          const draft = state.drafts[field]
          if (draft === undefined) return false
          let value
          if (field === 'timeoutMs') {
            const seconds = Number(draft.trim())
            const valid = Number.isInteger(seconds)
              && seconds >= TIMEOUT_MIN_SECONDS && seconds <= TIMEOUT_MAX_SECONDS
            if (valid !== true) {
              state = { ...state, errors: { ...state.errors, timeoutMs: 'timeoutRange' } }
              emit()
              return false
            }
            value = seconds * 1000
          } else {
            value = draft.trim()
          }
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
    const titleStyle = { margin: 0, fontSize: 14, color: 'var(--dsw-alias-label-primary)' }
    const descriptionStyle = {
      margin: '4px 0 0',
      fontSize: 12,
      color: 'var(--dsw-alias-label-tertiary)',
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
    const buttonStyle = {
      color: 'var(--dsw-alias-label-primary)',
      background: 'transparent',
      border: 'none',
      padding: '4px 0',
      fontSize: 12,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    const noticeStyle = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
    const groupStyle = { display: 'flex', flexDirection: 'column', gap: 4 }
    const headingStyle = { margin: '18px 0 0', fontSize: 15, fontWeight: 600 }
    const pageStyle = {
      display: 'flex',
      flexDirection: 'column',
      maxWidth: 760,
      color: 'var(--dsw-alias-label-primary)',
    }

    /** One labeled row with its control and optional reset action. O(1). */
    function Row({ id, label, description, resetLabel, showReset, onReset, children }) {
      return h('div', { style: rowStyle }, [
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

    /** The settings page component. O(1) hooks plus the rendered rows. */
    function SettingsPage({ form, t }) {
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
      if (state.status === 'failed') {
        return h('div', { style: pageStyle }, [
          h('h2', { key: 'title', style: { margin: 0, fontSize: 18 } }, t('title')),
          h('p', { key: 'failed', style: noticeStyle }, t('readFailed')),
        ])
      }
      if (state.status !== 'ready') {
        return h('div', { style: pageStyle }, [
          h('p', { key: 'loading', style: noticeStyle }, t('loading')),
        ])
      }
      const disabled = state.writable !== true
      const isReadOnly = (field) => disabled || state.readOnly[field] !== undefined
      const changed = (field) => (state.user[field] !== undefined && state.user[field] !== null)
      const reset = (field) => () => page.resetField(field)
      const rows = []
      const booleanRow = (field) => h(Row, {
        key: field,
        id: `pc-use-${field}`,
        label: t(field),
        description: t(`${field}Description`),
      }, h(Switch, {
        id: `pc-use-${field}`,
        label: t(field),
        checked: state.values[field] === true,
        disabled: isReadOnly(field),
        onChange: (value) => page.setToggle(field, value),
      }))
      rows.push(h('h3', { key: 'desktop-heading', style: headingStyle }, t('groupDesktop')))
      rows.push(booleanRow('computer'))
      rows.push(booleanRow('desktopApprovalChoices'))
      rows.push(booleanRow('rememberDesktopApprovals'))
      const languageValue = state.values.language ?? 'auto'
      const languageOptions = [
        ['auto', t('languageAuto')],
        ['zh', t('languageZh')],
        ['en', t('languageEn')],
      ]
      rows.push(h(Row, {
        key: 'language',
        id: 'pc-use-language',
        label: t('language'),
        description: t('languageDescription'),
        resetLabel: t('reset'),
        showReset: changed('language'),
        onReset: reset('language'),
      }, h('select', {
        id: 'pc-use-language',
        'aria-label': t('language'),
        value: languageValue,
        disabled: isReadOnly('language'),
        style: { ...controlStyle, minWidth: 180 },
        onChange: (event) => page.setLanguage(event.target.value),
      }, languageOptions.map(([value, label]) => h('option', { key: value, value }, label)))))
      rows.push(h('h3', { key: 'browser-heading', style: headingStyle }, t('groupBrowser')))
      rows.push(booleanRow('autoApprove'))
      rows.push(h('h3', { key: 'connection-heading', style: headingStyle }, t('groupConnection')))
      const timeoutDraft = state.drafts.timeoutMs
        ?? toSeconds(state.values.timeoutMs)
      rows.push(h(Row, {
        key: 'timeoutMs',
        id: 'pc-use-timeoutMs',
        label: t('timeoutMs'),
        description: `${t('timeoutMsDescription')} (${TIMEOUT_MIN_SECONDS}–${TIMEOUT_MAX_SECONDS} `
          + `${t('secondsUnit')})`,
        resetLabel: t('reset'),
        showReset: changed('timeoutMs'),
        onReset: reset('timeoutMs'),
      }, h(TextField, {
        id: 'pc-use-timeoutMs',
        label: t('timeoutMs'),
        value: timeoutDraft,
        inputMode: 'numeric',
        disabled: isReadOnly('timeoutMs'),
        onChange: (text) => page.editText('timeoutMs', text),
        onCommit: () => page.commitText('timeoutMs'),
        errorText: state.errors.timeoutMs === undefined ? undefined : t('timeoutInvalid'),
        errorId: 'pc-use-timeoutMs-error',
      })))
      const textRow = (field, placeholderKey) => h(Row, {
        key: field,
        id: `pc-use-${field}`,
        label: t(field),
        description: t(`${field}Description`),
        resetLabel: t('reset'),
        showReset: changed(field),
        onReset: reset(field),
      }, h(TextField, {
        id: `pc-use-${field}`,
        label: t(field),
        value: state.drafts[field] ?? String(state.values[field] ?? ''),
        placeholder: t(placeholderKey),
        disabled: isReadOnly(field),
        onChange: (text) => page.editText(field, text),
        onCommit: () => page.commitText(field),
      }))
      rows.push(textRow('codexHome', 'codexHomePlaceholder'))
      rows.push(textRow('logFile', 'logFilePlaceholder'))
      // Keep the live region in the DOM so screen readers announce later updates; the text
      // changes in place and the title row never changes height.
      const notice = h('p', {
        key: 'notice',
        role: 'status',
        style: { ...noticeStyle, margin: 0, whiteSpace: 'nowrap' },
      }, state.notice === null ? '' : t(state.notice))
      const readOnlyNotice = Object.keys(state.readOnly).length > 0
        ? h('p', { key: 'readonly', style: noticeStyle }, t('writeRejected'))
        : null
      return h('div', { style: pageStyle }, [
        h('div', {
          key: 'header',
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 12,
          },
        }, [
          h('h2', { key: 'title', style: { margin: 0, fontSize: 18 } }, t('title')),
          notice,
        ]),
        h('p', { key: 'intro', style: descriptionStyle }, t('intro')),
        readOnlyNotice,
        h('div', { key: 'rows', style: groupStyle }, rows),
        h('p', { key: 'footer', style: { ...descriptionStyle, marginTop: 20 } }, t('footer')),
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
