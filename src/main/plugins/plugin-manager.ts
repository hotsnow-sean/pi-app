import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { configStore } from '../config-store'
import {
  parsePluginManifest,
  type PluginManifest,
} from '@shared/plugin-manifest'

/**
 * 应用级插件扫描与启停状态。
 *
 * 插件目录（每个子目录一个插件，含 plugin.json）：
 * - dev：`<repo>/plugins/`
 * - 打包：`<resources>/plugins/`（electron-builder extraResources）
 *
 * 启用状态持久化在 configStore.pluginEnabled（缺省 = 启用）。
 */

export type DiscoveredPlugin = {
  manifest: PluginManifest
  /** 插件根目录（绝对路径） */
  dir: string
  enabled: boolean
  /** 非法清单等诊断信息（enabled=false 且不可激活） */
  error?: string
}

function pluginRoots(): string[] {
  const roots: string[] = []
  if (app.isPackaged) {
    // app.getAppPath() = .../app.asar；内置插件随 extraResources 放到 resources/plugins
    roots.push(path.join(path.dirname(app.getAppPath()), 'plugins'))
  } else {
    roots.push(path.join(app.getAppPath(), 'plugins'))
  }
  // 用户目录：<userData>/plugins/（后续安装第三方插件的落点）
  roots.push(path.join(app.getPath('userData'), 'plugins'))
  return roots
}

function readManifest(dir: string): DiscoveredPlugin {
  const manifestPath = path.join(dir, 'plugin.json')
  try {
    if (!fs.existsSync(manifestPath)) {
      return { manifest: null as unknown as PluginManifest, dir, enabled: false, error: 'plugin.json not found' }
    }
    const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const parsed = parsePluginManifest(raw)
    if (!parsed.ok) {
      return { manifest: null as unknown as PluginManifest, dir, enabled: false, error: parsed.error }
    }
    const enabled = configStore.get('pluginEnabled')[parsed.manifest.id] !== false
    return { manifest: parsed.manifest, dir, enabled }
  } catch (error) {
    return {
      manifest: null as unknown as PluginManifest,
      dir,
      enabled: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function discoverPlugins(): DiscoveredPlugin[] {
  const out: DiscoveredPlugin[] = []
  const seen = new Set<string>()
  for (const root of pluginRoots()) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      const plugin = readManifest(dir)
      // 同 id 先到先得（内置优先于 userData）
      if (plugin.manifest && seen.has(plugin.manifest.id)) continue
      if (plugin.manifest) seen.add(plugin.manifest.id)
      out.push(plugin)
    }
  }
  return out
}

export function findPlugin(pluginId: string): DiscoveredPlugin | null {
  return discoverPlugins().find((p) => p.manifest?.id === pluginId) ?? null
}

export function setPluginEnabled(pluginId: string, enabled: boolean): void {
  const next = { ...configStore.get('pluginEnabled'), [pluginId]: enabled }
  configStore.set('pluginEnabled', next)
}
