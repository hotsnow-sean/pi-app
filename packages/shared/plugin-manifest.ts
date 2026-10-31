import { z } from 'zod'

/**
 * 应用级插件清单（plugin.json）契约。
 *
 * 插件 = 四部件：plugin.json（清单）/ main.mjs（main 进程常驻服务）/ ui/（面板静态文档）/
 * agent.mjs（pi extension，后续接入）。本文件先固化清单层：main 与 renderer 共用同一 schema，
 * 校验失败只跳过该插件并记诊断，永不影响宿主启动。
 */

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/

export const pluginPanelContributionSchema = z.object({
  /** 面板短 id（插件内唯一）；完整 panel id = `plugin:<pluginId>:<panelId>` */
  id: z.string().regex(PLUGIN_ID_PATTERN, 'panel id must be lowercase alphanumeric/dash'),
  title: z.string().min(1),
  description: z.string().optional(),
  /** lucide 图标名（复用宿主 resolveAppIcon） */
  icon: z.string().optional(),
  /** 面板入口 HTML，相对插件目录，默认 ui/index.html */
  entry: z.string().default('ui/index.html'),
  defaultEnabled: z.boolean().default(true),
})

export type PluginPanelContribution = z.infer<typeof pluginPanelContributionSchema>

/**
 * 中央视图贡献点（侧栏入口 + 中央内容区）。
 *
 * 与 panels 的区别是**落点**而非能力：panels 落在右栏（窄，旁注性质），views 落在中央
 * （整块工作区，插件自建导航/列表/详情）。同一份 ui/index.html 可以两处都用——宿主不
 * 强制布局，插件按自身宽度自适应即可。
 */
export const pluginViewContributionSchema = z.object({
  /** 视图短 id（插件内唯一）；完整 id = `plugin:<pluginId>:<viewId>` */
  id: z.string().regex(PLUGIN_ID_PATTERN, 'view id must be lowercase alphanumeric/dash'),
  title: z.string().min(1),
  description: z.string().optional(),
  /** lucide 图标名（复用宿主 resolveAppIcon） */
  icon: z.string().optional(),
  /** 中央区入口 HTML，相对插件目录，默认 ui/index.html */
  entry: z.string().default('ui/index.html'),
})

export type PluginViewContribution = z.infer<typeof pluginViewContributionSchema>

export const pluginManifestSchema = z.object({
  /** 插件 id，全局唯一，小写字母数字连字符 */
  id: z.string().regex(PLUGIN_ID_PATTERN, 'plugin id must be lowercase alphanumeric/dash'),
  /** 显示名 */
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  /** lucide 图标名 */
  icon: z.string().optional(),
  /** 宿主版本约束（semver range）；缺省 = 不限制 */
  engines: z
    .object({
      'pi-desktop': z.string().optional(),
    })
    .optional(),
  /** main 进程入口，相对插件目录，默认 main.mjs；可省略（纯 UI 插件） */
  main: z.string().optional(),
  panels: z.array(pluginPanelContributionSchema).default([]),
  /** 中央视图：侧栏「应用」入口 + 中央内容区面板 */
  views: z.array(pluginViewContributionSchema).default([]),
})

export type PluginManifest = z.infer<typeof pluginManifestSchema>

/** 解析结果：清单合法 → ok；不合法 → 记录原因并跳过该目录（永不抛出） */
export type PluginManifestParse =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string }

export function parsePluginManifest(raw: unknown): PluginManifestParse {
  const result = pluginManifestSchema.safeParse(raw)
  if (result.success) return { ok: true, manifest: result.data }
  const detail = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
  return { ok: false, error: detail }
}

/** 完整 panel id：`plugin:<pluginId>:<panelId>`，与 adapter 的 `adapter:<id>` 命名空间平行 */
export function pluginPanelGlobalId(pluginId: string, panelId: string): string {
  return `plugin:${pluginId}:${panelId}`
}

/** 插件在右栏目录里复用的 adapter 通道 id（SidePanelHost 按此前缀路由到插件容器） */
export function pluginAdapterId(pluginId: string): string {
  return `plugin:${pluginId}`
}

export function isPluginAdapterId(adapterId: string | undefined): boolean {
  return !!adapterId && adapterId.startsWith('plugin:')
}

/** 中央视图的完整 id，与右栏面板共用 `plugin:` 命名空间 */
export function pluginViewGlobalId(pluginId: string, viewId: string): string {
  return `plugin:${pluginId}:${viewId}`
}

/** 中央视图的 iframe 地址（pi-plugin:// 协议，见 main/plugins/protocol.ts） */
export function pluginViewUrl(pluginId: string, entry: string): string {
  return `pi-plugin://${pluginId}/${entry.replace(/^\/+/, '')}`
}

/** 侧栏/中央视图状态：对话（默认）或某个插件视图 */
export type CenterView = { kind: 'chat' } | { kind: 'plugin'; pluginId: string; viewId: string }

export const CHAT_CENTER_VIEW: CenterView = { kind: 'chat' }

export function sameCenterView(a: CenterView, b: CenterView): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'chat') return true
  return a.pluginId === (b as { pluginId: string }).pluginId && a.viewId === (b as { viewId: string }).viewId
}

export function pluginIdFromAdapterId(adapterId: string): string {
  return adapterId.slice('plugin:'.length)
}
