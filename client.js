/**
 * dsh-session-delete — 会话彻底删除（Client 侧）。
 *
 * 1. 在 `sidebar.workspaces.session.menu.item` 注册一个「彻底删除」行，
 *    工作区与未分组区域的会话行共用同一个右键菜单，因此两处都能删。
 * 2. 在 `shell.overlay` 注册一个确认对话框 + 结果提示。
 * 3. 真正删除走 Host 路由 `POST /session-delete/delete`。
 *
 * 只依赖 react 与宿主主题 token，不 require 任何 Harness Client 包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-session-delete'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'
    const MENU_ID = `${NS}:delete`
    const OVERLAY_ID = `${NS}:confirm`

    const CSS = `
.dsd-item-wrap { display: contents; }
.dsd-sep { height: 1px; margin: 4px 8px; background: var(--dsw-alias-border-l1); }
.dsd-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 10px; border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: transparent; color: var(--dsw-alias-state-error-primary, #e5484d);
  font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer;
}
.dsd-item:hover, .dsd-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); outline: none; }
.dsd-item[disabled] { opacity: .5; cursor: default; }
.dsd-item-icon { display: inline-flex; width: 16px; height: 16px; flex: none; }
.dsd-item-icon svg { width: 16px; height: 16px; }
.dsd-backdrop {
  position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.42); pointer-events: auto; z-index: 60;
}
.dsd-dialog {
  width: min(420px, calc(100vw - 48px));
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #1f1f1f));
  color: var(--dsw-alias-label-primary, #eee);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  border-radius: var(--dsw-radius-lg, 12px);
  box-shadow: 0 18px 48px rgba(0,0,0,.35);
  padding: 18px 18px 14px;
}
.dsd-title { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.dsd-desc { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary, #b8b8b8); word-break: break-word; }
.dsd-desc b { color: var(--dsw-alias-label-primary, #eee); font-weight: 600; }
.dsd-hint { margin: 10px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #999); }
.dsd-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.dsd-btn {
  padding: 6px 14px; border-radius: var(--dsw-radius-md, 8px); font: inherit; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  background: transparent; color: var(--dsw-alias-label-primary, #eee); cursor: pointer;
}
.dsd-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.dsd-btn[disabled] { opacity: .55; cursor: default; }
.dsd-btn.dsd-danger {
  border-color: var(--dsw-alias-state-error-primary, #e5484d);
  background: var(--dsw-alias-state-error-primary, #e5484d);
  color: #fff;
}
.dsd-status { margin: 10px 0 0; font-size: 12px; color: var(--dsw-alias-label-tertiary, #999); }
.dsd-error { margin: 10px 0 0; font-size: 12px; color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsd-toast {
  position: fixed; right: 20px; bottom: 20px; max-width: 360px; pointer-events: auto; z-index: 61;
  padding: 10px 14px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px; line-height: 20px;
  background: var(--dsw-alias-bg-overlay, #222); color: var(--dsw-alias-label-primary, #eee);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  box-shadow: 0 10px 30px rgba(0,0,0,.32);
}
.dsd-toast.dsd-ok { border-color: var(--dsw-alias-state-success-primary, #46a758); }
.dsd-toast.dsd-fail { border-color: var(--dsw-alias-state-error-primary, #e5484d); }
`

    /** 幂等注入样式表。 */
    function insertStyles() {
      if (typeof document === 'undefined') return
      const tagId = `${NS}:css`
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** 极简快照 store：确认请求与结果提示。 */
    function createUiStore() {
      let state = { request: null, toast: null }
      const listeners = new Set()
      const publish = () => {
        for (const listener of [...listeners]) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        get: () => state,
        ask(sessionId, displayTitle) {
          state = { ...state, request: { sessionId, displayTitle } }
          publish()
        },
        dismiss() {
          if (state.request === null) return
          state = { ...state, request: null }
          publish()
        },
        notify(kind, text) {
          const toast = { kind, text, at: Date.now() }
          state = { ...state, toast }
          publish()
          setTimeout(() => {
            if (state.toast !== toast) return
            state = { ...state, toast: null }
            publish()
          }, 4200)
        },
      }
    }

    const store = createUiStore()

    /** 调 Host 删除接口。 */
    async function requestDelete(sessionId) {
      const response = await fetch(`${location.origin}/session-delete/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    const TrashIcon = () =>
      h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' },
        h('path', { d: 'M2.5 4.5h11M6 4.5V3.2h4v1.3M4 4.5l.7 8.1a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.1' }),
        h('path', { d: 'M6.6 7v4M9.4 7v4' }),
      )

    /** 右键菜单里的「彻底删除」行。 */
    function DeleteMenuItem(props) {
      const sessionId = props.sessionId
      const displayTitle = props.displayTitle
      const t = props.t
      const useMenuOpenState = props.useMenuOpenState
      const closeMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : undefined
      const disabled = typeof sessionId !== 'string' || sessionId === ''
      const label = t('menu.delete')
      const onSelect = React.useCallback(() => {
        if (typeof closeMenu === 'function') closeMenu(false)
        if (disabled) return
        store.ask(sessionId, displayTitle ?? '')
      }, [closeMenu, disabled, sessionId, displayTitle])
      return h(
        'div',
        { className: 'dsd-item-wrap' },
        h('div', { className: 'dsd-sep', role: 'separator' }),
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'dsd-item',
            disabled,
            onClick: onSelect,
            title: label,
          },
          h('span', { className: 'dsd-item-icon' }, h(TrashIcon, null)),
          h('span', null, label),
        ),
      )
    }

    /** 确认对话框 + 结果提示（挂在 shell.overlay）。 */
    function DeleteOverlay(props) {
      const t = props.t
      const snapshot = React.useSyncExternalStore(store.subscribe, store.get, store.get)
      const request = snapshot.request
      const toast = snapshot.toast
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const dangerRef = React.useRef(null)

      React.useEffect(() => {
        if (request === null) {
          setBusy(false)
          setError('')
          return undefined
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            store.dismiss()
            return
          }
          if (event.key === 'Enter' && !busy) confirm()
        }
        document.addEventListener('keydown', onKeyDown)
        const timer = setTimeout(() => dangerRef.current?.focus?.(), 30)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          clearTimeout(timer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [request, busy])

      async function confirm() {
        if (request === null || busy) return
        setBusy(true)
        setError('')
        try {
          const report = await requestDelete(request.sessionId)
          store.dismiss()
          if (report?.deferred === true) store.notify('ok', t('toast.deferred'))
          else if (report?.stillLive === true) store.notify('ok', t('toast.deletedLive'))
          else store.notify('ok', t('toast.deleted'))
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const dialog =
        request === null
          ? null
          : h(
              'div',
              {
                className: 'dsd-backdrop',
                onMouseDown: (event) => {
                  if (event.target === event.currentTarget && !busy) store.dismiss()
                },
              },
              h(
                'div',
                { className: 'dsd-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${NS}-title` },
                h('h2', { className: 'dsd-title', id: `${NS}-title` }, t('dialog.title')),
                h(
                  'p',
                  { className: 'dsd-desc' },
                  t('dialog.before'),
                  h('b', null, request.displayTitle || request.sessionId),
                  t('dialog.after'),
                ),
                h('p', { className: 'dsd-hint' }, t('dialog.hint')),
                busy ? h('p', { className: 'dsd-status', role: 'status' }, t('dialog.busy')) : null,
                error === '' ? null : h('p', { className: 'dsd-error', role: 'alert' }, error),
                h(
                  'div',
                  { className: 'dsd-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'dsd-btn', disabled: busy, onClick: () => store.dismiss() },
                    t('dialog.cancel'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsd-btn dsd-danger',
                      disabled: busy,
                      ref: dangerRef,
                      onClick: confirm,
                    },
                    busy ? t('dialog.deleting') : t('dialog.confirm'),
                  ),
                ),
              ),
            )

      const notice =
        toast === null
          ? null
          : h(
              'div',
              {
                className: `dsd-toast ${toast.kind === 'ok' ? 'dsd-ok' : 'dsd-fail'}`,
                role: toast.kind === 'ok' ? 'status' : 'alert',
              },
              toast.text,
            )

      return h(React.Fragment, null, dialog, notice)
    }

    const dictionaries = {
      zh: {
        'menu.delete': '彻底删除会话',
        'dialog.title': '彻底删除会话',
        'dialog.before': '将彻底删除「',
        'dialog.after': '」的后端日志、投影缓存与工作区登记。',
        'dialog.hint': '此操作不可撤销，删除后无法恢复该会话的任何历史消息。',
        'dialog.cancel': '取消',
        'dialog.confirm': '彻底删除',
        'dialog.deleting': '删除中…',
        'dialog.busy': '正在删除会话数据…',
        'toast.deleted': '会话已彻底删除。',
        'toast.deferred': '正在后台彻底删除该会话的数据…',
        'toast.deletedLive': '会话数据已删除；该会话仍在内存中运行，重启后不再出现。',
      },
      en: {
        'menu.delete': 'Delete session permanently',
        'dialog.title': 'Delete session permanently',
        'dialog.before': 'This permanently deletes the stored log, projection cache and workspace entry of “',
        'dialog.after': '”.',
        'dialog.hint': 'This cannot be undone — no history of this session can be recovered.',
        'dialog.cancel': 'Cancel',
        'dialog.confirm': 'Delete permanently',
        'dialog.deleting': 'Deleting…',
        'dialog.busy': 'Deleting the session data…',
        'toast.deleted': 'Session deleted permanently.',
        'toast.deferred': 'Deleting this session’s data in the background…',
        'toast.deletedLive': 'Session data deleted; it is still live in memory and will disappear after a restart.',
      },
    }

    /** Client 侧依赖：插槽与本地化。 */
    const inject = ['slots', 'locale']

    /** 注册菜单行、确认层与字典。 */
    function apply(ctx) {
      insertStyles()

      ctx.effect(
        () => ctx.locale.register(NS, dictionaries),
        `${NS}: locale`,
      )
      const t = ctx.locale.bind(NS)

      ctx.slots.inject(MENU_SLOT, () =>
        ctx.slots.register(
          { name: MENU_SLOT, id: MENU_ID, order: 550, inject: () => ({ t }) },
          DeleteMenuItem,
        ),
      )

      ctx.slots.inject(OVERLAY_SLOT, () =>
        ctx.slots.register(
          { name: OVERLAY_SLOT, id: OVERLAY_ID, order: 0, inject: () => ({ t }) },
          DeleteOverlay,
        ),
      )
    }

    exports.name = NS
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
