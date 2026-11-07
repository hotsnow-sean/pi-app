import { describe, expect, it, vi } from 'vitest'
import { createCompletionNotificationController } from './completion-notification-controller'
import type { CompletionEvent } from '@shared/app-events'

function event(partial: Partial<CompletionEvent> = {}): CompletionEvent {
  return {
    type: 'completion',
    outcome: 'success',
    settled: true,
    promptPreview: 'hi',
    responsePreview: 'done',
    durationMs: 10,
    seq: 1,
    workspaceId: '/w',
    sessionId: 's',
    sessionFile: '/w/a.jsonl',
    runId: 'r1',
    timestamp: 1,
    ...partial,
  }
}

describe('completion inbox', () => {
  it('keeps delivered cards for later review', () => {
    vi.useFakeTimers()
    const delivered: unknown[] = []
    const ctrl = createCompletionNotificationController({
      now: () => Date.now(),
      delayMs: 0,
      getSettings: () => ({
        soundEnabled: true,
        notificationEnabled: true,
        alertOnRunIdle: true,
        alertOnBackgroundRunIdle: true,
        alertOnRunFailed: true,
        alertOnCancelled: false,
        timeoutSeconds: 15,
        previewMode: 'response',
        onlyWhenUnfocused: false,
        dndUntil: null,
        delivery: 'custom',
        language: 'zh',
      }),
      getWindowState: () => ({ focused: false, visible: true, minimized: false }),
      getVisibleSessionFile: () => null,
      projectLabel: () => 'proj',
      deliver: (card) => delivered.push(card),
    })
    ctrl.handleCompletion(event())
    vi.runAllTimers()
    expect(ctrl.listInbox()).toHaveLength(1)
    expect(ctrl.listInbox()[0].unread).toBe(true)
    ctrl.markInboxRead(ctrl.listInbox()[0].notificationId)
    expect(ctrl.listInbox()[0].unread).toBe(false)
    vi.useRealTimers()
  })
})

function makeController(win: { focused: boolean; visible: boolean; minimized: boolean }, visible: { file: string | null }) {
  return createCompletionNotificationController({
    now: () => Date.now(),
    delayMs: 0,
    getSettings: () => ({
      soundEnabled: true,
      notificationEnabled: true,
      alertOnRunIdle: true,
      alertOnBackgroundRunIdle: true,
      alertOnRunFailed: true,
      alertOnCancelled: false,
      timeoutSeconds: 15,
      previewMode: 'response',
      onlyWhenUnfocused: false,
      dndUntil: null,
      delivery: 'custom',
      language: 'zh',
    }),
    getWindowState: () => win,
    getVisibleSessionFile: () => visible.file,
    projectLabel: () => 'proj',
    deliver: () => undefined,
  })
}

describe('completion inbox auto-read', () => {
  it('reads the rows of a session when the user opens that conversation', () => {
    vi.useFakeTimers()
    const win = { focused: true, visible: true, minimized: false }
    const visible = { file: '/w/other.jsonl' as string | null }
    const ctrl = makeController(win, visible)
    ctrl.handleCompletion(event({ sessionFile: '/w/a.jsonl', runId: 'r1' }))
    ctrl.handleCompletion(event({ sessionFile: '/w/b.jsonl', runId: 'r2' }))
    vi.runAllTimers()
    expect(ctrl.listInbox().map((c) => c.unread)).toEqual([true, true])

    visible.file = '/w/a.jsonl'
    ctrl.notifyVisibleSessionChanged('/w/a.jsonl')
    const bySession = Object.fromEntries(ctrl.listInbox().map((c) => [c.sessionFile, c.unread]))
    expect(bySession).toEqual({ '/w/a.jsonl': false, '/w/b.jsonl': true })
    vi.useRealTimers()
  })

  it('waits for the window to come back to the front', () => {
    vi.useFakeTimers()
    const win = { focused: false, visible: true, minimized: false }
    const visible = { file: '/w/a.jsonl' as string | null }
    const ctrl = makeController(win, visible)
    ctrl.handleCompletion(event({ sessionFile: '/w/a.jsonl' }))
    vi.runAllTimers()
    expect(ctrl.listInbox()[0].unread).toBe(true)

    ctrl.notifyVisibleSessionChanged('/w/a.jsonl')
    expect(ctrl.listInbox()[0].unread).toBe(true)
    win.focused = true
    ctrl.notifyVisibleSessionChanged('/w/a.jsonl')
    expect(ctrl.listInbox()[0].unread).toBe(false)
    vi.useRealTimers()
  })

  it('files a completion of the conversation on screen as already read', () => {
    vi.useFakeTimers()
    const ctrl = makeController({ focused: true, visible: true, minimized: false }, { file: '/w/a.jsonl' })
    ctrl.handleCompletion(event({ sessionFile: '/w/a.jsonl' }))
    vi.runAllTimers()
    expect(ctrl.listInbox()[0].unread).toBe(false)
    vi.useRealTimers()
  })
})

describe('completion inbox with default alert settings', () => {
  // Defaults: no popup for background runs, popups only while the app is not in front.
  function defaults(win: { focused: boolean; visible: boolean; minimized: boolean }, visible: { file: string | null }, extra: { dndUntil?: number | null } = {}) {
    const delivered: unknown[] = []
    const ctrl = createCompletionNotificationController({
      now: () => Date.now(),
      delayMs: 2000,
      getSettings: () => ({
        soundEnabled: true,
        notificationEnabled: true,
        alertOnRunIdle: true,
        alertOnBackgroundRunIdle: false,
        alertOnRunFailed: true,
        alertOnCancelled: false,
        timeoutSeconds: 15,
        previewMode: 'response',
        onlyWhenUnfocused: true,
        dndUntil: extra.dndUntil ?? null,
        delivery: 'custom',
        language: 'zh',
      }),
      getWindowState: () => win,
      getVisibleSessionFile: () => visible.file,
      projectLabel: () => 'proj',
      deliver: (card) => delivered.push(card),
    })
    return { ctrl, delivered }
  }

  it('files a background completion as unread without a popup', () => {
    vi.useFakeTimers()
    const { ctrl, delivered } = defaults({ focused: true, visible: true, minimized: false }, { file: '/w/other.jsonl' })
    ctrl.handleCompletion(event({ sessionFile: '/w/a.jsonl' }))
    vi.advanceTimersByTime(2000)
    expect(delivered).toHaveLength(0)
    expect(ctrl.listInbox().map((c) => [c.sessionFile, c.unread])).toEqual([['/w/a.jsonl', true]])
    vi.useRealTimers()
  })

  it('files the conversation on screen as read and a muted one without a popup', () => {
    vi.useFakeTimers()
    const onScreen = defaults({ focused: true, visible: true, minimized: false }, { file: '/w/a.jsonl' })
    onScreen.ctrl.handleCompletion(event({ sessionFile: '/w/a.jsonl' }))
    vi.advanceTimersByTime(2000)
    expect(onScreen.delivered).toHaveLength(0)
    expect(onScreen.ctrl.listInbox()[0]?.unread).toBe(false)

    const muted = defaults({ focused: false, visible: true, minimized: false }, { file: '/w/a.jsonl' }, { dndUntil: Date.now() + 60_000 })
    muted.ctrl.handleCompletion(event({ sessionFile: '/w/a.jsonl', runId: 'r2' }))
    vi.advanceTimersByTime(2000)
    expect(muted.delivered).toHaveLength(0)
    expect(muted.ctrl.listInbox()[0]?.unread).toBe(true)
    vi.useRealTimers()
  })

  it('keeps a card the user opened during the grace delay, read and without a popup', () => {
    vi.useFakeTimers()
    const win = { focused: false, visible: true, minimized: false }
    const visible = { file: '/w/other.jsonl' as string | null }
    const { ctrl, delivered } = defaults(win, visible)
    ctrl.handleCompletion(event({ sessionFile: '/w/a.jsonl' }))
    win.focused = true
    visible.file = '/w/a.jsonl'
    ctrl.notifyVisibleSessionChanged('/w/a.jsonl')
    vi.advanceTimersByTime(2000)
    expect(delivered).toHaveLength(0)
    expect(ctrl.listInbox().map((c) => c.unread)).toEqual([false])
    vi.useRealTimers()
  })

  it('leaves cancelled runs out entirely', () => {
    vi.useFakeTimers()
    const { ctrl } = defaults({ focused: false, visible: true, minimized: false }, { file: null })
    ctrl.handleCompletion(event({ outcome: 'cancelled' }))
    vi.advanceTimersByTime(2000)
    expect(ctrl.listInbox()).toHaveLength(0)
    vi.useRealTimers()
  })
})

describe('plugin inbox', () => {
  function makeCtrl(visibleFile: string | null = null) {
    const delivered: unknown[] = []
    const ctrl = createCompletionNotificationController({
      now: () => Date.now(),
      delayMs: 0,
      getSettings: () => ({
        soundEnabled: true,
        notificationEnabled: true,
        alertOnRunIdle: true,
        alertOnBackgroundRunIdle: true,
        alertOnRunFailed: true,
        alertOnCancelled: false,
        timeoutSeconds: 15,
        previewMode: 'response',
        onlyWhenUnfocused: false,
        dndUntil: null,
        delivery: 'custom',
        language: 'zh',
      }),
      getWindowState: () => ({ focused: true, visible: true, minimized: false }),
      getVisibleSessionFile: () => visibleFile,
      projectLabel: () => 'proj',
      deliver: (card) => delivered.push(card),
    })
    return { ctrl, delivered }
  }

  it('进同一个信箱、默认未读、不弹系统通知', () => {
    const { ctrl, delivered } = makeCtrl()
    ctrl.pushPluginInbox('scheduler', {
      title: '定时任务：每日简报',
      body: '有变化：3 条新评论',
      tone: 'success',
      target: { pluginId: 'scheduler', viewId: 'main' },
    })
    const [item] = ctrl.listInbox()
    expect(ctrl.listInbox()).toHaveLength(1)
    expect(item.unread).toBe(true)
    expect(item.copy.title).toBe('定时任务：每日简报')
    expect(item.copy.body).toBe('有变化：3 条新评论')
    expect(item.target).toEqual({ pluginId: 'scheduler', viewId: 'main' })
    expect(item.tone).toBe('success')
    // 插件条目只是「留个记录」，不能走完成卡的弹窗/声音通道
    expect(delivered).toHaveLength(0)
  })

  /**
   * 归属会话的三个作用一次验完：未读判定、条目带上路径、来源插件可辨。
   *
   * 未读这一条最容易漏：插件的子代理/定时任务跑完时，用户可能正看着那段会话——
   * 和自己跑完一轮一样，不该再亮红点。
   */
  it('带 sessionFile 的条目：正看着那段会话时算已读，并记下来源插件', () => {
    const { ctrl } = makeCtrl('c:\\work\\a.jsonl')
    ctrl.pushPluginInbox('subagents', {
      title: '子代理完成',
      // 反斜杠 + 小写盘符：归一化后必须认成同一段会话（否则每次都会亮红点）
      sessionFile: 'C:/work/a.jsonl',
      target: { pluginId: 'subagents', panelId: 'board' },
    })
    const [item] = ctrl.listInbox()
    expect(item.unread).toBe(false)
    expect(item.sessionFile).toBe('C:/work/a.jsonl')
    expect(item.pluginId).toBe('subagents')
    expect(item.target).toEqual({ pluginId: 'subagents', panelId: 'board' })
  })

  it('不在该会话时照常未读；只给 sessionFile 不给 target 也允许', () => {
    const { ctrl } = makeCtrl('C:/work/other.jsonl')
    ctrl.pushPluginInbox('subagents', { title: '子代理完成', sessionFile: 'C:/work/a.jsonl' })
    const [item] = ctrl.listInbox()
    expect(item.unread).toBe(true)
    expect(item.pluginId).toBe('subagents')
    expect(item.target).toBeUndefined()
  })

  it('dedupeKey 命中时替换旧条目并重新变未读', () => {    const { ctrl } = makeCtrl()
    ctrl.pushPluginInbox('scheduler', { title: '第一次', dedupeKey: 'task-1' })
    const first = ctrl.listInbox()[0]
    ctrl.markInboxRead(first.notificationId)
    ctrl.pushPluginInbox('scheduler', { title: '第二次', dedupeKey: 'task-1' })

    expect(ctrl.listInbox()).toHaveLength(1)
    expect(ctrl.listInbox()[0].copy.title).toBe('第二次')
    expect(ctrl.listInbox()[0].unread).toBe(true)
    expect(ctrl.listInbox()[0].notificationId).toBe(first.notificationId)
  })

  it('不同插件/不同 key 互不覆盖；error 观感映射成失败色', () => {
    const { ctrl } = makeCtrl()
    ctrl.pushPluginInbox('a', { title: 'A', dedupeKey: 'x' })
    ctrl.pushPluginInbox('b', { title: 'B', dedupeKey: 'x' })
    ctrl.pushPluginInbox('a', { title: 'A 失败', dedupeKey: 'y', tone: 'error' })
    expect(ctrl.listInbox()).toHaveLength(3)
    const failed = ctrl.listInbox().find((row) => row.copy.title === 'A 失败')
    expect(failed?.outcome).toBe('failed')
    expect(failed?.tone).toBe('error')
  })

  it('没有 title 的条目被丢弃（插件传空不该占格子）', () => {
    const { ctrl } = makeCtrl()
    ctrl.pushPluginInbox('scheduler', { title: '   ' })
    expect(ctrl.listInbox()).toHaveLength(0)
  })
})
