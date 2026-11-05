import { useEffect, useState } from 'react'
import { ipcClient, onAppEvent } from '@renderer/lib/ipc-client'

/**
 * 会话条目录（manifest.sessionBars 的渲染侧投影）。
 *
 * 和 usePluginViews 一样：进程内缓存 + 单飞请求，插件启停时由
 * `adapter-catalog-changed` 刷新。差别只在贡献点的形状——会话条跟着**当前会话**
 * 走，所以这里不关心图标/描述，只关心入口、默认高度和排序。
 */
export type PluginSessionBarEntry = {
  pluginId: string
  pluginName: string
  id: string
  title: string
  entry: string
  /** manifest 声明的默认高度（插件上报实际高度前的占位） */
  height: number
}

type CatalogPlugin = {
  id?: string
  name?: string
  enabled?: boolean
  sessionBars?: Array<{ id?: string; title?: string; entry?: string; height?: number }>
}

let cache: PluginSessionBarEntry[] = []
let inflight: Promise<void> | null = null
const listeners = new Set<(bars: PluginSessionBarEntry[]) => void>()

function publish(next: PluginSessionBarEntry[]): void {
  cache = next
  for (const listener of listeners) listener(next)
}

async function fetchBars(force = false): Promise<void> {
  if (inflight && !force) return inflight
  inflight = (async () => {
    try {
      const res = (await ipcClient.invoke('plugins.catalog')) as { plugins?: CatalogPlugin[] }
      const next: PluginSessionBarEntry[] = []
      for (const plugin of res?.plugins ?? []) {
        if (!plugin.id || plugin.enabled === false) continue
        for (const bar of plugin.sessionBars ?? []) {
          if (!bar.id || !bar.title) continue
          next.push({
            pluginId: plugin.id,
            pluginName: plugin.name ?? plugin.id,
            id: bar.id,
            title: bar.title,
            entry: bar.entry || 'ui/session-bar.html',
            height: typeof bar.height === 'number' ? bar.height : 44,
          })
        }
      }
      publish(next)
    } catch {
      // 目录失败不阻塞对话区：没有会话条，用户照样能聊天
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function usePluginSessionBars(): PluginSessionBarEntry[] {
  const [bars, setBars] = useState<PluginSessionBarEntry[]>(cache)
  useEffect(() => {
    listeners.add(setBars)
    setBars(cache)
    void fetchBars()
    const off = onAppEvent((event) => {
      if (event.type === 'adapter-catalog-changed') void fetchBars(true)
    })
    return () => {
      listeners.delete(setBars)
      off()
    }
  }, [])
  return bars
}
