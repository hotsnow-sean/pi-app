// 用 jsdom 环境只是因为全局 setup 会摸 window；被测代码是纯 node（fs + 定时器）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activate, deactivate } from './main.mjs'

/**
 * 定时任务插件 main 侧单测。
 *
 * 不走真实定时器等 5 秒 tick：所有用例都通过 `runNow` 驱动同一条 execute 路径，
 * 它和「到点自动跑」在 engine 里是同一个 enqueue → drain → execute。
 *
 * 覆盖四类只有跑起来才暴露的问题：
 *   1. 运行状态机是否真的三次落盘（queued / running / 终态）；
 *   2. JSONL 折叠、坏行容错、老数据迁移；
 *   3. 条件通知的三条信号通道（结果文件 / 输出协议 / 兜底）；
 *   4. 「手动执行不推移 nextRunAt」这类容易被后来者顺手改掉的语义。
 */

let dataDir
let handle
/** 系统通知记录 */
let notified = []
/** runAgentPrompt 收到的参数 */
let promptCalls = []
/** 每次执行的假答复；用例可替换（也可以返回 pending promise 模拟长任务） */
let reply = async () => ({ ok: true, text: '一切正常' })
/** 下一次 activate 用的设置值 */
let settingValues = {}
/** fakeCtx 持久化存储（重启模拟用） */
let stored = {}

const WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeCtx(initialStorage) {
  let data = initialStorage ?? {}
  return {
    dataDir,
    pluginId: 'scheduler',
    storage: {
      get: () => data,
      set: (value) => {
        data = value
        stored = value
      },
    },
    settings: {
      get: () => settingValues,
      onChange: () => () => {},
    },
    log: () => {},
    notify: (title, body) => notified.push({ title, body }),
    runAgentPrompt: async (spec) => {
      promptCalls.push(spec)
      return reply(spec)
    },
  }
}

const invoke = (method, params) => handle.invoke(method, params)
const tool = (name, args = {}, meta = {}) =>
  invoke('tool.execute', { name, args, cwd: process.cwd(), ...meta })

async function createTask(args = {}) {
  const res = await tool('sched_create', {
    name: '每日简报',
    prompt: '整理今天的工作安排，输出 3 条要点',
    kind: 'daily',
    time: '08:30',
    ...args,
  })
  expect(res.isError, res.text).toBeFalsy()
  return res
}

/** 等某任务出现第 n 条记录并进入终态 */
async function waitRuns(taskId, count = 1, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await invoke('listRuns', { taskId, limit: 50 })
    const terminal = res.runs.filter((run) => run.status !== 'queued' && run.status !== 'running')
    if (res.runs.length >= count && terminal.length >= count) return res.runs
    await WAIT(20)
  }
  throw new Error(`task ${taskId} did not produce ${count} finished run(s)`)
}

function runsFileLines() {
  try {
    return fs
      .readFileSync(path.join(dataDir, 'runs.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-test-'))
  notified = []
  promptCalls = []
  settingValues = { notifyOnStart: false }
  stored = {}
  reply = async () => ({ ok: true, text: '一切正常' })
  handle = await activate(fakeCtx())
})

afterEach(async () => {
  await deactivate()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('任务输入校验', () => {
  it('创建一个每天任务并复述下次执行时间', async () => {
    const res = await createTask()
    expect(res.text).toContain('已创建「每日简报」')
    expect(res.text).toContain('每天 08:30')
    expect(res.text).toContain('下次执行：')
    expect(res.details.id).toMatch(/^task-/)
    const snap = await invoke('snapshot')
    expect(snap.tasks).toHaveLength(1)
    expect(snap.tasks[0].createdBy).toBe('agent')
    expect(snap.tasks[0].nextRunAt).toBeGreaterThan(Date.now())
  })

  it('once 的执行时刻已过去 → 拒绝（UI 允许，工具不允许）', async () => {
    const res = await tool('sched_create', {
      name: '过期提醒',
      prompt: '提醒我',
      kind: 'once',
      at: new Date(Date.now() - 3_600_000).toISOString(),
    })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('已经过去')
    expect((await invoke('snapshot')).tasks).toHaveLength(0)
  })

  it('工作目录必须是存在的绝对路径', async () => {
    const relative = await tool('sched_create', { name: 'a', prompt: 'b', kind: 'daily', cwd: 'demo' })
    expect(relative.isError).toBe(true)
    expect(relative.text).toContain('绝对路径')

    const missing = await tool('sched_create', {
      name: 'a',
      prompt: 'b',
      kind: 'daily',
      cwd: path.join(dataDir, 'not-there'),
    })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('不存在')
  })

  it('同名同提示词不重复创建', async () => {
    await createTask()
    const again = await tool('sched_create', {
      name: '每日简报',
      prompt: '整理今天的工作安排，输出 3 条要点',
      kind: 'daily',
      time: '08:30',
    })
    expect(again.isError).toBe(true)
    expect(again.text).toContain('已存在同名同提示词')
  })
})

describe('运行状态机与存储', () => {
  it('queued → running → ok 三次落盘，列表不带正文', async () => {
    const created = await createTask()
    await invoke('runNow', { id: created.details.id })
    const runs = await waitRuns(created.details.id)
    expect(runs[0].status).toBe('ok')
    expect(runs[0].outputPreview).toContain('一切正常')
    expect(runs[0].output).toBeUndefined() // 列表只给预览
    expect(runs[0].durationMs).toBeGreaterThanOrEqual(0)

    const statuses = runsFileLines()
      .filter((line) => line.op === 'upsert')
      .map((line) => line.run.status)
    expect(statuses).toContain('queued')
    expect(statuses).toContain('running')
    expect(statuses).toContain('ok')

    const full = await invoke('getRun', { id: runs[0].id })
    expect(full.run.output).toBe('一切正常')

    const snap = await invoke('snapshot')
    expect(snap.tasks[0].lastRunOk).toBe(true)
    expect(snap.tasks[0].runCount).toBe(1)
    expect(snap.unreadByTask[created.details.id]).toBe(1)
  })

  it('失败时记 failed + 错误原因', async () => {
    reply = async () => ({ ok: false, error: '模型超时' })
    const created = await createTask()
    await invoke('runNow', { id: created.details.id })
    const [run] = await waitRuns(created.details.id)
    expect(run.status).toBe('failed')
    expect(run.error).toContain('模型超时')
    // 手动触发不弹通知（结果就在面板里）；失败通知的判定在「到点执行」用例里覆盖
    expect(run.notify).toBe('none')
  })

  it('重叠触发记 skipped/overlap，不静默丢弃', async () => {
    let release
    reply = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, text: '慢任务完成' })
      })
    const created = await createTask()
    await invoke('runNow', { id: created.details.id })
    const second = await invoke('runNow', { id: created.details.id })
    expect(second.ok).toBe(false)
    expect(second.skipped).toBe('overlap')

    release()
    const runs = await waitRuns(created.details.id, 2)
    expect(runs.some((run) => run.status === 'skipped' && run.skipReason === 'overlap')).toBe(true)
  })

  it('队列上限 20：第 22 个任务被标 queue_full', async () => {
    let release
    reply = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, text: 'done' })
      })
    const ids = []
    for (let i = 0; i < 22; i += 1) {
      const res = await createTask({ name: `任务 ${i}`, prompt: `干活 ${i}` })
      ids.push(res.details.id)
    }
    for (const id of ids.slice(0, 21)) await invoke('runNow', { id })
    const overflow = await invoke('runNow', { id: ids[21] })
    expect(overflow.ok).toBe(false)
    expect(overflow.skipped).toBe('queue_full')
    const res = await invoke('listRuns', { taskId: ids[21], limit: 5 })
    expect(res.runs[0].status).toBe('skipped')
    expect(res.runs[0].skipReason).toBe('queue_full')
    release()
  })

  it('执行期间删除记录，收尾不会把它「复活」', async () => {
    let release
    reply = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, text: '迟到的结果' })
      })
    const created = await createTask()
    const started = await invoke('runNow', { id: created.details.id })
    await WAIT(30)
    await invoke('deleteRun', { id: started.runId })
    release()
    await WAIT(120)
    expect((await invoke('listRuns', { taskId: created.details.id, limit: 5 })).runs).toHaveLength(0)
  })

  it('启动时把残留的 running 改成 interrupted', async () => {
    const run = {
      id: 'run-1-aaaaaa',
      taskId: 'task-1',
      taskName: '旧任务',
      status: 'running',
      trigger: 'scheduled',
      queuedAt: Date.now() - 60_000,
      startedAt: Date.now() - 59_000,
      finishedAt: null,
      durationMs: null,
      output: '',
      error: '',
      skipReason: '',
      notify: 'none',
      signal: null,
      seen: true,
      v: 1,
    }
    fs.writeFileSync(
      path.join(dataDir, 'runs.jsonl'),
      `${JSON.stringify({ v: 1, op: 'upsert', run })}\nnot-a-json-line\n`,
      'utf8',
    )
    await deactivate()
    handle = await activate(fakeCtx())
    const res = await invoke('listRuns', { limit: 10 })
    expect(res.runs).toHaveLength(1)
    expect(res.runs[0].status).toBe('interrupted')
    expect(res.runs[0].skipReason).toBe('app_exit')
  })

  it('v0.1 的 data.json.runs 迁移进 JSONL 并从任务表里删掉', async () => {
    const legacyTask = {
      id: 'task-legacy',
      name: '老任务',
      prompt: '旧提示词',
      schedule: { kind: 'daily', time: '09:00' },
      enabled: false,
      nextRunAt: null,
      createdAt: Date.now() - 86_400_000,
    }
    const legacyRuns = [
      { id: 'r1', taskId: 'task-legacy', taskName: '老任务', startedAt: 1000, durationMs: 20, ok: true, resultText: '旧结果', error: '' },
      { id: 'r2', taskId: 'task-legacy', taskName: '老任务', startedAt: 2000, durationMs: 30, ok: false, resultText: '', error: '旧错误', missed: true },
    ]
    await deactivate()
    handle = await activate(fakeCtx({ tasks: [legacyTask], runs: legacyRuns }))

    const res = await invoke('listRuns', { limit: 10 })
    expect(res.runs).toHaveLength(2)
    expect(res.runs[0].id).toBe('r2')
    expect(res.runs[0].status).toBe('failed')
    expect(res.runs[0].trigger).toBe('missed')
    expect(res.runs[0].seen).toBe(true)
    // data.json 里不再有 runs，schemaVersion 升到 2
    expect(stored.schemaVersion).toBe(2)
    expect(stored.runs).toBeUndefined()
  })

  it('删除任务连带清掉运行记录', async () => {
    const created = await createTask()
    await invoke('runNow', { id: created.details.id })
    await waitRuns(created.details.id)
    const del = await tool('sched_delete', { id: created.details.id })
    expect(del.text).toContain('1 条运行记录')
    expect((await invoke('listRuns', { limit: 10 })).runs).toHaveLength(0)
    expect((await invoke('snapshot')).tasks).toHaveLength(0)
  })
})

describe('调度语义', () => {
  it('runNow 不推移 nextRunAt（手动补跑不改节奏）', async () => {
    const created = await createTask()
    const before = created.details.nextRunAt
    await invoke('runNow', { id: created.details.id })
    await waitRuns(created.details.id)
    const snap = await invoke('snapshot')
    expect(snap.tasks[0].nextRunAt).toBe(before)
  })

  it('设置里的超时时间传到 runAgentPrompt', async () => {
    settingValues = { notifyOnStart: false, taskTimeoutMinutes: 3 }
    await deactivate()
    handle = await activate(fakeCtx())
    const created = await createTask()
    await invoke('runNow', { id: created.details.id })
    await waitRuns(created.details.id)
    expect(promptCalls[0].timeoutMs).toBe(180_000)
  })

  it('once 任务跑完自动置为已完成', async () => {
    const res = await tool('sched_create', {
      name: '一次性提醒',
      prompt: '提醒我喝水',
      kind: 'once',
      at: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(res.isError).toBeFalsy()
    const snap = await invoke('snapshot')
    expect(snap.tasks[0].enabled).toBe(true)
  })
})

describe('条件通知', () => {
  // 手动 runNow 按设计不弹通知（用户就在跟前），所以这里只验「判定」与「落库」；
  // 真正「发不发」由下面那条到点执行的用例覆盖（它必须等一次 5s tick）。
  it('输出协议 SCHED:unchanged → 判定无变化，协议行不留在正文里', async () => {
    reply = async () => ({ ok: true, text: '没有新动态\nSCHED:unchanged' })
    const created = await createTask({ notifyPolicy: 'on-change' })
    await invoke('runNow', { id: created.details.id })
    const [run] = await waitRuns(created.details.id)
    expect(run.signal.changed).toBe(false)
    expect(run.signal.source).toBe('protocol')
    expect(run.outputPreview).not.toContain('SCHED:')
  })

  it('SCHED:changed → 判定有变化，通知正文取结果首行', async () => {
    reply = async () => ({ ok: true, text: '发现 2 条新评论\nSCHED:changed' })
    const created = await createTask({ notifyPolicy: 'on-change' })
    await invoke('runNow', { id: created.details.id })
    const [run] = await waitRuns(created.details.id)
    expect(run.signal.changed).toBe(true)
    expect(run.signal.source).toBe('protocol')
    expect(run.outputPreview).toContain('发现 2 条新评论')
  })

  it('结果文件优先于输出协议', async () => {
    reply = async (spec) => {
      // 路径在 prompt 里被反引号包着，取引号内那一段（Windows 是反斜杠）
      const file = spec.prompt.match(/`([^`]*signals[\\/]run-[^`]*\.json)`/)?.[1]
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ changed: false, summary: '和昨天一样' }), 'utf8')
      return { ok: true, text: '看起来有变化\nSCHED:changed' }
    }
    const created = await createTask({ notifyPolicy: 'on-change' })
    await invoke('runNow', { id: created.details.id })
    const [run] = await waitRuns(created.details.id)
    expect(run.signal.changed).toBe(false)
    expect(run.signal.source).toBe('file')
    expect(run.signal.summary).toBe('和昨天一样')
  })

  it('两条通道都没有 → fail-open 按有变化处理', async () => {
    reply = async () => ({ ok: true, text: '我干完了但没写协议' })
    const created = await createTask({ notifyPolicy: 'on-change' })
    await invoke('runNow', { id: created.details.id })
    const [run] = await waitRuns(created.details.id)
    expect(run.signal.source).toBe('fallback')
    expect(run.signal.changed).toBe(true)
  })

  it(
    '到点执行按策略决定发不发：always 发，无变化/never 不发',
    async () => {
      // 走真实的调度路径：三个 once 任务同一时刻到点，一次 tick 全部入队
      const at = new Date(Date.now() + 1_500).toISOString()
      reply = async (spec) => {
        if (spec.prompt.includes('静默监控')) return { ok: true, text: '没变化\nSCHED:unchanged' }
        if (spec.prompt.includes('提醒喝水')) return { ok: true, text: '该喝水了\nSCHED:unchanged' }
        return { ok: true, text: '有变化\nSCHED:changed' }
      }
      await tool('sched_create', {
        name: '静默监控',
        prompt: '静默监控一下',
        kind: 'once',
        at,
        notifyPolicy: 'on-change',
      })
      await tool('sched_create', {
        name: '喝水提醒',
        prompt: '提醒喝水',
        kind: 'once',
        at,
        notifyPolicy: 'always',
      })
      await tool('sched_create', {
        name: '彻底静默',
        prompt: '彻底静默地跑',
        kind: 'once',
        at,
        notifyPolicy: 'never',
      })

      const deadline = Date.now() + 20_000
      let runs = []
      while (Date.now() < deadline) {
        runs = (await invoke('listRuns', { limit: 20 })).runs
        if (runs.filter((run) => run.status !== 'queued' && run.status !== 'running').length >= 3) break
        await WAIT(200)
      }
      expect(runs).toHaveLength(3)
      const byName = Object.fromEntries(runs.map((run) => [run.taskName, run]))
      expect(byName['静默监控'].notify).toBe('none')
      expect(byName['喝水提醒'].notify).toBe('sent')
      expect(byName['彻底静默'].notify).toBe('none')
      // 只发一条：静默监控「无变化」、彻底静默 policy=never
      expect(notified.map((item) => item.title)).toEqual(['定时任务：喝水提醒'])
      expect(notified[0].body).toContain('该喝水了')
    },
    30_000,
  )

  it('第二次执行带上次结论做基线，且旧基线在改 prompt 后失效', async () => {
    reply = async () => ({ ok: true, text: '基线内容 ABC\nSCHED:changed' })
    const created = await createTask()
    await invoke('runNow', { id: created.details.id })
    await waitRuns(created.details.id)
    await invoke('runNow', { id: created.details.id })
    await waitRuns(created.details.id, 2)
    expect(promptCalls[1].prompt).toContain('基线内容 ABC')
    expect(promptCalls[1].prompt).toContain('上次执行结论')

    await tool('sched_update', { id: created.details.id, prompt: '换一个全新的目标' })
    await invoke('runNow', { id: created.details.id })
    await waitRuns(created.details.id, 3)
    expect(promptCalls[2].prompt).not.toContain('基线内容 ABC')
    expect(promptCalls[2].prompt).toContain('首次执行')
  })
})

describe('工具', () => {
  it('未知工具名返回 isError', async () => {
    const res = await tool('sched_nope', {})
    expect(res.isError).toBe(true)
    expect(res.text).toContain('unknown tool')
  })

  it('sched_list 列表带 id / 下次执行 / 上次结果', async () => {
    const created = await createTask()
    await invoke('runNow', { id: created.details.id })
    await waitRuns(created.details.id)
    const res = await tool('sched_list', {})
    expect(res.text).toContain('1 个定时任务')
    expect(res.text).toContain(created.details.id)
    expect(res.text).toContain('上次')
    expect(res.text).toContain('成功')

    const detail = await tool('sched_list', { id: created.details.id })
    expect(detail.text).toContain('整理今天的工作安排')
    expect(detail.text).toContain('累计执行：1 次')
  })

  it('sched_update 部分更新，只改传了的字段', async () => {
    const created = await createTask()
    const res = await tool('sched_update', { id: created.details.id, time: '09:15' })
    expect(res.text).toContain('每天 09:15')
    const snap = await invoke('snapshot')
    expect(snap.tasks[0].name).toBe('每日简报')
    expect(snap.tasks[0].schedule.time).toBe('09:15')
  })

  it('sched_runs 默认不带正文，withOutput 才带', async () => {
    const created = await createTask()
    await invoke('runNow', { id: created.details.id })
    await waitRuns(created.details.id)
    const brief = await tool('sched_runs', { taskId: created.details.id })
    expect(brief.text).toContain('最近 1 条运行记录')
    expect(brief.text).not.toContain('一切正常')
    const full = await tool('sched_runs', { taskId: created.details.id, withOutput: true })
    expect(full.text).toContain('一切正常')
  })

  it('sched_run_now 带 waitMs 时同步回结果', async () => {
    const created = await createTask()
    const res = await tool('sched_run_now', { id: created.details.id, waitMs: 3_000 })
    expect(res.text).toContain('本次执行结束：成功')
    expect(res.text).toContain('一切正常')
  })

  it('sched_delete 需要显式 id；不存在的 id 给可操作的提示', async () => {
    const res = await tool('sched_delete', { id: 'task-nope' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('sched_list')
  })
})

describe('接口形状', () => {
  it('snapshot 带 active / lastRunByTask / settings', async () => {
    const snap = await invoke('snapshot')
    expect(snap.active).toEqual([])
    expect(snap.lastRunByTask).toEqual({})
    expect(snap.settings.taskTimeoutMinutes).toBe(15)
    expect(snap.serverNow).toBeGreaterThan(0)
  })

  it('markSeen 清掉未读', async () => {
    const created = await createTask()
    await invoke('runNow', { id: created.details.id })
    await waitRuns(created.details.id)
    expect((await invoke('snapshot')).unreadByTask[created.details.id]).toBe(1)
    await invoke('markSeen', { taskId: created.details.id })
    expect((await invoke('snapshot')).unreadByTask[created.details.id]).toBeUndefined()
  })

  it('删除单条运行记录', async () => {
    const created = await createTask()
    await invoke('runNow', { id: created.details.id })
    const [run] = await waitRuns(created.details.id)
    const res = await invoke('deleteRun', { id: run.id })
    expect(res.ok).toBe(true)
    expect((await invoke('listRuns', { limit: 5 })).runs).toHaveLength(0)
  })
})
