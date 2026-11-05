/**
 * 后台任务 — main 侧服务。
 *
 * 给会话一套「起长命令、干别的、跑完自己回来汇报」的能力。pi 内置的 bash 工具是
 * 同步等待的，长命令会把一轮对话卡死；这里把进程 detached 出去、输出直写日志文件，
 * 任务结束时通过 ctx.sessions.send 把结果投回发起它的那个会话。
 *
 * 契约：
 *   invoke('tool.execute', { name, args, sessionFile, cwd, signal }) → { text, details? }
 *   invoke('tasks.list' | 'tasks.output' | 'tasks.stop' | 'tasks.remove' | 'tasks.retryReport')
 *
 * 三条设计红线（见 doc/dev/background-tasks-design.md）：
 *   1. 输出不经宿主内存：stdio 直接是日志文件的 fd，几百 MB 也压不垮 main 进程。
 *   2. 任务表落盘：宿主重启后按 pid 探测接管，对不上的记 lost 并允许重新回报。
 *   3. 回报要克制：默认只报「超过阈值或失败」的任务，同会话 5 秒内合并，
 *      一条消息最多展开 3 个任务——否则模型连开十个任务会把对话淹掉。
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const READ_CHUNK_DEFAULT = 16 * 1024
const READ_CHUNK_MAX = 256 * 1024
const MIN_READ_BYTES = 64
/** bg_output 的协作式等待上限：只等「有新输出」，不等终态 */
const MAX_OUTPUT_WAIT_MS = 30_000
/** bg_stop 的终态等待上限 */
const MAX_STOP_WAIT_MS = 10_000
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
  // 64B 是编码安全的下限（够放一个多字节字符），不再有 1KB 的隐式抬升
  const cap = Math.min(Math.max(Number(maxBytes) || READ_CHUNK_DEFAULT, MIN_READ_BYTES), READ_CHUNK_MAX)
  const fromEnd = offset === undefined || offset === null
  const start = fromEnd ? Math.max(0, size - cap) : Math.min(Math.max(0, Number(offset) || 0), size)
  const end = fromEnd ? size : Math.min(size, start + cap)
  const out = {
    id: task.id,
    status: task.status,
    running: task.status === 'running',
    exitCode: task.exitCode ?? null,
    chunk: '',
    chunkBytes: 0,
    nextOffset: start,
    totalBytes: size,
    hasMore: false,
    truncated: false,
  }
  if (end <= start) return out
  let handle = null
  try {
    handle = await fsp.open(task.logPath, 'r')
    const buf = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(buf, 0, buf.length, start)
    out.chunk = decode(buf.subarray(0, bytesRead))
    out.chunkBytes = bytesRead
    out.nextOffset = start + bytesRead
    out.hasMore = out.nextOffset < size
    out.truncated = out.chunkBytes < end - start
    const want = Number(tailLines)
    if (fromEnd && want > 0) {
      const lines = out.chunk.split('\n')
      out.chunk = lines.slice(Math.max(0, lines.length - Math.min(want, 500))).join('\n')
      out.truncated = true
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

// ---------- shell ----------

/** Windows 上 Git Bash 的常见落点：PATH 里通常只有 git.exe，bash.exe 得自己找 */
const WIN_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs\\Git\\bin\\bash.exe'),
]

let cachedBash
let scriptDir = ''

function findBash() {
  if (cachedBash !== undefined) return cachedBash
  if (process.platform !== 'win32') {
    cachedBash = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
    return cachedBash
  }
  for (const candidate of WIN_BASH_CANDIDATES) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cachedBash = candidate
        return cachedBash
      }
    } catch {
      /* 路径不可读当作不存在 */
    }
  }
  try {
    const res = spawnSync('where', ['bash.exe'], { windowsHide: true, encoding: 'utf8' })
    const first = String(res.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0]
    if (res.status === 0 && first && fs.existsSync(first)) {
      cachedBash = first
      return cachedBash
    }
  } catch {
    /* where 不可用就算了 */
  }
  cachedBash = null
  return cachedBash
}

/**
 * bash 语法哨兵。
 *
 * 这是对「假成功」的兜底：cmd 会把 `$i`、`$(seq 1 3)` 这类 bash 语法当普通文本吃掉，
 * 命令照跑、退出码 0，调用方会得出完全相反的结论。与其在 cmd 下静默变形，不如直接拒绝。
 */
const BASH_ONLY_SYNTAX = [
  { re: /\$\(/, what: '$( ) 命令替换' },
  { re: /\$\{/, what: '${ } 变量展开' },
  { re: /(?:^|[\n;&|(])\s*for\s+\w+\s+in\s/, what: 'for … in 循环' },
  { re: /(?:^|[\n;&|(])\s*export\s+\w+=/, what: 'export 赋值' },
  { re: /\[\[\s/, what: '[[ ]] 条件判断' },
]

function assertCmdCompatible(command) {
  for (const { re, what } of BASH_ONLY_SYNTAX) {
    if (re.test(command)) {
      throw new Error(
        `命令里含 bash 语法（${what}），但当前 shell 是 cmd：cmd 会把它当普通文本吃掉，` +
          `命令看似成功其实没按预期执行。请传 shell:'bash' 重试，或改写成 cmd 语法。`,
      )
    }
  }
}

function bashQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`
}

/**
 * 命令 → 实际启动参数。
 *
 * 关键约束：**默认 shell 必须与内置 bash 工具一致**。模型是按 bash 语法写命令的，
 * 之前默认走 cmd 导致 `$i` 被吞掉、退出码却是 0——这种假成功比报错危险得多。
 *
 * 输出重定向一律交给 shell：Electron 主进程在 Windows 上不给子进程继承句柄，
 * 直接传文件 fd 会得到「进程在跑但日志永远为空」。
 */
function buildSpawnSpec({ command, logPath, requestedShell, id }) {
  const want = String(requestedShell || 'auto').toLowerCase()

  if (process.platform !== 'win32') {
    const file = want === 'bash' ? findBash() : '/bin/sh'
    return {
      kind: want === 'bash' ? 'bash' : 'sh',
      file: file || '/bin/sh',
      args: ['-c', `(${command}) >> ${bashQuote(logPath)} 2>&1`],
      line: null,
    }
  }

  if (want === 'powershell' || want === 'pwsh') {
    // 脚本文件 + 由 cmd 重定向：PowerShell 自己 `*>` 到文件默认 UTF-16，日志会变乱码
    const scriptPath = path.join(scriptDir, `${id}.ps1`)
    fs.writeFileSync(
      scriptPath,
      `$ErrorActionPreference = 'Continue'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n& {\n${command}\n}\n`,
      'utf8',
    )
    return {
      kind: 'powershell',
      file: null,
      args: null,
      line: `chcp 65001>nul & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" >> "${logPath}" 2>&1`,
    }
  }

  if (want === 'cmd') {
    assertCmdCompatible(command)
    return {
      kind: 'cmd',
      file: null,
      args: null,
      line: `chcp 65001>nul & (${command}) >> "${logPath}" 2>&1`,
    }
  }

  const bash = findBash()
  if (want === 'bash' && !bash) {
    throw new Error("找不到 bash（Git Bash 未安装或不在常见路径）。改用 shell:'cmd'，或先装 Git for Windows。")
  }
  if (bash) {
    return {
      kind: 'bash',
      file: bash,
      args: ['-c', `(${command}) >> ${bashQuote(logPath)} 2>&1`],
      line: null,
    }
  }
  // 没有 bash 才回落 cmd：此时必须拦住 bash 语法，避免静默错执行
  assertCmdCompatible(command)
  return {
    kind: 'cmd',
    file: null,
    args: null,
    line: `chcp 65001>nul & (${command}) >> "${logPath}" 2>&1`,
  }
}

function startTask({ command, label, cwd, sessionFile, shell }) {
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

  const spec = buildSpawnSpec({ command: cmd, logPath, requestedShell: shell, id })
  const child = spec.line
    ? spawn(spec.line, {
        cwd: workdir,
        shell: true,
        windowsHide: true,
        // 刻意不 detached：Electron 主进程里 detached 子进程在本机表现为「起了但从不退出、
        // 也不产出任何输出」。宿主退出时 Node 不会主动杀子进程，所以任务照样能活下来；
        // 停任务时按 pid 直接杀（Windows 走 taskkill /T 连带子进程树）。
        stdio: 'ignore',
      })
    : spawn(spec.file, spec.args, {
        cwd: workdir,
        windowsHide: true,
        stdio: 'ignore',
      })

  const task = {
    id,
    label: String(label || '').trim() || labelOf(cmd),
    command: cmd,
    shell: spec.kind,
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
  const rawCode = typeof code === 'number' ? code : null
  task.exitCode = rawCode
  task.signal = signal ?? null
  task.endedAt = Date.now()
  if (error) {
    task.status = 'lost'
    task.error = String(error)
  } else if (task.stopRequested) {
    task.status = 'stopped'
    // 被杀的进程会带一个无意义的退出码（taskkill 通常是 1）：留在 exitCode 里会跟真实失败撞车。
    // 原始码留在 rawExitCode 备查，语义一律看 status。
    task.rawExitCode = rawCode
    task.exitCode = null
    task.stopReason = task.stopReason || 'user'
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

function stopTask(task, force, reason = 'user') {
  if (task.status !== 'running') return false
  task.stopRequested = true
  task.stopReason = reason
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

/** 等到任务离开 running（或超时）。bg_stop 用它去掉「再查一次」这一步 */
async function waitForTerminal(task, waitMs) {
  const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), MAX_STOP_WAIT_MS)
  while (task.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return task.status !== 'running'
}

function pruneTasks() {
  const limit = Math.max(10, Math.min(MAX_TASKS, 200))
  // 从最旧的往前找可删的：运行中的任务跳过而不是整体停手——之前那样遇到一个 running
  // 尾巴就 break，任务数会悄悄突破上限。
  while (state.tasks.length > limit) {
    let victimIndex = -1
    for (let i = state.tasks.length - 1; i >= 0; i -= 1) {
      if (state.tasks[i].status !== 'running') {
        victimIndex = i
        break
      }
    }
    if (victimIndex === -1) break
    const [victim] = state.tasks.splice(victimIndex, 1)
    try {
      fs.rmSync(victim.logPath, { force: true })
    } catch {
      /* 删不掉就算了 */
    }
  }
}

// ---------- 回报 ----------

function scheduleReport(task) {
  // 防御性去重：同一个任务只允许被自动回报一次（retryReport 走的是显式通道）
  if (task.report === 'sent') return
  const policy = String(settings.reportPolicy || 'long')
  const skip = (reason) => {
    task.report = 'skipped'
    task.reportNote = reason
  }
  if (!task.sessionFile) return skip('没有关联会话')
  if (policy === 'off') return skip('回报策略为 off')
  const succeeded = task.status === 'exited'
  if (policy === 'failures' && succeeded) return skip('策略只回报失败')
  const duration = (task.endedAt ?? Date.now()) - task.startedAt
  const threshold = Number(settings.reportThresholdMs) || SETTING_DEFAULTS.reportThresholdMs
  if (policy === 'long' && succeeded && duration < threshold) {
    return skip(`成功且耗时 ${Math.round(duration / 1000)}s 短于阈值 ${Math.round(threshold / 1000)}s`)
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

function buildReport(items, skipped) {
  const blocks = []
  for (const task of items) {
    const head = `【后台任务回报】${task.id}「${task.label}」${statusText(task)}，耗时 ${fmtDuration(
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
          stopTask(task, true, 'log-limit')
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

function statusText(task) {
  if (task.status === 'exited') return '已完成'
  if (task.status === 'failed') return `失败（退出码 ${task.exitCode ?? '未知'}）`
  if (task.status === 'stopped') return task.stopReason === 'log-limit' ? '已停止（日志超限）' : '已停止'
  if (task.status === 'lost') return '状态丢失（宿主重启后找不到进程）'
  return '运行中'
}

/** 让模型在启动时就知道「这个任务会不会自己回来」——规则不透明比不回报更糟 */
function reportOutlook(task) {
  const policy = String(settings.reportPolicy || 'long')
  const threshold = Number(settings.reportThresholdMs) || SETTING_DEFAULTS.reportThresholdMs
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

const tools = {
  async bg_start(args, meta) {
    const task = startTask({
      command: args.command,
      label: args.label,
      cwd: args.cwd || meta.cwd,
      sessionFile: meta.sessionFile,
      shell: args.shell,
    })
    // 极短的命令（<2s）在工具返回时就已结束：直接把尾巴带上，省一次 bg_output
    await new Promise((resolve) => setTimeout(resolve, 120))
    const fresh = taskById(task.id)
    if (fresh && fresh.status !== 'running') {
      const tail = await tailOf(fresh)
      const details = {
        id: task.id,
        label: fresh.label,
        status: fresh.status,
        exitCode: fresh.exitCode ?? null,
        shell: fresh.shell,
        durationMs: (fresh.endedAt ?? Date.now()) - fresh.startedAt,
        output: tail || '',
        returnedInline: true,
      }
      const text = [
        `${task.id}「${fresh.label}」已经在 ${details.durationMs}ms 内结束：${statusText(fresh)}。`,
        tail ? `\n最后输出：\n\`\`\`\n${tail}\n\`\`\`` : '\n（该任务没有输出）',
        '\n它已经结束，不需要再查询，也不会再单独回报。',
      ].join('\n')
      return { text, details }
    }
    const outlook = reportOutlook(task)
    const details = {
      id: task.id,
      label: task.label,
      pid: task.pid,
      status: 'running',
      shell: task.shell,
      cwd: task.cwd,
      logPath: task.logPath,
      report: outlook,
    }
    const text = [
      `${task.id}「${task.label}」已在后台启动（shell: ${task.shell}，pid ${task.pid}）。`,
      `回报：${outlook.reason}${outlook.willReport ? '；结束后会自动回到本会话' : '，需要自己查' }。`,
      '任务结束时你会被自动唤醒，不要轮询。想看当前输出用 bg_output。',
    ].join('\n')
    return { text, details }
  },

  async bg_output(args) {
    const task = taskById(String(args.id || ''))
    if (!task) throw new Error(`unknown task: ${args.id}`)
    const waitMs = Math.min(Math.max(Number(args.waitMs) || 0, 0), MAX_OUTPUT_WAIT_MS)
    if (waitMs > 0 && task.status === 'running') {
      // 协作式长轮询：只等「有新输出」，不承诺等到终态（那是 bg_wait，刻意不做）
      const before = await fsp
        .stat(task.logPath)
        .then((s) => s.size)
        .catch(() => 0)
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && task.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 150))
        const now = await fsp
          .stat(task.logPath)
          .then((s) => s.size)
          .catch(() => 0)
        if (now > before) break
      }
    }
    const res = await readLog(task, {
      offset: args.offset === undefined || args.offset === null ? undefined : Number(args.offset),
      maxBytes: args.maxBytes,
      tailLines: args.tailLines ?? REPORT_TAIL_LINES,
    })
    const lines = [`${task.id}「${task.label}」${statusText(task)} · ${fmtDuration((task.endedAt ?? Date.now()) - task.startedAt)}`]
    if (res.totalBytes) lines.push(`日志 ${fmtBytes(res.nextOffset)}/${fmtBytes(res.totalBytes)}`)
    if (!res.chunk) lines.push(res.running ? '暂时还没有输出。' : '没有输出。')
    else lines.push('', '```', res.chunk.replace(/\n$/, ''), '```')
    if (res.hasMore) lines.push(`还有 ${fmtBytes(res.totalBytes - res.nextOffset)} 未读，下次传 offset=${res.nextOffset}。`)
    return {
      text: lines.join('\n'),
      details: {
        id: res.id,
        status: res.status,
        running: res.running,
        exitCode: res.exitCode,
        chunk: res.chunk,
        chunkBytes: res.chunkBytes,
        nextOffset: res.nextOffset,
        totalBytes: res.totalBytes,
        hasMore: res.hasMore,
        truncated: res.truncated,
        logPath: task.logPath,
      },
    }
  },

  async bg_stop(args) {
    const task = taskById(String(args.id || ''))
    if (!task) throw new Error(`unknown task: ${args.id}`)
    const stopped = stopTask(task, args.force === true)
    const settled = stopped ? await waitForTerminal(task, args.waitMs ?? 0) : true
    const details = {
      id: task.id,
      status: task.status,
      stopRequested: stopped,
      settled,
      exitCode: task.exitCode ?? null,
      stopReason: task.stopReason ?? null,
      durationMs: (task.endedAt ?? Date.now()) - task.startedAt,
    }
    const text = !stopped
      ? `${task.id} 已经不在运行（当前状态：${statusText(task)}），无需停止。`
      : settled
        ? `${task.id} 已停止（${task.stopReason === 'log-limit' ? '日志超限' : '主动停止'}），耗时 ${fmtDuration(details.durationMs)}。exitCode 为 null——判断结果请看 status，被杀掉的进程退出码没有意义。`
        : `${task.id} 已发出停止请求，但 ${args.waitMs}ms 内还没退出。稍后用 bg_list 确认，或传更大的 waitMs。`
    return { text, details }
  },

  async bg_list(args) {
    const want = args.status ? String(args.status) : ''
    const now = Date.now()
    const tasks = state.tasks
      .filter((t) => !want || t.status === want)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((t) => ({
        id: t.id,
        label: t.label,
        status: t.status,
        exitCode: t.exitCode ?? null,
        shell: t.shell,
        startedAt: t.startedAt,
        durationMs: (t.endedAt ?? now) - t.startedAt,
        report: t.report,
        cwd: t.cwd,
      }))
    const running = tasks.filter((t) => t.status === 'running').length
    const policy = String(settings.reportPolicy || 'long')
    const text = tasks.length
      ? [`${tasks.length} 个任务（${running} 个运行中，回报策略 ${policy}，新→旧）：`]
          .concat(tasks.map((t) => `${t.id} · ${statusText(t)} · ${fmtDuration(t.durationMs)} · ${t.label}`))
          .join('\n')
      : '没有符合条件的后台任务。'
    return { text, details: { tasks, running, reportPolicy: policy, thresholdMs: Number(settings.reportThresholdMs) || SETTING_DEFAULTS.reportThresholdMs } }
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
        shell: t.shell,
        status: t.status,
        exitCode: t.exitCode,
        stopReason: t.stopReason ?? null,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        durationMs: (t.endedAt ?? now) - t.startedAt,
        bytes: t.bytes,
        report: t.report,
        reportNote: t.reportNote ?? null,
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
    if (task.status === 'running') stopTask(task, true, 'user')
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
  const dataRoot = ctx.dataDir || path.join(os.tmpdir(), 'pi-background-tasks')
  logDir = path.join(dataRoot, 'logs')
  // powershell 任务要一个 .ps1 落点：直接塞命令行会被引号转义搞坏
  scriptDir = path.join(dataRoot, 'scripts')
  fs.mkdirSync(logDir, { recursive: true })
  fs.mkdirSync(scriptDir, { recursive: true })

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

  ctx.log(
    `background-tasks active, ${state.tasks.length} task(s), log dir ${logDir}, shell ${
      process.platform === 'win32' ? findBash() || 'cmd (bash not found)' : process.env.SHELL || 'sh'
    }`,
  )
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
