// @ts-check
/**
 * 面板侧 invoke 方法（右栏 UI 与托盘回调走这里）。
 *
 * 与 tools（模型侧）的区别：这里的调用方是 renderer——参数是面板自己发的、
 * 返回值直接进 UI，所以字段面向展示（durationMs、focus.seq），不做文案排版。
 */

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
const { readLog, tailOf, countLines } = await imp('log-io')
const { taskById, save } = await imp('store')
const { markDeleted, deliver } = await imp('report')
const { startTask, stopTask: stopTaskCore, clearTimeoutFor, waitForTerminal } = await imp('tasks')
const { composerBarFor, pushComposerBar, pushBarForTask } = await imp('compose-bar')
const { removeTaskFiles, sweepOrphanFiles } = await imp('files')

/**
 * 会话条点开某条任务时，右栏面板要「自动翻到那一条」。
 * 用 seq 而不是布尔：同一个任务连点两次也要能再次把用户拽回来，面板侧比较 seq 变化即可。
 * 不落盘——这是「谁在看什么」的界面状态，不是任务事实。
 */
let focus = { id: null, seq: 0 }

export const methods = {
  async listTasks() {
    const now = Date.now()
    return {
      tasks: rt.state.tasks.map((t) => ({
        id: t.id,
        label: t.label,
        command: t.command,
        cwd: t.cwd,
        shell: t.shell,
        // 面板按当前会话过滤要用它；此前面板跨会话展示所以一直没投影这个字段
        sessionFile: t.sessionFile ?? null,
        status: t.status,
        exitCode: t.exitCode,
        stopReason: t.stopReason ?? null,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        durationMs: (t.endedAt ?? now) - t.startedAt,
        bytes: t.bytes,
        errBytes: t.errBytes ?? 0,
        timeoutMs: t.timeoutMs ?? null,
        rerunOf: t.rerunOf ?? null,
        report: t.report,
        reportNote: t.reportNote ?? null,
        /** 投递问题（与任务本身的 error 分开：一个说「回报没送到」，一个说「任务怎么失败的」） */
        reportError: t.reportError ?? null,
        error: t.error ?? null,
        logPath: t.logPath,
        errPath: t.errPath ?? null,
        recovered: t.recovered === true,
      })),
      policy: String(rt.settings.reportPolicy || 'long'),
      thresholdMs: Number(rt.settings.reportThresholdMs) || SETTING_DEFAULTS.reportThresholdMs,
      serverNow: now,
      /** 面板比较 seq 变化来「翻到这一条」，见 composerBarAction */
      focus: { ...focus },
    }
  },

  /**
   * 手动重推某个会话的托盘状态。
   *
   * 正常路径是「任务一变就推」，这里只是兜底：renderer 重载、推送失败、或 UI 刚拿到
   * 会话上下文时，可以要一次最新值，不必等下一次任务事件。
   */
  async refreshBar(/** @type {{ sessionFile?: string }} */ { sessionFile } = {}) {
    pushComposerBar(String(sessionFile || ''))
    return { ok: true, bar: composerBarFor(String(sessionFile || '')) }
  },

  /**
   * 托盘里的点击回调（宿主约定的方法名）。
   *
   * 宿主只负责把「点了哪一行、点了什么动作」传回来：点行固定传 `select`（这是宿主
   * 唯一的保留字，表示「看详情」），点行内按钮则原样回传**本插件自定义的 action id**
   * （这里是 `stop`，定义在 composerBarFor 的 actions 里）。详情定位复用 focus.seq——
   * 右栏面板自己比对，宿主不必知道这套。
   */
  async composerBarAction(/** @type {{ action?: string, id?: string }} */ { action, id } = {}) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    if (action === 'stop') {
      const stopped = stopTaskCore(task, false)
      pushBarForTask(task)
      return { ok: stopped, status: task.status }
    }
    focus = { id: task.id, seq: focus.seq + 1 }
    return { ok: true, focus: { ...focus } }
  },

  async readOutput({ id, offset, maxBytes, tailLines, stream }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    if (stream === 'err' && !task.errPath) return { id: task.id, status: task.status, stream: 'err', chunk: '', chunkBytes: 0, nextOffset: 0, totalBytes: 0, hasMore: false, truncated: false, running: task.status === 'running', exitCode: task.exitCode ?? null }
    return readLog(task, {
      offset: offset === undefined || offset === null ? undefined : Number(offset),
      maxBytes,
      tailLines: tailLines ?? 200,
      stream: stream === 'err' ? 'err' : 'out',
    })
  },

  /** 方法名保持 'stopTask'：invoke 按名字分发，这是面板依赖的契约 */
  async stopTask({ id }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    return { ok: stopTaskCore(task, false), status: task.status }
  },

  async rerunTask({ id }) {
    const source = taskById(String(id || ''))
    if (!source) throw new Error(`unknown task: ${id}`)
    if (source.status === 'running') throw new Error('任务还在运行，先停止再重跑')
    const task = startTask({
      command: source.command,
      label: source.label,
      cwd: source.cwd,
      sessionFile: source.sessionFile,
      shell: source.shell,
      timeoutSeconds: source.timeoutMs ? source.timeoutMs / 1000 : undefined,
    })
    task.rerunOf = source.id
    save()
    return { ok: true, id: task.id, rerunOf: source.id }
  },

  async clearTasks(
    /** @type {{ status?: string | string[], ids?: string | string[], keepRunning?: boolean }} */
    { status, ids, keepRunning } = {},
  ) {
    const keep = keepRunning !== false
    const wanted = Array.isArray(status) ? status.map(String) : status ? [String(status)] : []
    const wantedIds = Array.isArray(ids) ? ids.map(String) : ids ? [String(ids)] : []
    let skippedRunning = 0
    const victims = rt.state.tasks.filter((t) => {
      // keepRunning 也约束 ids 路径：点名清理不是强杀通行证，
      // 默认跳过运行中的（误传一个 id 不该静默终止长任务），keepRunning:false 才停+删
      if (keep && t.status === 'running') {
        if (wantedIds.length > 0 ? wantedIds.includes(t.id) : wanted.includes('running')) skippedRunning++
        return false
      }
      if (wantedIds.length > 0) return wantedIds.includes(t.id)
      return wanted.length === 0 || wanted.includes(t.status)
    })
    // 按 id 清理时静默跳过不存在的 id 而不是整体报错：脚本场景常是「尽力清」
    if (wantedIds.length > 0 && victims.length === 0 && skippedRunning === 0) {
      return {
        ok: true,
        cleared: 0,
        ids: [],
        running: rt.state.tasks.filter((t) => t.status === 'running').length,
        missing: wantedIds,
      }
    }
    const stopping = []
    const clearedIds = victims.map((t) => t.id)
    // 与 bg_clear 同一条不变量：先宣布删除，再等进程退出
    markDeleted(clearedIds)
    for (const task of victims) {
      if (task.status === 'running') {
        stopTaskCore(task, true, 'user')
        stopping.push(task)
      }
      clearTimeoutFor(task)
    }
    await Promise.all(stopping.map((task) => waitForTerminal(task, 3_000)))
    rt.state.tasks = rt.state.tasks.filter((t) => !clearedIds.includes(t.id))
    save()
    for (const task of victims) removeTaskFiles(task)
    // 记录删完后再扫一遍目录：句柄已释放的残留（v8 报告 §八.2 的「惰性删除」）
    // 与任何历史孤儿都会在这里被收走，不必等用户再点一次清理。
    // 安全性由 sweepOrphanFiles 本体把关（rt.storageUsable）——读失败且没有任何
    // 已知任务的一代，这里照样会被拦下（二轮复审 P1）
    sweepOrphanFiles()
    // 托盘按会话聚合推送：清 5 条同会话任务 = 1 次推送（逐条推是 5 次全窗口
    // 广播 + 5 次面板重算，结果完全一样——托盘本来就是一个会话一条）
    for (const sf of new Set(victims.map((t) => t.sessionFile).filter(Boolean))) {
      pushComposerBar(sf)
    }
    // missing 只算真正不存在的 id：运行中被 keepRunning 挡下的任务存在且活着，
    // 把它报成「id 不存在」会让人以为记错了 id（v6 实测踩过）
    const missing = wantedIds.filter(
      (id) => !clearedIds.includes(id) && !rt.state.tasks.some((t) => t.id === id),
    )
    const remaining = rt.state.tasks.filter((t) => t.status === 'running').length
    return {
      ok: true,
      cleared: clearedIds.length,
      ids: clearedIds,
      running: remaining,
      ...(skippedRunning > 0 ? { skippedRunning } : {}),
      ...(missing.length ? { missing } : {}),
    }
  },

  async removeTask({ id }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    markDeleted([task.id])
    if (task.status === 'running') stopTaskCore(task, true, 'user')
    clearTimeoutFor(task)
    rt.state.tasks = rt.state.tasks.filter((t) => t.id !== task.id)
    removeTaskFiles(task)
    save()
    pushBarForTask(task)
    return { ok: true }
  },

  async retryReport({ id }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    if (task.status === 'running') throw new Error('任务还在运行')
    if (!task.sessionFile) throw new Error('该任务没有发起会话，无法回报')
    task.tailText = await tailOf(task)
    task.lineCount = await countLines(task)
    if (task.errBytes > 0 || task.status !== 'exited') {
      const err = await tailOf(task, 'err')
      if (err) task.errTailText = err
    }
    delete task.reportError
    await deliver(task.sessionFile, [task], 0)
    return { ok: task.report === 'queued', report: task.report, reportError: task.reportError ?? null }
  },
}
