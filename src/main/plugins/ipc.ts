import { BrowserWindow } from 'electron'
import { registerHandler, sendEvent } from '../ipc/registry'
import { discoverPlugins } from './plugin-manager'
import { activateEnabledPlugins, applyPluginEnabled, invokePlugin } from './plugin-host'
import type { AdapterSidePanelMeta } from '@shared/right-panels'
import { pluginAdapterId, pluginPanelGlobalId } from '@shared/plugin-manifest'

/**
 * 插件 IPC：目录 / 启停 / 插件面板 invoke。
 * 目录数据由 adapter-panels.ts 的 ipc:rightPanels.catalog 合并（复用右栏布局体系）。
 */

export type PluginPanelMeta = AdapterSidePanelMeta & { pluginId: string; entry: string }

/** 插件面板 → AdapterSidePanelMeta（复用右栏目录合并管道，adapterId 前缀 plugin:） */
export function pluginAdapterPanels(plugins: ReturnType<typeof discoverPlugins>): AdapterSidePanelMeta[] {
  const items: AdapterSidePanelMeta[] = []
  for (const plugin of plugins) {
    if (!plugin.manifest || !plugin.enabled) continue
    for (const panel of plugin.manifest.panels) {
      items.push({
        adapterId: pluginAdapterId(plugin.manifest.id),
        panelId: pluginPanelGlobalId(plugin.manifest.id, panel.id),
        label: panel.title,
        description: panel.description ?? plugin.manifest.description ?? '',
        icon: panel.icon ?? plugin.manifest.icon,
        panelComponent: 'plugin-iframe',
        defaultEnabled: panel.defaultEnabled,
      })
    }
  }
  return items
}

export function registerPluginHandlers(): void {
  registerHandler('ipc:plugins.catalog', async () => {
    const plugins = discoverPlugins()
    return {
      plugins: plugins.map((p) => ({
        id: p.manifest?.id ?? '',
        name: p.manifest?.name ?? p.dir,
        version: p.manifest?.version ?? '',
        description: p.manifest?.description ?? '',
        icon: p.manifest?.icon ?? '',
        enabled: p.enabled,
        error: p.error,
      })),
    }
  })

  registerHandler('ipc:plugins.setEnabled', async (req) => {
    const pluginId = String(req.pluginId || '')
    const enabled = req.enabled !== false
    if (!pluginId) return { ok: false, error: 'plugin_id_required' }
    const r = await applyPluginEnabled(pluginId, enabled)
    if (r.ok) {
      // 目录随启停变化，让 renderer 刷新右栏
      for (const win of BrowserWindow.getAllWindows()) sendEvent(win, { type: 'adapter-catalog-changed', revision: String(Date.now()) })
    }
    return r
  })

  registerHandler('ipc:plugin.invoke', async (req) => {
    const pluginId = String(req.pluginId || '')
    const method = String(req.method || '')
    if (!pluginId || !method) return { ok: false, error: 'plugin_id_and_method_required' }
    const params = (req.params ?? {}) as Record<string, unknown>
    return invokePlugin(pluginId, method, params)
  })
}

export { activateEnabledPlugins }
