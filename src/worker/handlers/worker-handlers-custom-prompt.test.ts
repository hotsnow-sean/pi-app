import { afterEach, describe, expect, it } from 'vitest'
import { PLUGIN_MESSAGE_CUSTOM_TYPE, type PluginMessageOrigin } from '@shared/plugin-message'
import { handleCustomPrompt } from './worker-handlers-turn'
import { st } from '../worker-runtime'

/**
 * ctx.sessions.send 的 worker 端：向宿主会话投递带来源标注的 custom message。
 *
 * 关键契约：
 * - 空闲时驱动完整一轮（原生路径 triggerTurn，或补齐 system 后走 _runAgentPrompt）
 * - streaming 中不强制开新轮（deliverAs 默认 followUp 排队）
 * - details（origin）原样透传——渲染层靠它画转述行
 */

const origin: PluginMessageOrigin = {
  pluginId: 'background-tasks',
  label: '后台任务',
  kind: 'report',
  detail: 'bg-3 编译 120 个模块',
}

const originalSession = st.session
const originalAgentTurnActive = st.agentTurnActive
const originalPreflight = st.promptPreflightActive

afterEach(() => {
  st.session = originalSession
  st.agentTurnActive = originalAgentTurnActive
  st.promptPreflightActive = originalPreflight
})

type CustomMessage = { customType: string; content: string; display: boolean; details?: unknown }
type CustomOptions = { triggerTurn?: boolean; deliverAs?: string }

function makeSession(overrides: Partial<{ isStreaming: boolean; error: Error }> = {}) {
  const calls: Array<{ message: CustomMessage; options?: CustomOptions }> = []
  const session = {
    isStreaming: overrides.isStreaming ?? false,
    sendCustomMessage: async (message: CustomMessage, options?: CustomOptions) => {
      if (overrides.error) throw overrides.error
      calls.push({ message, options })
    },
  }
  return { session, calls }
}

async function run(msg: Record<string, unknown>) {
  const replies: Array<Record<string, unknown>> = []
  await handleCustomPrompt({ type: 'customPrompt', ...msg } as never, (payload) => replies.push(payload))
  return replies
}

describe('handleCustomPrompt', () => {
  it('空闲会话：驱动一轮，origin 原样透传', async () => {
    const { session, calls } = makeSession()
    st.session = session as never
    st.agentTurnActive = false
    st.promptPreflightActive = false

    const replies = await run({
      message: { customType: PLUGIN_MESSAGE_CUSTOM_TYPE, content: '回报', display: true, details: origin },
    })

    expect(replies).toEqual([{ type: 'customPrompt-done' }])
    expect(calls).toHaveLength(1)
    expect(calls[0].message).toMatchObject({
      customType: PLUGIN_MESSAGE_CUSTOM_TYPE,
      content: '回报',
      display: true,
      details: origin,
    })
    // mock 会话拿不到 SDK 内部结构 → 退回原生路径，由 SDK 自己 triggerTurn
    expect(calls[0].options).toEqual({ triggerTurn: true })
  })

  it('streaming 中：不 triggerTurn，排队语义默认 followUp', async () => {
    const { session, calls } = makeSession({ isStreaming: true })
    st.session = session as never

    const replies = await run({
      message: { customType: PLUGIN_MESSAGE_CUSTOM_TYPE, content: '插话' },
    })

    expect(replies).toEqual([{ type: 'customPrompt-done' }])
    expect(calls[0].options).toEqual({ deliverAs: 'followUp' })
  })

  it('streaming 中：显式 deliverAs 优于此处默认', async () => {
    const { session, calls } = makeSession({ isStreaming: true })
    st.session = session as never

    await run({ message: { customType: 'x', content: '插话' }, options: { deliverAs: 'steer' } })
    expect(calls[0].options).toEqual({ deliverAs: 'steer' })
  })

  it('缺 customType 或 content 直接报错，不碰会话', async () => {
    const { session, calls } = makeSession()
    st.session = session as never

    const noType = await run({ message: { content: 'hi' } })
    const noContent = await run({ message: { customType: 'x' } })
    const noMessage = await run({})
    expect(noType[0]).toMatchObject({ type: 'error' })
    expect(noContent[0]).toMatchObject({ type: 'error' })
    expect(noMessage[0]).toMatchObject({ type: 'error' })
    expect(calls).toHaveLength(0)
  })

  it('投递抛错：错误上报且状态复位，reply 不丢', async () => {
    const { session } = makeSession({ error: new Error('model down') })
    st.session = session as never
    st.agentTurnActive = false
    st.promptPreflightActive = false

    const replies = await run({ message: { customType: PLUGIN_MESSAGE_CUSTOM_TYPE, content: '回报' } })
    expect(replies).toEqual([{ type: 'customPrompt-done' }])
    // 错误经 emit 上报；这里验证不因异常把 reply 搞丢、状态复位
    expect(st.promptPreflightActive).toBe(false)
    expect(st.agentTurnActive).toBe(false)
  })
})
