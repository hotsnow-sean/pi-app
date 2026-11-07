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

/**
 * 会话条贡献点：对话区顶部的一条插件 UI，跟着**当前会话**走。
 *
 * 宿主对它的全部理解就是「一条 iframe + 一个位置」：显不显示、多高、画什么，都由插件
 * 自己决定（它比宿主更清楚哪些任务/成员属于当前会话），所以宿主不做归属反查。
 * 插件通过 `plugin-content-height` 上报高度，报 0 就塌缩成 0（iframe 仍活着，随时能撑开）。
 *
 * 放在对话顶部而不是右栏，是因为它回答的是「我现在这个会话后台在干什么」——
 * 这个问题要在视线第一落点上，翻面板去确认就已经输了。
 */
export const pluginSessionBarContributionSchema = z.object({
  /** 会话条短 id（插件内唯一） */
  id: z.string().regex(PLUGIN_ID_PATTERN, 'session bar id must be lowercase alphanumeric/dash'),
  title: z.string().min(1),
  /** 入口文档，相对插件目录 */
  entry: z.string().default('ui/session-bar.html'),
  /** 默认高度（px）：插件上报实际高度之前的占位，避免加载后跳一下 */
  height: z.number().int().min(24).max(120).default(44),
})

export type PluginSessionBarContribution = z.infer<typeof pluginSessionBarContributionSchema>

/**
 * 插件设置项（声明式）。宿主据此在设置页渲染表单，值由宿主持久化，
 * 插件在 main 侧通过 `ctx.settings.get()` 读取、UI 侧通过 `plugin-settings` 消息接收。
 *
 * 只支持"数据"而非"界面"：布尔、文本、数字、枚举。需要特殊交互的设置项，
 * 走插件自己的中央视图（views[]），不要塞进这里。
 */
export const pluginSettingFieldSchema = z
  .object({
    /** 存储键（插件内唯一），也是 ctx.settings.get() 返回对象的 key */
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, 'setting key must start with a letter'),
    type: z.enum(['boolean', 'string', 'number', 'select']),
    /** 表单标签；宿主不翻译（插件自带文案） */
    label: z.string().min(1),
    description: z.string().optional(),
    /** 默认值；类型须与 type 匹配，宿主会校验 */
    default: z.union([z.boolean(), z.string(), z.number()]).optional(),
    placeholder: z.string().optional(),
    /** select 的候选项 */
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    /** number 范围与步进 */
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    /** string 用多行文本框 */
    multiline: z.boolean().optional(),
    /** string 用密码框（仅遮挡显示，文件仍为明文） */
    secret: z.boolean().optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'select' && (!field.options || field.options.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'select requires options[]' })
    }
    if (field.default !== undefined) {
      const ok =
        (field.type === 'boolean' && typeof field.default === 'boolean') ||
        (field.type === 'string' && typeof field.default === 'string') ||
        (field.type === 'select' && typeof field.default === 'string') ||
        (field.type === 'number' && typeof field.default === 'number')
      if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `default type mismatch for ${field.key}` })
    }
  })

export type PluginSettingField = z.infer<typeof pluginSettingFieldSchema>

/**
 * 插件工具（会话级贡献点）。
 *
 * 与 panels / views 的根本差别：工具跑在**对话里**，不是一块界面。宿主把 tools[] 注入
 * 每个会话的 pi SDK（customTools / inline extension），模型可以直接调用，插件成为
 * "伸进会话的那只手"。执行落在 main 进程（main.mjs 的 invoke('tool.execute')），
 * 所以插件拿不到会话内部状态，但能拿到 ctx.ui / ctx.storage——足够 ask 这一类交互。
 *
 * parameters 用纯 JSON Schema（与 MCP 一致），宿主原样交给 pi 做参数校验。
 */
export const pluginToolContributionSchema = z.object({
  /** 模型看到的工具名（全局唯一，小写字母数字下划线） */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'tool name must be lowercase alphanumeric/underscore'),
  /** 界面标签（工具卡标题） */
  label: z.string().min(1),
  /** 给模型看的说明，写清何时用、参数含义 */
  description: z.string().min(1),
  /** JSON Schema（type: object）。宿主只做形状校验，语义由插件自己把关 */
  parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  /** 时间线工具卡：模板与图标。缺省按 default 模板渲染 */
  card: z
    .object({
      template: z.enum(['default', 'kv', 'list', 'tree', 'media']).optional(),
      icon: z.string().optional(),
    })
    .optional(),
})

export type PluginToolContribution = z.infer<typeof pluginToolContributionSchema>

/**
 * pi extension 入口（`agent.mjs`）：插件在**会话进程**里跑的那部分。
 *
 * 与 main.mjs 的分工：main.mjs 在 main 进程常驻（有 ctx.ui / storage / 会话投递），
 * agent.mjs 在每个会话的 worker 里被当作 pi extension 注入（能读 eventBus、能注册工具、
 * 能挂事件钩子）。两者之间没有现成通道——要通信只能借文件或主进程转发，插件自己安排。
 *
 * 为什么值得多这一层：有些数据只存在于会话进程内（扩展的 eventBus、SDK 内部状态），
 * main 进程根本够不到；把它们搬出来是插件自己的事，宿主只负责把代码送进去。
 */
export const pluginAgentContributionSchema = z.object({
  /** 入口文件，相对插件目录；只接受 JS 模块（.mjs/.js/.cjs） */
  entry: z
    .string()
    .default('agent.mjs')
    .refine((v) => /\.(mjs|cjs|js)$/.test(v), 'agent entry must be a .mjs/.js/.cjs file'),
})

export type PluginAgentContribution = z.infer<typeof pluginAgentContributionSchema>

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
  /** 会话进程入口（pi extension）：省略 = 该插件不往会话里注入任何东西 */
  agent: pluginAgentContributionSchema.optional(),
  panels: z.array(pluginPanelContributionSchema).default([]),
  /** 中央视图：侧栏「应用」入口 + 中央内容区面板 */
  views: z.array(pluginViewContributionSchema).default([]),
  /** 会话条：对话顶部的一条插件 UI，跟随当前会话 */
  sessionBars: z.array(pluginSessionBarContributionSchema).default([]),
  /** 声明式设置项：设置页「插件」里由宿主渲染表单 */
  settings: z.array(pluginSettingFieldSchema).default([]),
  /** 会话级工具：注入 pi 会话，模型可直接调用 */
  tools: z.array(pluginToolContributionSchema).default([]),
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

/** 设置项默认值表（只含有 default 的键） */
export function pluginSettingDefaults(fields: readonly PluginSettingField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.default !== undefined) out[field.key] = field.default
  }
  return out
}

/**
 * 把任意输入强制成该设置项的合法值；不合法返回 undefined（调用方保留旧值 / 用默认值）。
 * 渲染层与 main 侧共用，保证"表单能存进去的，插件读出来一定合法"。
 */
export function coercePluginSettingValue(field: PluginSettingField, raw: unknown): unknown {
  switch (field.type) {
    case 'boolean':
      if (typeof raw === 'boolean') return raw
      if (raw === 'true') return true
      if (raw === 'false') return false
      return undefined
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
      if (!Number.isFinite(n)) return undefined
      let v = n
      if (typeof field.min === 'number' && v < field.min) v = field.min
      if (typeof field.max === 'number' && v > field.max) v = field.max
      return v
    }
    case 'select': {
      const s = String(raw ?? '')
      const allowed = field.options ?? []
      return allowed.some((o) => o.value === s) ? s : undefined
    }
    case 'string':
    default:
      return typeof raw === 'string' ? raw : raw === undefined || raw === null ? undefined : String(raw)
  }
}

/**
 * 下发给 worker 的工具目录行（会话只需要这些字段）。
 * 宿主 main 在每次 prompt 前重发一份，worker 据此注册 / 摘除工具。
 */
export type PluginToolDescriptor = {
  pluginId: string
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * 插件工具执行契约：main 侧 `invoke('tool.execute', { name, args, ... })` 的返回。
 *
 * 推荐返回 `{ text, details }`：`text` 写给人/模型看（可读文本，不要把 JSON 贴进去），
 * `details` 放原始对象——宿主一路带到 worker 的 tool result，代码执行类模式里
 * 被当对象用的就是它。返回纯字符串或任意对象也合法，宿主会归一化。
 */
export type PluginToolResult = {
  /** 回灌给模型的文本 */
  text: string
  /** 标记失败（模型会看到错误文本并自行决定重试） */
  isError?: boolean
  /** 结构化结果（可选）：正文只是文本，机器可读的那份放这里 */
  details?: Record<string, unknown>
}
