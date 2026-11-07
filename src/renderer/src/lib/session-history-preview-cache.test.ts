import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import { ipcClient } from '@renderer/lib/ipc-client'
import { clearSessionHistoryCache } from '@renderer/lib/session-history'
import { clearSessionShellForTests, hydrateSessionView } from '@renderer/lib/session-shell'
import type { TimelineItem } from '@renderer/stores/ui-store-types'

/**
 * 预览态（`bindWorker: false`）必须每次重读磁盘。
 *
 * 实测症状：预览一个正在跑的子代理，内容整段不动，直到两分钟后忽然跳一次——
 * `fetchSessionHistoryTail` 的切片缓存 TTL 正好是 120s，而旧逻辑只在「首次读取 /
 * 磁盘权威 / 轮次进行中」才绕过它。预览态不绑定 worker，三个条件全不成立，
 * 于是每次 tail 事件都拿到同一份缓存。
 */
vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: {
    invoke: vi.fn(async (channel: string) =>
      channel === 'session.getMessages'
        ? {
            items: [
              {
                id: 'item-1',
                type: 'assistant-message',
                text: 'hello',
                timestamp: 1,
                sessionEntryId: 'entry-1',
              } satisfies TimelineItem,
            ],
            totalCount: 1,
            sourceCount: 1,
          }
        : {},
    ),
  },
}))

const SESSION = '/tmp/proj/sessions/parent/run-x/run-0/session.jsonl'

function getMessagesCalls(): number {
  return vi.mocked(ipcClient.invoke).mock.calls.filter((c) => c[0] === 'session.getMessages').length
}

beforeEach(() => {
  clearSessionShellForTests()
  clearSessionHistoryCache()
  vi.mocked(ipcClient.invoke).mockClear()
  useUIStore.setState({
    currentWorkspace: '/tmp/proj',
    historySessionFile: SESSION,
    timelineItems: [],
    historyTotalCount: 0,
    historyLoadedCount: 0,
    historyLoading: false,
    streamingAssistantId: null,
    optimisticPendingUserText: null,
    agentTurnBootstrapping: false,
    runState: { status: 'idle' } as never,
    sessionRuntimeRunning: {},
    workerLiveSnapshot: { status: 'idle' } as never,
  })
})

describe('preview hydration vs history slice cache', () => {
  it('预览态重复 hydrate 每次都回源（不吃 2 分钟缓存）', async () => {
    await hydrateSessionView(SESSION, 's1', undefined, { bindWorker: false })
    const afterFirst = getMessagesCalls()
    await hydrateSessionView(SESSION, 's1', undefined, { bindWorker: false })
    expect(getMessagesCalls()).toBe(afterFirst + 1)
  })

  it('普通绑定会话仍然吃缓存（别把每次切会话都变成一次全量读盘）', async () => {
    await hydrateSessionView(SESSION, 's1')
    const afterFirst = getMessagesCalls()
    await hydrateSessionView(SESSION, 's1')
    expect(getMessagesCalls()).toBe(afterFirst)
  })
})
