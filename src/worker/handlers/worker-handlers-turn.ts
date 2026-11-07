import { fileURLToPath } from 'node:url'
import { preparePiCliEntry } from '../worker-cli-entry.js'
import { widenHttpConnectTimeout } from '../worker-http-connect.js'
import { setPluginAgentExtensions } from '../worker-plugin-agent-extensions.js'
import { errorMessage } from '@shared/error-message'
import { normalizeUserMessageDisplayText } from '@shared/worker-message'
import type { WorkerIncomingMessage } from '../worker-port-types.js'
import type { ExtensionUIResponse } from '../desktop-ui-bridge.js'
import type { WorkerReply } from '../worker-handler-types.js'
import {
  st,
  initSession,
  baseEvent,
  beginRunIdentity,
  emit,
  currentSessionModelKey,
} from '../worker-runtime.js'

export async function handleInit(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        try {
          console.log('[Worker] Initializing st.session for:', msg.cwd)
          st.activeSdkPath = typeof msg.sdkPath === 'string' && msg.sdkPath ? msg.sdkPath : null
          let sdkFallback = false
          try {
            if (st.activeSdkPath) {
              const { isAbsolute } = await import('node:path')
              const { pathToFileURL } = await import('node:url')
              if (isAbsolute(st.activeSdkPath)) {
                st.sdk = await import(pathToFileURL(st.activeSdkPath).href)
              } else {
                st.sdk = await import(st.activeSdkPath)
              }
            } else {
              st.sdk = await import('@earendil-works/pi-coding-agent')
            }
          } catch (e: unknown) {
            console.error('[Worker] Dynamic import SDK failed, fallback to builtin:', errorMessage(e))
            st.activeSdkPath = null
            st.sdk = await import('@earendil-works/pi-coding-agent')
            sdkFallback = true
          }
          if (!st.sdk) throw new Error('SDK load failed')
          let resolvedEntry: string | null = null
          try {
            resolvedEntry = st.activeSdkPath ?? fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
            await preparePiCliEntry(resolvedEntry)
            widenHttpConnectTimeout(resolvedEntry)
          } catch (e) {
            console.warn('[Worker] Could not resolve Pi CLI entry:', errorMessage(e))
          }
          if (!st.sharedEventBus) st.sharedEventBus = st.sdk.createEventBus()
          // 插件会话扩展清单必须在 initSession 之前落地：会话 runtime 是在那里面
          // 按 extensionFactories 建起来的，晚一步这一整个会话就没有插件扩展。
          setPluginAgentExtensions(msg.pluginAgentExtensions)
          await initSession(String(msg.cwd || ''))
          if (resolvedEntry) {
            const globalCfg = (st.session?.settingsManager as { getGlobalSettings?: () => Record<string, unknown> } | undefined)?.getGlobalSettings?.()
            widenHttpConnectTimeout(resolvedEntry, globalCfg?.httpConnectTimeoutMs)
          }
          console.log('[Worker] Init done, sessionId:', st.currentSessionId)
          reply({ type: 'init-done', sessionId: st.currentSessionId, model: currentSessionModelKey(), thinkingLevel: st.session?.thinkingLevel, sdkFallback })
        } catch (e: unknown) {
          console.error('[Worker] Init FAILED:', errorMessage(e), e instanceof Error ? e.stack : '')
          reply({ type: 'error', error: `Init failed: ${errorMessage(e)}`, stack: e instanceof Error ? e.stack : undefined })
        }
        return
}


export async function handlePrompt(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        const promptSession = st.session
        if (!promptSession) { reply({ type: 'error', error: 'No session' }); return }
        const promptText = String(msg.text ?? '').trim()
        const slashMatch = promptText.match(/^(\/\S+)/)
        if (slashMatch) {
          emit({
            ...baseEvent(),
            type: 'slash',
            command: slashMatch[1],
            status: 'dispatched',
            text: '已发送给 pi 执行',
          })
        }
        st.promptSent = true
        // 在首个 stream 事件前就标 busy，避免切会话/evict 误杀；streamingBehavior 须用标记前的状态
        const alreadyStreaming = promptSession.isStreaming || st.agentTurnActive
        if (!alreadyStreaming) {
          beginRunIdentity()
          st.agentTurnActive = true
          st.promptPreflightActive = true
          st.abortAfterPreflight = false
          emit({ ...baseEvent(), type: 'run', phase: 'started' })
        }
        reply({ type: 'prompt-done' })
        void (async () => {
          try {
            const extra = msg.options as Parameters<typeof promptSession.prompt>[1]
            const merged =
              alreadyStreaming && !extra?.streamingBehavior
                ? { ...extra, streamingBehavior: 'followUp' as const }
                : extra
            await promptSession.prompt(promptText, merged)
            if (!alreadyStreaming && st.promptPreflightActive) {
              st.promptPreflightActive = false
              st.abortAfterPreflight = false
              st.agentTurnActive = false
              emit({ ...baseEvent(), type: 'run', phase: 'idle' })
            }
            if (slashMatch) {
              emit({
                ...baseEvent(),
                type: 'slash',
                command: slashMatch[1],
                status: 'ok',
                text: '命令已执行（详见下方助手/工具输出）',
              })
            }
          } catch (e: unknown) {
            console.error('[Worker] prompt failed:', e)
            const errText = errorMessage(e)
            if (st.promptPreflightActive) {
              st.promptPreflightActive = false
              st.abortAfterPreflight = false
              st.agentTurnActive = false
              emit({
                ...baseEvent(),
                type: 'agent_error',
                text: errText,
                kind: 'error',
                stopReason: 'error',
              })
              emit({ ...baseEvent(), type: 'run', phase: 'failed' })
            }
            if (slashMatch) {
              emit({
                ...baseEvent(),
                type: 'slash',
                command: slashMatch[1],
                status: 'error',
                text: `执行失败: ${errText}`,
              })
            }
          }
        })()
        return
}


/**
 * 插件向**宿主会话**投递消息（ctx.sessions.send 的 worker 端）。
 *
 * 与 handlePrompt 的区别：落盘是 custom_message 而非 user message——
 * 消息照样进模型上下文、驱动完整一轮，但 `details`（来源标注）只给界面看，
 * 界面据此渲染「后台任务 → 会话」的回报行而不是冒充用户输入。
 * worker 事件流对 custom message 的实时转发（worker-session-events.ts）原样复用。
 */
type CustomAppMessage = {
  /** SDK 的 custom 消息固定 role:"custom"（sendCustomMessage 内部补的字段） */
  role: 'custom'
  customType: string
  content: string
  display: boolean
  details?: unknown
}

/**
 * SDK 缺口补丁：`sendCustomMessage({triggerTurn})` 直达 `_runAgentPrompt`，跳过了
 * `prompt()` 在首轮请求前做的两件事——dispatch `before_agent_start`（desktop 能力段
 * 就是在这里并入 systemPromptOptions 的）和 `_preparePromptAndToolLoadout`（生成
 * system 补丁消息随请求发出）。后果：**全新会话的第一轮请求整段没有 system**
 * （实测：首轮 system 为空，第二轮起由 agent.prepareNextTurnWithContext 兜底恢复）。
 *
 * 这里按 `prompt()` 的顺序补齐（窄类型断言，模式同 plugin-sessions 的 `_rewriteFile`）：
 * 返回随请求发送的消息数组（system 补丁 + custom 消息）；SDK 内部结构对不上或任何
 * 一步失败时返回 null，调用方退回原生 sendCustomMessage——退化成现状，不会更坏。
 * 仅空闲首轮流需要；run 内的后续请求由 agent.prepareNextTurnWithContext 兜底。
 *
 * 注意：本函数自身不抛错——错误传播路径必须保持与原生 sendCustomMessage 一致
 * （单层 await 直达 handleCustomPrompt 的 catch，状态复位/agent_error 时序不能变）。
 */
async function prepareFirstTurnMessages(
  session: NonNullable<typeof st.session>,
  appMessage: CustomAppMessage,
): Promise<unknown[] | null> {
  type SessionInternals = {
    _baseSystemPromptOptions?: Record<string, unknown>
    _extensionRunner?: {
      emitBeforeAgentStart?: (
        text: string,
        images: unknown,
        options: Record<string, unknown>,
      ) => Promise<{ systemPromptOptions?: Record<string, unknown> } | undefined>
    }
    getActiveToolNames?: () => string[]
    _preparePromptAndToolLoadout?: (options: Record<string, unknown>) => unknown
    _runSystemPromptOptions?: unknown
    _isEmittingAgentSettled?: boolean
  }
  try {
    const s = session as unknown as SessionInternals
    // agent settled 发射窗口内交回原生路径：原生分支会正确地把动作排进 deferred 队列
    if (s._isEmittingAgentSettled === true) return null
    const base = s._baseSystemPromptOptions
    const emitBefore = s._extensionRunner?.emitBeforeAgentStart?.bind(s._extensionRunner)
    const prepare = s._preparePromptAndToolLoadout?.bind(session)
    if (!base || !emitBefore || !prepare) return null
    // 与 prompt() 一致：before_agent_start 先行（能力段在这里并入），随后生成
    // system 补丁并作为请求首消息发出。before_agent_start 的 result.messages
    // （扩展注入的额外消息）worker 侧扩展不使用，这里不带。
    const result = await emitBefore('', undefined, base)
    const options = { ...(result?.systemPromptOptions ?? base) }
    if (typeof s.getActiveToolNames === 'function') options.selectedTools = s.getActiveToolNames()
    const update = prepare(options)
    s._runSystemPromptOptions = options
    return update ? [update, appMessage] : [appMessage]
  } catch {
    return null
  }
}

export async function handleCustomPrompt(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
  const session = st.session
  if (!session) { reply({ type: 'error', error: 'No session' }); return }
  const message = msg.message as
    | { customType?: string; content?: string; display?: boolean; details?: unknown }
    | undefined
  if (!message || typeof message.customType !== 'string' || typeof message.content !== 'string') {
    reply({ type: 'error', error: 'customPrompt requires message.customType & message.content' })
    return
  }
  st.promptSent = true
  const alreadyStreaming = session.isStreaming || st.agentTurnActive
  if (!alreadyStreaming) {
    beginRunIdentity()
    st.agentTurnActive = true
    st.promptPreflightActive = true
    emit({ ...baseEvent(), type: 'run', phase: 'started' })
  }
  reply({ type: 'customPrompt-done' })
  void (async () => {
    try {
      // streaming 中不强制开新轮：SDK 的 triggerTurn 只在空闲时生效，
      // 排队语义默认 followUp，插件可用 options.deliverAs 显式指定
      const opts = (msg.options ?? {}) as { deliverAs?: 'steer' | 'followUp' | 'nextTurn' }
      const appMessage: CustomAppMessage = {
        role: 'custom',
        customType: message.customType as string,
        content: message.content as string,
        display: message.display !== false,
        details: message.details,
      }
      if (alreadyStreaming) {
        await session.sendCustomMessage(appMessage, { deliverAs: opts.deliverAs ?? 'followUp' })
      } else {
        // 空闲首轮流：补 system 准备（见 prepareFirstTurnMessages）；拿不到内部结构
        // 就走原生 sendCustomMessage。两条路的错误都从这里的 await 直达外层 catch。
        const messages = await prepareFirstTurnMessages(session, appMessage)
        if (messages) {
          const run = (session as unknown as { _runAgentPrompt?: (m: unknown[]) => Promise<void> })._runAgentPrompt
          await run!.call(session, messages)
        } else {
          await session.sendCustomMessage(appMessage, { triggerTurn: true })
        }
      }
      if (!alreadyStreaming && st.promptPreflightActive) {
        st.promptPreflightActive = false
        st.agentTurnActive = false
        emit({ ...baseEvent(), type: 'run', phase: 'idle' })
      }
    } catch (e: unknown) {
      console.error('[Worker] customPrompt failed:', e)
      if (st.promptPreflightActive) {
        st.promptPreflightActive = false
        st.agentTurnActive = false
        emit({
          ...baseEvent(),
          type: 'agent_error',
          text: errorMessage(e),
          kind: 'error',
          stopReason: 'error',
        })
        emit({ ...baseEvent(), type: 'run', phase: 'failed' })
      }
    }
  })()
}

export async function handleAbort(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
  const session = st.session
  if (!session) {
    reply({ type: 'abort-done' })
    return
  }
  try {
    session.clearQueue()
    // prompt() is still in preflight (input handlers, routing): pi has no run to abort yet and
    // would start one right after. Abort that run as soon as it starts.
    if (st.promptPreflightActive) st.abortAfterPreflight = true
    await session.abort()
    reply({ type: 'abort-done' })
  } catch (error: unknown) {
    console.error('[Worker] abort failed:', error)
    reply({ type: 'error', error: `abort failed: ${errorMessage(error)}` })
  }
}


export async function handleSteer(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        await st.session?.steer(String(msg.text ?? ''))
        reply({ type: 'steer-done' })
        return
}


export async function handleFollowup(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        if (!st.session) { reply({ type: 'error', error: 'No st.session' }); return }
        reply({ type: 'followUp-done' })
        void st.session.followUp(String(msg.text ?? '')).catch((e: unknown) => {
          console.error('[Worker] followUp failed:', e)
          const errText = errorMessage(e)
          emit({
            ...baseEvent(),
            type: 'agent_error',
            text: errText,
            kind: 'error',
            stopReason: 'error',
          })
        })
        return
}


export async function handleClearqueue(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        if (!st.session) { reply({ type: 'clearQueue-done', steering: [], followUp: [] }); return }
        const cleared = st.session.clearQueue()
        reply({
          type: 'clearQueue-done',
          steering: (cleared.steering || []).map(normalizeUserMessageDisplayText),
          followUp: (cleared.followUp || []).map(normalizeUserMessageDisplayText),
        })
        return
}


export async function handleExtensionUiResponse(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        st.uiBridge?.handleExtensionUIResponse(msg.response as ExtensionUIResponse)
        reply({ type: 'extension-ui-response-done' })
        return
}


export async function handleExtensionUiCancel(
  msg: WorkerIncomingMessage,
  reply: WorkerReply,
): Promise<void> {
  st.uiBridge?.handleExtensionUiCancel(msg.cancel as { id?: string; reason?: string })
  reply({ type: 'extension-ui-cancel-done' })
}


export async function handleDispose(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        st.uiBridge?.dispose()
        st.uiBridge = null
        // Abort in-flight turn before dispose so pi can flush a terminal assistant entry
        // (empty/incomplete leaf) rather than leaving the session unrewindable after force-quit.
        try {
          const streaming = !!(st.agentTurnActive || st.session?.isStreaming)
          if (streaming) {
            try {
              st.session?.clearQueue?.()
            } catch {
              /* ignore */
            }
            if (st.session) await st.session.abort()
          }
        } catch (e) {
          console.error('[Worker] abort-on-dispose failed:', e)
        }
        st.agentTurnActive = false
        st.promptPreflightActive = false
        st.abortAfterPreflight = false
        if (st.unsubscribe) { st.unsubscribe(); st.unsubscribe = null }
        try {
          st.session?.dispose()
        } catch (e) {
          console.error('[Worker] session.dispose failed:', e)
        }
        st.session = null
        st.modelRuntime = null
        st.runtime = null
        reply({ type: 'dispose-done' })
        return
}


export async function handlePing(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        reply({ type: 'pong' })
        return
}

