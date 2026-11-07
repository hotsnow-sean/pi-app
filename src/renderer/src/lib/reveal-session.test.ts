import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  preview: vi.fn(),
  beginNavigation: vi.fn(() => 1),
  assertNavigation: vi.fn(() => true),
}))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: (...args: unknown[]) => mocks.invoke(...args) ?? Promise.resolve({}) },
}))

vi.mock('@renderer/lib/activate-workspace', () => ({
  previewSessionInPlace: (...args: unknown[]) => mocks.preview(...args),
}))

vi.mock('@renderer/lib/session-navigation', () => ({
  beginSessionNavigation: () => mocks.beginNavigation(),
  assertSessionNavigation: () => mocks.assertNavigation(),
}))

import { revealSessionPreview } from './reveal-session'

/**
 * 插件 `ctx.sessions.reveal` 的 renderer 落地。
 *
 * 与 `openSubagentSessionPreview` 的差别是本文件的全部意义：那条要求目标会话已经出现在
 * 当前时间线的子代理卡片里（顺带维护兄弟导航），而插件的会话来自 RPC 事件载荷，
 * 与当前时间线毫无关系——所以不能走那条，也不能把 `subagentSessionGroup` 留着。
 */
const CURRENT = '/sessions/parent/current.jsonl'
const TARGET = '/sessions/parent/run-1/session.jsonl'

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue({ sessionId: 'child-id', sessionFile: TARGET })
  mocks.preview.mockReset()
  mocks.preview.mockResolvedValue(undefined)
  mocks.beginNavigation.mockClear()
  mocks.assertNavigation.mockReset()
  mocks.assertNavigation.mockReturnValue(true)
  useUIStore.setState({
    historySessionFile: CURRENT,
    subagentSessionGroup: {
      workspacePath: '/ws',
      parentSessionId: 'parent',
      parentSessionFile: CURRENT,
      previewSessionFile: null,
      children: [],
    } as never,
  })
})

describe('reveal session preview', () => {
  it('空路径直接返回 false，不发 IPC', async () => {
    expect(await revealSessionPreview('   ')).toBe(false)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('已经停在这段会话：不重放导航（重放会整轮 capture + hydrate，闪一下）', async () => {
    expect(await revealSessionPreview(CURRENT)).toBe(true)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.preview).not.toHaveBeenCalled()
  })

  it('正常：prepare 后预览，并清掉上一条子代理导航组', async () => {
    expect(await revealSessionPreview(TARGET)).toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('session.prepare', { sessionFile: TARGET, bind: false })
    // 只读预览：bindWorker 由 previewSessionInPlace 内部固定为 false
    expect(mocks.preview).toHaveBeenCalledWith('child-id', TARGET, 1)
    expect(useUIStore.getState().subagentSessionGroup).toBeNull()
  })

  it('prepare 拿不到 sessionId（文件已过期）：false 且不动当前视图', async () => {
    mocks.invoke.mockResolvedValue({})
    expect(await revealSessionPreview(TARGET)).toBe(false)
    expect(mocks.preview).not.toHaveBeenCalled()
    expect(useUIStore.getState().subagentSessionGroup).not.toBeNull()
  })

  it('prepare 抛错：false 而不是把异常冒给插件后台逻辑', async () => {
    mocks.invoke.mockRejectedValue(new Error('boom'))
    expect(await revealSessionPreview(TARGET)).toBe(false)
    expect(mocks.preview).not.toHaveBeenCalled()
  })

  it('prepare 返回规范化后的路径时以它为准（软链 / 大小写差异）', async () => {
    mocks.invoke.mockResolvedValue({ sessionId: 'id', sessionFile: '/real/path/session.jsonl' })
    await revealSessionPreview(TARGET)
    expect(mocks.preview).toHaveBeenCalledWith('id', '/real/path/session.jsonl', 1)
  })

  it('导航已被后续点击取代（navToken 失效）：不预览', async () => {
    mocks.assertNavigation.mockReturnValue(false)
    expect(await revealSessionPreview(TARGET)).toBe(false)
    expect(mocks.preview).not.toHaveBeenCalled()
  })
})
