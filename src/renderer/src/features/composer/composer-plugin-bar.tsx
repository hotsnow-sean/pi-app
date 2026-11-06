import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Square,
  XCircle,
  type AppIconComponent,
} from '@renderer/components/icons'
import { cn } from '@renderer/lib/utils'
import { ipcClient } from '@renderer/lib/ipc-client'
import { normalizeSessionFileKey } from '@renderer/lib/session-file-key'
import { useUIStore } from '@renderer/stores/ui-store'
import type {
  PluginComposerBarActionIcon,
  PluginComposerBarRow,
  PluginComposerBarRowState,
  PluginComposerBarState,
} from '@shared/plugin-composer-bar'

/**
 * 插件托盘：插件推到输入框上方的那条摘要。
 *
 * 位置与视觉刻意和 adpater 的 todo tray 完全一致（同一个 .composer-accessory-row、
 * 同一套 .adapter-widget-* 类）：用户看到的应该是「输入框上的一层」，而不是
 * 「对话里的另一块 UI」。差别只在数据来源——todo 来自 pi 扩展在 worker 里的投影，
 * 这里来自插件 main 的推送，所以状态一变就变，不用轮询。
 *
 * 这里只认「观感词」（active/ok/error/idle/warn）与图标名，不认任何插件的业务状态：
 * 插件改用自定义状态机也不会被画错。
 */

const STATE_ICON: Record<PluginComposerBarRowState, AppIconComponent> = {
  active: Circle,
  ok: CheckCircle2,
  error: XCircle,
  idle: Square,
  warn: XCircle,
}

/** 动作图标：目前只有「停止」这一种，插件不传就默认按它画 */
const ACTION_ICON: Record<PluginComposerBarActionIcon, AppIconComponent> = {
  stop: Square,
}

/** 行尾耗时：进行中的由这里现算，避免插件推一次的「12s」永远停在 12s */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const mins = Math.floor(total / 60)
  if (mins < 60) return `${mins}m${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`
}

function openPanel(panelId: string): void {
  const store = useUIStore.getState()
  if (!store.rightPanelCatalog.some((c) => c.id === panelId)) return
  store.setActivePanel(panelId)
  store.revealRightPanel()
}

/**
 * 插件约定的回调：点行传 'select'，点行内动作传**插件自己的动作 id**。
 * 宿主不解释业务语义，也不知道 'stop' 意味着什么。
 */
function notifyPlugin(pluginId: string, action: string, id: string): void {
  void ipcClient
    .invoke('plugin.invoke', { pluginId, method: 'composerBarAction', params: { action, id } })
    .catch(() => {
      /* 插件没实现这个方法就只是「打不开详情」，不该把托盘弄崩 */
    })
}

function RowIcon({ state }: { state: PluginComposerBarRowState }) {
  const Icon = STATE_ICON[state]
  const active = state === 'active'
  return (
    <Icon
      className={cn(
        'mt-[3px] h-3 w-3 shrink-0',
        active && 'adapter-widget-pulse text-primary',
        state === 'ok' && 'text-[var(--success-semantic)]',
        state === 'error' && 'text-[var(--danger-semantic)]',
        state === 'idle' && 'text-muted-foreground/70',
        state === 'warn' && 'text-amber-600 dark:text-amber-400',
      )}
      strokeWidth={active ? 2.2 : 1.8}
    />
  )
}

function BarRows({
  pluginId,
  bar,
  now,
}: {
  pluginId: string
  bar: PluginComposerBarState
  now: number
}) {
  const { t } = useTranslation()
  if (bar.rows.length === 0) return null
  return (
    <ul className="max-h-[200px] overflow-y-auto py-1" data-independent-scroll>
      {bar.rows.map((row: PluginComposerBarRow) => {
        const live = row.state === 'active' && row.startedAt ? fmtElapsed(now - row.startedAt) : ''
        const meta = live || row.meta || ''
        return (
          <li
            key={row.id}
            data-row-id={row.id}
            className="adapter-widget-item flex items-center gap-2 rounded-md px-1.5 py-[3px] text-[12px] leading-[18px] text-foreground-secondary hover:bg-[var(--bg-1)]"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-start gap-2 text-left"
              title={row.label}
              onClick={() => {
                if (bar.panelId) openPanel(bar.panelId)
                notifyPlugin(pluginId, 'select', row.id)
                // 刻意不收起：托盘是「当前在跑的东西」的常驻入口，
                // 点开详情只是换了个地方看，列表本身没有理由消失。
              }}
            >
              <RowIcon state={row.state} />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {meta ? <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{meta}</span> : null}
            </button>
            {(row.actions ?? []).map((action) => {
              const Icon = ACTION_ICON[action.icon ?? 'stop']
              // 插件没给文案时用宿主的中文兜底：图标名是通用视觉词，宿主有资格配一句默认说明
              const title = action.title || t('composer:pluginBar.stop')
              return (
                <button
                  key={action.id}
                  type="button"
                  data-action-id={action.id}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-[var(--danger-semantic)]"
                  title={title}
                  onClick={() => notifyPlugin(pluginId, action.id, row.id)}
                >
                  <Icon className="h-3 w-3" strokeWidth={2} />
                </button>
              )
            })}
          </li>
        )
      })}
    </ul>
  )
}

export function ComposerPluginBars() {
  const bars = useUIStore((s) => s.pluginComposerBars)
  const sessionFile = useUIStore((s) => s.historySessionFile)
  const expandedMap = useUIStore((s) => s.adapterWidgetExpandedBySession)
  const toggle = useUIStore((s) => s.toggleAdapterWidget)

  const entries = useMemo(() => Object.entries(bars ?? {}), [bars])
  const hasLive = entries.some(([, bar]) => bar.rows.some((r) => r.state === 'active' && r.startedAt))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!hasLive) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasLive])

  if (entries.length === 0) return null
  const sessionKey = normalizeSessionFileKey(sessionFile) || sessionFile || 'session'

  return (
    <>
      {entries.map(([pluginId, bar]) => {
        const expansionKey = `${sessionKey}\u0000plugin-bar\u0000${pluginId}`
        const expanded = !!expandedMap[expansionKey]
        const expandable = bar.rows.length > 0
        const toneClass =
          bar.tone === 'error'
            ? 'text-[var(--danger-semantic)]'
            : bar.tone === 'ok'
              ? 'text-muted-foreground'
              : 'text-foreground'
        return (
          <section
            key={pluginId}
            className="adapter-widget-shell min-w-0 basis-full"
            data-open={expanded ? 'true' : 'false'}
            data-plugin-bar={pluginId}
          >
            <div className="adapter-widget-expand" data-open={expanded ? 'true' : 'false'} aria-hidden={!expanded}>
              <div className="adapter-widget-expand-inner">
                {expanded ? <BarRows pluginId={pluginId} bar={bar} now={now} /> : null}
              </div>
            </div>
            <button
              type="button"
              className="adapter-widget-trigger group flex h-7 w-full min-w-0 items-center gap-1.5 text-left"
              aria-expanded={expandable ? expanded : undefined}
              aria-label={bar.detail ? `${bar.summary} · ${bar.detail}` : bar.summary}
              onClick={() => {
                if (!expandable) {
                  if (bar.panelId) openPanel(bar.panelId)
                  return
                }
                toggle(expansionKey)
              }}
            >
              {bar.tone === 'ok' ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-[var(--success-semantic)]" strokeWidth={2.2} />
              ) : (
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    bar.tone === 'error' ? 'bg-[var(--danger-semantic)]' : 'adapter-widget-pulse bg-primary',
                  )}
                  aria-hidden
                />
              )}
              <span className={cn('shrink-0 text-[12px] font-medium', toneClass)}>{bar.summary}</span>
              {bar.detail ? (
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground-secondary">
                  <span className="mx-1 text-muted-foreground/40">·</span>
                  {bar.detail}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {expandable ? (
                <ChevronDown
                  className="adapter-widget-chevron h-3 w-3 shrink-0 opacity-55"
                  data-open={expanded ? 'true' : 'false'}
                  strokeWidth={1.8}
                />
              ) : null}
            </button>
          </section>
        )
      })}
    </>
  )
}
