import type { PluginComposerBarState } from '@shared/plugin-composer-bar'
import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'

/**
 * 插件托盘的对账（pull 侧）。
 *
 * 托盘平时靠 main 推送（plugin_widget）更新，但推送有两个会丢的时刻：
 * ①应用启动时插件先激活、renderer 的 `ipc:events` 监听还没挂上；
 * ②反过来，renderer 先就绪、插件还没 activate（此时 main 状态表还是空的）。
 * 两条路都指望不上时，托盘就永远不出现——所以启动时、以及每次切会话时，
 * 都从 main 的状态表拉一次并重放成原事件，让路由/按会话落库/可见投影
 * 全部复用现有管道。幂等，多拉无害。
 */

type BarEntry = { pluginId: string; sessionFile: string; bar: PluginComposerBarState }

let replaySeq = 0

/** @returns 本次拉到的托盘条数（0 不一定是错：可能确实没有任务） */
export async function syncPluginComposerBars(): Promise<number> {
  const res = await ipcClient.invoke('plugins.composerBars.list')
  const bars = (res?.bars ?? []) as BarEntry[]
  for (const { pluginId, sessionFile, bar } of bars) {
    if (!pluginId || !sessionFile || !bar) continue
    useUIStore.getState().processEvent({
      type: 'plugin_widget',
      seq: ++replaySeq,
      workspaceId: '',
      sessionFile,
      timestamp: Date.now(),
      pluginId,
      bar,
    })
  }
  return bars.length
}
