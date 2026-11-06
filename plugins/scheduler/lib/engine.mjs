// @ts-check
/**
 * 调度引擎：tick → 入队 → 串行执行 → 收尾。
 *
 * 语义与 v0.1 保持一致（到点先推进 nextRunAt 再入队、once 补跑、重复任务顺延、
 * 串行队列），这一轮只补三件用户能看见的事：
 *   - 入队即产生 queued 记录（「点了立即运行没反应」是最差的交互）；
 *   - 重叠触发记 skipped/overlap，不再静默丢弃；
 *   - 执行过程（running 态 + 实时耗时）对 UI 可见。
 *
 * 执行仍然是 `ctx.runAgentPrompt` 起的 inMemory 会话：跑完就 dispose，历史不落会话。
 * 这是宿主现状（没传 extensions，拿不到插件工具），不是本插件的实现选择。
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析（jsdom 会打补丁）
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(path.join(import.meta.dirname, `${name}.mjs`)).href + Q)

const { rt, log, isLive, GRACE_MS, QUEUE_LIMIT, BASELINE_CHARS } = await imp('runtime')
const { computeNextRun } = await imp('schedule')
const { saveTasks } = await imp('store')
const { newRun, markRunning, skipRun, finishRun, pruneRuns, isBusy } = await imp('runs')
const {
  buildPrompt,
  readSignal,
  parseToken,
  stripToken,
  decideNotify,
  notifySkipReason,
  notifyStarted,
  notifyFinished,
  sendInbox,
  notifyQueueFull,
} = await imp('notify')
const { oneLine } = await imp('format')

/** 单任务超时：设置项可调（长活如构建 15 分钟不够），上限 120 分钟 */
function timeoutMs() {
  const minutes = Number(rt.settings.taskTimeoutMinutes)
  const safe = Number.isFinite(minutes) ? Math.min(120, Math.max(1, minutes)) : 15
  return safe * 60_000
}

/**
 * 到点扫描（每 5s）。
 * 先推进 nextRunAt 再入队（v0.1 的既有顺序）：tick 抖动或执行卡住都不会重复触发。
 */
export function tick() {
  if (!isLive()) return
  try {
    const now = Date.now()
    let changed = false
    for (const task of rt.state.tasks) {
      if (!task.enabled || task.nextRunAt === null || task.nextRunAt === undefined) continue
      if (task.nextRunAt > now) continue
      enqueue(task, 'scheduled')
      if (task.schedule?.kind === 'once') {
        task.enabled = false
        task.nextRunAt = null
        task.done = true
      } else {
        task.nextRunAt = computeNextRun(task, new Date(now))
      }
      changed = true
    }
    if (changed) saveTasks()
  } catch (error) {
    log('tick failed:', error)
  }
}

/**
 * 启动补跑：once 错过就补一次；重复任务只顺延，不补——一小时一次的任务关机一夜，
 * 早上弹八条「补跑」没有意义。
 */
export function recoverMissed() {
  if (!isLive()) return
  const now = Date.now()
  let changed = false
  for (const task of rt.state.tasks) {
    if (!task.enabled || task.nextRunAt === null || task.nextRunAt === undefined) continue
    if (task.nextRunAt > now - GRACE_MS) continue
    if (task.schedule?.kind === 'once') {
      enqueue(task, 'missed')
      task.enabled = false
      task.nextRunAt = null
      task.done = true
      log(`missed once task "${task.name}", running now`)
    } else {
      task.nextRunAt = computeNextRun(task, new Date(now))
      log(`missed occurrence of "${task.name}", deferred to next slot`)
    }
    changed = true
  }
  if (changed) saveTasks()
}

/**
 * 入队。
 * @param {any} task
 * @param {'scheduled' | 'missed' | 'manual'} trigger
 * @returns {{ run: any | null, skipped: string | null }}
 */
export function enqueue(task, trigger) {
  if (!isLive()) return { run: null, skipped: 'offline' }
  if (isBusy(task.id)) {
    const run = skipRun(task, trigger, 'overlap')
    return { run, skipped: 'overlap' }
  }
  if (rt.queue.length >= QUEUE_LIMIT) {
    skipRun(task, trigger, 'queue_full')
    notifyQueueFull(task)
    return { run: null, skipped: 'queue_full' }
  }
  const run = newRun(task, trigger)
  rt.queue.push({ task, trigger, runId: run.id })
  void drain()
  return { run, skipped: null }
}

/** 串行队列：同一时刻只跑一个 prompt（宿主资源有限，并发跑会互相拖死） */
export async function drain() {
  if (rt.draining) return
  const gen = rt.gen
  rt.draining = true
  try {
    while (rt.queue.length > 0 && rt.gen === gen) {
      const item = rt.queue.shift()
      if (!item) break
      try {
        await execute(item, gen)
      } catch (error) {
        // 单条执行异常不能卡死队列：后面排队的任务还得跑（记录停在 running 也会被
        // 下次启动扫成 interrupted，不会永远转圈）
        log(`run ${item.runId} crashed`, error)
      }
    }
  } finally {
    // 停用/重载换代时不要抢新一代码的 drain 锁
    if (rt.gen === gen) rt.draining = false
  }
}

/**
 * 执行一次并收尾。
 *
 * `gen` 是激活代数：runAgentPrompt 可能跑十几分钟，期间插件被停用/热重载，
 * 返回时这一代已经不该再写盘、发通知了（写入会落到新一代的数据目录里）。
 * @param {{ task: any, trigger: string, runId: string }} item
 * @param {number} gen
 */
async function execute(item, gen) {
  const run = rt.runs.get(item.runId)
  if (!run) return
  const task = item.task
  markRunning(run)
  notifyStarted(task, item.trigger)

  let result
  try {
    result = await rt.ctx.runAgentPrompt({
      cwd: task.cwd || rt.settings.defaultCwd || '',
      prompt: buildPrompt(task, run.id),
      timeoutMs: timeoutMs(),
    })
  } catch (error) {
    // runAgentPrompt 自己会兜错；走到这里说明是更外层的意外（ctx 被回收等）
    result = { ok: false, error: String(error) }
  }
  if (rt.gen !== gen || !rt.live) {
    log(`run ${run.id} finished after deactivate, result dropped`)
    return
  }
  // 执行期间用户把这条记录（或整个任务）删了：收尾只更新任务统计，不再落记录，
  // 否则 appendRun 会把刚删掉的记录「复活」出来
  if (!rt.runs.has(run.id)) {
    log(`run ${run.id} was deleted while running, result dropped`)
    return
  }

  const sessionOk = !!result.ok
  const rawText = sessionOk ? String(result.text ?? '') : ''
  const fileSignal = readSignal(run.id)
  const token = parseToken(rawText)
  // agent 自报失败（`SCHED:failed: 原因`）：会话跑完了，但任务目标没达成。
  // 这与「会话异常」是两种失败，记录里都算 failed，区别是自报的还带正文。
  const selfFailed = token?.kind === 'failed'
  const ok = sessionOk && !selfFailed
  // 判定优先级：结果文件 > 输出协议 > 兜底（按有变化处理，宁可多打扰一次）
  const changed = fileSignal ? fileSignal.changed : token?.kind === 'unchanged' ? false : true
  const source = fileSignal ? 'file' : token ? 'protocol' : 'fallback'
  const output = stripToken(rawText)
  const summary = fileSignal?.summary || oneLine(output, 120)
  const decision = decideNotify(task, { ok, changed })
  const manual = item.trigger === 'manual'
  const willSend = decision.send && !manual

  finishRun(run, {
    status: ok ? 'ok' : 'failed',
    // 自报失败时正文就是诊断线索，必须留着；会话级异常（超时/崩）本来就没正文
    output,
    error: ok
      ? ''
      : selfFailed
        ? token.reason || oneLine(output, 200) || '任务自报失败'
        : String(result.error || '未知错误'),
    signal: { changed, source, summary },
    notify: willSend ? 'sent' : 'none',
    // 未通知也要记原因：否则「没有标注」会被读成「通知过了」
    notifyWhy: willSend ? '' : notifySkipReason({ policy: decision.policy, ok, changed, manual }),
  })

  task.lastRunAt = run.startedAt
  task.lastRunOk = ok
  task.runCount = (Number(task.runCount) || 0) + 1
  // 只在成功时更新基线：失败留下的半截结论/报错不能当成「上次的样子」
  if (ok) task.baseline = { text: output.slice(0, BASELINE_CHARS), at: run.finishedAt, runId: run.id }
  saveTasks()
  pruneRuns(task.id)

  // 两条通道各自成败：系统通知可能被系统设置吞掉，信箱是站内兜底
  if (decision.send) {
    notifyFinished(task, run)
    sendInbox(task, run)
  }
}
