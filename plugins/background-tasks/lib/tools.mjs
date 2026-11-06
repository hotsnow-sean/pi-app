// @ts-check
/**
 * 模型侧工具（bg_*）：参数校验、结果排版、与模型的约定文案。
 *
 * 这一层只做两件事：把 args 变成对 core 的调用、把结果变成模型读得懂的话。
 * 业务规则（过滤、删除语义）尽量下沉——bg_clear 的过滤曾经工具层与 invoke 层
 * 各写一份，ids 维度就是只在一份里生效才暴露的，现在逻辑收敛在 methods.clearTasks，
 * 这里只负责把结果格式化。
 */
import fsp from 'node:fs/promises'

// 插件内模块一律走 imp() 动态加载并透传 ?v=（见 main.mjs 顶部）：静态 import 解析
// 相对路径时会丢掉 query，热重载会命中旧模块缓存。import.meta.url 自带本次激活的
// v，链条从入口自然向下传，每个模块都拿到同一代。
import { pathToFileURL } from 'node:url'
import { join as joinPath } from 'node:path'
// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析——
// jsdom 测试环境会给 URL 构造器打补丁，相对解析会落到 document.baseURI 上
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(joinPath(import.meta.dirname, `${name}.mjs`)).href + Q)
const { rt, SETTING_DEFAULTS } = await imp('runtime')
const { statusText, stopReasonText, fmtDuration, fmtBytes, jsonBlock, sameSession } = await imp('format')
const {
  logPathFor,
  readLog,
  tailOf,
  countLines,
  MAX_OUTPUT_WAIT_MS,
  MIN_READ_BYTES,
  READ_CHUNK_MAX,
  REPORT_TAIL_LINES,
} = await imp('log-io')
const { taskById, save } = await imp('store')
const { suppressReport } = await imp('report')
const { startTask, stopTask, waitForTerminal } = await imp('tasks')
const { methods } = await imp('methods')

/**
 * 工具只作用于**本会话发起**的任务。
 *
 * 任务是全局进程，但「谁在跟这个任务对话」是按会话分的：模型在会话 A 里看到会话 B
 * 的任务，既分不出归属，也能一个 bg_stop 停掉别人的长任务。跨会话的查看与清理
 * 走应用入口（views.main）——那边是用户亲眼看着、亲手点的。
 */
function sessionScope(meta) {
  return String(meta?.sessionFile || '')
}

function inScope(task, meta) {
  return sameSession(task.sessionFile, sessionScope(meta))
}

/** 取任务并确认归属：不属于本会话时给一句能自我解释的错误，而不是含糊的 unknown */
function taskInScope(id, meta) {
  const task = taskById(String(id || ''))
  if (!task) throw new Error(`unknown task: ${id}`)
  if (!inScope(task, meta)) {
    throw new Error(
      `${task.id} 不属于当前会话。bg_* 工具只作用于本会话发起的任务；跨会话的任务请在「后台任务」应用入口查看和处理。`,
    )
  }
  return task
}

/** 让模型在启动时就知道「这个任务会不会自己回来」——规则不透明比不回报更糟 */
export function reportOutlook(task) {
  const policy = String(rt.settings.reportPolicy || 'long')
  const threshold = Number(rt.settings.reportThresholdMs) || SETTING_DEFAULTS.reportThresholdMs
  if (!task.sessionFile) return { willReport: false, policy, reason: '任务没有关联会话，只能从面板查看' }
  if (policy === 'off') return { willReport: false, policy, reason: '回报策略为「不回报」' }
  if (policy === 'failures') return { willReport: true, policy, reason: '只在失败时回报' }
  if (policy === 'long')
    return {
      willReport: true,
      policy,
      thresholdMs: threshold,
      reason: `失败必报；成功时耗时 ≥ ${Math.round(threshold / 1000)}s 才报`,
    }
  return { willReport: true, policy, reason: '每次结束都会回报' }
}

/**
 * 启动后的统一回执（bg_start 与 bg_rerun 共用）。
 *
 * 极短的命令（<2s）在工具返回时就已结束：直接把尾巴带上，省一次 bg_output 往返。
 */
export async function describeStart(task) {
  // 启动回执要等 120ms 看是否秒结束；这期间 exit 回调可能已经入队并即时 flush。
  // 先扣住自动回报：回执若内联带了结果就 suppress，任务还活着就放行。
  task.reportHold = true
  await new Promise((resolve) => setTimeout(resolve, 120))
  const fresh = taskById(task.id)
  if (!fresh) {
    // 这 120ms 里用户把它删了/清空了：回执不能拿已删除的记录拼「已在后台启动」，
    // 模型会据此以为任务还活着（而记录和日志都没了）。
    return {
      text: `${task.id}「${task.label}」的记录在启动回执返回前已被清理，任务可能仍在运行，可用 ps 查 pid ${task.pid}。`,
      details: { id: task.id, label: task.label, status: 'unknown', pid: task.pid, cleared: true },
    }
  }
  if (fresh.status !== 'running') {
    // 回执已经把终态完整交给调用方了：自动回报必须让位。
    // 否则文案写着「不会再单独回报」，几秒后又收到一条，等于自己打自己的脸。
    delete fresh.reportHold
    suppressReport(fresh, '启动回执里已带完整结果（内联返回）')
    const tail = await tailOf(fresh)
    const errTail = fresh.errBytes > 0 ? await tailOf(fresh, 'err') : ''
    const details = {
      id: task.id,
      label: fresh.label,
      status: fresh.status,
      exitCode: fresh.exitCode ?? null,
      shell: fresh.shell,
      durationMs: (fresh.endedAt ?? Date.now()) - fresh.startedAt,
      output: tail || '',
      outputErr: errTail || '',
      returnedInline: true,
      report: fresh.report,
    }
    const text = [
      `${task.id}「${fresh.label}」已经在 ${details.durationMs}ms 内结束：${statusText(fresh)}。`,
      tail ? `\n最后输出：\n\`\`\`\n${tail}\n\`\`\`` : '\n（该任务没有输出）',
      errTail ? `\nstderr：\n\`\`\`\n${errTail}\n\`\`\`` : '',
      '\n它已经结束，不需要再查询，也不会再单独回报。',
    ]
      .filter(Boolean)
      .join('\n')
    return { text, details }
  }
  // 还在跑：放行自动回报（内联窗口已过，之后结束的走正常回报流程）
  delete task.reportHold
  const outlook = reportOutlook(task)
  const details = {
    id: task.id,
    label: task.label,
    pid: task.pid,
    status: 'running',
    shell: task.shell,
    cwd: task.cwd,
    logPath: task.logPath,
    errPath: task.errPath ?? null,
    timeoutMs: task.timeoutMs ?? null,
    report: outlook,
  }
  const text = [
    `${task.id}「${task.label}」已在后台启动（shell: ${task.shell}，pid ${task.pid}）。`,
    task.timeoutMs ? `超时上限 ${Math.round(task.timeoutMs / 1000)}s，到点自动终止并回报。` : '',
    `回报：${outlook.reason}${outlook.willReport ? '；结束后会自动回到本会话' : '，需要自己查' }。`,
    '任务结束时你会被自动唤醒，不要轮询。想看当前输出用 bg_output。',
  ]
    .filter(Boolean)
    .join('\n')
  return { text, details }
}

export const tools = {
  async bg_start(args, meta) {
    const task = startTask({
      command: args.command,
      label: args.label,
      cwd: args.cwd || meta.cwd,
      sessionFile: meta.sessionFile,
      shell: args.shell,
      timeoutSeconds: args.timeoutSeconds,
    })
    return describeStart(task)
  },

  async bg_rerun(args, meta) {
    const source = taskInScope(args.id, meta)
    if (source.status === 'running') throw new Error(`${source.id} 还在运行，先停止再重跑`)
    const task = startTask({
      command: source.command,
      label: source.label,
      cwd: source.cwd,
      // 归属用调用方的写法（worker 给的绝对路径）：source 可能记的是相对路径，
      // 两者 sameSession 相等，但落盘统一成绝对值更省事
      sessionFile: sessionScope(meta),
      shell: source.shell,
      timeoutSeconds: source.timeoutMs ? source.timeoutMs / 1000 : undefined,
    })
    task.rerunOf = source.id
    save()
    const result = await describeStart(task)
    return {
      text: `按 ${source.id} 重跑 → ${result.text}`,
      details: { ...result.details, rerunOf: source.id },
    }
  },

  async bg_clear(args, meta) {
    // 逻辑收敛到 methods.clearTasks（工具层与 invoke 层曾经各写一份过滤，
    // ids 维度就是只在一份里生效才暴露的）。这里只负责把结果格式化成给模型看的文案。
    // 作用域同其它工具：只清本会话。跨会话清理在应用入口，那边清的是用户眼前的全量列表。
    const res = await methods.clearTasks({ ...args, sessionFile: sessionScope(meta) })
    const wanted = Array.isArray(args.status) ? args.status.map(String) : args.status ? [String(args.status)] : []
    // 「没有 running 任务」与事实不符是排障陷阱：明明在跑却说没有，
    // 实情是 keepRunning=true 把它们跳过了。文案必须说实话。
    const runningSkipped = res.skippedRunning || 0
    if (!res.cleared) {
      if (runningSkipped > 0 || res.missing?.length) {
        // 两种「没清掉」的原因必须分开说：一个是任务还活着，一个是 id 写错了
        const parts = []
        if (runningSkipped > 0)
          parts.push(`${runningSkipped} 个运行中任务已跳过（keepRunning=true，要连任务一起停止并删除请传 keepRunning:false）`)
        if (res.missing?.length) parts.push(`id 不存在：${res.missing.join(', ')}`)
        return { text: `没有清理任何记录：${parts.join('；')}。`, details: res }
      }
      return {
        text: wanted.length
          ? `没有状态为 ${wanted.join(' / ')} 的任务可清理。`
          : '没有已结束的任务可清理（运行中的任务不会被清掉）。',
        details: res,
      }
    }
    const remaining = rt.state.tasks.filter((t) => t.status === 'running' && inScope(t, meta)).length
    return {
      text: `已清理 ${res.cleared} 条任务记录（${res.ids.join(', ')}）。${
        res.missing?.length ? `id 不存在已跳过：${res.missing.join(', ')}。` : ''
      }${runningSkipped > 0 ? `${runningSkipped} 个运行中任务已跳过（keepRunning=true），要一并停止请传 keepRunning:false。` : ''}${
        // 记录清了不等于磁盘清了：句柄还占着的时候如实说，别让人以为已经干净
        res.stuckFiles
          ? `其中 ${res.stuckFiles} 个日志文件仍被进程占用，已安排自动重试，稍后会收走（不用再清一次）。`
          : ''
      }${remaining ? `仍有 ${remaining} 个任务在运行。` : ''}`,
      details: res,
    }
  },

  async bg_output(args, meta) {
    const task = taskInScope(args.id, meta)
    const stream = args.stream === 'err' ? 'err' : 'out'
    const file = logPathFor(task, stream)
    if (!file) throw new Error(`${task.id} 没有 stderr 记录（旧版本任务只保存合并输出）`)
    // 文件大小，读不到就当 0（日志可能还没建出来 / 已被清理）
    const size = () => fsp.stat(file).then((s) => s.size).catch(() => 0)
    const waitMs = Math.min(Math.max(Number(args.waitMs) || 0, 0), MAX_OUTPUT_WAIT_MS)
    if (waitMs > 0 && task.status === 'running') {
      // 协作式长轮询：只等「有新输出」，不承诺等到终态（那是 bg_wait，刻意不做）
      const before = await size()
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && task.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 150))
        if ((await size()) > before) break
      }
    }
    const res = await readLog(task, {
      offset: args.offset === undefined || args.offset === null ? undefined : Number(args.offset),
      maxBytes: args.maxBytes,
      tailLines: args.tailLines ?? REPORT_TAIL_LINES,
      stream,
    })
    const details = {
      id: res.id,
      status: res.status,
      running: res.running,
      exitCode: res.exitCode,
      stream,
      chunk: res.chunk,
      chunkBytes: res.chunkBytes,
      nextOffset: res.nextOffset,
      totalBytes: res.totalBytes,
      hasMore: res.hasMore,
      truncated: res.truncated,
      requestedMaxBytes: res.requestedMaxBytes,
      effectiveMaxBytes: res.effectiveMaxBytes,
      logPath: file,
      errBytes: task.errBytes ?? 0,
    }
    // 结构化出口：脚本/CI 不该靠正则解析人类排版
    if (args.format === 'json') return { text: jsonBlock(details), details }
    const lines = [
      `${task.id}「${task.label}」${statusText(task)} · ${fmtDuration((task.endedAt ?? Date.now()) - task.startedAt)}${
        stream === 'err' ? ' · stderr' : ''
      }`,
    ]
    if (res.totalBytes) lines.push(`日志 ${fmtBytes(res.nextOffset)}/${fmtBytes(res.totalBytes)}`)
    if (res.requestedMaxBytes !== res.effectiveMaxBytes) {
      lines.push(`maxBytes ${res.requestedMaxBytes} 已按 ${res.effectiveMaxBytes}B（允许范围 ${MIN_READ_BYTES}B~${fmtBytes(READ_CHUNK_MAX)}）实际执行。`)
    }
    if (!res.chunk) {
      // offset 已经走到日志末尾时说「没有输出」，会被读成「这个任务根本没输出」（v7 反馈）
      const atEnd = res.totalBytes > 0 && res.nextOffset >= res.totalBytes
      if (atEnd) lines.push(res.running ? '已读到末尾，暂时没有新输出。' : '已读到末尾（没有新内容）。')
      else lines.push(res.running ? '暂时还没有输出。' : '没有输出。')
    } else lines.push('', '```', res.chunk.replace(/\n$/, ''), '```')
    if (res.hasMore) lines.push(`还有 ${fmtBytes(res.totalBytes - res.nextOffset)} 未读，下次传 offset=${res.nextOffset}。`)
    if (stream === 'out' && (task.errBytes || 0) > 0) {
      lines.push(`这个任务还有 ${fmtBytes(task.errBytes)} 的 stderr 输出，需要时传 stream:'err' 查看。`)
    }
    return { text: lines.join('\n'), details }
  },

  async bg_stop(args, meta) {
    const task = taskInScope(args.id, meta)
    const stopped = stopTask(task, args.force === true)
    // 不传 waitMs 也给 1s：停止是短操作，回执顺手带上终态，省一次 bg_list 往返。
    // 显式传 0 表示「发完就返回」，那是调用方明确要的语义
    const waitMs = args.waitMs === undefined ? 1_000 : Math.min(Math.max(Number(args.waitMs) || 0, 0), 10_000)
    // 要同步等终态：先扣住自动回报，否则进程在这段等待里退出时，
    // exit 回调会即时 flush 一条回报，抢在下面的 suppressReport 之前
    const watch = stopped && waitMs > 0
    if (watch) task.reportHold = true
    const settled = stopped ? await waitForTerminal(task, waitMs) : true
    if (watch) delete task.reportHold
    // 结果已经在这个工具返回里交付了：撤掉排队中的自动回报，否则稍后又来一条一样的
    if (stopped && settled) suppressReport(task, '已在 bg_stop 中同步拿到终态')
    const details = {
      id: task.id,
      status: task.status,
      stopRequested: stopped,
      settled,
      exitCode: task.exitCode ?? null,
      stopReason: task.stopReason ?? null,
      durationMs: (task.endedAt ?? Date.now()) - task.startedAt,
      report: task.report,
    }
    const text = !stopped
      ? `${task.id} 已经不在运行（当前状态：${statusText(task)}），无需停止。`
      : settled
        ? `${task.id} 已停止（${stopReasonText(task)}），耗时 ${fmtDuration(details.durationMs)}。exitCode 为 null——判断结果请看 status，被杀掉的进程退出码没有意义。`
        : `${task.id} 已发出停止请求，但 ${waitMs}ms 内还没退出。稍后用 bg_list 确认，或传更大的 waitMs。`
    return { text, details }
  },

  async bg_list(args, meta) {
    const want = args.status ? String(args.status) : ''
    const now = Date.now()
    // 只列本会话：任务是全局进程，但「哪些跟我这轮工作有关」按会话分。
    // 跨会话的看全量在应用入口（views.main），那里也提供操作按钮。
    const mine = rt.state.tasks.filter((t) => inScope(t, meta))
    const tasks = mine
      .filter((t) => !want || t.status === want)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((t) => ({
        id: t.id,
        label: t.label,
        status: t.status,
        exitCode: t.exitCode ?? null,
        stopReason: t.stopReason ?? null,
        shell: t.shell,
        startedAt: t.startedAt,
        durationMs: (t.endedAt ?? now) - t.startedAt,
        timeoutMs: t.timeoutMs ?? null,
        bytes: t.bytes ?? 0,
        errBytes: t.errBytes ?? 0,
        report: t.report,
        reportError: t.reportError ?? null,
        cwd: t.cwd,
      }))
    const running = tasks.filter((t) => t.status === 'running').length
    const policy = String(rt.settings.reportPolicy || 'long')
    const details = {
      tasks,
      running,
      scope: 'session',
      reportPolicy: policy,
      thresholdMs: Number(rt.settings.reportThresholdMs) || SETTING_DEFAULTS.reportThresholdMs,
    }
    if (args.format === 'json') return { text: jsonBlock(details), details }
    if (tasks.length === 0) {
      const other = rt.state.tasks.length - mine.length
      const text = want
        ? `本会话没有状态为 ${want} 的后台任务。`
        : other > 0
          ? `本会话没有后台任务。其它会话还有 ${other} 条——bg_* 只作用于本会话，跨会话的任务请在「后台任务」应用入口查看。`
          : '本会话还没有后台任务。'
      return { text, details }
    }
    const text = [`${tasks.length} 个任务（${running} 个运行中，回报策略 ${policy}，新→旧）：`]
      .concat(tasks.map((t) => `${t.id} · ${statusText(t)} · ${fmtDuration(t.durationMs)} · ${t.label}`))
      .join('\n')
    return { text, details }
  },
}

