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

export function publishPluginComposerBar(
  pluginId: string,
  sessionFile: string,
  bar: PluginComposerBarState | null,
): void {
  const file = String(sessionFile || '').trim()
  if (!file) return
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
    bar: bar ? normalizePluginComposerBar(bar) : null,
  }
  for (const win of BrowserWindow.getAllWindows()) sendEvent(win, event)
}
