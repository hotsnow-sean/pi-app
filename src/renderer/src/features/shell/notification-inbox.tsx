import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox, RefreshCw, Check, Circle } from '@renderer/components/icons'
import { ipcClient, onAppEvent } from '@renderer/lib/ipc-client'
import { useVisibleInterval } from '@renderer/hooks/use-visible-interval'
import { useUIStore } from '@renderer/stores/ui-store'
import { listAttentionSessions } from '@renderer/lib/session-attention'
import { activateWorkspace, switchSessionInPlace } from '@renderer/lib/activate-workspace'
import { sessionFilesEqual } from '@renderer/lib/session-file-key'
import { SessionAttentionDot } from '@renderer/features/workspace/session-attention-dot'
import { cn } from '@renderer/lib/utils'
import { ShellPopover } from './shell-popover'

type InboxItem = {
  notificationId: string
  workspaceId: string
  sessionId?: string
  sessionFile?: string
  outcome: 'success' | 'failed' | 'cancelled'
  copy?: { title?: string; body?: string }
  unread?: boolean
  createdAt?: number
  /** 插件投递的条目：点开跳插件视图（与 sessionFile 二选一） */
  target?: { pluginId: string; viewId: string }
  /** 插件条目的观感；完成卡不带（按 outcome 推导） */
  tone?: 'info' | 'success' | 'warn' | 'error'
}

const outcomeIcon: Record<InboxItem['outcome'], string> = {
  success: '✓',
  failed: '✕',
  cancelled: '—',
}

const outcomeColor: Record<InboxItem['outcome'], string> = {
  success: 'text-[var(--success-semantic)]',
  failed: 'text-[var(--danger-semantic)]',
  cancelled: 'text-[var(--text-secondary)]',
}

/** 插件条目按 tone 选观感；没有 tone 就沿用完成卡那套 */
const toneIcon: Record<NonNullable<InboxItem['tone']>, string> = {
  info: '•',
  success: '✓',
  warn: '!',
  error: '✕',
}

const toneColor: Record<NonNullable<InboxItem['tone']>, string> = {
  info: 'text-[var(--text-secondary)]',
  success: 'text-[var(--success-semantic)]',
  warn: 'text-[var(--warning-semantic)]',
  error: 'text-[var(--danger-semantic)]',
}

function itemIcon(item: InboxItem): string {
  return item.tone ? toneIcon[item.tone] : outcomeIcon[item.outcome]
}

function itemColor(item: InboxItem): string {
  return item.tone ? toneColor[item.tone] : outcomeColor[item.outcome]
}

/**
 * 两个响应是否是同一份信箱。
 *
 * 参数刻意收成 `unknown`：宿主可能返回不含 `items` 的对象（IPC 桥没注入时的空实现、
 * 通道还没注册的老宿主、上游改过 shape）。这一层必须自己判类型——把 `undefined`
 * 放进 state，下一次渲染就会在 `items.filter` 上炸掉整个外壳。
 */
function sameInboxItems(previous: unknown, next: unknown): boolean {
  if (previous === next) return true
  if (!Array.isArray(previous) || !Array.isArray(next)) return false
  if (previous.length !== next.length) return false
  return previous.every((item, index) => JSON.stringify(item) === JSON.stringify(next[index]))
}

/** 把任意响应收敛成条目数组；不是数组就是「这次没读到」，不能当空信箱处理 */
function readInboxItems(res: unknown): InboxItem[] | null {
  const raw = (res as { items?: unknown } | null | undefined)?.items
  return Array.isArray(raw) ? (raw as InboxItem[]) : null
}

export function NotificationInbox() {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const attention = useUIStore((s) => s.sessionAttention)
  const sessions = useUIStore((s) => s.sessions)
  const currentWorkspace = useUIStore((s) => s.currentWorkspace)
  const setCenterView = useUIStore((s) => s.setCenterView)
  const waiting = listAttentionSessions(attention || {}, 'needs-you')
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const filteredItems = filter === 'unread' ? items.filter((i) => i.unread) : items
  const unread = items.filter((i) => i.unread).length + waiting.length
  const close = useCallback(() => { setOpen(false); setActionError(null) }, [])

  const load = useCallback(async () => {
    try {
      const res = await ipcClient.invoke('notifications.inbox', {})
      const next = readInboxItems(res)
      if (!next) {
        // 桥没注入 / 通道没注册 / 老宿主：报「读取失败」，别把 undefined 写进 state
        setLoadFailed(true)
        return
      }
      // Same inbox → keep the array identity so the bar and popover do not re-render every poll.
      setItems((previous) => (sameInboxItems(previous, next) ? previous : next))
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useVisibleInterval(() => void load(), 4000)
  // A finished turn is what creates inbox rows — show it now instead of on the next poll.
  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.type === 'completion') void load()
      }),
    [load],
  )

  // Opening a conversation (or returning to the window on it) reads its rows in Main; pick that
  // up right away. The short delay lets session.setVisible land first.
  const historySessionFile = useUIStore((s) => s.historySessionFile)
  const seenSessionFile = useRef(historySessionFile)
  useEffect(() => {
    let timer = 0
    const refresh = () => {
      window.clearTimeout(timer)
      if (document.visibilityState === 'hidden') return
      timer = window.setTimeout(() => void load(), 300)
    }
    // Mount is covered by the poll's first load; only a real switch needs the extra refresh.
    if (seenSessionFile.current !== historySessionFile) {
      seenSessionFile.current = historySessionFile
      refresh()
    }
    window.addEventListener('focus', refresh)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [historySessionFile, load])

  useEffect(() => {
    if (!loading && !loadFailed) void ipcClient.invoke('desktop.setBadge', { count: unread }).catch(() => {})
  }, [unread, loading, loadFailed])

  const openSession = async (workspaceId?: string, sessionId?: string, sessionFile?: string, notificationId?: string) => {
    if (!sessionFile) return
    setActionError(null)
    setPending(notificationId || sessionFile)
    try {
      const match = sessions.find((s) => sessionFilesEqual(s.sessionFile, sessionFile))
      const workspace = match?.workspaceId || workspaceId || (match ? currentWorkspace : undefined)
      if (match && workspace === currentWorkspace) await switchSessionInPlace(match.sessionId, sessionFile)
      else if (workspace) await activateWorkspace(workspace, { sessionId: sessionId || match?.sessionId, sessionFile })
      else { setActionError(t('common:notification.sessionGone')); return }
      if (notificationId) await ipcClient.invoke('notifications.markRead', { id: notificationId })
      await load()
      close()
    } catch {
      setActionError(t('common:notification.openFailed'))
    } finally {
      setPending(null)
    }
  }

  /**
   * 插件条目：切中央视图而不是切会话。
   *
   * 信箱与插件视图是两套东西（前者是「发生过什么」，后者是「现在怎么样」），
   * 所以点开只负责把人送到插件页；定位到具体那条记录要靠插件自己的未读标记。
   */
  const openPluginView = async (item: InboxItem) => {
    const target = item.target
    if (!target) return
    setActionError(null)
    setPending(item.notificationId)
    try {
      setCenterView({ kind: 'plugin', pluginId: target.pluginId, viewId: target.viewId })
      await ipcClient.invoke('notifications.markRead', { id: item.notificationId })
      await load()
      close()
    } catch {
      setActionError(t('common:notification.openFailed'))
    } finally {
      setPending(null)
    }
  }

  const openItem = async (item: InboxItem) => {
    if (item.target) await openPluginView(item)
    else await openSession(item.workspaceId, item.sessionId, item.sessionFile, item.notificationId)
  }

  const toggleRead = async (item: InboxItem) => {
    setPending(item.notificationId)
    setActionError(null)
    try {
      if (item.unread) await ipcClient.invoke('notifications.markRead', { id: item.notificationId })
      else await ipcClient.invoke('notifications.markUnread', { id: item.notificationId, unread: true })
      await load()
    } catch {
      setActionError(t('common:operationFailed'))
    } finally {
      setPending(null)
    }
  }

  return (
    <>
      <button ref={anchorRef} type="button" className="chrome-icon-btn notification-trigger workbench-icon" title={t('common:notification.inbox')} aria-label={t('common:notification.inbox')} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen((v) => !v); void load() }}>
        <Inbox className="h-4 w-4" />
        {unread > 0 && <span className="notification-unread-dot" />}
      </button>
      {open && <ShellPopover title={t('common:notification.inbox')} anchorRef={anchorRef} onClose={close}>
        <div className="flex items-center gap-1 border-b border-border/40 px-3 py-2">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={cn(
              'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              filter === 'all' ? 'bg-[var(--bg-active)] text-foreground' : 'text-foreground-secondary hover:text-foreground',
            )}
          >
            {t('common:notification.all')}
          </button>
          <button
            type="button"
            onClick={() => setFilter('unread')}
            className={cn(
              'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              filter === 'unread' ? 'bg-[var(--bg-active)] text-foreground' : 'text-foreground-secondary hover:text-foreground',
            )}
          >
            {t('common:notification.unread')}
            {unread > 0 && <span className="ml-1 rounded-full bg-[var(--danger-semantic)] px-1 text-[9px] text-white">{unread}</span>}
          </button>
          <div className="flex-1" />
          <button type="button" className="workbench-icon" aria-label={t('common:refresh')} onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" /></button>
        </div>
        {actionError && <p role="alert" className="workbench-error">{actionError}</p>}
        {loadFailed && <div role="alert" className="workbench-error flex items-center justify-between gap-2"><span>{t('common:notification.loadFailed')}</span><button type="button" className="workbench-button" onClick={() => void load()}>{t('common:retry')}</button></div>}
        {waiting.length > 0 && <section className="workbench-group" aria-label={t('common:attention.needsYou')}>
          <h3 className="workbench-group-heading"><SessionAttentionDot attention="needs-you" />{t('common:attention.needsYou')}<span>{waiting.length}</span></h3>
          {waiting.map((file) => {
            const match = sessions.find((s) => sessionFilesEqual(s.sessionFile, file))
            return <button key={file} type="button" className="workbench-list-row" disabled={!match || pending !== null} onClick={() => void openSession(match?.workspaceId, match?.sessionId, file)}>
              <span className="workbench-row-title">{match?.title || file.split(/[\\/]/).pop()}</span>
              <span className="workbench-row-detail">{match ? t('common:notification.continueAnswer') : t('common:notification.sessionGone')}</span>
            </button>
          })}
        </section>}
        {loading ? <p role="status" className="workbench-empty">{t('common:loading')}</p> : filteredItems.length === 0 && waiting.length === 0 && !loadFailed ? (
          <div className="workbench-empty"><Inbox className="h-6 w-6 opacity-50" /><p>{t('common:notification.empty')}</p><span>{t('common:notification.emptyHint')}</span></div>
        ) : filteredItems.length > 0 && <section className="workbench-group" aria-label={t('common:notification.history')}>
          <h3 className="workbench-group-heading">{t('common:notification.history')}<span>{filteredItems.length}</span></h3>
          {filteredItems.map((item) => (
            <div key={item.notificationId} className="notification-row" data-unread={item.unread || undefined}>
              <button type="button" className="workbench-list-row min-w-0 flex-1" disabled={(!item.sessionFile && !item.target) || pending !== null} title={!item.sessionFile && !item.target ? t('common:notification.sessionGone') : undefined} onClick={() => void openItem(item)}>
                <span className={cn('workbench-row-title', item.unread && 'font-semibold')}>
                  <span className={cn('mr-1.5 inline-block w-3 text-center', itemColor(item))}>{itemIcon(item)}</span>
                  {item.copy?.title || t('common:attention.done')}
                </span>
                {item.copy?.body && <span className="notification-preview">{item.copy.body}</span>}
                {item.outcome === 'failed' && <span className="notification-error-code">{t('common:notification.failed')}</span>}
                {item.createdAt && <time className="workbench-row-detail" dateTime={new Date(item.createdAt).toISOString()}>{new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(item.createdAt)}</time>}
              </button>
              <button type="button" className="workbench-icon mr-2 shrink-0" disabled={pending !== null} title={item.unread ? t('common:notification.markRead') : t('common:notification.markUnread')} aria-label={item.unread ? t('common:notification.markRead') : t('common:notification.markUnread')} onClick={() => void toggleRead(item)}>{item.unread ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}</button>
            </div>
          ))}
        </section>}
      </ShellPopover>}
    </>
  )
}
