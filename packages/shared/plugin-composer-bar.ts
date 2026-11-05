/**
 * 插件托盘（composer bar）：插件往输入框上方那条窄带里放的东西。
 *
 * 分工：插件负责「说什么」（摘要、行、语气），宿主负责「长什么样」。
 * 这样桌面端只有一套托盘视觉，不会每个插件各画一版；插件也不需要通过 iframe
 * 去复刻 1px 边框、圆角和字体。
 *
 * 与 adapter 的 todo widget 是同一落点（.composer-accessory-row），但数据源不同：
 * todo 来自 pi 扩展在 worker 里的 ctx.ui.setWidget 投影，这里来自插件 main 主动推送。
 */

export type PluginComposerBarTone = 'running' | 'done' | 'error'

export type PluginComposerBarRowStatus = 'running' | 'exited' | 'failed' | 'stopped' | 'lost'

export interface PluginComposerBarRow {
  /** 插件自己认得的 id，点行 / 点停止时原样回传 */
  id: string
  label: string
  status: PluginComposerBarRowStatus
  /** 行尾固定文案（终态用：耗时、退出码）。运行中的耗时由宿主按 startedAt 现算 */
  meta?: string
  /** 运行中任务的开始时间：给了就显示实时耗时，避免一个「12s」僵在那里骗人 */
  startedAt?: number
  /** 行尾可点的动作；目前只有停止 */
  action?: 'stop'
}

export interface PluginComposerBarState {
  /** 摘要行主文案，插件自己组织语言 */
  summary: string
  /** 摘要行次要文案（通常是当前任务名） */
  detail?: string
  tone: PluginComposerBarTone
  /** 展开后的行；宿主最多渲染 MAX_ROWS 条，多的截断 */
  rows: PluginComposerBarRow[]
  /** 点行时宿主打开这个右栏面板（完整 `plugin:<id>:<panel>`），再回调插件 composerBarAction */
  panelId?: string
}

export const PLUGIN_COMPOSER_BAR_MAX_ROWS = 8
export const PLUGIN_COMPOSER_BAR_MAX_TEXT = 200

const TONES: readonly PluginComposerBarTone[] = ['running', 'done', 'error']
const ROW_STATUS: readonly PluginComposerBarRowStatus[] = ['running', 'exited', 'failed', 'stopped', 'lost']

function text(value: unknown, max = PLUGIN_COMPOSER_BAR_MAX_TEXT): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * 宿主侧的兜底校验：插件是第三方代码，推上来的东西不能直接进 React。
 * 不合法就丢掉那一段，绝不让一个坏字段把托盘染成 undefined。
 */
export function normalizePluginComposerBar(raw: unknown): PluginComposerBarState | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Partial<PluginComposerBarState>
  const summary = text(input.summary)
  const rowsInput = Array.isArray(input.rows) ? input.rows : []
  const rows: PluginComposerBarRow[] = []
  for (const item of rowsInput.slice(0, PLUGIN_COMPOSER_BAR_MAX_ROWS)) {
    if (!item || typeof item !== 'object') continue
    const row = item as Partial<PluginComposerBarRow>
    const id = text(row.id, 80)
    const label = text(row.label)
    if (!id || !label) continue
    const status = ROW_STATUS.includes(row.status as PluginComposerBarRowStatus)
      ? (row.status as PluginComposerBarRowStatus)
      : 'running'
    const startedAt = Number(row.startedAt)
    rows.push({
      id,
      label,
      status,
      ...(row.meta ? { meta: text(row.meta, 60) } : {}),
      ...(Number.isFinite(startedAt) && startedAt > 0 ? { startedAt } : {}),
      ...(row.action === 'stop' ? { action: 'stop' as const } : {}),
    })
  }
  if (!summary && rows.length === 0) return null
  const tone = TONES.includes(input.tone as PluginComposerBarTone) ? (input.tone as PluginComposerBarTone) : 'running'
  return {
    summary: summary || `${rows.length}`,
    ...(input.detail ? { detail: text(input.detail, 120) } : {}),
    tone,
    rows,
    ...(input.panelId ? { panelId: text(input.panelId, 120) } : {}),
  }
}
