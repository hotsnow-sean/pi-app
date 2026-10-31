import { useSyncExternalStore } from 'react'
import { ipcClient, onAppEvent } from '@renderer/lib/ipc-client'

/**
 * 插件工具卡元数据的渲染侧缓存。
 *
 * 插件在 plugin.json 的 tools[].card 里声明工具卡模板与图标（kv / list / tree / media），
 * 宿主在时间线里按它渲染——与 adapter 的 toolCard 同一套模板，插件工具因此不会退化成
 * 一坨裸文本，也不必让宿主为每个插件写渲染代码。
 *
 * 数据源与侧栏「应用」入口同一个 IPC（plugins.catalog），模块加载即拉一次；
 * 插件启停后由 adapter-catalog-changed 事件刷新。未命中时调用方回落到默认模板。
 */

export type PluginToolCard = {
  template?: 'default' | 'kv' | 'list' | 'tree' | 'media'
  icon?: string
}

type CatalogPlugin = {
  enabled?: boolean
  tools?: Array<{ name?: string; card?: { template?: string; icon?: string } }>
}

const cards = new Map<string, PluginToolCard>()
const listeners = new Set<() => void>()
let version = 0
let inflight: Promise<void> | null = null
let subscribed = false

function publish(next: Map<string, PluginToolCard>): void {
  cards.clear()
  for (const [name, card] of next) cards.set(name, card)
  version++
  for (const listener of listeners) listener()
}

export function loadPluginToolCards(force = false): Promise<void> {
  if (inflight && !force) return inflight
  inflight = (async () => {
    try {
      const res = (await ipcClient.invoke('plugins.catalog')) as { plugins?: CatalogPlugin[] }
      const next = new Map<string, PluginToolCard>()
      for (const plugin of res?.plugins ?? []) {
        if (plugin.enabled === false) continue
        for (const tool of plugin.tools ?? []) {
          if (!tool.name) continue
          const template = tool.card?.template
          next.set(tool.name, {
            template: template as PluginToolCard['template'],
            icon: tool.card?.icon,
          })
        }
      }
      const changed =
        next.size !== cards.size || [...next].some(([k, v]) => cards.get(k)?.icon !== v.icon || cards.get(k)?.template !== v.template)
      if (changed || force) publish(next)
    } catch {
      // 目录拉取失败只是没有工具卡样式，不影响对话
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function pluginToolCard(toolName: string | undefined): PluginToolCard | undefined {
  return toolName ? cards.get(toolName) : undefined
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!subscribed) {
    subscribed = true
    onAppEvent((event) => {
      if (event.type === 'adapter-catalog-changed') void loadPluginToolCards(true)
    })
    // 模块加载即预热：时间线首屏通常晚于这一次 IPC
    void loadPluginToolCards()
  }
  return () => listeners.delete(listener)
}

/** 目录版本变化时让工具行重渲染（工具卡/图标随之更新） */
export function usePluginToolCardVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

// 预热：时间线第一屏通常晚于这次 IPC 返回，工具卡因此不会闪一下默认样式
void loadPluginToolCards()
