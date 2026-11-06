import { describe, expect, it } from 'vitest'
import { normalizePluginComposerBar } from './plugin-composer-bar'

/**
 * 托盘的契约测试。这里钉住的不是「校验有多严」，而是**宿主不认识任何插件的业务词汇**：
 * 插件说 running/exited/lost 一律被当成未知值，插件把动作定义成什么 id 都原样保留。
 * 这条如果失守，第二个用托盘的插件就得反过来读后台任务的代码来对齐词表。
 */
describe('normalizePluginComposerBar', () => {
  it('falls back to the visual defaults for business words it does not know', () => {
    const bar = normalizePluginComposerBar({
      summary: 'x',
      tone: 'running',
      rows: [{ id: 'a', label: 'A', state: 'lost' }],
    })
    expect(bar?.tone).toBe('active')
    expect(bar?.rows[0].state).toBe('active')
  })

  it('keeps plugin-defined action ids and only falls back on unknown icons', () => {
    const bar = normalizePluginComposerBar({
      summary: 'x',
      tone: 'ok',
      rows: [
        {
          id: 'a',
          label: 'A',
          state: 'ok',
          actions: [
            { id: 'kill', icon: 'stop', title: '终止' },
            { id: 'retry', icon: 'bogus' },
            { title: '没有 id 的按钮' },
          ],
        },
      ],
    })
    expect(bar?.rows[0].actions).toEqual([{ id: 'kill', icon: 'stop', title: '终止' }, { id: 'retry' }])
  })

  it('drops a field rather than letting a bad value into React', () => {
    const bar = normalizePluginComposerBar({
      summary: 'ok',
      rows: [{ id: '', label: 'no id' }, { id: 'b', label: 'B', state: 'warn' }, 'nonsense'],
    })
    expect(bar?.rows).toHaveLength(1)
    expect(bar?.rows[0]).toMatchObject({ id: 'b', state: 'warn' })
  })

  it('returns null when there is nothing to show', () => {
    expect(normalizePluginComposerBar(null)).toBeNull()
    expect(normalizePluginComposerBar({ summary: '  ', rows: [] })).toBeNull()
  })
})
