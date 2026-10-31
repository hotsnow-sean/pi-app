import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { configStore } from '../config-store'
import {
  parsePluginManifest,
  type PluginManifest,
} from '@shared/plugin-manifest'
import { errorMessage } from '@shared/error-message'

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
  /** builtin = 随应用分发（含 PI_PLUGINS_DIR 覆盖，e2e 用）；user = 用户安装到 userData */
  source: PluginSource
  enabled: boolean
  /** 非法清单等诊断信息（enabled=false 且不可激活） */
  error?: string
}

export type PluginSource = 'builtin' | 'user'

type PluginRoot = { dir: string; source: PluginSource }

/** 用户安装目录：安装/卸载只允许发生在这一层之内 */
export function userPluginsRoot(): string {
  return path.join(app.getPath('userData'), 'plugins')
}

function pluginRoots(): PluginRoot[] {
  const roots: PluginRoot[] = []
  // 显式覆盖（e2e / 自定义安装位置）；优先级最高，视为内置（不可卸载）
  const override = process.env.PI_PLUGINS_DIR?.trim()
  if (override) roots.push({ dir: override, source: 'builtin' })
  if (app.isPackaged) {
    // app.getAppPath() = .../app.asar；内置插件随 extraResources 放到 resources/plugins
    roots.push({ dir: path.join(path.dirname(app.getAppPath()), 'plugins'), source: 'builtin' })
  } else {
    roots.push({ dir: path.join(app.getAppPath(), 'plugins'), source: 'builtin' })
  }
  // 用户目录：<userData>/plugins/（安装第三方插件的落点）
  roots.push({ dir: userPluginsRoot(), source: 'user' })
  return roots
}

function readManifest(dir: string): Omit<DiscoveredPlugin, 'source'> {
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
      entries = fs.readdirSync(root.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root.dir, entry.name)
      const plugin = readManifest(dir)
      // 同 id 先到先得（内置优先于 userData）
      if (plugin.manifest && seen.has(plugin.manifest.id)) continue
      if (plugin.manifest) seen.add(plugin.manifest.id)
      out.push({ ...plugin, source: root.source })
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

// ---------- 安装 / 卸载 ----------

/** 复制时跳过的目录：源码仓库自带的东西，运行时用不到 */
const COPY_SKIP = new Set(['.git', 'node_modules', '.DS_Store'])

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 安装/升级：把一个插件目录复制到 <userData>/plugins/<id>。
 *
 * 也接受"父目录"（里面若干子目录各是一个插件），方便从仓库 plugins/ 整目录安装。
 * 已存在同 id 且 force=false 时返回 needConfirm，由 UI 二次确认后带 force 重试。
 */
export function installPluginFromDir(
  sourceDir: string,
  options: { force?: boolean } = {},
): { ok: true; installed: string[] } | { ok: false; error: string; needConfirm?: string[] } {
  const src = path.resolve(sourceDir)
  let stat: fs.Stats
  try {
    stat = fs.statSync(src)
  } catch {
    return { ok: false, error: `path not found: ${src}` }
  }
  if (!stat.isDirectory()) return { ok: false, error: 'not a directory' }

  // 自身就是插件目录，还是包含多个插件的父目录
  const candidates = fs.existsSync(path.join(src, 'plugin.json'))
    ? [src]
    : fs
        .readdirSync(src, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(src, e.name, 'plugin.json')))
        .map((e) => path.join(src, e.name))
  if (candidates.length === 0) return { ok: false, error: 'no plugin.json found' }

  const parsed: { dir: string; manifest: PluginManifest }[] = []
  for (const dir of candidates) {
    try {
      const result = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')))
      if (!result.ok) return { ok: false, error: `${path.basename(dir)}: ${result.error}` }
      parsed.push({ dir, manifest: result.manifest })
    } catch (error) {
      return { ok: false, error: `${path.basename(dir)}: ${errorMessage(error)}` }
    }
  }

  const root = userPluginsRoot()
  const conflicts = parsed.filter((p) => {
    const target = path.join(root, p.manifest.id)
    // 源目录就是目标目录（重复安装自己）不算冲突
    return fs.existsSync(target) && path.resolve(target) !== path.resolve(p.dir)
  })
  if (conflicts.length > 0 && !options.force) {
    return { ok: false, error: 'already_installed', needConfirm: conflicts.map((c) => c.manifest.id) }
  }

  const installed: string[] = []
  try {
    fs.mkdirSync(root, { recursive: true })
    for (const p of parsed) {
      const target = path.join(root, p.manifest.id)
      if (path.resolve(target) === path.resolve(p.dir)) {
        installed.push(p.manifest.id)
        continue
      }
      // 复制前清空旧版本，避免残留已删除文件
      fs.rmSync(target, { recursive: true, force: true })
      fs.cpSync(p.dir, target, {
        recursive: true,
        dereference: true,
        filter: (from) => {
          const name = path.basename(from)
          if (COPY_SKIP.has(name)) return false
          // 不把目标目录复制进自己（父目录安装时的自嵌套保护）
          return !isInside(target, from) || path.resolve(from) === path.resolve(p.dir)
        },
      })
      installed.push(p.manifest.id)
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  return { ok: true, installed }
}

/** 卸载：只允许删除 <userData>/plugins/<id> 这一层 */
export function removeUserPlugin(pluginId: string): { ok: true; dir: string } | { ok: false; error: string } {
  const found = findPlugin(pluginId)
  if (!found) return { ok: false, error: `plugin not found: ${pluginId}` }
  if (found.source !== 'user') return { ok: false, error: 'builtin_not_removable' }
  const root = userPluginsRoot()
  const target = path.resolve(found.dir)
  if (path.dirname(target) !== path.resolve(root)) return { ok: false, error: 'outside_plugin_root' }
  try {
    fs.rmSync(target, { recursive: true, force: true })
    const enabled = { ...configStore.get('pluginEnabled') }
    delete enabled[pluginId]
    configStore.set('pluginEnabled', enabled)
    return { ok: true, dir: target }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
