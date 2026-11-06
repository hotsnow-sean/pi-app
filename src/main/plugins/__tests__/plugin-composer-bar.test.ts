import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

const sendEvent = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false }] },
}))

vi.mock('../../ipc/registry', () => ({
  sendEvent: (...args: unknown[]) => sendEvent(...args),
  // electron mock 的 getAllWindows 只有一个假窗口；广播 = 逐窗口 sendEvent，
  // 与真实 broadcastEvent 行为等价（断言只看 sendEvent 的调用次数与内容）
  broadcastEvent: (event: unknown) => sendEvent({ isDestroyed: () => false }, event as never),
}))

import { clearPluginComposerBars, listPluginComposerBars, publishPluginComposerBar } from '../plugin-composer-bar'

/**
 * 托盘状态表：renderer 启动拉取的兜底数据源。
 *
 * 背景：插件激活可能早于 renderer 挂上事件监听，彼时的推送已经丢了——
 * 表现为「重启后面板里有列表、托盘消失」。这里钉住三件事：
 * 推送即入表、null 即出表、停用插件整表收回并广播 null。
 */

function barOf(summary: string) {
  return {
    summary,
    detail: '',
    tone: 'active' as const,
    rows: [],
  }
}

beforeEach(() => {
  sendEvent.mockClear()
})

describe('plugin composer bar registry', () => {
  it('publish 记入状态表并广播事件', () => {
    publishPluginComposerBar('p1', '/ws/a.jsonl', barOf('2 running'))
    expect(listPluginComposerBars()).toEqual([
      { pluginId: 'p1', sessionFile: '/ws/a.jsonl', bar: expect.objectContaining({ summary: '2 running' }) },
    ])
    expect(sendEvent).toHaveBeenCalledTimes(1)
    const event = sendEvent.mock.calls[0][1] as { type: string; pluginId: string; sessionFile: string; bar: unknown }
    expect(event.type).toBe('plugin_widget')
    expect(event.pluginId).toBe('p1')
    expect(event.sessionFile).toBe('/ws/a.jsonl')
  })

  it('publish null 把该会话的托盘移出状态表（仍广播，供在线 renderer 清理）', () => {
    publishPluginComposerBar('p1', '/ws/a.jsonl', barOf('active'))
    publishPluginComposerBar('p1', '/ws/a.jsonl', null)
    expect(listPluginComposerBars()).toEqual([])
    expect(sendEvent).toHaveBeenCalledTimes(2)
    expect((sendEvent.mock.calls[1][1] as { bar: unknown }).bar).toBeNull()
  })

  it('同一插件不同会话互不干扰；null 只清指定会话', () => {
    publishPluginComposerBar('p1', '/ws/a.jsonl', barOf('a'))
    publishPluginComposerBar('p1', '/ws/b.jsonl', barOf('b'))
    publishPluginComposerBar('p1', '/ws/a.jsonl', null)
    expect(listPluginComposerBars().map((x) => x.sessionFile)).toEqual(['/ws/b.jsonl'])
  })

  it('clearPluginComposerBars 整表收回并按会话广播 null', () => {
    publishPluginComposerBar('p1', '/ws/a.jsonl', barOf('a'))
    publishPluginComposerBar('p1', '/ws/b.jsonl', barOf('b'))
    publishPluginComposerBar('p2', '/ws/c.jsonl', barOf('c'))
    sendEvent.mockClear()

    clearPluginComposerBars('p1')

    expect(listPluginComposerBars().map((x) => x.pluginId)).toEqual(['p2'])
    const nulled = sendEvent.mock.calls.map((c) => c[1] as { pluginId: string; bar: unknown })
    expect(nulled).toHaveLength(2)
    expect(nulled.every((e) => e.pluginId === 'p1' && e.bar === null)).toBe(true)
  })

  it('没有 sessionFile 的推送被忽略（不进表也不广播）', () => {
    publishPluginComposerBar('p3', '   ', barOf('nope'))
    expect(listPluginComposerBars().filter((x) => x.pluginId === 'p3')).toEqual([])
    expect(sendEvent).not.toHaveBeenCalled()
  })
})
