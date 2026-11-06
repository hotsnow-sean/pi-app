/**
 * 插件托盘（composer bar）：插件往输入框上方那条窄带里放的东西。
 *
 * 分工：插件负责「说什么」（摘要、行、语气），宿主负责「长什么样」。
 * 这样桌面端只有一套托盘视觉，不会每个插件各画一版；插件也不需要通过 iframe
 * 去复刻 1px 边框、圆角和字体。
 *
 * 与 adapter 的 todo widget 是同一落点（.composer-accessory-row），但数据源不同：
 * todo 来自 pi 扩展在 worker 里的 ctx.ui.setWidget 投影，这里来自插件 main 主动推送。
 *
 * **词表只表达观感，不表达业务**：宿主认 `active/ok/error/idle/warn` 这类「看起来
 * 是什么样」的词，不认 `running/exited/lost` 这种某个插件的状态机。行上的动作由插件
 * 自定义 id，宿主只负责把它原样回传并选一个图标。这样第二个想用托盘的插件不必读
 * 后台任务的代码来「对齐词表」，也不会因为说了自己的状态名而被显示成默认样式。
 */

/** 行状态的观感词表（宿主据此选图标与配色） */
export type PluginComposerBarRowState = 'active' | 'ok' | 'error' | 'idle' | 'warn'

/** 摘要行的语气（同上，只影响视觉） */
export type PluginComposerBarTone = 'active' | 'ok' | 'error'

/** 宿主支持的图标名；目前只有「停止」这一种，够用且不需要插件画 SVG */
export type PluginComposerBarActionIcon = 'stop'

export interface PluginComposerBarRowAction {
  /**
   * 插件自己的动作 id，点击后原样回传：
   * `plugin.invoke('composerBarAction', { action: <这个 id>, id: <行 id> })`。
   * 宿主不解释它的含义。
   */
  id: string
  /** 图标名（宿主枚举）。省略时按 'stop' 画 */
  icon?: PluginComposerBarActionIcon
  /** 悬浮提示。插件自带文案——宿主不认识业务，写不出除「停止」以外的措辞 */
  title?: string
}

export interface PluginComposerBarRow {
  /** 插件自己认得的 id，点行 / 点动作时原样回传 */
  id: string
  label: string
  state: PluginComposerBarRowState
  /** 行尾固定文案（终态用：耗时、退出码）。运行中的耗时由宿主按 startedAt 现算 */
  meta?: string
  /** 进行中的开始时间：给了就显示实时耗时，避免一个「12s」僵在那里骗人 */
  startedAt?: number
  /** 行尾可点的动作；空 / 省略 = 没有 */
  actions?: PluginComposerBarRowAction[]
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
export const PLUGIN_COMPOSER_BAR_MAX_ACTIONS = 3

const TONES: readonly PluginComposerBarTone[] = ['active', 'ok', 'error']
const ROW_STATES: readonly PluginComposerBarRowState[] = ['active', 'ok', 'error', 'idle', 'warn']
const ACTION_ICONS: readonly PluginComposerBarActionIcon[] = ['stop']

function text(value: unknown, max = PLUGIN_COMPOSER_BAR_MAX_TEXT): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function actionsOf(raw: unknown): PluginComposerBarRowAction[] {
  if (!Array.isArray(raw)) return []
  const actions: PluginComposerBarRowAction[] = []
  for (const item of raw.slice(0, PLUGIN_COMPOSER_BAR_MAX_ACTIONS)) {
    if (!item || typeof item !== 'object') continue
    const action = item as Partial<PluginComposerBarRowAction>
    const id = text(action.id, 40)
    // 没有 id 就回传不了，画出来只会是个死按钮
    if (!id) continue
    const icon = ACTION_ICONS.includes(action.icon as PluginComposerBarActionIcon)
      ? (action.icon as PluginComposerBarActionIcon)
      : undefined
    actions.push({
      id,
      ...(icon ? { icon } : {}),
      ...(action.title ? { title: text(action.title, 60) } : {}),
    })
  }
  return actions
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
    // 认不出的观感词按「进行中」画：比画成错误更不容易误导，也更接近未知的真实含义
    const state = ROW_STATES.includes(row.state as PluginComposerBarRowState)
      ? (row.state as PluginComposerBarRowState)
      : 'active'
    const startedAt = Number(row.startedAt)
    const actions = actionsOf(row.actions)
    rows.push({
      id,
      label,
      state,
      ...(row.meta ? { meta: text(row.meta, 60) } : {}),
      ...(Number.isFinite(startedAt) && startedAt > 0 ? { startedAt } : {}),
      ...(actions.length ? { actions } : {}),
    })
  }
  if (!summary && rows.length === 0) return null
  const tone = TONES.includes(input.tone as PluginComposerBarTone) ? (input.tone as PluginComposerBarTone) : 'active'
  return {
    summary: summary || `${rows.length}`,
    ...(input.detail ? { detail: text(input.detail, 120) } : {}),
    tone,
    rows,
    ...(input.panelId ? { panelId: text(input.panelId, 120) } : {}),
  }
}
