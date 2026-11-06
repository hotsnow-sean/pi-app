// @ts-check
/**
 * 运行状态机与记录裁剪。
 *
 * 状态：queued → running → ok | failed；旁路有 skipped（重叠/队列满）与
 * interrupted（应用退出，启动时扫描补记）。**每次状态变化都落盘**——崩溃后还能
 * 看出「上次中断在哪个任务」，这是纯内存态做不到的。
 *
 * 这里只管记录本身，不负责执行、不负责通知：engine.mjs 驱动状态，notify.mjs 决定
 * 要不要打扰用户，methods/tools 只读。
 */
import fs from 'node:fs'
import path from 'node:path'

import { pathToFileURL } from 'node:url'
// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析（jsdom 会打补丁）
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(path.join(import.meta.dirname, `${name}.mjs`)).href + Q)

const { rt, log, MAX_RUNS, OUTPUT_LIMIT, PREVIEW_CHARS } = await imp('runtime')
const { appendRun, appendDelete, runsSorted } = await imp('store')
const { oneLine } = await imp('format')

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8)
}

/**
 * 入队即建记录：用户点「立即运行」后立刻能看到「排队中」，不用等执行到它。
 * @param {any} task
 * @param {'scheduled' | 'missed' | 'manual'} trigger
 */
export function newRun(task, trigger) {
  const now = Date.now()
  const run = {
    id: `run-${now}-${randomSuffix()}`,
    taskId: task.id,
    taskName: task.name,
    status: 'queued',
    trigger,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    cwd: String(task.cwd || rt.settings.defaultCwd || ''),
    promptPreview: oneLine(task.prompt, 200),
    output: '',
    error: '',
    skipReason: '',
    notify: 'none',
    signal: null,
    seen: false,
    v: 1,
  }
  rt.runs.set(run.id, run)
  appendRun(run)
  return run
}

/** @param {any} run */
export function markRunning(run) {
  run.status = 'running'
  run.startedAt = Date.now()
  appendRun(run)
}

/**
 * 建一条「没跑」的记录。重叠触发与队列满是用户可见的事实，不能静默丢弃——
 * 否则连点两次「立即运行」的人会以为跑了两遍。
 * @param {any} task
 * @param {'scheduled' | 'missed' | 'manual'} trigger
 * @param {'overlap' | 'queue_full' | 'disabled' | 'app_exit'} reason
 */
export function skipRun(task, trigger, reason) {
  const now = Date.now()
  const run = {
    id: `run-${now}-${randomSuffix()}`,
    taskId: task.id,
    taskName: task.name,
    status: 'skipped',
    trigger,
    queuedAt: now,
    startedAt: null,
    finishedAt: now,
    durationMs: 0,
    cwd: String(task.cwd || rt.settings.defaultCwd || ''),
    promptPreview: oneLine(task.prompt, 200),
    output: '',
    error: '',
    skipReason: reason,
    notify: 'none',
    signal: null,
    seen: false,
    v: 1,
  }
  rt.runs.set(run.id, run)
  appendRun(run)
  return run
}

/**
 * 收尾：唯一写终态的地方。
 * @param {any} run
 * @param {{ status: 'ok' | 'failed', output?: string, error?: string, signal?: any, notify?: string }} patch
 */
export function finishRun(run, patch) {
  const finishedAt = Date.now()
  run.status = patch.status
  run.finishedAt = finishedAt
  run.durationMs = run.startedAt ? finishedAt - run.startedAt : 0
  run.output = String(patch.output ?? '').slice(0, OUTPUT_LIMIT)
  run.error = String(patch.error ?? '')
  run.signal = patch.signal ?? null
  run.notify = patch.notify ?? 'none'
  run.seen = false
  appendRun(run)
  return run
}

/**
 * 启动扫描：上一次进程里停在 queued / running 的记录一律改成 interrupted。
 * 这是唯一的僵尸兜底——内存态一重启就没了，磁盘上的状态才认得出来。
 */
export function recoverInterrupted() {
  let count = 0
  for (const run of rt.runs.values()) {
    if (run.status !== 'queued' && run.status !== 'running') continue
    run.status = 'interrupted'
    run.finishedAt = Date.now()
    run.durationMs = run.startedAt ? run.finishedAt - run.startedAt : 0
    run.skipReason = 'app_exit'
    run.seen = false
    appendRun(run)
    count += 1
  }
  if (count > 0) log(`marked ${count} unfinished run(s) as interrupted`)
  return count
}

/**
 * 裁剪：每个任务保留 historyLimit 条，全局再兜 MAX_RUNS。
 * 老记录是墓碑删除（不重写文件），到阈值时 store 自动压缩。
 * @param {string} [taskId] 刚跑完的任务，只用于日志
 */
export function pruneRuns(taskId) {
  const perTask = Math.max(1, Math.round(Number(rt.settings.historyLimit) || 30))
  /** @type {Map<string, any[]>} */
  const byTask = new Map()
  for (const run of rt.runs.values()) {
    const list = byTask.get(run.taskId) ?? []
    list.push(run)
    byTask.set(run.taskId, list)
  }
  let removed = 0
  for (const list of byTask.values()) {
    list.sort((a, b) => b.queuedAt - a.queuedAt)
    for (let i = perTask; i < list.length; i += 1) {
      rt.runs.delete(list[i].id)
      appendDelete(list[i].id)
      removed += 1
    }
  }
  if (rt.runs.size > MAX_RUNS) {
    const all = runsSorted().slice(MAX_RUNS)
    for (const run of all) {
      rt.runs.delete(run.id)
      appendDelete(run.id)
      removed += 1
    }
  }
  if (removed > 0) log(`pruned ${removed} old run(s)${taskId ? ` (task ${taskId})` : ''}`)
}

/** @param {string} id */
export function removeRun(id) {
  if (!rt.runs.has(id)) return false
  rt.runs.delete(id)
  appendDelete(id)
  return true
}

/** 删任务时连带清掉它的全部记录 */
export function removeRunsOfTask(taskId) {
  const ids = [...rt.runs.values()].filter((run) => run.taskId === taskId).map((run) => run.id)
  for (const id of ids) {
    rt.runs.delete(id)
    appendDelete(id)
  }
  return ids.length
}

/** 排队中/执行中的记录（UI 左列「执行中」组） */
export function activeRuns() {
  return [...rt.runs.values()]
    .filter((run) => run.status === 'queued' || run.status === 'running')
    .sort((a, b) => a.queuedAt - b.queuedAt)
}

/** 某任务是否已在排队/执行（重叠判定） */
export function isBusy(taskId) {
  for (const run of rt.runs.values()) {
    if (run.taskId !== taskId) continue
    if (run.status === 'queued' || run.status === 'running') return true
  }
  return false
}

/** @param {string} taskId */
export function lastRunOf(taskId) {
  let latest = null
  for (const run of rt.runs.values()) {
    if (run.taskId !== taskId) continue
    if (!latest || run.queuedAt > latest.queuedAt) latest = run
  }
  return latest
}

/** 未读计数：只看终态记录，排队中不算「有新结果」 */
export function unreadCounts() {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const run of rt.runs.values()) {
    if (run.seen) continue
    if (run.status === 'queued' || run.status === 'running') continue
    counts[run.taskId] = (counts[run.taskId] || 0) + 1
  }
  return counts
}

/**
 * 标已读：打开任务详情 / 运行记录页时调用。
 * @param {{ ids?: string[], taskId?: string }} spec
 */
export function markSeen(spec) {
  const ids = Array.isArray(spec?.ids) ? new Set(spec.ids.map(String)) : null
  const taskId = spec?.taskId ? String(spec.taskId) : ''
  let changed = 0
  for (const run of rt.runs.values()) {
    if (run.seen) continue
    // ids 优先；只给 taskId 就只标这个任务；两个都不给 = 全部标已读（运行记录总览）
    if (ids) {
      if (!ids.has(run.id)) continue
    } else if (taskId && run.taskId !== taskId) {
      continue
    }
    run.seen = true
    appendRun(run)
    changed += 1
  }
  return changed
}

/**
 * 列表视图：不带正文，只回预览。用户点开某条再 getRun 拉全文。
 * @param {any} run
 */
export function publicRun(run) {
  return {
    id: run.id,
    taskId: run.taskId,
    taskName: run.taskName,
    status: run.status,
    trigger: run.trigger,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    cwd: run.cwd,
    promptPreview: run.promptPreview,
    error: run.error,
    skipReason: run.skipReason,
    notify: run.notify,
    signal: run.signal,
    seen: run.seen,
    outputPreview: oneLine(run.output, PREVIEW_CHARS),
    hasOutput: run.output.length > 0,
  }
}

/** 全文视图（含 output）。100KB 级的记录也只在点开单条时走这条 */
export function fullRun(run) {
  return { ...publicRun(run), output: run.output }
}

/**
 * 等某条记录进入终态（工具 sched_run_now 的 waitMs 用）。
 * 不阻塞事件循环之外的执行：drain 在同一个 tick 循环里推进。
 * @param {string} id
 * @param {number} timeoutMs
 */
export async function waitForRun(id, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 30_000))
  while (Date.now() < deadline) {
    const run = rt.runs.get(id)
    if (!run) return null
    if (run.status !== 'queued' && run.status !== 'running') return run
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return rt.runs.get(id) ?? null
}

/** 信号文件目录：runId → `<dataDir>/signals/<runId>.json`（agent 可选写入） */
export function signalPath(runId) {
  return path.join(rt.signalDir, `${runId}.json`)
}

/**
 * 清掉 24 小时前的信号文件：agent 写完没被读（例如记录被删）时不会永久堆积。
 * 只按修改时间扫目录，不依赖任务表。
 */
export function sweepSignals() {
  if (!rt.signalDir) return 0
  let names = []
  try {
    names = fs.readdirSync(rt.signalDir)
  } catch {
    return 0
  }
  const cutoff = Date.now() - 86_400_000
  let removed = 0
  for (const name of names) {
    const file = path.join(rt.signalDir, name)
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true })
        removed += 1
      }
    } catch {
      /* 并发删除 / 权限问题：下一轮再试 */
    }
  }
  if (removed > 0) log(`swept ${removed} stale signal file(s)`)
  return removed
}

// 排序函数定义在 store（它才是记录表的持有者），这里转出去给 methods/tools 用，
// 免得调用方为了拿一个排序去直接依赖存储层
export { runsSorted }

