import {
  extractTextFromPiMessage,
  extractThinkingFromPiMessage,
  extractToolResultFromPiMessage,
  normalizeUserMessageDisplayText,
  piMessageTimestamp,
  type PiSessionMessage,
} from '@shared/worker-message'
import { markTrailingIncompleteAssistants } from '@shared/timeline-incomplete'
import { PLUGIN_MESSAGE_CUSTOM_TYPE } from '@shared/plugin-message'

let msgSeq = 0
/**
 * History rows are built in Main *and* in every Worker process, each with its own counter (and a
 * restarted Worker starts over). Timelines merge rows from several of those sources, so bare
 * `hist-N` ids collided; duplicate React keys then misplaced whole turns / tool rows until a
 * remount. A per-process tag keeps ids unique across sources.
 */
const PROCESS_TAG = Math.random().toString(36).slice(2, 7)

function nextHistId(): string {
  return `hist-${PROCESS_TAG}-${++msgSeq}`
}

export function resetTimelineSeq(): void {
  msgSeq = 0
}

const extractText = extractTextFromPiMessage
const extractThinking = extractThinkingFromPiMessage
const extractToolResult = extractToolResultFromPiMessage

/**
 * 插件投递消息（`sessions.send`）的正文，非插件消息返回 null。
 *
 * 这类消息 `role` 是 `custom`，占的是「用户位」——不处理的话模型看得到、时间线看不见，
 * 用户重开会话才发现对话里少了一轮。`display === false` 的是隐藏上下文（只进模型、
 * 不进界面），必须在这里挡掉。
 */
export function pluginMessageText(message: unknown): string | null {
  return pluginMessageParts(message)?.text ?? null
}

/**
 * 插件投递消息的完整信息：正文 + 来源（origin 落盘在 message.details）。
 * 界面用 origin 把这类消息渲染成「转述行」（`后台任务 · 回报` 徽标 + 左对齐浅底），
 * 与用户自己输入的消息区分开——它们在模型侧占用户位，在界面上不该冒充用户。
 */
export function pluginMessageParts(message: unknown): {
  text: string
  origin: Record<string, unknown> | undefined
} | null {
  const m = message as
    | { role?: string; customType?: string; content?: unknown; display?: boolean; details?: unknown }
    | null
  if (!m || m.role !== 'custom') return null
  if (m.customType !== PLUGIN_MESSAGE_CUSTOM_TYPE) return null
  if (m.display === false) return null
  const content = m.content
  let text: string
  if (typeof content === 'string') text = content
  else if (!Array.isArray(content)) text = ''
  else
    text = content
      .filter((block) => (block as { type?: string })?.type === 'text')
      .map((block) => String((block as { text?: string }).text ?? ''))
      .join('\n')
  return { text, origin: asPluginOrigin(m.details) }
}

/** details 只承认形状完整的 origin，防止插件乱写污染界面 */
function asPluginOrigin(details: unknown): Record<string, unknown> | undefined {
  const o = details as { pluginId?: unknown; label?: unknown } | null | undefined
  if (!o || typeof o !== 'object') return undefined
  if (typeof o.pluginId !== 'string' || !o.pluginId.trim()) return undefined
  if (typeof o.label !== 'string' || !o.label.trim()) return undefined
  return o as Record<string, unknown>
}

/** Always keep assistant rows (even empty) so incomplete turns remain rewound-able. */
function pushAssistantItem(
  items: Array<Record<string, unknown>>,
  opts: {
    text: string
    thinkingText: string
    timestamp: number
    sessionEntryId?: string
    stopReason?: string
    /** Provider error of a failed reply (e.g. "Request timed out."), shown instead of a bare "incomplete". */
    errorMessage?: string
    /** Same assistant message also emitted toolCall blocks — not a crash leaf. */
    hasToolCalls?: boolean
  },
): void {
  const emptyBody = !opts.text.trim() && !opts.thinkingText.trim()
  const errorStop =
    opts.stopReason === 'aborted' || opts.stopReason === 'error' || opts.stopReason === 'interrupted'
  // Mid-turn tool-use bridges are empty by design — only mark incomplete on true errors
  // or empty leaves without tool calls (crash before first token / tool).
  const incomplete = emptyBody && (errorStop || !opts.hasToolCalls)
  items.push({
    id: nextHistId(),
    type: 'assistant-message',
    text: opts.text,
    thinkingText: opts.thinkingText || undefined,
    timestamp: opts.timestamp,
    ...(opts.sessionEntryId ? { sessionEntryId: opts.sessionEntryId } : {}),
    ...(incomplete
      ? {
          incomplete: true,
          stopReason: opts.stopReason || 'interrupted',
          ...(opts.stopReason === 'error' && opts.errorMessage?.trim() ? { errorMessage: opts.errorMessage.trim() } : {}),
        }
      : opts.stopReason
        ? { stopReason: opts.stopReason }
        : {}),
  })
}

export function normalizeMessages(messages: unknown[]): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = []
  const now = Date.now()
  const toolCallIndex = new Map<string, number>()

  for (const m of messages) {
    const pm = m as PiSessionMessage & { toolCallId?: string; toolName?: string }
    const ts = piMessageTimestamp(pm, now)
    const content = Array.isArray(pm.content) ? pm.content : []

    const pluginText = pluginMessageText(pm)
    if (pm.role === 'user' || pluginText !== null) {
      const text = pluginText ?? normalizeUserMessageDisplayText(extractText(pm))
      if (text)
        items.push({
          id: nextHistId(),
          type: 'user-message',
          text,
          timestamp: ts,
          ...(pluginText !== null ? { pluginOrigin: pluginMessageParts(pm)?.origin } : {}),
        })
    } else if (pm.role === 'assistant') {
      const text = extractText(pm)
      const thinkingText = extractThinking(pm)
      const toolCalls = content.filter((c) => (c as { type?: string }).type === 'toolCall')
      // Always emit assistant bubble (even if empty after crash mid-stream) for leaf/rewind.
      pushAssistantItem(items, {
        text,
        thinkingText,
        timestamp: ts,
        stopReason: pm.stopReason,
        errorMessage: (pm as { errorMessage?: string }).errorMessage,
        hasToolCalls: toolCalls.length > 0,
      })
      for (const c of toolCalls) {
        const tc = c as {
          name?: string
          input?: unknown
          arguments?: unknown
          id?: string
          toolCall?: { name?: string; input?: unknown; arguments?: unknown; id?: string }
        }
        const name = tc.name || tc.toolCall?.name || 'tool'
        const input = tc.input ?? tc.arguments ?? tc.toolCall?.input ?? tc.toolCall?.arguments
        const callId = tc.id || tc.toolCall?.id || ''
        const item: Record<string, unknown> = {
          id: nextHistId(),
          type: 'tool-call',
          ...(callId ? { toolCallId: callId } : {}),
          toolName: name,
          toolArgs: input || undefined,
          toolPhase: 'end',
          toolOutput: '',
          timestamp: ts,
        }
        const idx = items.length
        items.push(item)
        if (callId) toolCallIndex.set(callId, idx)
      }
    } else if (pm.role === 'toolResult') {
      const text = extractText(pm) || extractToolResult(pm)
      const callId = pm.toolCallId || ''
      const toolName = pm.toolName || ''
      let targetIdx = callId ? toolCallIndex.get(callId) : undefined
      if (targetIdx === undefined) {
        for (let i = items.length - 1; i >= 0; i--) {
          const row = items[i]
          if (
            row.type === 'tool-call' &&
            !row.toolOutput &&
            (!toolName || row.toolName === toolName)
          ) {
            targetIdx = i
            break
          }
        }
      }
      if (targetIdx !== undefined && items[targetIdx]) {
        items[targetIdx].toolOutput = text.slice(0, 4000)
        if (callId) items[targetIdx].toolCallId = callId
        if (pm.details !== undefined) items[targetIdx].toolDetails = pm.details
        if (pm.isError !== undefined) items[targetIdx].isError = pm.isError
        if (toolName && items[targetIdx].toolName === 'tool') items[targetIdx].toolName = toolName
      } else if (text) {
        items.push({
          id: nextHistId(),
          type: 'tool-call',
          ...(callId ? { toolCallId: callId } : {}),
          toolName: toolName || 'result',
          toolPhase: 'end',
          toolOutput: text.slice(0, 2000),
          ...(pm.details !== undefined ? { toolDetails: pm.details } : {}),
          ...(pm.isError !== undefined ? { isError: pm.isError } : {}),
          timestamp: ts,
        })
      }
    } else if (pm.role === 'compactionSummary' || pm.role === 'branchSummary') {
      const text = extractText(pm)
      items.push({ id: nextHistId(), type: 'compaction', text, timestamp: ts })
    }
  }
  return markTrailingIncompleteAssistants(items)
}

/** 按当前 leaf 的 getBranch() 顺序建时间线，与 TUI 树上路径一致。 */
export function timelineItemsFromBranchPath(path: unknown[]): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = []
  const toolCallIndex = new Map<string, number>()
  const now = Date.now()

  for (const entry of path) {
    const e = entry as {
      timestamp?: string
      id?: string
      type?: string
      summary?: string
      message?: PiSessionMessage & { content?: unknown[] }
    }
    const ts = e.timestamp ? new Date(e.timestamp).getTime() : now
    const sid = e.id

    if (e.type === 'compaction' && e.summary) {
      items.push({
        id: nextHistId(),
        type: 'compaction',
        text: String(e.summary),
        timestamp: ts,
        sessionEntryId: sid,
      })
      continue
    }
    if (e.type === 'branch_summary' && e.summary) {
      items.push({
        id: nextHistId(),
        type: 'compaction',
        text: String(e.summary),
        timestamp: ts,
        sessionEntryId: sid,
      })
      continue
    }
    if (e.type !== 'message' || !e.message) continue

    const m = e.message
    const content = m.content || []

    const pluginText = pluginMessageText(m)
    if (m.role === 'user' || pluginText !== null) {
      const text = pluginText ?? normalizeUserMessageDisplayText(extractText(m))
      // Keep empty user only if we have an entry id (rare); normally require text.
      if (text || sid) {
        items.push({
          id: nextHistId(),
          type: 'user-message',
          text: text || '',
          timestamp: ts,
          sessionEntryId: sid,
          ...(pluginText !== null ? { pluginOrigin: pluginMessageParts(m)?.origin } : {}),
        })
      }
    } else if (m.role === 'assistant') {
      const text = extractText(m)
      const thinkingText = extractThinking(m)
      const toolCalls = content.filter((c) => (c as { type?: string }).type === 'toolCall')
      // Always keep assistant entries — crash mid-turn leaves empty leaf that must stay visible for rewind.
      pushAssistantItem(items, {
        text,
        thinkingText,
        timestamp: ts,
        sessionEntryId: sid,
        stopReason: m.stopReason,
        errorMessage: (m as { errorMessage?: string }).errorMessage,
        hasToolCalls: toolCalls.length > 0,
      })
      for (const c of toolCalls) {
        const cc = c as {
          name?: string
          arguments?: unknown
          id?: string
          toolCall?: { name?: string; input?: unknown; arguments?: unknown; id?: string }
        }
        const name = cc.name || cc.toolCall?.name || 'tool'
        const input = cc.arguments ?? cc.toolCall?.input ?? cc.toolCall?.arguments
        const callId = cc.id || cc.toolCall?.id || ''
        const item: Record<string, unknown> = {
          id: nextHistId(),
          type: 'tool-call',
          ...(callId ? { toolCallId: callId } : {}),
          toolName: name,
          toolArgs: input || undefined,
          toolPhase: 'end',
          toolOutput: '',
          timestamp: ts,
          sessionEntryId: sid,
        }
        const idx = items.length
        items.push(item)
        if (callId) toolCallIndex.set(callId, idx)
      }
    } else if (m.role === 'toolResult') {
      const text = extractText(m)
      const callId = (m as { toolCallId?: string }).toolCallId || ''
      const toolName = (m as { toolName?: string }).toolName || ''
      let targetIdx = callId ? toolCallIndex.get(callId) : undefined
      if (targetIdx === undefined) {
        for (let i = items.length - 1; i >= 0; i--) {
          const row = items[i]
          if (
            row.type === 'tool-call' &&
            !row.toolOutput &&
            (!toolName || row.toolName === toolName)
          ) {
            targetIdx = i
            break
          }
        }
      }
      if (targetIdx !== undefined && items[targetIdx]) {
        items[targetIdx].toolOutput = text.slice(0, 4000)
        if (callId) items[targetIdx].toolCallId = callId
        if (m.details !== undefined) items[targetIdx].toolDetails = m.details
        if (m.isError !== undefined) items[targetIdx].isError = m.isError
        if (toolName && items[targetIdx].toolName === 'tool') items[targetIdx].toolName = toolName
      } else if (text) {
        items.push({
          id: nextHistId(),
          type: 'tool-call',
          ...(callId ? { toolCallId: callId } : {}),
          toolName: toolName || 'result',
          toolPhase: 'end',
          toolOutput: text.slice(0, 2000),
          ...(m.details !== undefined ? { toolDetails: m.details } : {}),
          ...(m.isError !== undefined ? { isError: m.isError } : {}),
          timestamp: ts,
          sessionEntryId: sid,
        })
      }
    }
  }
  // Force-quit mid-stream leaves empty assistant leaf — mark so UI keeps it + rewind works.
  return markTrailingIncompleteAssistants(items)
}
