// @ts-check
/**
 * agent 工具（sched_*）：参数映射 → 调 methods → 组织成模型读得懂的话。
 *
 * 这一层不直接改 state：所有写操作都走 methods（与 UI 同一条路径、同一份校验），
 * 否则「UI 允许保存已过去的一次性任务、工具应该报错」这类差异会散落两处。
 *
 * 文案的三条硬规矩：
 *   1. **必须复述下次执行的本地时间**。模型自己算「明天 8:30」经常算错星期/跨月，
 *      复述一遍就把错误暴露在对话里，用户当场能纠。
 *   2. 失败返回 `{ text, isError: true }`，不抛异常——抛了宿主会包成
 *      `sched_create failed: ...`，模型看不清是哪一步。
 *   3. 列表用小表格文本，不贴 JSON。
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析（jsdom 会打补丁）
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(path.join(import.meta.dirname, `${name}.mjs`)).href + Q)

const { rt } = await imp('runtime')
const { normalizeTaskInput } = await imp('task-input')
const { methods, publicTask } = await imp('methods')
const { runsSorted, publicRun } = await imp('runs')
const { describeNext, fmtWhen, fmtDuration, statusText, skipText, triggerText, oneLine } = await imp('format')

function fail(text, details) {
  return { text, isError: true, details }
}

function taskById(id) {
  return rt.state.tasks.find((task) => String(task.id) === String(id)) ?? null
}

/**
 * 工具参数是**扁平的**（kind/time/weekday 直接在顶层，模型的 schema 就是这么写的），
 * 而 normalizeTaskInput 吃的是任务形状（schedule 嵌套）。这一层只做搬移，
 * 不做校验——否则「哪些字段能改」会在三处各有一份。
 */
function fromToolArgs(args) {
  return {
    name: args.name,
    prompt: args.prompt,
    schedule: {
      kind: args.kind,
      time: args.time,
      weekday: args.weekday,
      day: args.day,
      everyMinutes: args.everyMinutes,
      at: args.at,
    },
    cwd: args.cwd,
    validUntil: args.validUntil,
    enabled: args.enabled,
    notifyPolicy: args.notifyPolicy,
  }
}

/** 编辑类工具用：只挑真正传了的字段，未传的保持原样（部分更新语义） */
function pickPatch(args) {
  /** @type {Record<string, any>} */
  const patch = {}
  for (const key of ['name', 'prompt', 'cwd', 'validUntil', 'enabled', 'notifyPolicy']) {
    if (args?.[key] !== undefined) patch[key] = args[key]
  }
  const scheduleKeys = ['kind', 'time', 'weekday', 'day', 'everyMinutes', 'at']
  if (scheduleKeys.some((key) => args?.[key] !== undefined)) {
    patch.schedule = {}
    for (const key of scheduleKeys) {
      if (args[key] !== undefined) patch.schedule[key] = args[key]
    }
  }
  return patch
}

/**
 * 任务列表的一行。
 *
 * ⚠️ 入参**必须**是 `publicTask()` 的产物：`scheduleLabel` / `notifyPolicyLabel`
 * 都是投影里才算出来的派生字段，原始任务对象上没有——直接传 `rt.state.tasks` 里的
 * 元素会渲染出 `undefined`（v0.2.0 的列表就这么坏过一版）。
 */
function taskLine(view, index, now) {
  const next =
    view.enabled && view.nextRunAt
      ? `下次 ${fmtWhen(view.nextRunAt, now)}`
      : view.done
        ? '已完成'
        : '已停用'
  const last = (() => {
    const run = runsSorted().find((item) => item.taskId === view.id)
    if (!run) return '还没跑过'
    return `上次 ${fmtWhen(run.finishedAt ?? run.queuedAt, now)} ${statusText(run.status)}`
  })()
  return `${index}. ${view.name}（${view.id}）· ${view.scheduleLabel} · ${next} · ${last}`
}

/** 进行中的记录数：runCount 只在收尾时累加，光看它会以为「没跑过」 */
function activeCountOf(taskId) {
  return runsSorted().filter(
    (run) => run.taskId === taskId && (run.status === 'queued' || run.status === 'running'),
  ).length
}

const tools = {
  /** 建任务 */
  async create(args = {}, meta = {}) {
    const input = fromToolArgs(args)
    // 工具没给 cwd 就用这次会话的工作目录（模型不该为了「在哪跑」去猜路径）；
    // 但它同样要过校验——相对路径/已删除的目录到点必失败，不如现在就说
    if (!input.cwd && meta?.cwd) input.cwd = String(meta.cwd)
    const { task, errors } = normalizeTaskInput(input, { mode: 'tool' })
    if (errors.length > 0) return fail(`未创建：${errors.join('；')}`)
    task.cwd = task.cwd || rt.settings.defaultCwd || ''
    task.createdBy = 'agent'
    // 上限与重名都归 methods.saveTask 管：UI 与工具只有这一条写路径，
    // 规则放两处必然漂移（v0.2.0 里工具判重、UI 不判，描述说的和做的不一致）
    let saved
    try {
      ;({ task: saved } = await methods.saveTask({ task }))
    } catch (error) {
      return fail(`未创建：${oneLine(error?.message ?? error, 300)}`)
    }
    const next = saved.nextRunAt ? describeNext(saved.nextRunAt) : '不会执行（已停用或已过期）'
    return {
      text: [
        `已创建「${saved.name}」，${saved.scheduleLabel}，下次执行：${next}。`,
        `任务 id：${saved.id}`,
        `通知策略：${saved.notifyPolicyLabel}${saved.notifyPolicy ? '（本任务单独设定）' : '（跟随全局默认）'}`,
        '要改时间或提示词用 sched_update，要停用随时说。',
      ].join('\n'),
      details: {
        id: saved.id,
        nextRunAt: saved.nextRunAt,
        scheduleLabel: saved.scheduleLabel,
        notifyPolicy: saved.notifyPolicy,
        createdBy: saved.createdBy,
      },
    }
  },

  /** 列任务（含下次执行 / 上次结果） */
  async list(args = {}) {
    const now = Date.now()
    const status = String(args.status || 'all')
    const id = args.id ? String(args.id) : ''
    if (id) {
      const task = taskById(id)
      if (!task) return fail(`没有 id 为 ${id} 的任务。先用 sched_list 查一遍 id（id 不会变）。`)
      const view = publicTask(task)
      const run = runsSorted().find((item) => item.taskId === task.id)
      const active = activeCountOf(task.id)
      const lines = [
        `「${view.name}」· ${view.scheduleLabel}`,
        `id：${view.id}`,
        `状态：${view.enabled ? '已启用' : view.done ? '已完成（已停用）' : '已停用'}`,
        `下次执行：${view.enabled && view.nextRunAt ? describeNext(view.nextRunAt, now) : '不再执行'}`,
        `上次执行：${run ? `${fmtWhen(run.finishedAt ?? run.queuedAt, now)} ${statusText(run.status)}` : '还没有运行记录'}`,
        `通知策略：${view.notifyPolicyLabel}${view.notifyPolicy ? '（本任务单独设定）' : '（跟随全局默认）'}`,
        // runCount 只在收尾时累加（跳过的也不算）：说「累计完成」才和数字对得上
        `累计完成：${view.runCount} 次${active > 0 ? ` · 另有 ${active} 条进行中` : ''}`,
        view.cwd ? `工作目录：${view.cwd}` : '',
        view.validUntil ? `有效期至：${view.validUntil}` : '',
        '提示词：',
        view.prompt,
      ].filter(Boolean)
      return { text: lines.join('\n'), details: { task: view } }
    }

    let tasks = rt.state.tasks
    if (status === 'enabled') tasks = tasks.filter((task) => task.enabled)
    else if (status === 'disabled') tasks = tasks.filter((task) => !task.enabled)
    else if (status === 'active') {
      const activeIds = new Set(
        runsSorted()
          .filter((run) => run.status === 'queued' || run.status === 'running')
          .map((run) => run.taskId),
      )
      tasks = tasks.filter((task) => activeIds.has(task.id))
    }
    if (tasks.length === 0) {
      return {
        text:
          status === 'all'
            ? '当前没有任何定时任务。用户说「以后每天/每周…」时，用 sched_create 建一个。'
            : `没有「${status}」状态的定时任务。`,
        details: { tasks: [] },
      }
    }
    return {
      text: `${tasks.length} 个定时任务\n\n${tasks.map((task, index) => taskLine(publicTask(task), index + 1, now)).join('\n')}`,
      details: { tasks: tasks.map(publicTask) },
    }
  },

  /** 改任务（含启停）；只传要改的字段 */
  async update(args = {}) {
    const id = String(args.id || '')
    const task = taskById(id)
    if (!task) return fail(`没有 id 为 ${id} 的任务。先用 sched_list 查 id（id 不会变）。`)
    const patch = pickPatch(args)
    if (Object.keys(patch).length === 0) {
      return fail('没有要改的字段。可改：name / prompt / kind / time / weekday / day / everyMinutes / at / cwd / validUntil / enabled / notifyPolicy。')
    }
    const changed = Object.keys(patch).filter((key) => key !== 'schedule')
    if (patch.schedule) changed.push('调度')
    // saveTask 会拒掉重名与非法值：转成 isError 而不是让宿主包成 "sched_update failed: …"
    let saved
    try {
      ;({ task: saved } = await methods.saveTask({ task: { ...patch, id: task.id } }))
    } catch (error) {
      return fail(`未更新：${oneLine(error?.message ?? error, 300)}`)
    }
    const next = saved.nextRunAt ? describeNext(saved.nextRunAt) : '不会执行（已停用或已过期）'
    return {
      text: [
        `已更新「${saved.name}」（改了：${changed.join('、') || '无'}）。`,
        `现在：${saved.scheduleLabel}，${saved.enabled ? `下次执行：${next}` : '已停用，不会执行'}。`,
        saved.notifyPolicyLabel ? `通知策略：${saved.notifyPolicyLabel}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      details: { id: saved.id, nextRunAt: saved.nextRunAt, scheduleLabel: saved.scheduleLabel },
    }
  },

  /** 删任务（连历史）；只在用户明确要求时调用 */
  async remove(args = {}) {
    const id = String(args.id || args.taskId || '')
    const task = taskById(id)
    if (!task) return fail(`没有 id 为 ${id} 的任务。先用 sched_list 查 id；如果用户只是想停掉它，用 sched_update({enabled:false})。`)
    const { runCount } = await methods.deleteTask({ id: task.id })
    return {
      text: `已删除「${task.name}」（连同 ${runCount} 条运行记录）。这个操作不可撤销。`,
      details: { id: task.id, deletedRuns: runCount },
    }
  },

  /** 立即跑一次（不改变既定节奏） */
  async runNow(args = {}, meta = {}) {
    const id = String(args.id || '')
    const task = taskById(id)
    if (!task) return fail(`没有 id 为 ${id} 的任务。先用 sched_list 查 id。`, undefined)
    const waitMs = Math.min(Math.max(0, Number(args.waitMs) || 0), 30_000)
    // 一次性任务的手动执行是「预览」，不消费原定计划——不主动说明的话，
    // 用户会以为测过就等于跑过了（v0.2.0 实测报告里就是这么困惑的）
    const stillScheduled =
      task.schedule?.kind === 'once' && task.enabled && task.nextRunAt
        ? `\n原定 ${fmtWhen(task.nextRunAt)} 仍会照常执行（手动执行不影响计划）。`
        : ''
    const result = await methods.runNow({ id: task.id, waitMs })
    if (!result.ok) {
      if (result.skipped === 'overlap') {
        return {
          text: `「${task.name}」正在执行中，这一次没有重复入队。用 sched_runs 可以看进度，完成后结果会出现在应用入口的「运行记录」里。`,
          details: { id: task.id, skipped: 'overlap' },
        }
      }
      return {
        text: `「${task.name}」没有开始：排队已满（同时排队的任务太多）。等前面的跑完再试一次。`,
        details: { id: task.id, skipped: result.skipped },
      }
    }
    if (result.run) {
      const run = result.run
      const tail = run.output ? `\n结果（前 300 字）：\n${oneLine(run.output, 300)}` : run.error ? `\n错误：${oneLine(run.error, 300)}` : ''
      return {
        text: `「${task.name}」本次执行结束：${statusText(run.status)}，用时 ${fmtDuration(run.durationMs)}。${tail}${stillScheduled}`,
        details: { id: task.id, runId: run.id, status: run.status, notify: run.notify },
      }
    }
    return {
      text: [
        `已开始执行「${task.name}」（运行 id：${result.runId}）。`,
        '任务按顺序排队执行，可能要等前面的任务跑完；它不改变原本的下次执行时间。',
        '完成后结果会写进应用入口的「运行记录」；要现在查进度用 sched_runs({ taskId, limit: 1 })。',
      ].join('\n') + stillScheduled,
      details: { id: task.id, runId: result.runId, status: 'queued' },
    }
  },

  /** 查运行记录；默认只回摘要 */
  async runs(args = {}) {
    const now = Date.now()
    const taskId = args.taskId || args.id ? String(args.taskId || args.id) : ''
    const status = args.status ? String(args.status) : ''
    const limit = Math.min(Math.max(1, Number(args.limit) || 10), 50)
    const withOutput = args.withOutput === true
    let runs = runsSorted()
    if (taskId) {
      const task = taskById(taskId)
      if (!task) return fail(`没有 id 为 ${taskId} 的任务。先用 sched_list 查 id。`)
      runs = runs.filter((run) => run.taskId === taskId)
    }
    if (status === 'active') runs = runs.filter((run) => run.status === 'queued' || run.status === 'running')
    else if (status) runs = runs.filter((run) => run.status === status)
    if (runs.length === 0) {
      return {
        text: taskId
          ? '这个任务还没有运行记录。到点执行或 sched_run_now 之后才会有。'
          : '还没有任何运行记录。',
        details: { runs: [] },
      }
    }
    const picked = runs.slice(0, limit)
    const lines = [`最近 ${picked.length} 条运行记录（共 ${runs.length} 条）`, '']
    picked.forEach((run, index) => {
      const flags = [triggerText(run.trigger), run.status === 'skipped' ? skipText(run.skipReason) : '']
        .filter(Boolean)
        .join(' · ')
      const when = fmtWhen(run.finishedAt ?? run.startedAt ?? run.queuedAt, now)
      const dur = run.status === 'queued' || run.status === 'running' ? '进行中' : fmtDuration(run.durationMs)
      lines.push(`${index + 1}. ${run.taskName} · ${when} · ${statusText(run.status)} · ${dur}${flags ? ` · ${flags}` : ''}`)
      if (run.status === 'failed' && run.error) lines.push(`   错误：${oneLine(run.error, 200)}`)
      // 「为什么没通知」由引擎记原因码、format 出文案；不再用「有没有标注」当判据
      const notifyNote = publicRun(run).notifyLabel
      if (notifyNote) lines.push(`   ${notifyNote}`)
      if (withOutput && run.output) lines.push(indent(run.output.slice(0, 4_000)))
    })
    return {
      text: lines.join('\n'),
      details: {
        runs: picked.map((run) => ({
          ...publicRun(run),
          output: withOutput ? run.output : undefined,
        })),
      },
    }
  },
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n')
}

export { tools }
