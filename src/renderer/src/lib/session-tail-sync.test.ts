import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  tailHandler: null as null | ((payload: { sessionFile: string; size: number; truncated: boolean }) => void),
  detach: vi.fn(),
  hydrate: vi.fn(),
  clearCache: vi.fn(),
}))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: (...args: unknown[]) => mocks.invoke(...args) ?? Promise.resolve({}) },
  onSessionTail: (callback: never) => {
    mocks.tailHandler = callback
    return mocks.detach
  },
}))

vi.mock('@renderer/lib/session-shell', () => ({
  hydrateSessionView: (...args: unknown[]) => mocks.hydrate(...args),
}))

vi.mock('@renderer/lib/session-history', () => ({
  clearSessionHistoryCache: (...args: unknown[]) => mocks.clearCache(...args),
}))

import { unwatchSessionTail, watchSessionTail, watchedSessionTailFile } from './session-tail-sync'

/**
 * 预览会话的文件监听（renderer 侧）。
 *
 * 这里最容易错的两点：
 * ①事件是按窗口广播的 —— 用户已经切走的会话不能把内容刷进当前视图；
 * ②换目标时要先订新的再退旧的，反过来会有一段「静止期」。
 */
const FILE_A = '/sessions/parent/run-a/session.jsonl'
const FILE_B = '/sessions/parent/run-b/session.jsonl'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(async () => {
  await unwatchSessionTail()
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue({ ok: true })
  mocks.detach.mockReset()
  mocks.hydrate.mockReset()
  mocks.hydrate.mockResolvedValue(undefined)
  mocks.clearCache.mockReset()
  mocks.tailHandler = null
  useUIStore.setState({
    historySessionFile: FILE_A,
    currentSessionId: 'session-a',
  })
})

describe('session tail sync', () => {
  it('watch 会向 main 订阅并记住目标', async () => {
    await watchSessionTail(FILE_A)
    expect(mocks.invoke).toHaveBeenCalledWith('session.tail.subscribe', { sessionFile: FILE_A })
    expect(watchedSessionTailFile()).toBe(FILE_A)
  })

  it('同一文件重复 watch 不重复订阅（切回预览会再调一次）', async () => {
    await watchSessionTail(FILE_A)
    await watchSessionTail(FILE_A)
    expect(mocks.invoke.mock.calls.filter((c) => c[0] === 'session.tail.subscribe')).toHaveLength(1)
  })

  it('文件变化且正在看它：重读磁盘尾巴（不绑定 worker）', async () => {
    await watchSessionTail(FILE_A)
    mocks.tailHandler?.({ sessionFile: FILE_A, size: 120, truncated: false })
    await flush()
    expect(mocks.hydrate).toHaveBeenCalledWith(FILE_A, 'session-a', undefined, { bindWorker: false })
  })

  // 磁盘已经变了就必须作废切片缓存：那份 TTL 是 2 分钟，否则「跑着的子代理」会冻在
  // 打开那一刻，只有等缓存过期才跳一次（实测症状）。
  it('文件变化时作废这段会话的切片缓存', async () => {
    await watchSessionTail(FILE_A)
    mocks.tailHandler?.({ sessionFile: FILE_A, size: 120, truncated: false })
    await flush()
    expect(mocks.clearCache).toHaveBeenCalledWith(FILE_A)
  })

  it('别的会话变化不作废当前缓存（事件按窗口广播）', async () => {
    await watchSessionTail(FILE_A)
    mocks.tailHandler?.({ sessionFile: FILE_B, size: 120, truncated: false })
    await flush()
    expect(mocks.clearCache).not.toHaveBeenCalled()
  })

  it('文件变化但用户已切走：不刷当前视图（事件是按窗口广播的）', async () => {
    await watchSessionTail(FILE_A)
    mocks.tailHandler?.({ sessionFile: FILE_B, size: 120, truncated: false })
    await flush()
    expect(mocks.hydrate).not.toHaveBeenCalled()
  })

  it('当前没有会话：忽略', async () => {
    useUIStore.setState({ historySessionFile: null, currentSessionId: null })
    await watchSessionTail(FILE_A)
    mocks.tailHandler?.({ sessionFile: FILE_A, size: 1, truncated: false })
    await flush()
    expect(mocks.hydrate).not.toHaveBeenCalled()
  })

  it('换目标：先订新的再退旧的', async () => {
    await watchSessionTail(FILE_A)
    mocks.invoke.mockClear()
    await watchSessionTail(FILE_B)
    const order = mocks.invoke.mock.calls.map((c) => c[0])
    expect(order).toEqual(['session.tail.subscribe', 'session.tail.unsubscribe'])
    expect(mocks.invoke.mock.calls[1]![1]).toEqual({ sessionFile: FILE_A })
  })

  it('truncated 事件同样触发重读（整段重来由 renderer 自己决定）', async () => {
    await watchSessionTail(FILE_A)
    mocks.tailHandler?.({ sessionFile: FILE_A, size: 10, truncated: true })
    await flush()
    expect(mocks.hydrate).toHaveBeenCalledTimes(1)
  })

  it('快速连续切换：订阅/退订不会交叉（否则会把刚订上的又退掉）', async () => {
    const first = watchSessionTail(FILE_A)
    const second = watchSessionTail(FILE_B)
    await Promise.all([first, second])
    const order = mocks.invoke.mock.calls.map((c) => c[0])
    expect(order).toEqual([
      'session.tail.subscribe',
      'session.tail.subscribe',
      'session.tail.unsubscribe',
    ])
    expect(mocks.invoke.mock.calls[2]![1]).toEqual({ sessionFile: FILE_A })
    expect(watchedSessionTailFile()).toBe(FILE_B)
  })

  it('unwatch：退订并摘掉事件监听', async () => {
    await watchSessionTail(FILE_A)
    mocks.invoke.mockClear()
    await unwatchSessionTail()
    expect(mocks.invoke).toHaveBeenCalledWith('session.tail.unsubscribe', { sessionFile: FILE_A })
    expect(mocks.detach).toHaveBeenCalled()
    expect(watchedSessionTailFile()).toBeNull()
  })

  it('没有 watch 时 unwatch 不发 IPC', async () => {
    mocks.invoke.mockClear()
    await unwatchSessionTail()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
