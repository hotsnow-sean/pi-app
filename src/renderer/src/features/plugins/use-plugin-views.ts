import { useEffect, useState } from 'react'
import { ipcClient, onAppEvent } from '@renderer/lib/ipc-client'

/**
 * 插件中央视图目录（manifest.views 的渲染侧投影）。
 *
 * 侧栏「应用」入口与中央面板共用同一份数据：进程内缓存 + 单飞请求，多处挂载只拉一次。
 * 插件启停/目录变化时由 `adapter-catalog-changed` 事件触发刷新（与右栏目录同一信号）。
 */
export type PluginViewEntry = {
  pluginId: string
  pluginName: string
  id: string
  title: string
  description: string
  icon: string
  entry: string
}

type CatalogPlugin = {
  id?: string
  name?: string
  enabled?: boolean
  views?: Array<{ id?: string; title?: string; description?: string; icon?: string; entry?: string }>
}

let cache: PluginViewEntry[] = []
let inflight: Promise<void> | null = null
const listeners = new Set<(views: PluginViewEntry[]) => void>()

function publish(next: PluginViewEntry[]): void {
  cache = next
  for (const listener of listeners) listener(next)
}

async function fetchViews(force = false): Promise<void> {
  if (inflight && !force) return inflight
  inflight = (async () => {
    try {
      const res = (await ipcClient.invoke('plugins.catalog')) as { plugins?: CatalogPlugin[] }
      const next: PluginViewEntry[] = []
      for (const plugin of res?.plugins ?? []) {
        if (!plugin.id || plugin.enabled === false) continue
        for (const view of plugin.views ?? []) {
          if (!view.id || !view.title) continue
          next.push({
            pluginId: plugin.id,
            pluginName: plugin.name ?? plugin.id,
            id: view.id,
            title: view.title,
            description: view.description ?? '',
            icon: view.icon ?? '',
            entry: view.entry || 'ui/index.html',
          })
        }
      }
      publish(next)
    } catch {
      // 目录拉取失败不阻塞宿主：侧栏只是不显示应用区
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function usePluginViews(): PluginViewEntry[] {
  const [views, setViews] = useState<PluginViewEntry[]>(cache)
  useEffect(() => {
    listeners.add(setViews)
    // 事件期间可能已有更新的缓存：订阅后立刻对齐一次
    setViews(cache)
    void fetchViews()
    const off = onAppEvent((event) => {
      if (event.type === 'adapter-catalog-changed') void fetchViews(true)
    })
    return () => {
      listeners.delete(setViews)
      off()
    }
  }, [])
  return views
}
