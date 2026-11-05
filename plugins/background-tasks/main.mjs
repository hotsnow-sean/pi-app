/**
 * 后台任务 — main 侧服务。
 *
 * 给会话一套「起长命令、干别的、跑完自己回来汇报」的能力。pi 内置的 bash 工具是
 * 同步等待的，长命令会把一轮对话卡死；这里把进程 detached 出去、输出直写日志文件，
 * 任务结束时通过 ctx.sessions.send 把结果投回发起它的那个会话。
 *
 * 契约：
 *   invoke('tool.execute', { name, args, sessionFile, cwd, signal }) → { text } | 对象
 *   invoke('tasks.list' | 'tasks.output' | 'tasks.stop' | 'tasks.remove' | 'tasks.retryReport')
 *
 * 三条设计红线（见 doc/dev/background-tasks-design.md）：
 *   1. 输出不经宿主内存：stdio 直接是日志文件的 fd，几百 MB 也压不垮 main 进程。
 *   2. 任务表落盘：宿主重启后按 pid 探测接管，对不上的记 lost 并允许重新回报。
 *   3. 回报要克制：默认只报「超过阈值或失败」的任务，同会话 5 秒内合并，
 *      一条消息最多展开 3 个任务——否则模型连开十个任务会把对话淹掉。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const READ_CHUNK_DEFAULT = 16 * 1024
const READ_CHUNK_MAX = 256 * 1024
const MERGE_WINDOW_MS = 5_000
const MAX_DETAILED_REPORTS = 3
const REPORT_TAIL_LINES = 20
const REPORT_MAX_CHARS = 8_000
const MAX_TASKS = 50
const PROBE_MS = 3_000
const DEFAULT_MAX_LOG_MB = 50
const COUNT_LINES_MAX_BYTES = 20 * 1024 * 1024

const SETTING_DEFAULTS = {
  reportPolicy: 'long',
  reportThresholdMs: 15_000,
  maxLogMb: DEFAULT_MAX_LOG_MB,
}

let ctx = null
let settings = { ...SETTING_DEFAULTS }
let state = { seq: 0, tasks: [] }
let logDir = ''
let probeTimer = null
let unsubscribeRuns = null
/** sessionFile → 最近一次见到的 run phase（仅用于面板提示，不参与投递决策） */
const sessionPhases = new Map()
/** sessionFile → { items: BgTask[], timer } 合并窗口 */
const reportQueues = new Map()
/** 活着的子进程句柄（不在 storage 里，重启即丢，靠 pid 探测接管） */
const children = new Map()

// ---------- 存储 ----------

function loadSettings() {
  try {
    settings = { ...SETTING_DEFAULTS, ...(ctx.settings?.get?.() ?? {}) }
  } catch {
    settings = { ...SETTING_DEFAULTS }
  }
}

function load() {
  try {
    const data = ctx.storage.get() ?? {}
    state = {
      seq: Number(data.seq) || 0,
      tasks: Array.isArray(data.tasks) ? data.tasks.filter((t) => t && typeof t.id === 'string') : [],
    }
  } catch {
    state = { seq: 0, tasks: [] }
  }
}

function save() {
  try {
    ctx.storage.set({
      seq: state.seq,
      // tailText 只在内存里活到回报完成，不落盘
      tasks: state.tasks.map(({ tailText, ...rest }) => rest),
    })
  } catch (error) {
    ctx.log('storage save failed', error)
  }
}

function taskById(id) {
  return state.tasks.find((t) => t.id === id) ?? null
}

// ---------- 小工具 ----------

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m} 分 ${s} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function labelOf(command) {
  const first = String(command || '').trim().split(/\r?\n/)[0].trim()
  return first.length > 60 ? `${first.slice(0, 57)}…` : first || '未命名命令'
}

function decode(buffer) {
  let text = buffer.toString('utf8')
  // 多字节字符被截在 chunk 边界时会出替换符：退到最后一个换行，剩下的下次再读
  if (text.includes('\uFFFD')) {
    const cut = text.lastIndexOf('\n')
    if (cut > 0) text = text.slice(0, cut + 1)
  }
  return text
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程在，只是不归我们管
    return error?.code === 'EPERM'
  }
}

// ---------- 日志 ----------

async function readLog(task, { offset, maxBytes, tailLines }) {
  const size = await fsp
    .stat(task.logPath)
    .then((s) => s.size)
    .catch(() => 0)
  const cap = Math.min(Math.max(Number(maxBytes) || READ_CHUNK_DEFAULT, 1024), READ_CHUNK_MAX)
  const fromEnd = offset === undefined || offset === null
  const start = fromEnd ? Math.max(0, size - cap) : Math.min(Math.max(0, Number(offset) || 0), size)
  const end = fromEnd ? size : Math.min(size, start + cap)
  const out = {
    id: task.id,
    status: task.status,
    running: task.status === 'running',
    exitCode: task.exitCode ?? null,
    chunk: '',
    nextOffset: start,
    totalBytes: size,
    hasMore: false,
  }
  if (end <= start) return out
  let handle = null
  try {
    handle = await fsp.open(task.logPath, 'r')
    const buf = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(buf, 0, buf.length, start)
    out.chunk = decode(buf.subarray(0, bytesRead))
    out.nextOffset = start + bytesRead
    out.hasMore = out.nextOffset < size
    const want = Number(tailLines)
    if (fromEnd && want > 0) {
      const lines = out.chunk.split('\n')
      out.chunk = lines.slice(Math.max(0, lines.length - Math.min(want, 500))).join('\n')
    }
  } catch {
    /* 日志还没建出来（spawn 立刻失败）：返回空 chunk，状态字段仍然有用 */
  } finally {
    await handle?.close().catch(() => {})
  }
  return out
}

async function tailOf(task) {
  const res = await readLog(task, { tailLines: REPORT_TAIL_LINES, maxBytes: 32 * 1024 })
  const text = res.chunk.trim()
  return text.length > REPORT_MAX_CHARS ? `${text.slice(0, REPORT_MAX_CHARS)}\n…（已截断）` : text
}

async function countLines(task) {
  try {
    const size = await fsp.stat(task.logPath).then((s) => s.size)
    if (size > COUNT_LINES_MAX_BYTES) return null
    const text = await fsp.readFile(task.logPath, 'utf8')
    if (!text) return 0
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch {
    return null
  }
}

// ---------- 进程 ----------

/**
 * 命令串 + 输出重定向。
 *
 * 为什么不让 Node 把日志文件的 fd 交给子进程：Electron 主进程在 Windows 上不给子进程
 * 继承句柄（普通 node 下可以），子进程的 stdout 是无效句柄，表现是「进程在跑但日志永远
 * 是空的」。改成让 shell 自己重定向，与父进程的句柄继承完全无关。
 *
 * 走 `shell: true` 而不是自己拼 `cmd /d /s /c`：日志路径可能含空格或中文，命令行引号
 * 必须由 Node 的参数转义规则处理，手拼必错。
 */
function commandLine(command, logPath) {
  if (process.platform === 'win32') {
    // chcp 65001：让 cmd 的管道输出按 UTF-8 走，否则中文在日志里是乱码
    return `chcp 65001>nul & (${command}) >> "${logPath}" 2>&1`
  }
  return `(${command}) >> '${String(logPath).replace(/'/g, `'\\''`)}' 2>&1`
}

function startTask({ command, label, cwd, sessionFile }) {
  const cmd = String(command || '').trim()
  if (!cmd) throw new Error('command required')
  const workdir = String(cwd || '').trim() || process.cwd()
  if (!fs.existsSync(workdir)) throw new Error(`cwd does not exist: ${workdir}`)

  state.seq += 1
  const id = `bg-${state.seq}`
  const logPath = path.join(logDir, `${id}.log`)
  fs.mkdirSync(logDir, { recursive: true })
  // 先建空文件：路径/权限问题要在启动时暴露，而不是让 shell 悄悄失败
  fs.writeFileSync(logPath, '')

  const line = commandLine(cmd, logPath)
  const child = spawn(line, {
    cwd: workdir,
    shell: true,
    windowsHide: true,
    // 刻意不 detached：Electron 主进程里 detached 子进程在本机表现为「起了但从不退出、
    // 也不产出任何输出」。宿主退出时 Node 不会主动杀子进程，所以任务照样能活下来；
    // 停任务时按 pid 直接杀（Windows 走 taskkill /T 连带子进程树）。
    stdio: 'ignore',
  })

  const task = {
    id,
    label: String(label || '').trim() || labelOf(cmd),
    command: cmd,
    shell: process.platform === 'win32' ? 'cmd' : 'sh',
    cwd: workdir,
    sessionFile: String(sessionFile || ''),
    pid: child.pid ?? null,
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    endedAt: null,
    logPath,
    bytes: 0,
    report: 'pending',
    reportedAt: null,
    recovered: false,
  }
  state.tasks.unshift(task)
  pruneTasks()
  save()

  bindChild(task, child)
  return task
}

function bindChild(task, child) {
  children.set(task.id, child)
  child.on('error', (error) => {
    finishTask(task, { error: error?.message || String(error) })
  })
  child.on('exit', (code, signal) => {
    finishTask(task, { code, signal })
  })
}

function finishTask(task, { code = null, signal = null, error = null } = {}) {
  if (children.has(task.id)) children.delete(task.id)
  if (task.status !== 'running') return
  task.exitCode = typeof code === 'number' ? code : null
  task.signal = signal ?? null
  task.endedAt = Date.now()
  if (error) {
    task.status = 'lost'
    task.error = String(error)
  } else if (task.stopRequested) {
    task.status = 'stopped'
  } else {
    task.status = task.exitCode === 0 ? 'exited' : 'failed'
  }
  delete task.stopRequested
  void refreshBytes(task)
  save()
  scheduleReport(task)
}

async function refreshBytes(task) {
  try {
    const s = await fsp.stat(task.logPath)
    task.bytes = s.size
    save()
  } catch {
    /* 文件可能已被清理 */
  }
}

function stopTask(task, force) {
  if (task.status !== 'running') return false
  task.stopRequested = true
  // 有句柄就顺手收掉监听，避免子进程被 taskkill 后我们这边毫无感知
  if (!alive(task.pid)) {
    finishTask(task, { code: null, signal: null })
    return true
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(task.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try {
      process.kill(-task.pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      try {
        process.kill(task.pid, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        /* 已经没了 */
      }
    }
  }
  return true
}

function pruneTasks() {
  const limit = Math.max(10, Math.min(MAX_TASKS, 200))
  while (state.tasks.length > limit) {
    const victim = state.tasks[state.tasks.length - 1]
    if (victim.status === 'running') break
    state.tasks.pop()
    try {
      fs.rmSync(victim.logPath, { force: true })
    } catch {
      /* 删不掉就算了 */
    }
  }
}

// ---------- 回报 ----------

function scheduleReport(task) {
  const policy = String(settings.reportPolicy || 'long')
  if (!task.sessionFile) {
    task.report = 'skipped'
    return
  }
  if (policy === 'off') {
    task.report = 'skipped'
    return
  }
  const succeeded = task.status === 'exited'
  if (policy === 'failures' && succeeded) {
    task.report = 'skipped'
    return
  }
  const duration = (task.endedAt ?? Date.now()) - task.startedAt
  const threshold = Number(settings.reportThresholdMs) || SETTING_DEFAULTS.reportThresholdMs
  if (policy === 'long' && succeeded && duration < threshold) {
    task.report = 'skipped'
    return
  }
  enqueueReport(task)
}

function enqueueReport(task) {
  task.report = 'pending'
  const key = task.sessionFile
  let queue = reportQueues.get(key)
  if (!queue) {
    queue = { items: [], timer: null }
    reportQueues.set(key, queue)
  }
  queue.items.push(task)
  if (queue.timer) return
  // 合并窗口：同一会话短时间内的多个完成事件只唤醒一次
  queue.timer = setTimeout(() => {
    queue.timer = null
    void flushReports(key)
  }, MERGE_WINDOW_MS)
}

async function flushReports(sessionFile) {
  const queue = reportQueues.get(sessionFile)
  if (!queue) return
  reportQueues.delete(sessionFile)
  const items = queue.items.splice(0)
  if (!items.length) return
  const detailed = items.slice(0, MAX_DETAILED_REPORTS)
  const skipped = items.length - detailed.length
  for (const task of detailed) {
    task.tailText = await tailOf(task)
    task.lineCount = await countLines(task)
  }
  await deliver(sessionFile, detailed, skipped)
}

function statusLine(task) {
  if (task.status === 'exited') return '已完成'
  if (task.status === 'failed') return `失败（退出码 ${task.exitCode ?? '未知'}）`
  if (task.status === 'stopped') return '已被停止'
  if (task.status === 'lost') return '状态丢失（宿主重启后找不到进程）'
  return task.status
}

function buildReport(items, skipped) {
  const blocks = []
  for (const task of items) {
    const head = `【后台任务回报】${task.id}「${task.label}」${statusLine(task)}，耗时 ${fmtDuration(
      (task.endedAt ?? Date.now()) - task.startedAt,
    )}。`
    const lines = [head]
    if (task.tailText) {
      lines.push('最后输出：')
      lines.push('```')
      lines.push(task.tailText)
      lines.push('```')
    } else {
      lines.push('（该任务没有输出）')
    }
    const size = task.bytes ? fmtBytes(task.bytes) : ''
    const count = task.lineCount ? `共 ${task.lineCount} 行` : ''
    const meta = [count, size].filter(Boolean).join(' / ')
    lines.push(`完整日志：${task.logPath}${meta ? `（${meta}）` : ''}，需要更多内容时用 bg_output 读。`)
    blocks.push(lines.join('\n'))
  }
  if (skipped > 0) blocks.push(`另外还有 ${skipped} 个任务也结束了，详见面板「后台任务」。`)
  blocks.push('请基于以上结果继续你的工作，不要重复启动相同的任务。')
  return blocks.join('\n\n')
}

async function deliver(sessionFile, items, skipped) {
  const content = buildReport(items, skipped)
  try {
    await ctx.sessions.send({
      sessionFile,
      content,
      origin: {
        pluginId: 'background-tasks',
        label: '后台任务',
        kind: 'report',
        detail: items.map((t) => t.id).join(', '),
      },
    })
    for (const task of items) {
      task.report = 'sent'
      task.reportedAt = Date.now()
      delete task.tailText
    }
  } catch (error) {
    ctx.log('report delivery failed', error)
    for (const task of items) {
      task.report = 'failed'
      task.error = error?.message || String(error)
      delete task.tailText
    }
  }
  save()
}

// ---------- 恢复 ----------

function recover() {
  const now = Date.now()
  for (const task of state.tasks) {
    if (task.status !== 'running') continue
    task.recovered = true
    if (alive(task.pid)) continue
    // 宿主退出期间任务早就结束了：pid 不在，退出码永远拿不到，如实记 lost
    task.status = 'lost'
    task.endedAt = task.endedAt ?? now
    task.report = 'pending'
  }
  save()

  probeTimer = setInterval(() => {
    let changed = false
    const cap = Math.max(1, Number(settings.maxLogMb) || DEFAULT_MAX_LOG_MB) * 1024 * 1024
    for (const task of state.tasks) {
      if (task.status !== 'running') continue
      // 接管来的任务没有 exit 事件，只能轮询 pid
      if (task.recovered && !alive(task.pid)) {
        task.status = 'lost'
        task.endedAt = task.endedAt ?? Date.now()
        changed = true
        scheduleReport(task)
        continue
      }
      // 日志上限：别让一个 while(true) 打满磁盘
      try {
        const size = fs.statSync(task.logPath).size
        if (size !== task.bytes) {
          task.bytes = size
          changed = true
        }
        if (size > cap) {
          task.error = `日志超过 ${Math.round(cap / 1024 / 1024)}MB 上限，已停止`
          stopTask(task, true)
          changed = true
        }
      } catch {
        /* 文件暂时不可读，下一轮再看 */
      }
    }
    if (changed) save()
  }, PROBE_MS)
  if (typeof probeTimer.unref === 'function') probeTimer.unref()
}

// ---------- 工具 ----------

const tools = {
  async bg_start(args, meta) {
    const task = startTask({
      command: args.command,
      label: args.label,
      cwd: args.cwd || meta.cwd,
      sessionFile: meta.sessionFile,
    })
    // 极短的命令（<2s）在工具返回时就已结束：直接把尾巴带上，省一次 bg_output
    await new Promise((resolve) => setTimeout(resolve, 120))
    const fresh = taskById(task.id)
    if (fresh && fresh.status !== 'running') {
      const tail = await tailOf(fresh)
      return {
        id: task.id,
        label: fresh.label,
        status: fresh.status,
        exitCode: fresh.exitCode,
        durationMs: (fresh.endedAt ?? Date.now()) - fresh.startedAt,
        output: tail || '（无输出）',
        note: '任务已结束，无需再查询。',
      }
    }
    return {
      id: task.id,
      label: task.label,
      pid: task.pid,
      status: 'running',
      logPath: task.logPath,
      note: '任务在后台运行。继续做别的事；它会自己把结果回报到本会话。想看当前输出用 bg_output。',
    }
  },

  async bg_output(args) {
    const task = taskById(String(args.id || ''))
    if (!task) throw new Error(`unknown task: ${args.id}`)
    const res = await readLog(task, {
      offset: args.offset === undefined || args.offset === null ? undefined : Number(args.offset),
      maxBytes: args.maxBytes,
      tailLines: args.tailLines ?? REPORT_TAIL_LINES,
    })
    if (!res.chunk && res.running) {
      return { ...res, chunk: '', note: '暂时还没有输出。' }
    }
    return res
  },

  async bg_stop(args) {
    const task = taskById(String(args.id || ''))
    if (!task) throw new Error(`unknown task: ${args.id}`)
    const stopped = stopTask(task, args.force === true)
    return {
      id: task.id,
      requested: stopped,
      status: task.status,
      note: stopped ? '已请求停止。' : '任务已经不在运行。',
    }
  },

  async bg_list(args) {
    const want = args.status ? String(args.status) : ''
    const now = Date.now()
    const tasks = state.tasks
      .filter((t) => !want || t.status === want)
      .map((t) => ({
        id: t.id,
        label: t.label,
        status: t.status,
        exitCode: t.exitCode,
        startedAt: t.startedAt,
        durationMs: (t.endedAt ?? now) - t.startedAt,
        report: t.report,
        cwd: t.cwd,
      }))
    return { tasks, running: tasks.filter((t) => t.status === 'running').length }
  },
}

// ---------- UI 方法 ----------

const methods = {
  async listTasks() {
    const now = Date.now()
    return {
      tasks: state.tasks.map((t) => ({
        id: t.id,
        label: t.label,
        command: t.command,
        cwd: t.cwd,
        status: t.status,
        exitCode: t.exitCode,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        durationMs: (t.endedAt ?? now) - t.startedAt,
        bytes: t.bytes,
        report: t.report,
        logPath: t.logPath,
        recovered: t.recovered === true,
      })),
      policy: String(settings.reportPolicy || 'long'),
      thresholdMs: Number(settings.reportThresholdMs) || SETTING_DEFAULTS.reportThresholdMs,
      serverNow: now,
    }
  },

  async readOutput({ id, offset, maxBytes, tailLines }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    return readLog(task, {
      offset: offset === undefined || offset === null ? undefined : Number(offset),
      maxBytes,
      tailLines: tailLines ?? 200,
    })
  },

  async stopTask({ id }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    return { ok: stopTask(task, false), status: task.status }
  },

  async removeTask({ id }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    if (task.status === 'running') stopTask(task, true)
    state.tasks = state.tasks.filter((t) => t.id !== task.id)
    try {
      fs.rmSync(task.logPath, { force: true })
    } catch {
      /* 文件可能已经不在 */
    }
    save()
    return { ok: true }
  },

  async retryReport({ id }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    if (task.status === 'running') throw new Error('任务还在运行')
    if (!task.sessionFile) throw new Error('该任务没有发起会话，无法回报')
    task.tailText = await tailOf(task)
    task.lineCount = await countLines(task)
    await deliver(task.sessionFile, [task], 0)
    return { ok: task.report === 'sent', report: task.report, error: task.error ?? null }
  },
}

// ---------- 生命周期 ----------

export async function activate(pluginContext) {
  ctx = pluginContext
  loadSettings()
  logDir = path.join(ctx.dataDir || path.join(os.tmpdir(), 'pi-background-tasks'), 'logs')
  fs.mkdirSync(logDir, { recursive: true })

  ctx.settings?.onChange?.((values) => {
    settings = { ...SETTING_DEFAULTS, ...(values ?? {}) }
    ctx.log('settings updated', settings)
  })

  load()
  recover()

  // 会话忙闲：只为面板提示与将来的 deliverAs 决策留痕，不参与「要不要回报」
  try {
    unsubscribeRuns = ctx.sessions?.onRunEvent?.((payload) => {
      if (payload?.sessionFile) sessionPhases.set(payload.sessionFile, payload.phase)
    })
  } catch (error) {
    ctx.log('onRunEvent unavailable', error)
  }

  ctx.log(`background-tasks active, ${state.tasks.length} task(s), log dir ${logDir}`)
  return {
    async invoke(method, params) {
      if (method === 'tool.execute') {
        const { name, args, sessionFile, cwd } = params ?? {}
        const fn = tools[String(name || '')]
        if (!fn) return { text: `unknown tool: ${name}`, isError: true }
        try {
          const result = await fn(args ?? {}, { sessionFile: String(sessionFile || ''), cwd: String(cwd || '') })
          return result
        } catch (error) {
          return { text: `${name} failed: ${error?.message ?? error}`, isError: true }
        }
      }
      const handler = methods[method]
      if (!handler) throw new Error(`unknown method: ${method}`)
      return handler(params ?? {})
    },
  }
}

export async function deactivate() {
  // 只解订阅、停探测：任务本身继续跑（用户可能正等它出结果），重启后再接管
  if (probeTimer) clearInterval(probeTimer)
  probeTimer = null
  try {
    unsubscribeRuns?.()
  } catch {
    /* 已经解过 */
  }
  unsubscribeRuns = null
  for (const queue of reportQueues.values()) {
    if (queue.timer) clearTimeout(queue.timer)
  }
  reportQueues.clear()
  children.clear()
}
