import { describe, expect, it } from 'vitest'
import { PLUGIN_MESSAGE_CUSTOM_TYPE } from '@shared/plugin-message'
import {
  normalizeMessages,
  pluginMessageParts,
  pluginMessageText,
  timelineItemsFromBranchPath,
} from './worker-timeline'

/**
 * 插件回报（sessions.send 投递的 custom message）在时间线里的识别。
 *
 * 契约：进模型上下文的消息，界面上也得看得见；但 display:false 的隐藏上下文
 * 只进模型、不进界面，必须挡掉。两条渲染路径（实时流 / 重开会话）判定一致。
 * 来源（origin）随消息落盘在 details，归一化时取回，供界面渲染成转述行。
 */

const ORIGIN = { pluginId: 'background-tasks', label: '后台任务', kind: 'report', detail: 'bg-3' }

function customMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: 'custom',
    customType: PLUGIN_MESSAGE_CUSTOM_TYPE,
    content: '【后台任务回报】bg-3 已完成',
    display: true,
    ...overrides,
  }
}

describe('pluginMessageText', () => {
  it('普通用户消息不识别', () => {
    expect(pluginMessageText({ role: 'user', content: 'hi' })).toBeNull()
  })

  it('其它 customType 不识别（不抢别人的消息）', () => {
    expect(pluginMessageText({ role: 'custom', customType: 'other', content: 'x' })).toBeNull()
  })

  it('display:false 的隐藏上下文不识别', () => {
    expect(pluginMessageText(customMessage({ display: false }))).toBeNull()
  })

  it('字符串与 text block 数组两种 content 都能取到正文', () => {
    expect(pluginMessageText(customMessage())).toBe('【后台任务回报】bg-3 已完成')
    expect(
      pluginMessageText(
        customMessage({ content: [{ type: 'text', text: '第一行' }, { type: 'image' }, { type: 'text', text: '第二行' }] }),
      ),
    ).toBe('第一行\n第二行')
  })
})

describe('pluginMessageParts', () => {
  it('details 里的 origin 原样取出', () => {
    const parts = pluginMessageParts(customMessage({ details: ORIGIN }))
    expect(parts?.text).toBe('【后台任务回报】bg-3 已完成')
    expect(parts?.origin).toEqual(ORIGIN)
  })

  it('details 缺失或形状不对时 origin 为 undefined，正文不受影响', () => {
    expect(pluginMessageParts(customMessage())?.origin).toBeUndefined()
    expect(pluginMessageParts(customMessage({ details: '垃圾数据' }))?.origin).toBeUndefined()
    expect(pluginMessageParts(customMessage({ details: { label: '缺 pluginId' } }))?.origin).toBeUndefined()
    expect(pluginMessageParts(customMessage({ details: { pluginId: 'x', label: '  ' } }))?.origin).toBeUndefined()
  })
})

describe('时间线归一化', () => {
  it('normalizeMessages 把插件回报变成用户位消息', () => {
    const items = normalizeMessages([customMessage()])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'user-message', text: '【后台任务回报】bg-3 已完成' })
  })

  it('归一化带出 origin（两条路径一致），普通用户消息没有 origin', () => {
    for (const normalize of [
      () => normalizeMessages([customMessage({ details: ORIGIN })]),
      () =>
        timelineItemsFromBranchPath([
          { type: 'message', message: customMessage({ details: ORIGIN }), timestamp: Date.now() },
        ]),
    ]) {
      const items = normalize()
      expect(items[0].pluginOrigin).toEqual(ORIGIN)
    }
    const userItems = normalizeMessages([{ role: 'user', content: '我自己说的' }])
    expect(userItems[0].pluginOrigin).toBeUndefined()
  })

  it('隐藏上下文不进时间线', () => {
    const items = normalizeMessages([customMessage({ display: false })])
    expect(items).toHaveLength(0)
  })

  it('分支路径归一化同样识别', () => {
    const items = timelineItemsFromBranchPath([
      { type: 'message', message: customMessage(), timestamp: Date.now() },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'user-message', text: '【后台任务回报】bg-3 已完成' })
  })
})
