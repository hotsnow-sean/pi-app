/* 应用入口 UI 的回归测试：jsdom 起一个假宿主，跑真实的 ui/app.js。
   只驱动 DOM 与宿主消息，不碰 main.mjs——这里守的是「分组/时间线/空态/未读」
   这些光看代码看不出来的渲染问题。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installFakeBridge } from '../../../scripts/test-utils/fake-bridge.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'app.js'), 'utf8')
const realSetInterval = window.setInterval.bind(window)
const realSetTimeout = window.setTimeout.bind(window)
const realConfirm = window.confirm.bind(window)

const wait = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

/** 用例可改的宿主状态 */
let tasks = []
let active = []
let lastRunByTask = {}
let unreadByTask = {}
let runs = []
/** 记录 UI 发出的每次 invoke */
let calls = []
let failSave = false
/** 系统确认框被调用了几次——面板必须用自绘的，这里守着别再退回去 */
let systemConfirmCalls = 0

function task(id, extra = {}) {
  return {
    id,
    name: `任务 ${id}`,
    prompt: `提示词 ${id}`,
    schedule: { kind: 'daily', time: '09:00' },
    scheduleLabel: '每天 09:00',
    cwd: '',
    validUntil: null,
    enabled: true,
    done: false,
    nextRunAt: Date.now() + 3_600_000,
    lastRunAt: null,
    lastRunOk: null,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 86_400_000,
    createdBy: 'user',
    runCount: 0,
    notifyPolicy: null,
    notifyPolicyLabel: '有变化才通知',
    hasBaseline: false,
    ...extra,
  }
}

function run(id, taskId, extra = {}) {
  const finishedAt = Date.now() - 60_000
  return {
    id,
    taskId,
    taskName: `任务 ${taskId}`,
    status: 'ok',
    trigger: 'scheduled',
    queuedAt: finishedAt - 1000,
    startedAt: finishedAt - 900,
    finishedAt,
    durationMs: 900,
    cwd: '',
    promptPreview: 'p',
    error: '',
    skipReason: '',
    notify: 'sent',
    notifyLabel: '',
    signal: { changed: true, source: 'protocol', summary: '有变化' },
    seen: true,
    outputPreview: '结果预览',
    hasOutput: true,
    ...extra,
  }
}

const listenerTargets = [window, document].map((target) => ({
  target,
  realAdd: target.addEventListener.bind(target),
  realRemove: target.removeEventListener.bind(target),
  added: [],
}))

function isolateListeners() {
  for (const entry of listenerTargets) {
    entry.added = []
    entry.target.addEventListener = (type, handler, opts) => {
      entry.added.push([type, handler, opts])
      entry.realAdd(type, handler, opts)
    }
  }
}

function removeListeners() {
  for (const entry of listenerTargets) {
    for (const [type, handler, opts] of entry.added) entry.realRemove(type, handler, opts)
    entry.added = []
    entry.target.addEventListener = entry.realAdd
  }
}

async function waitFor(check, label) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (check()) return
    await wait(10)
  }
  throw new Error(`超时：${label}`)
}

function installHost() {
  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || data.type !== 'plugin-invoke') return
    const { requestId, method, params } = data
    calls.push({ method, params })
    let result = {}
    if (method === 'snapshot') {
      result = {
        tasks: tasks.map((item) => ({ ...item })),
        active: active.map((item) => ({ ...item })),
        lastRunByTask,
        unreadByTask,
        serverNow: Date.now(),
        limits: { maxTasks: 50, maxRuns: 200 },
        settings: {
          taskTimeoutMinutes: 15,
          historyLimit: 30,
          defaultNotifyPolicy: 'on-change',
          defaultCwd: '',
          notifyOnStart: true,
        },
      }
    } else if (method === 'listRuns') {
      const filtered = runs
        .filter((item) => !params?.taskId || item.taskId === params.taskId)
        .filter((item) => {
          const status = params?.status
          if (!status) return true
          if (status === 'active') return item.status === 'queued' || item.status === 'running'
          return item.status === status
        })
      result = { runs: filtered.map((item) => ({ ...item })), total: filtered.length }
    } else if (method === 'getRun') {
      const found = runs.find((item) => item.id === params.id)
      result = { run: { ...found, output: `完整正文 ${params.id}` } }
    } else if (method === 'markSeen') {
      if (params?.taskId) delete unreadByTask[params.taskId]
      else unreadByTask = {}
      result = { changed: 1 }
    } else if (method === 'runNow') {
      result = { ok: true, runId: 'run-new', skipped: null, status: 'queued' }
    } else if (method === 'setTaskEnabled') {
      const target = tasks.find((item) => item.id === params.id)
      if (target) target.enabled = params.enabled
      result = { task: target }
    } else if (method === 'deleteTask') {
      tasks = tasks.filter((item) => item.id !== params.id)
      runs = runs.filter((item) => item.taskId !== params.id)
      result = { ok: true, runCount: 1 }
    } else if (method === 'saveTask') {
      if (failSave) {
        setTimeout(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { type: 'plugin-invoke-result', requestId, ok: false, error: '工作目录不存在：C:\\nope' },
            }),
          )
        }, 0)
        return
      }
      const saved = task(params.task.id ?? 't-new', { ...params.task, name: params.task.name })
      tasks = [...tasks, saved]
      result = { task: saved }
    } else if (method === 'nextRunPreview') {
      result = { nextRunAt: Date.now() + 7_200_000, scheduleLabel: '每天 09:00' }
    } else if (method === 'getMemory') {
      result = {
        id: params.id,
        name: '任务 t1',
        text: '# 定时任务记忆：任务 t1\n\n## 长期备注\n- 基线 comments=0\n\n## 执行记录\n- 2026-11-07 11:02 成功 · 无变化 · 没新评论\n',
        chars: 100,
        exists: true,
        records: 1,
      }
    } else if (method === 'saveMemory') {
      result = { ok: true, text: params.text }
    } else if (method === 'clearMemory') {
      result = { ok: true }
    }
    realSetTimeout(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'plugin-invoke-result', requestId, ok: true, result },
        }),
      )
    }, 0)
  })
}

function loadUi() {
  new Function(source)()
}

function cards() {
  return [...document.querySelectorAll('#app .task-card')].map((el) => el.dataset.id)
}

/** 点自绘确认框里的按钮（弹窗挂在 body 上，不在 #app 内） */
function clickConfirm(which = 'ok') {
  const button = document.querySelector(`.confirm-overlay [data-confirm="${which}"]`)
  if (!button) throw new Error('确认框没有出现')
  button.click()
}

beforeEach(() => {
  tasks = []
  active = []
  lastRunByTask = {}
  unreadByTask = {}
  runs = []
  calls = []
  failSave = false
  document.body.className = ''
  document.body.innerHTML = '<div id="app"></div>'
  // 轮询不是这组用例的对象；关掉它，所有重绘都由动作驱动
  window.setInterval = () => 0
  // 面板自己画确认框；真有代码退回 window.confirm 时用计数抓出来
  systemConfirmCalls = 0
  window.confirm = () => {
    systemConfirmCalls++
    return true
  }
  isolateListeners()
  // 桥由宿主下发，UI 只认 window.pi；这里装一个替身（真桥有独立单测）
  installFakeBridge()
  installHost()
})

afterEach(() => {
  removeListeners()
  window.setInterval = realSetInterval
  window.setTimeout = realSetTimeout
  window.confirm = realConfirm
})

describe('应用入口 UI', () => {
  it('左列按 执行中 / 已启用 / 已停用 分组，已启用按下次执行升序', async () => {
    tasks = [
      task('late', { nextRunAt: Date.now() + 7_200_000 }),
      task('soon', { nextRunAt: Date.now() + 600_000 }),
      task('off', { enabled: false, nextRunAt: null }),
    ]
    active = [{ runId: 'r-live', taskId: 'live', taskName: '任务 live', status: 'running', queuedAt: Date.now(), startedAt: Date.now() }]
    tasks.push(task('live'))
    loadUi()
    await waitFor(() => cards().length === 4, '渲染出四张卡')

    const groups = [...document.querySelectorAll('#app .group-head')].map((el) => el.textContent.trim())
    expect(groups[0]).toContain('执行中')
    expect(groups[1]).toContain('已启用')
    expect(groups[2]).toContain('已停用')
    // 执行中排最前，其余按 nextRunAt 升序
    expect(cards()).toEqual(['live', 'soon', 'late', 'off'])
  })

  it('执行中的卡片显示耗时，且不再提供「立即运行」', async () => {
    tasks = [task('live')]
    active = [{ runId: 'r-live', taskId: 'live', taskName: '任务 live', status: 'running', queuedAt: Date.now() - 5000, startedAt: Date.now() - 5000 }]
    loadUi()
    await waitFor(() => document.querySelector('#app .task-card'), '卡片出现')
    const card = document.querySelector('#app .task-card')
    expect(card.className).toContain('is-active')
    expect(card.textContent).toContain('执行中')
    expect(card.querySelector('[data-elapsed]')).not.toBeNull()
    expect(card.querySelector('[data-act="run"]')).toBeNull()
  })

  it('点击任务打开详情：显示下次执行、提示词与按日分组的运行记录', async () => {
    tasks = [task('t1', { runCount: 2 })]
    runs = [
      run('r-today', 't1', { notify: 'sent' }),
      run('r-yesterday', 't1', {
        finishedAt: Date.now() - 86_400_000,
        queuedAt: Date.now() - 86_400_000,
        startedAt: Date.now() - 86_400_000,
        status: 'failed',
        error: '模型超时',
        notify: 'sent',
      }),
    ]
    loadUi()
    await waitFor(() => cards().length === 1, '列表出现')
    document.querySelector('#app .task-card').click()
    await waitFor(() => document.querySelector('#app .detail-title'), '详情出现')

    const detail = document.querySelector('#app .col-detail')
    expect(detail.textContent).toContain('下次执行')
    expect(detail.textContent).toContain('提示词 t1')
    const days = [...detail.querySelectorAll('.tl-day')].map((el) => el.textContent.trim())
    expect(days).toEqual(['今天', '昨天'])
    expect(detail.textContent).toContain('失败')
  })

  it('未通知的记录直接显示插件算好的原因，不用自己推断', async () => {
    tasks = [task('t1')]
    runs = [
      run('r-never', 't1', { notify: 'none', notifyWhy: 'never', notifyLabel: '从不通知（策略）' }),
      run('r-same', 't1', {
        notify: 'none',
        notifyWhy: 'unchanged',
        notifyLabel: '无变化（策略不提示）',
        signal: { changed: false, source: 'protocol', summary: '没变化' },
      }),
    ]
    loadUi()
    await waitFor(() => cards().length === 1, '列表出现')
    document.querySelector('#app .task-card').click()
    await waitFor(() => document.querySelector('#app .tl-row'), '时间线出现')
    const detail = document.querySelector('#app .col-detail')
    expect(detail.textContent).toContain('从不通知（策略）')
    expect(detail.textContent).toContain('无变化（策略不提示）')
  })

  it('展开一条记录才拉全文，再点一次收起', async () => {
    tasks = [task('t1')]
    runs = [run('r1', 't1')]
    loadUi()
    await waitFor(() => cards().length === 1, '列表出现')
    document.querySelector('#app .task-card').click()
    await waitFor(() => document.querySelector('#app .tl-row'), '时间线出现')

    document.querySelector('#app .tl-line').click()
    await waitFor(() => document.querySelector('#app .tl-body'), '正文展开')
    expect(document.querySelector('#app .tl-body').textContent).toContain('完整正文 r1')
    expect(calls.some((call) => call.method === 'getRun' && call.params.id === 'r1')).toBe(true)

    document.querySelector('#app .tl-line').click()
    await waitFor(() => !document.querySelector('#app .tl-body'), '正文收起')
  })

  it('空态给三个可一键预填的模板，点击进编辑页而不是直接创建', async () => {
    loadUi()
    await waitFor(() => document.querySelectorAll('#app .template').length === 3, '模板出现')
    document.querySelector('#app .template').click()
    await waitFor(() => document.querySelector('#app #f-name'), '编辑页出现')
    expect(document.querySelector('#app #f-name').value).toBe('每日简报')
    expect(document.querySelector('#app #f-prompt').value).toContain('整理今天的工作安排')
    // 只预填，不落库
    expect(calls.some((call) => call.method === 'saveTask')).toBe(false)
  })

  it('未读角标可见，点开任务后标已读', async () => {
    tasks = [task('t1')]
    unreadByTask = { t1: 2 }
    loadUi()
    await waitFor(() => document.querySelector('#app .unread'), '未读角标出现')
    expect(document.querySelector('#app .unread').textContent.trim()).toBe('2')
    document.querySelector('#app .task-card').click()
    await waitFor(() => calls.some((call) => call.method === 'markSeen'), '发出已读标记')
    await waitFor(() => !document.querySelector('#app .unread'), '角标消失')
  })

  it('运行记录页的筛选会把状态传给 listRuns', async () => {
    tasks = [task('t1')]
    runs = [run('r1', 't1'), run('r2', 't1', { status: 'failed', error: '炸了' })]
    loadUi()
    await waitFor(() => document.querySelector('#app [data-nav="runs"]'), '顶栏出现')
    document.querySelector('#app [data-nav="runs"]').click()
    await waitFor(() => document.querySelector('#app .runs-page'), '运行记录页出现')
    expect(document.querySelectorAll('#app .tl-row').length).toBe(2)

    document.querySelector('#app [data-filter="failed"]').click()
    await waitFor(
      () => calls.filter((call) => call.method === 'listRuns').some((call) => call.params.status === 'failed'),
      '按失败筛选',
    )
  })

  it('详情里可以展开、编辑、保存并清空任务记忆', async () => {
    tasks = [task('t1', { hasMemory: true, memoryRecords: 1 })]
    loadUi()
    await waitFor(() => document.querySelector('#app .task-card'), '列表出现')
    document.querySelector('#app .task-card').click()
    await waitFor(() => document.querySelector('#app #btn-memory'), '记忆按钮出现')
    expect(document.querySelector('#app .memory-count').textContent).toContain('1 条执行记录')

    document.querySelector('#app #btn-memory').click()
    await waitFor(() => document.querySelector('#app .memory-body'), '记忆正文出现')
    expect(document.querySelector('#app .memory-body').textContent).toContain('基线 comments=0')

    document.querySelector('#app #btn-memory-edit').click()
    await waitFor(() => document.querySelector('#app #memory-draft'), '编辑框出现')
    const draft = document.querySelector('#app #memory-draft')
    draft.value = '## 长期备注\n- 人工补一条事实\n'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#app #btn-memory-save').click()
    await waitFor(
      () => calls.some((call) => call.method === 'saveMemory' && call.params.text.includes('人工补一条事实')),
      '保存记忆',
    )

    document.querySelector('#app #btn-memory-clear').click()
    await waitFor(() => document.querySelector('.confirm-overlay'), '确认框出现')
    clickConfirm('ok')
    await waitFor(() => calls.some((call) => call.method === 'clearMemory'), '清空记忆')
    expect(systemConfirmCalls).toBe(0)
  })

  it('清空记忆要二次确认，点取消就不发请求', async () => {
    tasks = [task('t1', { hasMemory: true, memoryRecords: 1 })]
    loadUi()
    await waitFor(() => document.querySelector('#app .task-card'), '列表出现')
    document.querySelector('#app .task-card').click()
    await waitFor(() => document.querySelector('#app #btn-memory'), '记忆按钮出现')
    document.querySelector('#app #btn-memory').click()
    await waitFor(() => document.querySelector('#app #btn-memory-clear'), '清空按钮出现')

    document.querySelector('#app #btn-memory-clear').click()
    await waitFor(() => document.querySelector('.confirm-overlay'), '确认框出现')
    clickConfirm('cancel')
    await wait(30)
    expect(document.querySelector('.confirm-overlay')).toBeNull()
    expect(calls.some((call) => call.method === 'clearMemory')).toBe(false)
  })

  it('删除任务用面板自己的确认框：取消不删，确认才删', async () => {
    tasks = [task('t1'), task('t2')]
    loadUi()
    await waitFor(() => document.querySelector('#app .task-card'), '列表出现')

    document.querySelector('#app .task-card [data-act="delete"]').click()
    await waitFor(() => document.querySelector('.confirm-overlay'), '确认框出现')
    expect(document.querySelector('.confirm-title').textContent).toContain('删除任务')
    expect(document.querySelector('[data-confirm="ok"]').classList.contains('danger')).toBe(true)

    clickConfirm('cancel')
    await wait(30)
    expect(calls.some((call) => call.method === 'deleteTask')).toBe(false)
    expect(cards()).toEqual(['t1', 't2'])

    document.querySelector('#app .task-card [data-act="delete"]').click()
    await waitFor(() => document.querySelector('.confirm-overlay'), '确认框再次出现')
    clickConfirm('ok')
    await waitFor(() => calls.some((call) => call.method === 'deleteTask'), '发删除请求')
    expect(calls.find((call) => call.method === 'deleteTask').params.id).toBe('t1')
    expect(systemConfirmCalls).toBe(0)
  })

  it('编辑记忆时轮询不重建输入框：焦点和正在写的内容都保住', async () => {
    // 这条必须让轮询真的跑：把长 delay 压到 20ms（只在本用例内生效）
    window.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 2_000 ? 20 : ms, ...args)
    tasks = [task('t1', { hasMemory: true, memoryRecords: 1 })]
    loadUi()
    await waitFor(() => document.querySelector('#app .task-card'), '列表出现')
    document.querySelector('#app .task-card').click()
    await waitFor(() => document.querySelector('#app #btn-memory'), '记忆按钮出现')
    document.querySelector('#app #btn-memory').click()
    await waitFor(() => document.querySelector('#app .memory-body'), '记忆正文出现')
    document.querySelector('#app #btn-memory-edit').click()
    await waitFor(() => document.querySelector('#app #memory-draft'), '编辑框出现')

    const draft = document.querySelector('#app #memory-draft')
    draft.value = '## 长期备注\n- 正在输入的内容\n'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    draft.focus()

    // 编辑期间有任务跑完：签名变化（memoryRecords 1 → 2）
    tasks = [task('t1', { hasMemory: true, memoryRecords: 2, runCount: 2 })]
    const before = calls.filter((call) => call.method === 'snapshot').length
    await waitFor(() => calls.filter((call) => call.method === 'snapshot').length > before + 1, '轮询跑过两轮')

    const still = document.querySelector('#app #memory-draft')
    expect(still).toBe(draft) // 同一个元素，没被重建
    expect(still.value).toContain('正在输入的内容')
    expect(document.activeElement).toBe(still)

    // 退出编辑后恢复重绘，计数跟得上
    document.querySelector('#app #btn-memory-cancel').click()
    await waitFor(() => document.querySelector('#app .memory-count').textContent.includes('2 条'), '计数更新')
  })

  it('保存失败时把错误显示在表单里，不静默吞掉', async () => {
    failSave = true
    tasks = [task('t1')]
    loadUi()
    await waitFor(() => cards().length === 1, '列表出现')
    document.querySelector('#app .task-card').click()
    await waitFor(() => document.querySelector('#app .detail-title'), '详情出现')
    document.querySelector('#app .col-detail [data-act="edit"]').click()
    await waitFor(() => document.querySelector('#app #btn-save'), '编辑页出现')
    document.querySelector('#app #btn-save').click()
    await waitFor(() => {
      const box = document.querySelector('#app #form-error')
      return box && !box.hidden
    }, '错误可见')
    expect(document.querySelector('#app #form-error').textContent).toContain('工作目录不存在')
  })
})
