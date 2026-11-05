/**
 * 后台任务 — main 侧服务。
 *
 * 给会话一套「起长命令、干别的、跑完自己回来汇报」的能力。pi 内置的 bash 工具是
 * 同步等待的，长命令会把一轮对话卡死；这里把进程 detached 出去、输出直写日志文件，
 * 任务结束时通过 ctx.sessions.send 把结果投回发起它的那个会话。
 *
 * 契约：
 *   invoke('tool.execute', { name, args, sessionFile, cwd, signal }) → { text, details? }
 *   invoke('listTasks' | 'readOutput' | 'stopTask' | 'removeTask' | 'retryReport'
 *          | 'rerunTask' | 'clearTasks' | 'refreshBar')
 *   invoke('composerBarAction', { action: 'select' | 'stop', id })
 *        → 输入框托盘的点击回调；select 顺带把 focus.seq +1，右栏面板比 seq 翻到那一条
 *
 * 三条设计红线（见 doc/dev/background-tasks-design.md）：
 *   1. 输出不经宿主内存：由 shell 把 stdout/stderr 分别重定向到两个文件，
 *      几百 MB 也压不垮 main 进程。分流是为了让「失败时看 stderr」不用翻整份日志。
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
/** 超时下限：5 秒以下的任务本来就是同步工具该干的活 */
const MIN_TIMEOUT_MS = 5_000
/** 超时上限：一天。再长就不该用超时兜底，而该自己盯着 */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

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
/**
 * 已判定「不该再有任何回报」的 id。
 *
 * 为什么不只靠 state.tasks.includes：删除流程里有 await（停进程最多 3s），而队列
 * 可能刚好在这段窗口里被 flush 取走——取走之后 dropQueuedReports 就找不到它了。
 * 这个集合在删除动作的**第一个 await 之前**写入，deliver 前统一比对，把窗口压到同步段。
 * 保留 60s 是为了兜住「进程退出事件晚于记录删除」的回调。
 */
const deletedIds = new Set()
/** 活着的子进程句柄（不在 storage 里，重启即丢，靠 pid 探测接管） */
const children = new Map()
/** task id → 超时定时器；不落盘，重启后按 startedAt 重算 */
const timeouts = new Map()

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

/**
 * 会话条点开某条任务时，右栏面板要「自动翻到那一条」。
 * 用 seq 而不是布尔：同一个任务连点两次也要能再次把用户拽回来，面板侧比较 seq 变化即可。
 * 不落盘——这是「谁在看什么」的界面状态，不是任务事实。
 */
let focus = { id: null, seq: 0 }

/** 会话路径归一化：大小写、分隔符、尾斜杠在两端都可能不一致 */
function normSession(p) {
  const s = String(p || '').trim()
  if (!s) return ''
  return s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 判断两个 sessionFile 是不是同一个会话。
 * 全路径相等最可靠；退一步比 basename——同一份会话在不同入口可能带不同的前缀
 * （工作区相对路径 vs 绝对路径），而 pi 的会话文件名本身带唯一 id，撞名几乎不可能。
 */
function sameSession(a, b) {
  const x = normSession(a)
  const y = normSession(b)
  if (!x || !y) return false
  if (x === y) return true
  return path.posix.basename(x) === path.posix.basename(y)
}

// ---------- 输入框托盘 ----------

const PLUGIN_ID = 'background-tasks'
/** 右栏面板的完整 id（宿主 catalog 里的形式） */
const PANEL_ID = `plugin:${PLUGIN_ID}:tasks`
/** 托盘里最多列几条：再多就该去右栏看，而不是把输入框顶上去 */
const BAR_MAX_ROWS = 8

function barMeta(task) {
  if (task.status === 'failed') return `退出码 ${task.exitCode ?? '?'}`
  if (task.status === 'stopped') return task.stopReason === 'timeout' ? '已超时' : '已停止'
  if (task.status === 'lost') return '状态丢失'
  return fmtDuration((task.endedAt ?? Date.now()) - task.startedAt)
}

/**
 * 这个会话在托盘里该显示什么。
 *
 * 归属判断留在 main（sameSession）而不是 UI：工具侧的 sessionFile 来自 worker，
 * 推送侧也只是插件自己知道的值，归一化只该有一份实现，两份早晚会漂。
 */
function composerBarFor(sessionFile) {
  const mine = state.tasks.filter((t) => sameSession(t.sessionFile, sessionFile))
  if (mine.length === 0) return null
  const running = mine.filter((t) => t.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
  const failed = mine.filter((t) => t.status === 'failed' || t.status === 'lost')
  const summary = running.length
    ? `${running.length} 个任务在运行`
    : failed.length
      ? `${failed.length} 个任务失败`
      : `${mine.length} 个任务已结束`
  const ordered = [...running, ...mine.filter((t) => t.status !== 'running').sort((a, b) => b.startedAt - a.startedAt)]
  return {
    summary,
    detail: (running[0] ?? failed[0] ?? ordered[0])?.label ?? '',
    tone: running.length ? 'running' : failed.length ? 'error' : 'done',
    rows: ordered.slice(0, BAR_MAX_ROWS).map((t) => ({
      id: t.id,
      label: t.label,
      status: t.status,
      // 运行中的耗时由宿主现算：推一次就固化的「12s」会骗人
      ...(t.status === 'running' ? { startedAt: t.startedAt, action: 'stop' } : { meta: barMeta(t) }),
    })),
    panelId: PANEL_ID,
  }
}

/** 把某个会话的托盘状态推给宿主；bar 为 null 表示这个会话没东西可显示 */
function pushComposerBar(sessionFile) {
  if (!sessionFile) return
  try {
    ctx?.ui?.setComposerBar?.(sessionFile, composerBarFor(sessionFile))
  } catch (error) {
    // 托盘是锦上添花：推不动不能影响任务本身
    ctx?.log?.('composer bar push failed', error)
  }
}

/** 某条任务变了之后刷新它所属会话的托盘 */
function pushBarForTask(task) {
  if (task?.sessionFile) pushComposerBar(task.sessionFile)
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

/** 工具返回里的结构化出口：`format:'json'` 时把 details 原样交出去，省得调用方用正则解析排版 */
function jsonBlock(payload) {
  return ['```json', JSON.stringify(payload, null, 2), '```'].join('\n')
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

/** stdout 与 stderr 分别落盘：失败细节通常只在后者里，混在一起就得整份翻 */
function logPathFor(task, stream) {
  return stream === 'err' ? task.errPath || '' : task.logPath
}

async function readLog(task, { offset, maxBytes, tailLines, stream }) {
  const file = logPathFor(task, stream)
  if (!file) {
    return { id: task.id, status: task.status, running: task.status === 'running', exitCode: task.exitCode ?? null, chunk: '', chunkBytes: 0, nextOffset: 0, totalBytes: 0, hasMore: false, truncated: false, stream: stream === 'err' ? 'err' : 'out' }
  }
  const size = await fsp
    .stat(file)
    .then((s) => s.size)
    .catch(() => 0)
  // 64B 是编码安全的下限（够放一个多字节字符），不再有 1KB 的隐式抬升
  const requested = Number(maxBytes) || READ_CHUNK_DEFAULT
  const cap = Math.min(Math.max(requested, MIN_READ_BYTES), READ_CHUNK_MAX)
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
    stream: stream === 'err' ? 'err' : 'out',
    requestedMaxBytes: requested,
    /** 实际生效的切片大小：被上下限夹过时与请求值不同，调用方不该猜 */
    effectiveMaxBytes: cap,
  }
  if (end <= start) return out
  let handle = null
  try {
    handle = await fsp.open(file, 'r')
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

async function tailOf(task, stream) {
  const res = await readLog(task, { tailLines: REPORT_TAIL_LINES, maxBytes: 32 * 1024, stream })
  const text = res.chunk.trim()
  return text.length > REPORT_MAX_CHARS ? `${text.slice(0, REPORT_MAX_CHARS)}\n…（已截断）` : text
}

async function countLines(task, stream) {
  const file = logPathFor(task, stream)
  if (!file) return null
  try {
    const size = await fsp.stat(file).then((s) => s.size)
    if (size > COUNT_LINES_MAX_BYTES) return null
    const text = await fsp.readFile(file, 'utf8')
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
 *
 * stdout 与 stderr 分成两个文件：失败时只需读几百字节的 stderr，不必在几万行
 * 正常输出里翻错误。两者都用 >> 追加，文件预先建空，等价于覆盖。
 */
function buildSpawnSpec({ command, logPath, errPath, requestedShell, id }) {
  const want = String(requestedShell || 'auto').toLowerCase()

  if (process.platform !== 'win32') {
    const file = want === 'bash' ? findBash() : '/bin/sh'
    return {
      kind: want === 'bash' ? 'bash' : 'sh',
      file: file || '/bin/sh',
      args: ['-c', `(${command}) >> ${bashQuote(logPath)} 2>> ${bashQuote(errPath)}`],
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
      line: `chcp 65001>nul & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" >> "${logPath}" 2>> "${errPath}"`,
    }
  }

  if (want === 'cmd') {
    assertCmdCompatible(command)
    return {
      kind: 'cmd',
      file: null,
      args: null,
      line: `chcp 65001>nul & (${command}) >> "${logPath}" 2>> "${errPath}"`,
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
      args: ['-c', `(${command}) >> ${bashQuote(logPath)} 2>> ${bashQuote(errPath)}`],
      line: null,
    }
  }
  // 没有 bash 才回落 cmd：此时必须拦住 bash 语法，避免静默错执行
  assertCmdCompatible(command)
  return {
    kind: 'cmd',
    file: null,
    args: null,
    line: `chcp 65001>nul & (${command}) >> "${logPath}" 2>> "${errPath}"`,
  }
}

function startTask({ command, label, cwd, sessionFile, shell, timeoutSeconds }) {
  const cmd = String(command || '').trim()
  if (!cmd) throw new Error('command required')
  const workdir = String(cwd || '').trim() || process.cwd()
  if (!fs.existsSync(workdir)) throw new Error(`cwd does not exist: ${workdir}`)

  let timeoutMs = Math.round((Number(timeoutSeconds) || 0) * 1000)
  if (timeoutMs > 0) {
    // 小于下限不报错，抬到下限——模型传 1 秒多半是想「快点结束」，抬到 5 秒仍符合意图
    timeoutMs = Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
  } else {
    timeoutMs = 0
  }

  state.seq += 1
  const id = `bg-${state.seq}`
  const logPath = path.join(logDir, `${id}.log`)
  const errPath = path.join(logDir, `${id}.err`)
  fs.mkdirSync(logDir, { recursive: true })
  // 先建空文件：路径/权限问题要在启动时暴露，而不是让 shell 悄悄失败
  fs.writeFileSync(logPath, '')
  fs.writeFileSync(errPath, '')

  const spec = buildSpawnSpec({ command: cmd, logPath, errPath, requestedShell: shell, id })
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
    errPath,
    timeoutMs: timeoutMs || undefined,
    bytes: 0,
    errBytes: 0,
    report: 'pending',
    reportedAt: null,
    recovered: false,
  }
  state.tasks.unshift(task)
  pruneTasks()
  save()

  bindChild(task, child)
  armTimeout(task)
  pushBarForTask(task)
  return task
}

/**
 * 超时兜底。
 *
 * 为什么需要：模型起一个 `npm run dev` 之后忘了收，任务会挂到天亮——日志上限只能
 * 挡住刷盘，挡不住一个安静的空转进程。超时是「防呆」而不是「调度」，所以不落盘、
 * 重启后按 startedAt 重算剩余时间。
 */
function armTimeout(task) {
  const ms = Number(task.timeoutMs) || 0
  if (ms <= 0) return
  if (task.status !== 'running') return
  const remaining = Math.max(0, task.startedAt + ms - Date.now())
  const timer = setTimeout(() => {
    timeouts.delete(task.id)
    if (task.status !== 'running') return
    task.timedOutAt = Date.now()
    task.error = `超过 ${Math.round(ms / 1000)}s 超时上限，已终止`
    stopTask(task, true, 'timeout')
  }, remaining)
  if (typeof timer.unref === 'function') timer.unref()
  timeouts.set(task.id, timer)
}

function clearTimeoutFor(task) {
  const timer = timeouts.get(task.id)
  if (!timer) return
  clearTimeout(timer)
  timeouts.delete(task.id)
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
  clearTimeoutFor(task)
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
  pushBarForTask(task)
}

async function refreshBytes(task) {
  const size = (file) => fsp.stat(file).then((s) => s.size).catch(() => 0)
  const [out, err] = await Promise.all([size(task.logPath), task.errPath ? size(task.errPath) : 0])
  task.bytes = out
  task.errBytes = err
  save()
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

/** 文件大小，读不到就当 0（日志可能还没建出来 / 已被清理） */
function statSize(file) {
  if (!file) return 0
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** 一条任务的两个输出文件，删记录时一起收掉，别留孤儿日志 */
function removeTaskFiles(task) {
  for (const file of [task.logPath, task.errPath]) {
    if (!file) continue
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* 文件可能已经不在 */
    }
  }
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
    removeTaskFiles(victim)
  }
}

// ---------- 回报 ----------

function scheduleReport(task) {
  // 防御性去重：同一个任务只允许被自动回报一次（retryReport 走的是显式通道）
  if (task.report === 'sent') return
  // 记录已被清理（进程退出事件可能晚于 bg_clear 到达）：再入队就是一条死链
  if (deletedIds.has(task.id)) return
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
  const key = task.sessionFile
  let queue = reportQueues.get(key)
  if (!queue) {
    queue = { items: [], timer: null }
    reportQueues.set(key, queue)
  }
  // 同一任务只排一次：exit / close 两个回调都可能触发 scheduleReport
  if (queue.items.some((t) => t.id === task.id)) return
  task.report = 'pending'
  queue.items.push(task)
  if (queue.timer) return
  // 合并窗口：同一会话短时间内的多个完成事件只唤醒一次
  queue.timer = setTimeout(() => {
    queue.timer = null
    void flushReports(key)
  }, MERGE_WINDOW_MS)
}

/**
 * 撤掉排队中、但已经不该发的回报。
 *
 * 两种来源：记录被删/被清（回报会指向一个不存在的任务，用户看到的是死链），
 * 以及用户已经在 bg_stop 里同步拿到了终态（再推一遍是重复信息）。
 * 只动队列不动 timer 的话，用户仍会在 5 秒后收到一条幽灵回报。
 */
function dropQueuedReports(ids) {
  const set = new Set(ids)
  if (set.size === 0) return
  for (const [sessionFile, queue] of reportQueues) {
    const kept = queue.items.filter((t) => !set.has(t.id))
    if (kept.length === queue.items.length) continue
    queue.items = kept
    if (kept.length === 0) {
      if (queue.timer) clearTimeout(queue.timer)
      reportQueues.delete(sessionFile)
    }
  }
}

/** 显式动作已经交付过结果：把这条的自动回报关掉，并记下原因 */
function suppressReport(task, reason) {
  dropQueuedReports([task.id])
  if (task.report === 'sent') return
  task.report = 'suppressed'
  task.reportNote = reason
}

/**
 * 删除流程的统一入口：先「宣布死亡」，再慢慢收尸。
 *
 * 调用点必须在任何 await 之前——队列的 flush 是异步的（合并窗口 + 读日志文件），
 * 只删记录不先标记，就会出现「记录没了、回报照发」的孤儿消息。
 */
function markDeleted(ids) {
  if (!ids.length) return
  for (const id of ids) {
    deletedIds.add(id)
    // 60s 足够覆盖晚到的 exit 回调；unref 避免拖住宿主退出
    setTimeout(() => deletedIds.delete(id), 60_000).unref?.()
  }
  dropQueuedReports(ids)
}

async function flushReports(sessionFile) {
  const queue = reportQueues.get(sessionFile)
  if (!queue) return
  reportQueues.delete(sessionFile)
  const items = queue.items.splice(0)
  // 从「队列取走」到「真正投递」之间记录可能已被清理：先剔掉，别让 skipped 计数跟着虚高
  const alive = items.filter((t) => !deletedIds.has(t.id))
  if (!alive.length) return
  const detailed = alive.slice(0, MAX_DETAILED_REPORTS)
  const skipped = alive.length - detailed.length
  for (const task of detailed) {
    task.tailText = await tailOf(task)
    task.lineCount = await countLines(task)
    // stderr 有内容就带上：失败了它是唯一有用的一段，成功了往往也埋着警告
    if (task.errBytes > 0 || task.status !== 'exited') {
      const err = await tailOf(task, 'err')
      if (err) task.errTailText = err
    }
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
      lines.push('最后输出（stdout）：')
      lines.push('```')
      lines.push(task.tailText)
      lines.push('```')
    } else {
      lines.push('（该任务没有 stdout 输出）')
    }
    if (task.errTailText) {
      lines.push('stderr：')
      lines.push('```')
      lines.push(task.errTailText)
      lines.push('```')
    }
    const size = task.bytes ? fmtBytes(task.bytes) : ''
    const errSize = task.errBytes ? fmtBytes(task.errBytes) : ''
    const count = task.lineCount ? `共 ${task.lineCount} 行` : ''
    const meta = [count, size, errSize ? `stderr ${errSize}` : ''].filter(Boolean).join(' / ')
    lines.push(`完整日志：${task.logPath}${meta ? `（${meta}）` : ''}，需要更多内容时用 bg_output 读（传 stream:'err' 看错误输出）。`)
    blocks.push(lines.join('\n'))
  }
  if (skipped > 0) blocks.push(`另外还有 ${skipped} 个任务也结束了，详见面板「后台任务」。`)
  blocks.push('请基于以上结果继续你的工作，不要重复启动相同的任务。')
  return blocks.join('\n\n')
}

async function deliver(sessionFile, items, skipped) {
  // 二次校验：从入队到真正投递之间，这条记录可能已经被删除/清理了。
  // 投一条「bg-14 已失败」而 bg-14 早已不存在，用户只会去查一个空 id。
  // 按 id 比对而不是对象引用：插件重载后 state 里的对象可能被重建过。
  const live = items.filter((t) => !deletedIds.has(t.id) && state.tasks.some((x) => x.id === t.id))
  if (live.length === 0) {
    for (const task of items) delete task.tailText
    return
  }
  const content = buildReport(live, skipped)
  try {
    await ctx.sessions.send({
      sessionFile,
      content,
      origin: {
        pluginId: PLUGIN_ID,
        label: '后台任务',
        kind: 'report',
        detail: live.map((t) => t.id).join(', '),
      },
    })
    for (const task of live) {
      task.report = 'sent'
      task.reportedAt = Date.now()
      delete task.tailText
    }
  } catch (error) {
    ctx.log('report delivery failed', error)
    for (const task of live) {
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
  // 超时定时器不落盘：接管来的任务按 startedAt 重算剩余时间，已过期的立刻到点
  for (const task of state.tasks) {
    if (task.status === 'running') armTimeout(task)
  }
  // 重启后宿主还没收过任何托盘状态：把有任务的会话各推一次
  for (const sessionFile of new Set(state.tasks.map((t) => t.sessionFile).filter(Boolean))) {
    pushComposerBar(sessionFile)
  }

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
        pushBarForTask(task)
        continue
      }
      // 日志上限：别让一个 while(true) 打满磁盘。stdout + stderr 合并计算
      const outSize = statSize(task.logPath)
      const errSize = statSize(task.errPath)
      if (outSize !== task.bytes || errSize !== (task.errBytes || 0)) {
        task.bytes = outSize
        task.errBytes = errSize
        changed = true
      }
      if (outSize + errSize > cap) {
        task.error = `日志超过 ${Math.round(cap / 1024 / 1024)}MB 上限，已停止`
        stopTask(task, true, 'log-limit')
        changed = true
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
  if (task.status === 'stopped') {
    if (task.stopReason === 'log-limit') return '已停止（日志超限）'
    if (task.stopReason === 'timeout') return `已超时终止（上限 ${Math.round((task.timeoutMs || 0) / 1000)}s）`
    return '已停止'
  }
  if (task.status === 'lost') return '状态丢失（宿主重启后找不到进程）'
  return '运行中'
}

/** 停止原因的人话版本（bg_stop 回执用） */
function stopReasonText(task) {
  if (task.stopReason === 'log-limit') return '日志超限'
  if (task.stopReason === 'timeout') return '超时'
  return '主动停止'
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

/**
 * 启动后的统一回执（bg_start 与 bg_rerun 共用）。
 *
 * 极短的命令（<2s）在工具返回时就已结束：直接把尾巴带上，省一次 bg_output 往返。
 */
async function describeStart(task) {
  await new Promise((resolve) => setTimeout(resolve, 120))
  const fresh = taskById(task.id)
  if (fresh && fresh.status !== 'running') {
    // 回执已经把终态完整交给调用方了：自动回报必须让位。
    // 否则文案写着「不会再单独回报」，几秒后又收到一条，等于自己打自己的脸。
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

const tools = {
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
    const source = taskById(String(args.id || ''))
    if (!source) throw new Error(`unknown task: ${args.id}`)
    if (source.status === 'running') throw new Error(`${source.id} 还在运行，先停止再重跑`)
    const task = startTask({
      command: source.command,
      label: source.label,
      cwd: source.cwd,
      // 重跑通常发生在同一个会话里；换会话重跑时用调用方给的那个
      sessionFile: meta.sessionFile || source.sessionFile,
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

  async bg_clear(args) {
    const wanted = Array.isArray(args.status) ? args.status.map(String) : args.status ? [String(args.status)] : []
    const keepRunning = args.keepRunning !== false
    const victims = state.tasks.filter((t) => {
      if (keepRunning && t.status === 'running') return false
      return wanted.length === 0 || wanted.includes(t.status)
    })
    if (!victims.length) {
      return {
        text: wanted.length
          ? `没有状态为 ${wanted.join(' / ')} 的任务可清理。`
          : '没有已结束的任务可清理（运行中的任务不会被清掉）。',
        details: { cleared: 0, ids: [] },
      }
    }
    const stopping = []
    const ids = victims.map((t) => t.id)
    // 先「宣布删除」再去停进程：下面的 await 最长 3s，队列可能正好在这段时间 flush
    markDeleted(ids)
    for (const task of victims) {
      // keepRunning:false 时会把运行中的也纳入：必须先停进程，否则记录没了、进程还在
      if (task.status === 'running') {
        stopTask(task, true, 'user')
        stopping.push(task)
      }
      clearTimeoutFor(task)
    }
    // 停进程是异步的（Windows 走 taskkill）：等它真的退出再删日志，别删了文件它还在写
    await Promise.all(stopping.map((task) => waitForTerminal(task, 3_000)))
    state.tasks = state.tasks.filter((t) => !ids.includes(t.id))
    save()
    for (const task of victims) removeTaskFiles(task)
    for (const task of victims) pushBarForTask(task)
    const remaining = state.tasks.filter((t) => t.status === 'running').length
    return {
      text: `已清理 ${ids.length} 条任务记录（${ids.join(', ')}）。${remaining ? `仍有 ${remaining} 个任务在运行。` : ''}`,
      details: { cleared: ids.length, ids, running: remaining },
    }
  },

  async bg_output(args) {
    const task = taskById(String(args.id || ''))
    if (!task) throw new Error(`unknown task: ${args.id}`)
    const stream = args.stream === 'err' ? 'err' : 'out'
    const file = logPathFor(task, stream)
    if (!file) throw new Error(`${task.id} 没有 stderr 记录（旧版本任务只保存合并输出）`)
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
    if (!res.chunk) lines.push(res.running ? '暂时还没有输出。' : '没有输出。')
    else lines.push('', '```', res.chunk.replace(/\n$/, ''), '```')
    if (res.hasMore) lines.push(`还有 ${fmtBytes(res.totalBytes - res.nextOffset)} 未读，下次传 offset=${res.nextOffset}。`)
    if (stream === 'out' && (task.errBytes || 0) > 0) {
      lines.push(`这个任务还有 ${fmtBytes(task.errBytes)} 的 stderr 输出，需要时传 stream:'err' 查看。`)
    }
    return { text: lines.join('\n'), details }
  },

  async bg_stop(args) {
    const task = taskById(String(args.id || ''))
    if (!task) throw new Error(`unknown task: ${args.id}`)
    const stopped = stopTask(task, args.force === true)
    const settled = stopped ? await waitForTerminal(task, args.waitMs ?? 0) : true
    // 结果已经在这个工具返回里交付了：撤掉排队中的自动回报，否则 5 秒后又来一条一样的
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
        stopReason: t.stopReason ?? null,
        shell: t.shell,
        startedAt: t.startedAt,
        durationMs: (t.endedAt ?? now) - t.startedAt,
        timeoutMs: t.timeoutMs ?? null,
        bytes: t.bytes ?? 0,
        errBytes: t.errBytes ?? 0,
        report: t.report,
        cwd: t.cwd,
      }))
    const running = tasks.filter((t) => t.status === 'running').length
    const policy = String(settings.reportPolicy || 'long')
    const details = {
      tasks,
      running,
      reportPolicy: policy,
      thresholdMs: Number(settings.reportThresholdMs) || SETTING_DEFAULTS.reportThresholdMs,
    }
    if (args.format === 'json') return { text: jsonBlock(details), details }
    const text = tasks.length
      ? [`${tasks.length} 个任务（${running} 个运行中，回报策略 ${policy}，新→旧）：`]
          .concat(tasks.map((t) => `${t.id} · ${statusText(t)} · ${fmtDuration(t.durationMs)} · ${t.label}`))
          .join('\n')
      : '没有符合条件的后台任务。'
    return { text, details }
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
        errBytes: t.errBytes ?? 0,
        timeoutMs: t.timeoutMs ?? null,
        rerunOf: t.rerunOf ?? null,
        report: t.report,
        reportNote: t.reportNote ?? null,
        error: t.error ?? null,
        logPath: t.logPath,
        errPath: t.errPath ?? null,
        recovered: t.recovered === true,
      })),
      policy: String(settings.reportPolicy || 'long'),
      thresholdMs: Number(settings.reportThresholdMs) || SETTING_DEFAULTS.reportThresholdMs,
      serverNow: now,
      /** 面板比较 seq 变化来「翻到这一条」，见 focusTask */
      focus: { ...focus },
    }
  },

  /**
   * 手动重推某个会话的托盘状态。
   *
   * 正常路径是「任务一变就推」，这里只是兜底：renderer 重载、推送失败、或 UI 刚拿到
   * 会话上下文时，可以要一次最新值，不必等下一次任务事件。
   */
  async refreshBar({ sessionFile } = {}) {
    pushComposerBar(String(sessionFile || ''))
    return { ok: true, bar: composerBarFor(String(sessionFile || '')) }
  },

  /**
   * 托盘里的点击回调（宿主约定的方法名）。
   *
   * 宿主只负责把「点了哪一行、点了什么动作」传回来，不解释业务：select 是看详情，
   * stop 是停任务。详情定位复用 focus.seq——右栏面板自己比对，宿主不必知道这套。
   */
  async composerBarAction({ action, id } = {}) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    if (action === 'stop') {
      const stopped = stopTask(task, false)
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

  async stopTask({ id }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    return { ok: stopTask(task, false), status: task.status }
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

  async clearTasks({ status, keepRunning } = {}) {
    const keep = keepRunning !== false
    const wanted = Array.isArray(status) ? status.map(String) : status ? [String(status)] : []
    const victims = state.tasks.filter((t) => {
      if (keep && t.status === 'running') return false
      return wanted.length === 0 || wanted.includes(t.status)
    })
    const stopping = []
    const ids = victims.map((t) => t.id)
    // 与 bg_clear 同一条不变量：先宣布删除，再等进程退出
    markDeleted(ids)
    for (const task of victims) {
      if (task.status === 'running') {
        stopTask(task, true, 'user')
        stopping.push(task)
      }
      clearTimeoutFor(task)
    }
    await Promise.all(stopping.map((task) => waitForTerminal(task, 3_000)))
    state.tasks = state.tasks.filter((t) => !ids.includes(t.id))
    save()
    for (const task of victims) removeTaskFiles(task)
    for (const task of victims) pushBarForTask(task)
    return { ok: true, cleared: ids.length, ids }
  },

  async removeTask({ id }) {
    const task = taskById(String(id || ''))
    if (!task) throw new Error(`unknown task: ${id}`)
    markDeleted([task.id])
    if (task.status === 'running') stopTask(task, true, 'user')
    clearTimeoutFor(task)
    state.tasks = state.tasks.filter((t) => t.id !== task.id)
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
  // 重载后任务 id 不会复用，旧标记只会变成内存垃圾
  deletedIds.clear()
  // 超时定时器只是「谁盯着」而非「任务本身」：插件卸载后不再兜底，任务继续跑
  for (const timer of timeouts.values()) clearTimeout(timer)
  timeouts.clear()
  children.clear()
}
