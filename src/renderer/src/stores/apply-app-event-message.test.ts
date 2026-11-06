import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageEvent, StoreApi } from './apply-app-event-types'
import { handleMessage } from './apply-app-event-message'

/**
 * 插件投递消息（sessions.send）的实时入列。
 *
 * 契约：带 pluginOrigin 的事件是「插件说的话」，绝不能与用户乐观行合并——
 * 合并会把用户没打完的草稿替换成回报正文；它以转述行（带 origin 的 user-message）
 * 直接入列，界面据此渲染成与用户气泡不同的样式。
 */

const ORIGIN = { pluginId: 'background-tasks', label: '后台任务', kind: 'report', detail: 'bg-3' }

function makeHarness(items: Array<Record<string, unknown>> = []) {
  const state: Record<string, unknown> & {
    timelineItems: Array<Record<string, unknown>>
    appendTimeline: ReturnType<typeof vi.fn>
    updateTimelineItem: ReturnType<typeof vi.fn>
  } = {
    timelineItems: items,
    runState: { status: 'idle' },
    optimisticPendingUserText: null,
    appendTimeline: vi.fn((item: Record<string, unknown>) => {
      state.timelineItems.push(item)
    }),
    updateTimelineItem: vi.fn((id: string, patch: Record<string, unknown>) => {
      const item = state.timelineItems.find((i) => i.id === id)
      if (item) Object.assign(item, patch)
    }),
    setRunState: vi.fn((r: Record<string, unknown>) => {
      state.runState = { ...(state.runState as Record<string, unknown>), ...r }
    }),
  }
  const api = {
    get: () => state,
    set: (u: Record<string, unknown>) => Object.assign(state, u),
    nextItemId: () => `t-${state.timelineItems.length + 1}`,
  } as unknown as StoreApi & { get: () => typeof state }
  return { state, api: api as StoreApi }
}

function userEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    type: 'message',
    role: 'user',
    phase: 'start',
    seq: 1,
    workspaceId: '/ws',
    timestamp: 1_000,
    text: '正文',
    ...overrides,
  } as MessageEvent
}

describe('handleMessage — 插件转述行', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('带 pluginOrigin 的事件直接入列，带完整 origin', () => {
    const { state, api } = makeHarness()
    handleMessage(userEvent({ pluginOrigin: ORIGIN, text: 'bg-3 已完成' }), api)
    expect(state.appendTimeline).toHaveBeenCalledTimes(1)
    expect(state.timelineItems).toHaveLength(1)
    expect(state.timelineItems[0]).toMatchObject({
      type: 'user-message',
      text: 'bg-3 已完成',
      pluginOrigin: ORIGIN,
    })
  })

  it('带 pluginOrigin 的事件不吞掉用户乐观行草稿', () => {
    const optimistic = { id: 't-1', type: 'user-message', text: '用户正在打的字…' }
    const { state, api } = makeHarness([optimistic])
    state.optimisticPendingUserText = '用户正在打的字…'
    handleMessage(userEvent({ pluginOrigin: ORIGIN }), api)
    // 乐观行保持原样，回报另起新行
    expect(state.updateTimelineItem).not.toHaveBeenCalled()
    expect(state.optimisticPendingUserText).toBe('用户正在打的字…')
    expect(state.timelineItems).toHaveLength(2)
    expect(state.timelineItems[0].text).toBe('用户正在打的字…')
  })

  it('普通用户事件仍走乐观行合并（原行为不变）', () => {
    const optimistic: Record<string, unknown> = { id: 't-1', type: 'user-message', text: 'hi' }
    const { state, api } = makeHarness([optimistic])
    state.optimisticPendingUserText = 'hi'
    handleMessage(userEvent({ text: 'hi', sessionEntryId: 'e-1' }), api)
    expect(state.appendTimeline).not.toHaveBeenCalled()
    expect(optimistic.sessionEntryId).toBe('e-1')
    expect(state.optimisticPendingUserText).toBeNull()
  })
})
