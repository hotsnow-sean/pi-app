import { describe, expect, it } from 'vitest'
import { isDerivedChildSessionFile, planInboxJump, resolveInboxTargetAction } from './plugin-inbox-target'

/**
 * 信箱落点：右栏优先、面板缺位时回落中央视图。
 *
 * 背景：`ctx.ui.inbox` 的 `target` 原本只能跳中央视图，插件就得「为了看一眼
 * 而顶掉整页」。加 `panelId` 之后，回落规则成了唯一的坑——插件升级删了面板、
 * 用户禁用了面板，都会让 `panelId` 指空，此时必须还能落到 `viewId`。
 *
 * 第二个坑（实测踩到）：manifest 写的是局部 id，目录存的是完整 id。解析结果必须是
 * **完整 id**，否则组件拿局部 id 去 `setActivePanel`，右栏会亮但停在别的页签。
 */
describe('plugin inbox target', () => {
  /** 模拟宿主：把局部 id 补成 `plugin:<插件>:<面板>`，目录里没有就返回 null */
  const registry = (ids: string[]) => (local: string) => {
    const global = `plugin:p:${local}`
    return ids.includes(global) ? global : null
  }

  it('面板存在 → 开右栏，且返回完整 id（局部 id 会落到别的页签）', () => {
    expect(resolveInboxTargetAction({ pluginId: 'p', viewId: 'board', panelId: 'fleet' }, registry(['plugin:p:fleet'])))
      .toEqual({ kind: 'panel', panelId: 'plugin:p:fleet' })
  })

  it('面板不存在 → 回落中央视图', () => {
    expect(resolveInboxTargetAction({ pluginId: 'p', viewId: 'board', panelId: 'fleet' }, registry([])))
      .toEqual({ kind: 'center', pluginId: 'p', viewId: 'board' })
  })

  it('只给 viewId（旧插件）→ 中央视图', () => {
    expect(resolveInboxTargetAction({ pluginId: 'p', viewId: 'board' }, registry(['plugin:p:fleet'])))
      .toEqual({ kind: 'center', pluginId: 'p', viewId: 'board' })
  })

  it('只给 panelId 且存在 → 右栏', () => {
    expect(resolveInboxTargetAction({ pluginId: 'p', panelId: 'fleet' }, registry(['plugin:p:fleet'])))
      .toEqual({ kind: 'panel', panelId: 'plugin:p:fleet' })
  })

  it('panelId 空串当作没给（插件拼模板时常见），不拿空 id 去查目录', () => {
    const seen: string[] = []
    expect(
      resolveInboxTargetAction({ pluginId: 'p', viewId: 'board', panelId: '  ' }, (id) => {
        seen.push(id)
        return `plugin:p:${id}`
      }),
    ).toEqual({ kind: 'center', pluginId: 'p', viewId: 'board' })
    expect(seen).toEqual([])
  })

  it('两个都没有 → none（组件据此提示「点不开」而不是静默关闭）', () => {
    expect(resolveInboxTargetAction({ pluginId: 'p' }, registry([]))).toEqual({ kind: 'none' })
    expect(resolveInboxTargetAction(undefined, registry([]))).toEqual({ kind: 'none' })
  })

  it('panelId 不存在且无 viewId → none', () => {
    expect(resolveInboxTargetAction({ pluginId: 'p', panelId: 'gone' }, registry([]))).toEqual({ kind: 'none' })
  })
})

/**
 * 子会话识别：决定「只读预览」还是「切项目正常打开」。
 *
 * 实测反馈是「中间回到了 A，但左侧高亮没动、也没输入框」——A 当时在另一个项目里，
 * 当前项目列表找不到它，代码就整体退化成只读预览。普通会话该切项目；只有子代理的
 * `run-<i>/session.jsonl` 才该只读预览（它本来就不属于侧栏）。
 */
describe('derived child session detection', () => {
  it('run-<i>/session.jsonl 认作子会话（正反斜杠都行）', () => {
    expect(isDerivedChildSessionFile('C:/p/.pi/sessions/x/abc/run-0/session.jsonl')).toBe(true)
    expect(isDerivedChildSessionFile('C:\\p\\.pi\\sessions\\x\\abc\\run-12\\session.jsonl')).toBe(true)
  })

  it('普通会话文件不是子会话', () => {
    expect(isDerivedChildSessionFile('C:/p/.pi/sessions/x/2026-11-07T04-56-18Z_abc.jsonl')).toBe(false)
    expect(isDerivedChildSessionFile('C:/p/run-0/other.jsonl')).toBe(false)
    expect(isDerivedChildSessionFile('')).toBe(false)
    expect(isDerivedChildSessionFile(null)).toBe(false)
  })
})

/**
 * 会话优先的两条规则。
 *
 * 起因是实测反馈：「右栏面板点了不跳」「点信箱只跳到插件页，我的对话没了」。
 * 结论是右栏与会话绑死——插件条目必须能先把人送回去，面板只是叠加。
 */
describe('plugin inbox jump plan', () => {
  it('只给会话 → 只跳会话，不碰插件落点', () => {
    expect(planInboxJump(true, { kind: 'none' })).toEqual({ jumpSession: true, empty: false })
  })

  it('会话 + 右栏面板 → 先回会话，再亮面板（右栏是会话的附属物）', () => {
    expect(planInboxJump(true, { kind: 'panel', panelId: 'plugin:p:fleet' })).toEqual({
      jumpSession: true,
      panelId: 'plugin:p:fleet',
      empty: false,
    })
  })

  it('会话 + 中央视图 → 忽略视图（否则刚打开的会话立刻被插件页顶掉）', () => {
    expect(planInboxJump(true, { kind: 'center', pluginId: 'p', viewId: 'board' })).toEqual({
      jumpSession: true,
      empty: false,
    })
  })

  it('没有会话时：中央视图照常打开', () => {
    expect(planInboxJump(false, { kind: 'center', pluginId: 'p', viewId: 'board' })).toEqual({
      jumpSession: false,
      center: { pluginId: 'p', viewId: 'board' },
      empty: false,
    })
  })

  it('没有会话也没有落点 → empty（UI 提示打不开）', () => {
    expect(planInboxJump(false, { kind: 'none' })).toEqual({ jumpSession: false, empty: true })
  })
})
