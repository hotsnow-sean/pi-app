import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox, RefreshCw, Check, Circle } from '@renderer/components/icons'
import { ipcClient, onAppEvent } from '@renderer/lib/ipc-client'
import { useVisibleInterval } from '@renderer/hooks/use-visible-interval'
import { useUIStore } from '@renderer/stores/ui-store'
import { listAttentionSessions } from '@renderer/lib/session-attention'
import { activateWorkspace, switchSessionInPlace } from '@renderer/lib/activate-workspace'
import { sessionFilesEqual } from '@renderer/lib/session-file-key'
import { resolveInboxTargetAction, planInboxJump, isDerivedChildSessionFile } from '@renderer/lib/plugin-inbox-target'
import { pluginPanelGlobalId } from '@shared/plugin-manifest'
import { workspacePathsEqual } from '@shared/workspace-path'
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
  /**
   * 插件投递的条目：点开先回到 `sessionFile`（切会话或只读预览），
   * 再按 `target` 亮出右栏面板 / 中央视图。宿主完成卡没有这两个字段。
   */
  target?: { pluginId: string; viewId?: string; panelId?: string }
  /** 来源插件 id；有它就是插件条目（空字符串也算插件条目） */
  pluginId?: string
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

/**
 * 只读预览一段会话（按需加载）。
 *
 * 只有「目标会话不在侧栏列表里」时才走这条（子代理的子会话），所以按需引入——
 * 静态引入会把整条会话导航链塞进首屏 chunk（`app.tsx` 处理 reveal 事件时也是动态导入）。
 */
async function previewSession(sessionFile: string): Promise<boolean> {
  const { revealSessionPreview } = await import('@renderer/lib/reveal-session')
  return revealSessionPreview(sessionFile)
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
   * 插件条目：先回到产生这条记录的会话，再看要不要亮插件面板。
   *
   * 为什么会话优先：右栏面板是**会话的附属物**（内容跟着当前会话变）。只亮面板不切
   * 会话，用户看到的是「别的会话的面板」，比不跳更迷惑。所以插件的正确用法是给条目
   * 带 `sessionFile`，宿主切过去，右栏自然跟到那段对话。
   *
   * 会话找不到侧栏条目时退化成**只读预览**而不是报错：子代理的子会话（`run-<i>/session.jsonl`）
   * 本来就不在侧栏列表里，但它确实是能读的一段会话。
   */
  const jumpToSessionFile = async (sessionFile: string): Promise<'switched' | 'previewed' | 'missing'> => {
    const match = sessions.find((s) => sessionFilesEqual(s.sessionFile, sessionFile))
    if (match) {
      // 会话行上的 workspaceId 可能缺（未加载的工作区）：用当前工作区兜底，
      // 都没有就退回只读预览，别把用户扔进一个空工作区。
      const workspace = match.workspaceId || currentWorkspace
      if (!workspace) return (await previewSession(sessionFile)) ? 'previewed' : 'missing'
      // 路径比较必须走归一化：`C:\x` 与 `c:/x` 在这里是同一个工作区，
      // 用 `!==` 会误判成「跨项目」，白跑一次 workspace.open（还会闪一下）。
      if (workspacePathsEqual(workspace, currentWorkspace)) await switchSessionInPlace(match.sessionId, sessionFile)
      else await activateWorkspace(workspace, { sessionId: match.sessionId, sessionFile })
      return 'switched'
    }
    // 不在当前项目的会话列表里。两种可能，处理方式相反：
    // - 子代理的子会话（run-<i>/session.jsonl）：本来就不属于侧栏，只读预览。
    // - 别的项目里的普通会话：应当切项目 + 正常打开（有输入框、侧栏跟着高亮）。
    //   早先这里一律降级成预览，于是「中间回到了 A，左侧高亮没动、也没输入框」。
    if (isDerivedChildSessionFile(sessionFile)) {
      return (await previewSession(sessionFile)) ? 'previewed' : 'missing'
    }
    const prepared = (await ipcClient
      .invoke('session.prepare', { sessionFile, bind: false })
      .catch(() => null)) as
      | { sessionId?: string | null; sessionFile?: string; workspaceId?: string | null }
      | null
    if (prepared?.sessionId && prepared.workspaceId) {
      await activateWorkspace(prepared.workspaceId, {
        sessionId: prepared.sessionId,
        sessionFile: prepared.sessionFile || sessionFile,
      })
      return 'switched'
    }
    return (await previewSession(sessionFile)) ? 'previewed' : 'missing'
  }

  const openPluginItem = async (item: InboxItem) => {
    const target = item.target
    setActionError(null)
    setPending(item.notificationId)
    try {
      const store = useUIStore.getState()
      // 面板 id 是插件 manifest 里的**局部** id，目录里存的是 `plugin:<插件>:<面板>`。
      // 解析结果必须是完整 id：直接拿局部 id 去 setActivePanel，右栏会亮但停在别的
      // 页签（prefs 里查不到 → 回落首个可用面板），用户看到的是「没切过去」。
      const action = resolveInboxTargetAction(target, (panelId) => {
        if (!target) return null
        const globalId = pluginPanelGlobalId(target.pluginId, panelId)
        return store.rightPanelCatalog.some((c) => c.id === globalId) ? globalId : null
      })
      const plan = planInboxJump(!!item.sessionFile, action)
      if (plan.empty) {
        // 面板拼错、没视图、又没有可回的会话：别静默关掉弹窗，让用户知道这条点不开。
        // 文案不能复用「无法打开该会话」——这里根本没涉及会话，会把人带偏。
        setActionError(t('common:notification.pluginTargetMissing'))
        return
      }
      if (plan.jumpSession && item.sessionFile) {
        const hop = await jumpToSessionFile(item.sessionFile)
        if (hop === 'missing') {
          // 文件没了就是真没了：明确告诉用户，别静默关掉让人以为跳过去了
          setActionError(t('common:notification.sessionGone'))
          return
        }
      }
      if (plan.panelId) {
        store.setActivePanel(plan.panelId)
        store.revealRightPanel()
      }
      if (plan.center) {
        setCenterView({ kind: 'plugin', pluginId: plan.center.pluginId, viewId: plan.center.viewId })
      }
      await ipcClient.invoke('notifications.markRead', { id: item.notificationId })
      await load()
      close()
    } catch {
      setActionError(t('common:notification.pluginTargetMissing'))
    } finally {
      setPending(null)
    }
  }

  const openItem = async (item: InboxItem) => {
    // 插件条目统一走上面的分支：它的 sessionFile 可能指向一段不在侧栏里的子会话，
    // 不能交给宿主的完成卡跳转逻辑。`target` 也算判据——老宿主的条目没有 pluginId。
    if (item.target || item.pluginId != null) await openPluginItem(item)
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
