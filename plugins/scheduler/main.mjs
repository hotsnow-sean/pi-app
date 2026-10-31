/**
 * 定时任务插件 — main 侧服务。
 *
 * 生命周期：activate(ctx) 启动调度循环；deactivate() 清理定时器。
 * 任务与执行历史存在插件隔离存储（ctx.storage），UI 通过 invoke() 调用本文件暴露的方法。
 *
 * 调度语义：
 * - kind: once / daily / weekly / monthly；time: 'HH:mm'；weekly.weekday(0=周日)；monthly.day(1-31，无该日顺延到存在该日的下月)
 * - 触发：tick 每 5s；到点先推进 nextRunAt 再入队（防重复）
 * - 错过：once 任务错过（应用未运行）→ 启动时补跑一次；重复任务错过 → 顺延到下一个未来时刻，不补跑
 * - 并发：串行执行队列，同一时刻最多跑一个 agent prompt
 */

const TICK_MS = 5_000
const MAX_RUNS = 200
const GRACE_MS = 60_000

let ctx = null
let timer = null
let state = { tasks: [], runs: [] }
const queue = []
let draining = false

// ---------- 存储 ----------

function load() {
  try {
    const data = ctx.storage.get()
    state = {
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      runs: Array.isArray(data.runs) ? data.runs : [],
    }
  } catch {
    state = { tasks: [], runs: [] }
  }
}

function save() {
  ctx.storage.set(state)
}

// ---------- 时间计算 ----------

function atTime(base, h, m) {
  const d = new Date(base)
  d.setHours(h, m, 0, 0)
  return d
}

function nextDaily(from, h, m) {
  const next = atTime(from, h, m)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime()
}

function nextWeekly(from, h, m, weekday) {
  const next = atTime(from, h, m)
  let delta = (weekday - next.getDay() + 7) % 7
  if (delta === 0 && next.getTime() <= from.getTime()) delta = 7
  next.setDate(next.getDate() + delta)
  return next.getTime()
}

function nextMonthly(from, h, m, day) {
  const probe = new Date(from)
  for (let i = 0; i < 48; i++) {
    // 无该日的月份（如 2 月没有 30 号）取当月最后一天
    const lastDay = new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate()
    const anchor = new Date(probe.getFullYear(), probe.getMonth(), Math.min(day, lastDay), h, m, 0, 0)
    if (anchor.getTime() > from.getTime()) return anchor.getTime()
    probe.setMonth(probe.getMonth() + 1)
  }
  // 48 个月都找不到（理论上不可能）——退回一个月后
  return from.getTime() + 30 * 86_400_000
}

/** 计算某任务的下一个执行时刻；null = 不再执行（禁用 / once 已跑 / 超出有效期） */
export function computeNextRun(task, from = new Date()) {
  if (!task.enabled) return null
  const [h, m] = String(task.schedule?.time || '09:00').split(':').map(Number)
  let next
  switch (task.schedule?.kind) {
    case 'daily':
      next = nextDaily(from, h, m)
      break
    case 'weekly':
      next = nextWeekly(from, h, m, Number(task.schedule.weekday ?? 1))
      break
    case 'monthly':
      next = nextMonthly(from, h, m, Number(task.schedule.day ?? 1))
      break
    case 'once':
    default:
      next = task.schedule?.at ? new Date(task.schedule.at).getTime() : null
      if (next !== null && next <= from.getTime()) return null
      break
  }
  if (next === null) return null
  if (task.validUntil) {
    const until = new Date(`${task.validUntil}T23:59:59`).getTime()
    if (Number.isFinite(until) && next > until) return null
  }
  return next
}

function scheduleLabel(task) {
  const s = task.schedule ?? {}
  const time = s.time || '09:00'
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  switch (s.kind) {
    case 'daily':
      return `每天 ${time}`
    case 'weekly':
      return `每${weekdays[Number(s.weekday ?? 1)] ?? '周一'} ${time}`
    case 'monthly':
      return `每月 ${s.day ?? 1} 日 ${time}`
    case 'once':
      return s.at ? `一次 · ${new Date(s.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '一次'
    default:
      return time
  }
}

// ---------- 调度 ----------

function tick() {
  try {
    const now = Date.now()
    let changed = false
    for (const task of state.tasks) {
      if (!task.enabled || task.nextRunAt === null || task.nextRunAt === undefined) continue
      if (task.nextRunAt <= now) {
        enqueue(task, false)
        if (task.schedule?.kind === 'once') {
          task.enabled = false
          task.nextRunAt = null
          task.done = true
        } else {
          task.nextRunAt = computeNextRun(task, new Date(now))
        }
        changed = true
      }
    }
    if (changed) save()
  } catch (error) {
    ctx.log('tick failed:', error)
  }
}

function recoverMissed() {
  const now = Date.now()
  for (const task of state.tasks) {
    if (!task.enabled || task.nextRunAt === null || task.nextRunAt === undefined) continue
    if (task.nextRunAt <= now - GRACE_MS) {
      if (task.schedule?.kind === 'once') {
        // once 错过 → 补跑
        enqueue(task, true)
        task.enabled = false
        task.nextRunAt = null
        task.done = true
        ctx.log(`missed once task "${task.name}", running now`)
      } else {
        // 重复任务错过 → 顺延，不补跑
        task.nextRunAt = computeNextRun(task, new Date(now))
        ctx.log(`missed occurrence of "${task.name}", deferred to next slot`)
      }
    }
  }
  save()
}

function enqueue(task, missed) {
  if (queue.some((q) => q.task.id === task.id)) return
  queue.push({ task, missed })
  void drain()
}

async function drain() {
  if (draining) return
  draining = true
  try {
    while (queue.length > 0) {
      const { task, missed } = queue.shift()
      await execute(task, missed)
    }
  } finally {
    draining = false
  }
}

async function execute(task, missed) {
  const startedAt = Date.now()
  ctx.notify(`定时任务：${task.name}`, missed ? '错过调度，正在补跑' : '任务开始执行')
  let ok = false
  let text = ''
  let error = ''
  try {
    const result = await ctx.runAgentPrompt({
      cwd: task.cwd || '',
      prompt: task.prompt || '',
      timeoutMs: 15 * 60_000,
    })
    if (result.ok) {
      ok = true
      text = result.text
    } else {
      error = result.error
    }
  } catch (e) {
    error = String(e)
  }
  const run = {
    id: `run-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: task.id,
    taskName: task.name,
    startedAt,
    durationMs: Date.now() - startedAt,
    missed: !!missed,
    ok,
    resultText: text ? String(text).slice(0, 20_000) : '',
    error,
  }
  state.runs.unshift(run)
  if (state.runs.length > MAX_RUNS) state.runs.length = MAX_RUNS
  task.lastRunAt = startedAt
  task.lastRunOk = ok
  save()
  ctx.notify(
    `定时任务：${task.name}`,
    ok ? `执行完成，用时 ${Math.round(run.durationMs / 1000)}s` : `执行失败：${error.slice(0, 120)}`,
  )
}

// ---------- invoke 方法（UI 调用） ----------

function publicTask(t) {
  return {
    id: t.id,
    name: t.name,
    prompt: t.prompt,
    schedule: t.schedule,
    scheduleLabel: scheduleLabel(t),
    cwd: t.cwd || '',
    validUntil: t.validUntil || null,
    enabled: !!t.enabled,
    done: !!t.done,
    nextRunAt: t.nextRunAt ?? null,
    lastRunAt: t.lastRunAt ?? null,
    lastRunOk: t.lastRunOk ?? null,
    createdAt: t.createdAt,
  }
}

const methods = {
  async listTasks() {
    return { tasks: state.tasks.map(publicTask), serverNow: Date.now() }
  },
  async saveTask({ task }) {
    if (!task || typeof task !== 'object') throw new Error('task required')
    const now = Date.now()
    let saved = state.tasks.find((t) => t.id === task.id)
    if (!saved) {
      saved = { id: `task-${now}-${Math.random().toString(36).slice(2, 8)}`, createdAt: now }
      state.tasks.push(saved)
    }
    saved.name = String(task.name || '').trim() || '未命名任务'
    saved.prompt = String(task.prompt || '')
    saved.schedule = {
      kind: ['once', 'daily', 'weekly', 'monthly'].includes(task.schedule?.kind) ? task.schedule.kind : 'daily',
      time: /^\d{2}:\d{2}$/.test(task.schedule?.time ?? '') ? task.schedule.time : '09:00',
      weekday: Number.isInteger(task.schedule?.weekday) ? task.schedule.weekday : 1,
      day: Number.isInteger(task.schedule?.day) ? task.schedule.day : 1,
      at: task.schedule?.kind === 'once' && task.schedule?.at ? String(task.schedule.at) : undefined,
    }
    saved.cwd = String(task.cwd || '').trim()
    saved.validUntil = /^\d{4}-\d{2}-\d{2}$/.test(task.validUntil ?? '') ? task.validUntil : null
    saved.enabled = task.enabled !== false
    if (saved.schedule.kind === 'once') {
      saved.schedule.at = saved.schedule.at || new Date(now + 5 * 60_000).toISOString()
      // 创建/编辑时执行时刻已过：不补跑，直接视为已完成
      if (new Date(saved.schedule.at).getTime() <= now) {
        saved.enabled = false
        saved.done = true
        saved.nextRunAt = null
        save()
        return { task: publicTask(saved) }
      }
    }
    saved.nextRunAt = saved.enabled ? computeNextRun(saved, new Date(now)) : null
    saved.done = false
    save()
    return { task: publicTask(saved) }
  },
  async deleteTask({ id }) {
    state.tasks = state.tasks.filter((t) => t.id !== id)
    save()
    return { ok: true }
  },
  async setTaskEnabled({ id, enabled }) {
    const task = state.tasks.find((t) => t.id === id)
    if (!task) throw new Error('task not found')
    task.enabled = enabled !== false
    task.nextRunAt = task.enabled ? computeNextRun(task) : null
    save()
    return { task: publicTask(task) }
  },
  async runNow({ id }) {
    const task = state.tasks.find((t) => t.id === id)
    if (!task) throw new Error('task not found')
    enqueue(task, false)
    return { ok: true }
  },
  async listRuns({ taskId, limit }) {
    const cap = Math.min(Number(limit) || 50, MAX_RUNS)
    const runs = (taskId ? state.runs.filter((r) => r.taskId === taskId) : state.runs).slice(0, cap)
    return { runs }
  },
  async nextRunPreview({ schedule }) {
    const probe = { enabled: true, schedule }
    return { nextRunAt: computeNextRun(probe, new Date()) }
  },
}

// ---------- 生命周期 ----------

export async function activate(pluginContext) {
  ctx = pluginContext
  load()
  recoverMissed()
  timer = setInterval(tick, TICK_MS)
  ctx.log(`scheduler active, ${state.tasks.length} task(s)`)
  return {
    async invoke(method, params) {
      const fn = methods[method]
      if (!fn) throw new Error(`unknown method: ${method}`)
      return fn(params ?? {})
    },
  }
}

export async function deactivate() {
  if (timer) clearInterval(timer)
  timer = null
}
