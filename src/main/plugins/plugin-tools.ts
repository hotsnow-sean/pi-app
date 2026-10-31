import { discoverPlugins } from './plugin-manager'
import { invokePlugin } from './plugin-host'
import { errorMessage } from '@shared/error-message'
import type { PluginToolDescriptor } from '@shared/plugin-manifest'

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

type ToolResultPayload = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
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

/** 插件返回值 → pi 的工具结果（字符串 / {text,isError} / 任意对象都接） */
function normalizeResult(raw: unknown): ToolResultPayload {
  if (typeof raw === 'string') return textResult(raw)
  if (raw && typeof raw === 'object') {
    const obj = raw as { text?: unknown; isError?: unknown }
    if (typeof obj.text === 'string') return textResult(obj.text, obj.isError === true)
    try {
      return textResult(JSON.stringify(raw))
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
  if (!callId) return

  const controller = new AbortController()
  running.set(callId, { pluginId, controller })
  let result: ToolResultPayload
  try {
    const r = await invokePlugin(pluginId, 'tool.execute', { name: tool, args, signal: controller.signal })
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
