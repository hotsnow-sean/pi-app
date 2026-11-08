// @ts-check
/**
 * UI 侧接口（invoke 方法）。工具层也复用这里的写操作——校验只有一份，
 * 落盘只有一条路径。
 *
 * 接口粒度按「一屏一次」设计：
 *   snapshot()  一次拿齐任务 + 执行中 + 未读 + 服务端时间（替代每任务翻历史）；
 *   listRuns()  只回 120 字预览，点开某条再 getRun 拉全文。
 *
 * 200 条 × 20KB 的记录如果每次都整包下发，UI 每 2 秒轮询都在搬 4MB——这是这次
 * 重做接口的直接原因。
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析（jsdom 会打补丁）
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(path.join(import.meta.dirname, `${name}.mjs`)).href + Q)

const { rt, MAX_TASKS, MAX_RUNS } = await imp('runtime')
const { computeNextRun, scheduleLabel } = await imp('schedule')
const { normalizeTaskInput } = await imp('task-input')
const { saveTasks, removeTaskRecord } = await imp('store')
const {
  publicRun,
  fullRun,
  runsSorted,
  activeRuns,
  lastRunOf,
  unreadCounts,
  markSeen: markSeenRuns,
  removeRun,
  removeRunsOfTask,
  waitForRun,
} = await imp('runs')
const { enqueue } = await imp('engine')
const {
  readMemoryText,
  writeMemoryText,
  clearMemory: clearMemoryFile,
  resetMemoryRecords,
  mergeNote,
  readMemory,
  writeMemory,
  memoryInfo,
  USER_TEXT_LIMIT,
} = await imp('memory')

const POLICY_LABELS = {
  always: '每次都通知',
  'on-change': '有变化才通知',
  failures: '仅失败时通知',
  never: '不通知',
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8)
}

/**
 * 名称比较：去空白 + 不区分大小写（「Daily Brief」和「daily brief」在列表里
 * 看起来就是一个东西）。中文名不受影响。
 * @param {any} a
 * @param {any} b
 */
function sameName(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
}

/**
 * 公开出去的任务形状。工具层也要用（工具回执要复述下次执行时间），
 * 所以不藏在闭包里。
 * @param {any} task
 */
export function publicTask(task) {
  const memory = memoryInfo(task.id)
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    schedule: task.schedule,
    scheduleLabel: scheduleLabel(task),
    cwd: task.cwd || '',
    validUntil: task.validUntil || null,
    enabled: !!task.enabled,
    done: !!task.done,
    nextRunAt: task.nextRunAt ?? null,
    lastRunAt: task.lastRunAt ?? null,
    lastRunOk: task.lastRunOk ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt ?? task.createdAt ?? null,
    createdBy: task.createdBy === 'agent' ? 'agent' : 'user',
    runCount: Number(task.runCount) || 0,
    notifyPolicy: task.notifyPolicy ?? null,
    notifyPolicyLabel: POLICY_LABELS[task.notifyPolicy ?? rt.settings.notifyPolicy] ?? POLICY_LABELS['on-change'],
    hasBaseline: !!task.baseline?.text,
    hasMemory: memory.exists,
    memoryRecords: memory.records,
  }
}

function taskById(id) {
  return rt.state.tasks.find((task) => task.id === id) ?? null
}

const methods = {
  /**
   * 一次拿齐首屏要的东西。`serverNow` 用于倒计时校正（UI 本地每秒重算，
   * 避免客户端时钟偏差把「还有 3 分钟」算成「已到点」）。
   */
  async snapshot() {
    const lastRunByTask = {}
    for (const task of rt.state.tasks) {
      const run = lastRunOf(task.id)
      if (!run) continue
      lastRunByTask[task.id] = {
        runId: run.id,
        status: run.status,
        trigger: run.trigger,
        queuedAt: run.queuedAt,
        finishedAt: run.finishedAt,
        notify: run.notify,
        skipReason: run.skipReason,
        seen: run.seen,
      }
    }
    return {
      tasks: rt.state.tasks.map(publicTask),
      active: activeRuns().map((run) => ({
        runId: run.id,
        taskId: run.taskId,
        taskName: run.taskName,
        status: run.status,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
      })),
      lastRunByTask,
      unreadByTask: unreadCounts(),
      serverNow: Date.now(),
      limits: { maxTasks: MAX_TASKS, maxRuns: MAX_RUNS },
      settings: {
        taskTimeoutMinutes: Number(rt.settings.taskTimeoutMinutes) || 15,
        historyLimit: Number(rt.settings.historyLimit) || 30,
        defaultNotifyPolicy: rt.settings.notifyPolicy || 'on-change',
        defaultCwd: rt.settings.defaultCwd || '',
        notifyOnStart: rt.settings.notifyOnStart !== false,
      },
    }
  },

  /** 兼容旧 UI（热重载期间可能还挂着上一份 app.js）：形状与 snapshot 一致 */
  async listTasks() {
    return methods.snapshot()
  },

  /**
   * 运行记录列表：不带正文。
   * @param {{ taskId?: string, status?: string, limit?: number }} [params]
   */
  async listRuns(params = {}) {
    const taskId = params?.taskId ? String(params.taskId) : ''
    const status = params?.status ? String(params.status) : ''
    const limit = Math.min(Math.max(1, Number(params?.limit) || 60), MAX_RUNS)
    let runs = runsSorted()
    if (taskId) runs = runs.filter((run) => run.taskId === taskId)
    if (status === 'active') runs = runs.filter((run) => run.status === 'queued' || run.status === 'running')
    else if (status) runs = runs.filter((run) => run.status === status)
    return { runs: runs.slice(0, limit).map(publicRun), total: runs.length }
  },

  /** 单条全文（点开才拉） */
  async getRun({ id }) {
    const run = rt.runs.get(String(id || ''))
    if (!run) throw new Error('run not found')
    return { run: fullRun(run) }
  },

  async deleteRun({ id }) {
    return { ok: removeRun(String(id || '')) }
  },

  /** 新建/编辑共用：先合并原值，再走同一份校验 */
  async saveTask({ task }) {
    if (!task || typeof task !== 'object') throw new Error('任务数据缺失')
    const now = Date.now()
    const existing = task.id ? taskById(String(task.id)) : null
    if (task.id && !existing) throw new Error('任务不存在（可能已被删除）')
    const merged = {
      ...(existing ?? {}),
      ...task,
      schedule: { ...(existing?.schedule ?? {}), ...(task.schedule ?? {}) },
    }
    const { task: normalized, errors, pastOnce } = normalizeTaskInput(merged, { mode: 'ui', now })
    if (errors.length > 0) throw new Error(errors.join('；'))

    // 名称是用户唯一能用来指认任务的字段（id 是 `task-1793966830721-bmgsgr` 这种），
    // 重名之后列表里根本没法分辨谁是谁。规则放在这里——UI 与工具只有这一条写路径，
    // 各写一份必然漂移（v0.2.0 就是工具判重、UI 不判，描述和实现还对不上）。
    const clash = rt.state.tasks.find(
      (item) => item.id !== existing?.id && sameName(item.name, normalized.name),
    )
    if (clash) {
      throw new Error(
        `已存在同名任务「${clash.name}」（${clash.id}，${scheduleLabel(clash)}）：请换个名字，或直接改那个任务。`,
      )
    }

    let saved = existing
    if (!saved) {
      if (rt.state.tasks.length >= MAX_TASKS) {
        throw new Error(`任务数已达上限 ${MAX_TASKS} 个，请先删除不用的任务`)
      }
      saved = {
        id: `task-${now}-${randomSuffix()}`,
        createdAt: now,
        createdBy: task.createdBy === 'agent' ? 'agent' : 'user',
        runCount: 0,
      }
      rt.state.tasks.push(saved)
    }
    // prompt 变了，旧基线就不能拿来比「有没有变化」——比的是两件事。
    // 记忆里的执行记录同样是关于旧目标的，一并清掉；长期备注是沉淀的事实，保留。
    if (saved.prompt !== undefined && saved.prompt !== normalized.prompt) {
      saved.baseline = null
      if (saved.id) resetMemoryRecords(saved.id, normalized.name)
    }
    saved.name = normalized.name
    saved.prompt = normalized.prompt
    saved.schedule = normalized.schedule
    saved.cwd = normalized.cwd
    saved.validUntil = normalized.validUntil
    saved.enabled = normalized.enabled
    saved.notifyPolicy = normalized.notifyPolicy
    saved.updatedAt = now
    saved.done = false

    if (normalized.schedule.kind === 'once' && pastOnce) {
      // UI 允许保存「已过去的一次性任务」：按已完成处理，不补跑（v0.1 语义）
      saved.enabled = false
      saved.done = true
      saved.nextRunAt = null
    } else {
      saved.nextRunAt = saved.enabled ? computeNextRun(saved, new Date(now)) : null
      if (saved.enabled && saved.nextRunAt === null) {
        // 有效期已过 / once 时间没了：别留一个「开着但永远不跑」的任务
        saved.enabled = false
        saved.done = true
      }
    }
    saveTasks()
    return { task: publicTask(saved) }
  },

  async deleteTask({ id }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error('任务不存在')
    const runCount = removeRunsOfTask(task.id)
    removeTaskRecord(task.id)
    clearMemoryFile(task.id)
    return { ok: true, runCount }
  },

  /** 记忆全文（编辑框用；不存在时给空模板，不落盘） */
  async getMemory({ id }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error('任务不存在')
    const text = readMemoryText(task.id, task.name)
    // memoryInfo 里已经带 chars / exists / records，别再手写一遍（会被覆盖，白读一次盘）
    return { id: task.id, name: task.name, text, ...memoryInfo(task.id) }
  },

  /** 用户整份编辑记忆：解析两段 → 限幅 → 原子写回 */
  async saveMemory({ id, text }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error('任务不存在')
    const value = String(text ?? '')
    if (value.length > USER_TEXT_LIMIT) throw new Error(`记忆内容过长（上限 ${USER_TEXT_LIMIT} 字）`)
    writeMemoryText(task.id, task.name, value)
    return { ok: true, text: readMemoryText(task.id, task.name) }
  },

  /** 只往「长期备注」追加几行（工具 sched_memory 用，不动执行记录） */
  async appendMemory({ id, text }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error('任务不存在')
    const value = String(text ?? '')
    if (value.length > USER_TEXT_LIMIT) throw new Error(`内容过长（上限 ${USER_TEXT_LIMIT} 字）`)
    const mem = mergeNote(readMemory(task.id), value)
    writeMemory(task.id, task.name, mem)
    return { ok: true, text: readMemoryText(task.id, task.name) }
  },

  /** 清空：记忆与基线一起归零，下一轮等同首次执行 */
  async clearMemory({ id }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error('任务不存在')
    clearMemoryFile(task.id)
    task.baseline = null
    saveTasks()
    return { ok: true }
  },

  async setTaskEnabled({ id, enabled }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error('任务不存在')
    task.enabled = enabled !== false
    task.updatedAt = Date.now()
    if (task.enabled) {
      task.done = false
      task.nextRunAt = computeNextRun(task)
      if (task.nextRunAt === null) {
        // 已过期的一次性任务不该能从开关里「复活」
        task.enabled = false
        task.done = true
      }
    } else {
      task.nextRunAt = null
    }
    saveTasks()
    return { task: publicTask(task) }
  },

  /**
   * 立即运行。只入队，**不动 nextRunAt**——手动补跑一次不该改变既定节奏
   * （与 WorkBuddy 一致；main.test.mjs 有钉子用例防止后来者「顺手优化」）。
   * @param {{ id: string, waitMs?: number }} params
   */
  async runNow({ id, waitMs }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error('任务不存在')
    const result = enqueue(task, 'manual')
    // 重叠/队列满也算「这次没跑」：ok:false 才能让工具和 UI 区分出跳过原因
    if (!result.run) return { ok: false, skipped: result.skipped }
    if (result.skipped) return { ok: false, skipped: result.skipped, runId: result.run.id }
    const wait = Math.min(Math.max(0, Number(waitMs) || 0), 30_000)
    if (wait > 0) {
      const run = await waitForRun(result.run.id, wait)
      // 带全文：工具要用 result 组织回执，UI 只是在面板里刷新一下
      return { ok: true, runId: result.run.id, skipped: null, run: run ? fullRun(run) : null }
    }
    return { ok: true, runId: result.run.id, skipped: null, status: 'queued' }
  },

  /** 编辑页的「下次执行」实时预览 */
  async nextRunPreview({ schedule }) {
    const probe = { enabled: true, schedule }
    return { nextRunAt: computeNextRun(probe, new Date()), scheduleLabel: scheduleLabel(probe) }
  },

  /** 标已读：打开任务详情（taskId）或运行记录页（不传 = 全部）时调用 */
  async markSeen(params = {}) {
    return { changed: markSeenRuns({ taskId: params?.taskId ? String(params.taskId) : '', ids: params?.ids }) }
  },
}

export { methods, POLICY_LABELS }
