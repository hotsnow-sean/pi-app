import { BrowserWindow, dialog, shell } from 'electron'
import { registerHandler, sendEvent } from '../ipc/registry'
import { discoverPlugins, installPluginFromDir, removeUserPlugin } from './plugin-manager'
import { activateEnabledPlugins, activatePlugin, applyPluginEnabled, deactivatePlugin, invokePlugin } from './plugin-host'
import {
  getPluginSettings,
  purgePluginData,
  resetPluginSettings,
  setPluginSettings,
} from './plugin-settings'
import type { AdapterSidePanelMeta } from '@shared/right-panels'
import { pluginAdapterId, pluginPanelGlobalId } from '@shared/plugin-manifest'

/**
 * 插件 IPC：目录 / 启停 / 安装 / 卸载 / 设置 / 面板 invoke。
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

/** 启停/安装/卸载后刷新 renderer 的插件目录与右栏 */
function broadcastCatalogChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendEvent(win, { type: 'adapter-catalog-changed', revision: String(Date.now()) })
  }
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
        source: p.source,
        dir: p.dir,
        // 中央视图贡献点：侧栏入口与中央面板都由 renderer 按此渲染
        views: (p.manifest?.views ?? []).map((v) => ({
          id: v.id,
          title: v.title,
          description: v.description ?? '',
          icon: v.icon ?? p.manifest?.icon ?? '',
          entry: v.entry,
        })),
        panels: (p.manifest?.panels ?? []).map((panel) => ({ id: panel.id, title: panel.title })),
        /** 声明式设置项（只有 schema，值另取，避免目录被人人拉一遍全量设置） */
        settings: p.manifest?.settings ?? [],
      })),
    }
  })

  registerHandler('ipc:plugins.setEnabled', async (req) => {
    const pluginId = String(req.pluginId || '')
    const enabled = req.enabled !== false
    if (!pluginId) return { ok: false, error: 'plugin_id_required' }
    const r = await applyPluginEnabled(pluginId, enabled)
    if (r.ok) broadcastCatalogChanged()
    return r
  })

  /**
   * 安装：不带 sourceDir 时弹目录选择框。
   * 已安装同 id 时返回 needConfirm + 冲突列表，UI 确认后带 force=true 重试（覆盖升级）。
   */
  registerHandler('ipc:plugins.install', async (req) => {
    let sourceDir = typeof req?.sourceDir === 'string' ? req.sourceDir.trim() : ''
    if (!sourceDir) {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const picked = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择插件目录' })
        : await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择插件目录' })
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'cancelled' }
      sourceDir = picked.filePaths[0]
    }
    const result = installPluginFromDir(sourceDir, { force: req?.force === true })
    // sourceDir 一并回传：覆盖安装需要用户确认，确认后 renderer 带着同一个来源重试，别二次弹框
    if (!result.ok) return { ...result, sourceDir }
    for (const id of result.installed) {
      // 新装的插件默认启用（覆盖升级保留原有启停状态）
      if (discoverPlugins().find((p) => p.manifest?.id === id)?.enabled === false) {
        await applyPluginEnabled(id, true)
      } else {
        await activatePlugin(id)
      }
    }
    broadcastCatalogChanged()
    return { ...result, sourceDir }
  })

  registerHandler('ipc:plugins.uninstall', async (req) => {
    const pluginId = String(req?.pluginId || '')
    if (!pluginId) return { ok: false, error: 'plugin_id_required' }
    deactivatePlugin(pluginId)
    const removed = removeUserPlugin(pluginId)
    if (!removed.ok) {
      // 删除失败时把插件重新拉起来，别让用户点一下卸载反而把插件弄停
      await activatePlugin(pluginId)
      return removed
    }
    if (req?.purgeData === true) purgePluginData(pluginId)
    broadcastCatalogChanged()
    return { ok: true, dir: removed.dir }
  })

  registerHandler('ipc:plugins.reveal', async (req) => {
    const pluginId = String(req?.pluginId || '')
    const found = discoverPlugins().find((p) => p.manifest?.id === pluginId)
    if (!found) return { ok: false, error: `plugin not found: ${pluginId}` }
    const error = await shell.openPath(found.dir)
    return error ? { ok: false, error } : { ok: true }
  })

  registerHandler('ipc:plugins.settings.get', async (req) => {
    const pluginId = String(req?.pluginId || '')
    if (!pluginId) return { ok: false, error: 'plugin_id_required' }
    return { ok: true, values: getPluginSettings(pluginId) }
  })

  registerHandler('ipc:plugins.settings.set', async (req) => {
    const pluginId = String(req?.pluginId || '')
    if (!pluginId) return { ok: false, error: 'plugin_id_required' }
    const patch = (req?.values ?? {}) as Record<string, unknown>
    return setPluginSettings(pluginId, patch)
  })

  registerHandler('ipc:plugins.settings.reset', async (req) => {
    const pluginId = String(req?.pluginId || '')
    if (!pluginId) return { ok: false, error: 'plugin_id_required' }
    return resetPluginSettings(pluginId)
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
