// 插件工具（pi Desktop 的会话级插件能力）。
//
// 插件在 plugin.json 里声明 tools[]，Main 把目录下发给 Worker（每次 prompt 前重发一份），
// 这里用一个隐藏 inline extension 把它们注册成 pi 工具。执行体在 Main 的插件 main.mjs，
// Worker 只转发调用并等结果——与 browser_* 工具同一套路（见 worker-browser-tools.ts）。
//
// 关键点：工具是插件唯一能合法穿进"会话"那条边界的通道。插件 UI（iframe）做不到这件事，
// runAgentPrompt 也只能另起一个会话。

import type { ExtensionAPI, InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { WorkerIncomingMessage } from './worker-port-types.js'
import type { WorkerReply } from './worker-handler-types.js'
import type { PluginToolDescriptor } from '@shared/plugin-manifest'
import { sendToMain } from './worker-transport.js'

/** 插件工具常常在等人（问卷/审批），超时给足；真正的取消来自用户 Esc 的 abort */
const CALL_TIMEOUT_MS = 20 * 60_000

type ToolResultPayload = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

let api: ExtensionAPI | null = null
/**
 * 发起调用的会话信息。工具执行体在 Main 进程，本来拿不到「谁在调我」；
 * 但插件常常需要这个——后台任务要知道把完成回报投回哪个会话。
 * worker-runtime 在初始化时把活的 state 接进来（不直接 import 是为了避开循环依赖）。
 */
let sessionInfo: () => { sessionFile: string | null; cwd: string | null } = () => ({
  sessionFile: null,
  cwd: null,
})

export function setPluginToolSessionResolver(
  resolver: () => { sessionFile: string | null; cwd: string | null },
): void {
  sessionInfo = resolver
}

let catalog: PluginToolDescriptor[] = []
/** 本 Worker 生命周期内注册过的工具名（pi 不允许重名注册，只能注册一次） */
const registered = new Set<string>()
let seq = 0
const pending = new Map<
  string,
  { resolve: (r: ToolResultPayload) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>()

function isDescriptor(raw: unknown): raw is PluginToolDescriptor {
  const d = raw as Partial<PluginToolDescriptor> | null
  return !!d && typeof d.name === 'string' && typeof d.pluginId === 'string' && typeof d.description === 'string'
}

/** Main 下发的目录（含启用插件的全部工具；空数组 = 全部停用） */
export function setPluginTools(raw: unknown): void {
  catalog = Array.isArray(raw) ? raw.filter(isDescriptor) : []
  apply()
}

export async function handleSetPluginTools(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
  setPluginTools(msg.tools)
  reply({ ok: true, count: catalog.length })
}

/** 测试/诊断用：当前生效的工具名 */
export function pluginToolNames(): string[] {
  return catalog.map((d) => d.name)
}

function callMain(def: PluginToolDescriptor, args: unknown, signal?: AbortSignal): Promise<ToolResultPayload> {
  const callId = `pt-${process.pid}-${++seq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(callId)
      sendToMain({ type: 'plugin-tool-cancel', callId })
      reject(new Error('plugin_tool_timeout: 插件工具没有在预期时间内返回'))
    }, CALL_TIMEOUT_MS)
    pending.set(callId, { resolve, reject, timer })
    signal?.addEventListener('abort', () => {
      const p = pending.get(callId)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(callId)
      // Main 侧还挂着对话框：让它一起收尾，否则用户会看到一个没人等的弹窗
      sendToMain({ type: 'plugin-tool-cancel', callId })
      reject(new Error('aborted'))
    })
    const info = sessionInfo()
    sendToMain({
      type: 'plugin-tool-request',
      callId,
      pluginId: def.pluginId,
      tool: def.name,
      args,
      sessionFile: info.sessionFile,
      cwd: info.cwd,
    })
  })
}

function registerOne(pi: ExtensionAPI, def: PluginToolDescriptor): void {
  if (registered.has(def.name)) return
  // 与宿主/其它扩展已有的工具重名：让位，不覆盖（工具名是模型可见的全局标识）
  try {
    if (pi.getAllTools().some((t) => t.name === def.name)) {
      console.warn(`[Worker] plugin tool "${def.name}" conflicts with an existing tool, skipped`)
      return
    }
  } catch {
    /* getAllTools 不可用时按无冲突处理 */
  }
  registered.add(def.name)
  pi.registerTool({
    name: def.name,
    label: def.label,
    description: def.description,
    // 纯 JSON Schema：pi 对非 TypeBox schema 走自己的 JSON Schema 校验路径
    parameters: def.parameters as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params, signal): Promise<{ content: ToolResultPayload['content']; details: Record<string, never> }> {
      const result = await callMain(def, params, signal)
      if (result.isError) {
        throw new Error(result.content.map((c) => c.text).join('\n') || 'plugin tool failed')
      }
      return { content: result.content, details: {} }
    },
  })
}

/**
 * 把已注册的工具集合对齐到当前目录：新工具补注册，去掉的从 active 集合里摘掉。
 * （pi 没有 unregisterTool；摘出 active 集合后模型就看不到了。）
 */
function apply(): void {
  if (!api) return
  const pi = api
  for (const def of catalog) registerOne(pi, def)
  const desired = catalog.filter((d) => registered.has(d.name)).map((d) => d.name)
  let current: string[]
  try {
    current = pi.getActiveTools()
  } catch {
    return
  }
  const ours = new Set(registered)
  const next = [...current.filter((n) => !ours.has(n)), ...desired]
  if (next.length === current.length && next.every((n, i) => n === current[i])) return
  try {
    pi.setActiveTools(next)
  } catch {
    /* 会话还没绑定时忽略；session_start 会再来一次 */
  }
}

export async function handlePluginToolResponse(msg: WorkerIncomingMessage, _reply: WorkerReply): Promise<void> {  const callId = String(msg.callId ?? '')
  const p = pending.get(callId)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(callId)
  p.resolve((msg.result as ToolResultPayload) ?? { content: [{ type: 'text', text: '' }], isError: true })
}

export const pluginToolsExtension: InlineExtension = {
  name: 'pi-desktop-plugin-tools',
  hidden: true,
  factory: (pi: ExtensionAPI) => {
    api = pi
    // 新会话 = 新的 ExtensionAPI 实例，注册表要跟着重置（工具挂在实例上，不在模块里）
    registered.clear()
    for (const def of catalog) registerOne(pi, def)
    pi.on('session_start', () => apply())
  },
}
