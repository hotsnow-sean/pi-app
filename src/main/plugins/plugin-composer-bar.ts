import { BrowserWindow } from 'electron'
import { sendEvent } from '../ipc/registry'
import { normalizePluginComposerBar, type PluginComposerBarState } from '@shared/plugin-composer-bar'
import type { AppEvent } from '@shared/app-events'

/**
 * 插件托盘广播：把插件 main 侧的状态推给 renderer。
 *
 * 为什么不让 renderer 自己来拿：任务从「运行中」变「结束」是 main 侧才知道的时刻，
 * 轮询只能把延迟摊平（当前是 2 秒），推才能做到「结束即变」。而且推送天然带着
 * sessionFile，切会话时不会串台——这比让插件 UI 反查当前会话更可靠。
 *
 * seq 是全局单调的：同一条状态连续推两次，renderer 也能靠它判断「这是新的」。
 */
let seq = 0

/**
 * 当前所有托盘状态：pluginId → sessionFile → bar。
 *
 * 为什么 main 要留一份：插件激活可能早于 renderer 窗口挂上事件监听（启动时
 * activateEnabledPlugins 与 createWindow 并行），彼时的推送 `webContents.send`
 * 直接石沉大海——托盘是纯推送面，丢了就再没有自然恢复的机会（右栏面板是拉取式，
 * 所以表现为「面板正常、托盘消失」）。留这份状态表，renderer 启动时拉一次补齐。
 */
const currentBars = new Map<string, Map<string, PluginComposerBarState>>()

export function publishPluginComposerBar(
  pluginId: string,
  sessionFile: string,
  bar: PluginComposerBarState | null,
): void {
  const file = String(sessionFile || '').trim()
  if (!file) return
  const normalized = bar ? normalizePluginComposerBar(bar) : null
  let perPlugin = currentBars.get(pluginId)
  if (normalized) {
    if (!perPlugin) {
      perPlugin = new Map()
      currentBars.set(pluginId, perPlugin)
    }
    perPlugin.set(file, normalized)
  } else if (perPlugin) {
    perPlugin.delete(file)
    if (perPlugin.size === 0) currentBars.delete(pluginId)
  }
  seq += 1
  const event: AppEvent = {
    type: 'plugin_widget',
    seq,
    // workspaceId 留空：路由按 sessionFile 判定即可（见 apply-app-event-route），
    // 插件侧并不知道工作区标识，编一个假的反而会误判成 background。
    workspaceId: '',
    sessionFile: file,
    timestamp: Date.now(),
    pluginId,
    bar: normalized,
  }
  for (const win of BrowserWindow.getAllWindows()) sendEvent(win, event)
}

/** renderer 启动拉取：所有插件当前推着的托盘（含会话归属），一次拿全 */
export function listPluginComposerBars(): Array<{
  pluginId: string
  sessionFile: string
  bar: PluginComposerBarState
}> {
  const out: Array<{ pluginId: string; sessionFile: string; bar: PluginComposerBarState }> = []
  for (const [pluginId, perPlugin] of currentBars) {
    for (const [sessionFile, bar] of perPlugin) out.push({ pluginId, sessionFile, bar })
  }
  return out
}

/** 插件停用/卸载：收回它推的所有托盘（按会话广播 null，renderer 与状态表同步清掉） */
export function clearPluginComposerBars(pluginId: string): void {
  const perPlugin = currentBars.get(pluginId)
  if (!perPlugin) return
  currentBars.delete(pluginId)
  for (const sessionFile of perPlugin.keys()) publishPluginComposerBar(pluginId, sessionFile, null)
}
