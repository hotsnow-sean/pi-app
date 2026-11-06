import { discoverPlugins } from './plugin-manager'
import { invokePlugin } from './plugin-host'
import { errorMessage } from '@shared/error-message'
import type { PluginToolDescriptor, PluginToolResult } from '@shared/plugin-manifest'
import type { PluginToolExecuteParams } from '@shared/plugin-context'

/**
 * 插件工具的宿主侧：目录汇总 + 执行分发。
 *
 * 链路：main 在每次 prompt 前把目录下发给 worker → worker 的 inline extension 注册成
 * pi 工具 → 模型调用 → worker 发 `plugin-tool-request` → 这里 invoke 插件的
 * `tool.execute` → 结果回灌给会话。
 *
 * 为什么执行放 main：插件代码本来就在 main 里跑，工具调用只是它的一条对外通道；
 * 放 worker 会引入"插件代码进 worker"的生命周期与沙箱问题，收益（读会话内部状态）
 * 现在还用不上。代价是工具拿不到 messages / 当前 model，够用即可。
 */

/**
 * 回给 worker 的工具结果：插件契约（`PluginToolResult`）的线上形态。
 * `text` 换成 pi 的 content block，其余字段原样——两边字段靠这个派生关系绑定，
 * 加字段时不会只改一边。
 */
type ToolResultPayload = Omit<PluginToolResult, 'text'> & {
  content: Array<{ type: 'text'; text: string }>
}

/** callId → 取消句柄：worker 侧 abort/超时会发 plugin-tool-cancel */
const running = new Map<string, { pluginId: string; controller: AbortController }>()

/** 所有启用插件声明的工具（同名先到先得，重复的跳过并记日志） */
export function pluginToolDescriptors(): PluginToolDescriptor[] {
  const out: PluginToolDescriptor[] = []
  const seen = new Set<string>()
  for (const plugin of discoverPlugins()) {
    if (!plugin.manifest || !plugin.enabled) continue
    for (const tool of plugin.manifest.tools) {
      if (seen.has(tool.name)) {
        console.warn(`[plugin-tools] duplicate tool name "${tool.name}" in ${plugin.manifest.id}, skipped`)
        continue
      }
      seen.add(tool.name)
      out.push({
        pluginId: plugin.manifest.id,
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
      })
    }
  }
  return out
}

function textResult(text: string, isError = false): ToolResultPayload {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

function asDetails(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = (raw as { details?: unknown }).details
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 插件返回值 → pi 的工具结果。
 *
 * 接受三种形状：
 *   - 字符串                          → 原样当正文
 *   - { text, isError?, details? }    → 正文 + 结构化 result（推荐写法）
 *   - 任意对象                        → 序列化进正文，同时作为 details 留给代码模式/UI
 */
function normalizeResult(raw: unknown): ToolResultPayload {
  if (typeof raw === 'string') return textResult(raw)
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Partial<PluginToolResult>
    if (typeof obj.text === 'string') {
      const details = asDetails(raw)
      return {
        content: [{ type: 'text', text: obj.text }],
        ...(obj.isError === true ? { isError: true } : {}),
        ...(details ? { details } : {}),
      }
    }
    try {
      return { content: [{ type: 'text', text: JSON.stringify(raw) }], details: raw as Record<string, unknown> }
    } catch {
      return textResult(String(raw))
    }
  }
  return textResult(String(raw ?? ''))
}

/** worker → main：执行一个插件工具。reply 由调用方注入（不同宿主路径的回传方式不同） */
export async function handlePluginToolRequest(
  msg: Record<string, unknown>,
  reply: (payload: Record<string, unknown>) => void,
): Promise<void> {
  const callId = String(msg.callId ?? '')
  const pluginId = String(msg.pluginId ?? '')
  const tool = String(msg.tool ?? '')
  const args = (msg.args ?? {}) as Record<string, unknown>
  // 谁发起的调用：插件执行体在 main，本来够不到会话，只能由 worker 带过来
  const sessionFile = typeof msg.sessionFile === 'string' ? msg.sessionFile : ''
  const cwd = typeof msg.cwd === 'string' ? msg.cwd : ''
  if (!callId) return

  const controller = new AbortController()
  running.set(callId, { pluginId, controller })
  let result: ToolResultPayload
  try {
    // satisfies 而不是 `: PluginToolExecuteParams` —— 字段拼错要报错，同时保留字面量
    // 类型好赋给 invokePlugin 的 params（接口类型没有 index signature，反而会打架）
    const params = {
      name: tool,
      args,
      sessionFile,
      cwd,
      signal: controller.signal,
    } satisfies PluginToolExecuteParams
    const r = await invokePlugin(pluginId, 'tool.execute', params)
    result =
      r.ok === true
        ? normalizeResult(r.result)
        : textResult(`plugin_error: ${String(r.error || 'tool failed')}`, true)
  } catch (error) {
    result = textResult(`plugin_error: ${errorMessage(error)}`, true)
  } finally {
    running.delete(callId)
  }
  reply({ type: 'plugin-tool-response', callId, result })
}

/** worker 侧放弃这次调用（用户 Esc / 超时）：中止挂着的对话框，让插件尽快收尾 */
export function cancelPluginTool(callId: string): void {
  const entry = running.get(callId)
  if (!entry) return
  running.delete(callId)
  entry.controller.abort()
}

/** 插件停用：它的在途调用一并中止（别把别的插件也打断） */
export function cancelPluginToolCallsFor(pluginId: string): void {
  for (const [callId, entry] of [...running]) {
    if (entry.pluginId !== pluginId) continue
    running.delete(callId)
    entry.controller.abort()
  }
}
