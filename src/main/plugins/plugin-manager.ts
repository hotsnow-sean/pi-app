import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { configStore } from '../config-store'
import {
  parsePluginManifest,
  type PluginManifest,
} from '@shared/plugin-manifest'
import { satisfiesHostRange } from '@shared/semver-range'
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

/**
 * 目录扫描结果。
 *
 * `manifest` 是判别式的：合法时非空，不可激活时**就是 null**（而不是「声明成非空、
 * 用 `null as unknown as` 蒙过编译器」——那样每个消费者都得靠猜）。不可激活时若有
 * 解析成功的清单，它落在 `blockedManifest`，只为设置页能显示「这行插件是谁、为什么
 * 没加载」。
 */
type ManifestRead = { dir: string; error?: string; errorKind?: 'manifest' | 'engines' } & (
  | { manifest: PluginManifest; blockedManifest?: undefined }
  | { manifest: null; blockedManifest?: PluginManifest }
)

/** 目录里读出来的东西（不含启停状态：那是 configStore 的事，现算） */
type DiscoveredBase = ManifestRead & {
  /**
   * builtin = 随应用分发；user = 用户安装到 userData；dev = 显式指定（PI_PLUGINS_DIR）
   * 的本地开发目录。
   *
   * `dev` 是后加的：原先显式覆盖一律算 `builtin`，于是 dev 用的插件目录在设置页被标成
   * 「内置」——既不是随应用分发的，也不在用户安装目录里，标签纯属误导，用户会去翻
   * 内置插件列表找它。`dev` 与 `builtin` 一样不可卸载（删源码太危险），只是标签如实。
   */
  source: PluginSource
}

export type DiscoveredPlugin = DiscoveredBase & { enabled: boolean }

export type PluginSource = 'builtin' | 'user' | 'dev'

type PluginRoot = { dir: string; source: PluginSource }

/** 用户安装目录：安装/卸载只允许发生在这一层之内 */
export function userPluginsRoot(): string {
  return path.join(app.getPath('userData'), 'plugins')
}

function pluginRoots(): PluginRoot[] {
  const roots: PluginRoot[] = []
  // 显式覆盖（e2e / 自定义安装位置）；优先级最高，不可卸载。
  //
  // 身份由调用方声明：默认仍按内置算（e2e 与打包资源目录的既有行为不变），传
  // `PI_PLUGINS_DIR_SOURCE=dev` 则标成「本地开发」——开发时插件目录在仓库外，
  // 硬说成「内置」会让人在设置页里找错地方。两者都不可卸载：这里的卸载流程会按
  // 用户安装目录的规则删文件，对着源码目录用它会出人命。
  const override = process.env.PI_PLUGINS_DIR?.trim()
  if (override) {
    const kind = process.env.PI_PLUGINS_DIR_SOURCE?.trim().toLowerCase() === 'dev' ? 'dev' : 'builtin'
    roots.push({ dir: override, source: kind })
  }
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

function readManifest(dir: string): ManifestRead {
  const manifestPath = path.join(dir, 'plugin.json')
  try {
    if (!fs.existsSync(manifestPath)) {
      return { manifest: null, dir, error: 'plugin.json not found', errorKind: 'manifest' }
    }
    const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const parsed = parsePluginManifest(raw)
    if (!parsed.ok) {
      return { manifest: null, dir, error: parsed.error, errorKind: 'manifest' }
    }
    // engines 校验（P2-7）：声明了「需要 host ≥ x」就要真的有人管，
    // 否则这个字段只是作者的自我安慰。不满足 = 不可激活，进设置页的诊断信息。
    // 清单本身是好的：保留 manifest（id/name/version 可用），设置页才能把
    // 这行插件显示出来并写明原因，而不是让它无声消失（复审 P1）。
    const required = parsed.manifest.engines?.['pi-desktop']
    if (required && !satisfiesHostRange(app.getVersion(), required)) {
      return {
        blockedManifest: parsed.manifest,
        manifest: null,
        dir,
        error: `host version ${app.getVersion()} does not satisfy engines['pi-desktop'] = ${required}`,
        errorKind: 'engines',
      }
    }
    return { manifest: parsed.manifest, dir }
  } catch (error) {
    return {
      manifest: null,
      dir,
      error: error instanceof Error ? error.message : String(error),
      errorKind: 'manifest',
    }
  }
}

// ---------- 目录缓存（P2-8） ----------
//
// discoverPlugins 的调用点在热路径上：每轮 prompt.send、每次 ctx.sessions.send、
// 每次设置读写都要全盘 readdir + readFileSync + JSON.parse + zod parse。缓存以
// 「各插件根目录的 mtime」为失效键——安装/卸载/升级都会改动根目录 mtime，天然失效；
// setPluginEnabled 只动 configStore，不动目录，所以 enabled 每次现算、不进缓存。
//
// 已知边界：直接改某个插件目录内部的 plugin.json 不会改根目录 mtime，缓存不失效。
// 开发期改 manifest 请重启应用（改代码走的是 mtime 热重载，与这条无关）。

type CacheEntry = {
  /** 缓存键：各根目录的 `dir\0mtimeMs` 串 */
  key: string
  /** 不含 enabled 的目录结果（enabled 现算）。保持判别式联合，别用 Omit 把它拍平 */
  plugins: DiscoveredBase[]
  /** 每次重建 +1：派生结果（工具描述符等）用它做缓存键 */
  version: number
}

let cache: CacheEntry | null = null

/** 当前发现代数：pluginToolDescriptors 等派生结果用它做自己的缓存键 */
export function pluginDiscoveryVersion(): number {
  return cache?.version ?? 0
}

function discoveryKey(): string | null {
  const parts: string[] = []
  for (const root of pluginRoots()) {
    try {
      parts.push(`${root.dir}\u0000${root.source}\u0000${fs.statSync(root.dir).mtimeMs}`)
    } catch {
      // 根目录不存在（如 userData/plugins 还没建过）：也算一种稳定状态
      parts.push(`${root.dir}\u0000${root.source}\u0000missing`)
    }
  }
  return parts.join('\u0001')
}

export function discoverPlugins(): DiscoveredPlugin[] {
  const key = discoveryKey()
  if (key === null) return []
  if (!cache || cache.key !== key) {
    const out: DiscoveredBase[] = []
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
        // 同 id 先到先得（内置优先于 userData）；被拒载的插件也占住 id
        const pluginId = plugin.manifest?.id ?? plugin.blockedManifest?.id
        if (pluginId && seen.has(pluginId)) continue
        if (pluginId) seen.add(pluginId)
        out.push({ ...plugin, source: root.source })
      }
    }
    cache = { key, plugins: out, version: (cache?.version ?? 0) + 1 }
  }
  // 分开写而不是 `{...p, enabled: p.manifest ? ... : false}`：spread 一个联合会把两侧
  // 属性求并集，判别关系丢掉，manifest 又变回 `PluginManifest | null`
  return cache.plugins.map((p) =>
    p.manifest
      ? { ...p, enabled: configStore.get('pluginEnabled')[p.manifest.id] !== false }
      : { ...p, enabled: false },
  )
}

export function findPlugin(pluginId: string): DiscoveredPlugin | null {
  return discoverPlugins().find((p) => p.manifest?.id === pluginId) ?? null
}

export function setPluginEnabled(pluginId: string, enabled: boolean): void {
  const next = { ...configStore.get('pluginEnabled'), [pluginId]: enabled }
  configStore.set('pluginEnabled', next)
  // enabled 不进目录缓存（现算），但派生结果（工具描述符等）依赖它——
  // 启停后抬一代，让它们失效
  if (cache) cache.version += 1
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
