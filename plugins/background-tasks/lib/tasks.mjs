// @ts-check
/**
 * 任务生命周期：启动、子进程绑定、终态、超时、停止、重启接管。
 *
 * 三条与 Electron 相关的硬约束（写代码前必看，都是踩过的坑）：
 *   1. Windows 上刻意不 detached——Electron 主进程里 detached 子进程表现为「起了但
 *      从不退出、也不产出任何输出」。但 Windows 的 `taskkill /T` 在 MSYS 进程树上
 *      杀不到最内层（Git Bash 的 fork 把子进程的 Windows 父 PID 指向一个已退出的
 *      fork helper，父子链是断的），所以停止时必须先用 pidfile 里的 msys 进程组 id
 *      做 `kill -9 -<pgid>` 组杀。POSIX 上反过来：必须 detached 让子进程当组长，
 *      否则 `kill(-pid)` 指的仍是宿主进程组（见 stopTask）。
 *   2. 输出不经宿主内存：shell 自己把 stdout/stderr 重定向到两个文件（见 shell.mjs）。
 *   3. 超时定时器不落盘：它是「防呆」不是「调度」，重启后按 startedAt 重算剩余时间。
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'

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
const { labelOf, alive } = await imp('format')
const { buildSpawnSpec, findBash } = await imp('shell')
const { tryRemoveFile } = await imp('files')
const { save, pruneTasks } = await imp('store')
const { pushBarForTask } = await imp('compose-bar')
const { scheduleReport } = await imp('report')

/** 超时下限：5 秒以下的任务本来就是同步工具该干的活 */
const MIN_TIMEOUT_MS = 5_000
/** 超时上限：一天。再长就不该用超时兜底，而该自己盯着 */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000
const MAX_STOP_WAIT_MS = 10_000
const PROBE_MS = 3_000

/** 活着的子进程句柄（不在 storage 里，重启即丢，靠 pid 探测接管） */
const children = new Map()
/** task id → 超时定时器；不落盘，重启后按 startedAt 重算 */
const timeouts = new Map()
let probeTimer = null
/**
 * 本代是否已停用。子进程是跨代桥：deactivate 后进程还活着（设计红线：不杀任务），
 * 它退出时旧代的 exit 监听若还在，会用**旧代的 state** save()——storage.set 是整份
 * 覆盖，刚被新代建好的任务表会被抹掉，还会对着会话重复回报（复审 P1）。
 * disposeTasks 摘监听是第一道闸，这个标志是第二道。
 */
let disposed = false

export function startTask({ command, label, cwd, sessionFile, shell, timeoutSeconds }) {
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

  const prevSeq = rt.state.seq
  rt.state.seq += 1
  const id = `bg-${rt.state.seq}`
  const logPath = path.join(rt.logDir, `${id}.log`)
  const errPath = path.join(rt.logDir, `${id}.err`)
  // MSYS 进程组 id 的落点：停止时按它整组收（Windows 上 taskkill /T 杀不到最内层）
  const pidPath = path.join(rt.logDir, `${id}.pid`)
  fs.mkdirSync(rt.logDir, { recursive: true })

  let spec
  try {
    // 先建空文件：路径/权限问题要在启动时暴露，而不是让 shell 悄悄失败
    fs.writeFileSync(logPath, '')
    fs.writeFileSync(errPath, '')
    spec = buildSpawnSpec({ command: cmd, logPath, errPath, pidPath, requestedShell: shell, id })
  } catch (error) {
    // 校验（cmd 下的 bash 语法、找不到 bash）发生在文件建好之后——被拒绝的启动
    // 不能留下孤儿日志：它们没有任务记录，bg_clear 永远够不着（v8 报告 §八.3）。
    // seq 也退回去，让被拒的 id 不被占用（否则任务列表里出现无解释的空号）。
    rt.state.seq = prevSeq
    tryRemoveFile(logPath)
    tryRemoveFile(errPath)
    throw error
  }
  let child
  try {
    child = spec.line
      ? spawn(spec.line, {
          cwd: workdir,
          shell: true,
          windowsHide: true,
          // 刻意不 detached：见文件头注释第 1 条
          stdio: 'ignore',
        })
      : spawn(spec.file, spec.args, {
          cwd: workdir,
          windowsHide: true,
          stdio: 'ignore',
          // POSIX 上 detached 让子进程当进程组组长；Windows 分支返回 false（见文件头）
          detached: spec.detached === true,
        })
  } catch (error) {
    rt.state.seq = prevSeq
    tryRemoveFile(logPath)
    tryRemoveFile(errPath)
    // powershell 的 .ps1 也是启动副产物：spawn 失败时它已经在盘上了，
    // 不同样收掉就是一个 bg_clear 永远够不着的孤儿（复审 P2）
    tryRemoveFile(path.join(rt.scriptDir, `${id}.ps1`))
    throw error
  }

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
    /** msys 进程组 id 的落点（只有 Windows 的 bash 任务有），停止时按它整组收 */
    pidFile: spec.pidFile ?? null,
    timeoutMs: timeoutMs || undefined,
    bytes: 0,
    errBytes: 0,
    report: 'pending',
    reportedAt: null,
    recovered: false,
  }
  rt.state.tasks.unshift(task)
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
export function armTimeout(task) {
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

export function clearTimeoutFor(task) {
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

export function finishTask(task, { code = null, signal = null, error = null } = {}) {
  // 旧代收尾闸：停用后子进程退出不该再写盘/回报（见 disposed 的注释）
  if (disposed) return
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

/** pidfile 里的 msys 进程组 id；读不到就是 0（cmd/powershell 任务本来就没有） */
function readMsysPgid(task) {
  // 重启接管来的旧记录没有 pidFile 字段：按命名约定再找一次，
  // 磁盘上还在的话照样能整组收（不在就只能退回 taskkill /T）
  const file = task.pidFile || (rt.logDir && task.id ? path.join(rt.logDir, `${task.id}.pid`) : null)
  if (!file) return 0
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

/**
 * 进程组里是否还有活口。
 *
 * Windows 的组是 MSYS 自己的概念（与 Windows 进程组无关），只能借 bash 内建 kill
 * 判定；POSIX 上 detached 让 task.pid 就是 pgid，直接 kill(-pgid, 0)。
 * 判不出来一律当「已消失」——等待是为了确认收干净，不是为了拖住调用方。
 */
function groupAlive(task) {
  if (process.platform !== 'win32') {
    if (!Number.isInteger(task.pid) || task.pid <= 0) return Promise.resolve(false)
    try {
      process.kill(-task.pid, 0)
      return Promise.resolve(true)
    } catch (error) {
      return Promise.resolve(error?.code === 'EPERM')
    }
  }
  const pgid = readMsysPgid(task)
  const bash = pgid ? findBash() : null
  if (!pgid || !bash) return Promise.resolve(false)
  return new Promise((resolve) => {
    let probe
    try {
      probe = spawn(bash, ['-c', `kill -0 -${pgid} 2>/dev/null`], { windowsHide: true, stdio: 'ignore' })
    } catch {
      resolve(false)
      return
    }
    probe.on('error', () => resolve(false))
    probe.on('exit', (code) => resolve(code === 0))
  })
}

/**
 * 向任务树发信号。
 *
 * **Windows 为什么不能只 taskkill /T**：Git Bash 的 MSYS fork 会把子进程的 Windows
 * 父 PID 指向一个已退出的 fork helper——`ps -W` 看 sleep 的父是 msys bash，CIM 看却是
 * 一个早已不在的 winpid。父子链断了，任何「按 Windows 树杀」的办法（taskkill /T、
 * 递归 CIM）都只能杀到 bash 层，最内层的 sleep/node 永远漏网，日志句柄也不释放。
 * 正确解法是走 MSYS 自己的进程组：pidfile 里的 `$$` 同时就是 pgid，`kill -9 -pgid`
 * 一发就把 bash、子 shell 和所有后代一起收掉（实测 100ms 内消失）。
 *
 * 组杀与 taskkill 都要发：组杀负责后代，taskkill 负责 launcher 本身与原生子树。
 */
function signalTree(task, force) {
  if (process.platform === 'win32') {
    const pgid = task.shell === 'bash' ? readMsysPgid(task) : 0
    const bash = pgid ? findBash() : null
    if (bash) {
      try {
        // 一律 -9：这是「停止后台任务」，用 TERM 留一线只会让忽略 TERM 的命令赖着不走。
        // 温和退出的语义在 bg_stop 的 force 里，而原实现（taskkill /F）本来就从不温和。
        spawn(bash, ['-c', `kill -9 -${pgid}`], { windowsHide: true, stdio: 'ignore' })
      } catch {
        /* 组已经没了 */
      }
    }
    if (Number.isInteger(task.pid) && task.pid > 0) {
      spawn('taskkill', ['/PID', String(task.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
    return
  }
  // POSIX：detached 出来的子进程是组长，负 pid 才是「收整组」；
  // 单 pid 只收 shell 自己，它们起的孙进程会变成孤儿继续跑
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

export function stopTask(task, force, reason = 'user') {
  if (task.status !== 'running') return false
  task.stopRequested = true
  task.stopReason = reason
  // 有句柄就顺手收掉监听，避免子进程被 taskkill 后我们这边毫无感知
  if (!alive(task.pid)) {
    finishTask(task, { code: null, signal: null })
    return true
  }
  signalTree(task, force)
  return true
}

/**
 * 等到任务离开 running（或超时）。bg_stop 用它去掉「再查一次」这一步。
 *
 * launcher 退出 ≠ 任务树清空：bash 先退、`sleep` 还挂在 MSYS 组里的窗口真实存在
 * （报告 §1.1 的「已停止但日志被锁」就是它）。所以终态之后再确认组里没活口，
 * 等不到就补一刀 KILL——回执说「已停止」时，进程必须真的没了。
 */
export async function waitForTerminal(task, waitMs) {
  const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), MAX_STOP_WAIT_MS)
  while (task.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (task.status === 'running') return false
  // 组消失的等待给固定 1.5s：这是收尾确认，不该被调用方传的 waitMs（可能为 0）掐掉
  const groupDeadline = Date.now() + 1500
  let escalated = false
  while (await groupAlive(task)) {
    if (Date.now() > groupDeadline) break
    if (!escalated) {
      // 组还在：要么 TERM 被忽略，要么 taskkill 只收掉了 launcher。补一次强杀
      escalated = true
      signalTree(task, true)
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return true
}

/** 文件大小，读不到就当 0（日志可能还没建出来 / 已被清理） */
export function statSize(file) {
  if (!file) return 0
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * 重启接管：按 pid 探测。进程还活着就继续盯（轮询），死了就如实记 lost。
 * 不自动补报：重启瞬间可能有一批任务同时变 lost，一次性推给模型只是噪声；
 * 记成 skipped + 原因，面板据此给出「重新回报」入口，语义与事实一致。
 */
export function recover() {
  // 测试进程里模块实例跨 activate 复用：重新激活 = 本代重新算数
  disposed = false
  const now = Date.now()
  let changed = false
  for (const task of rt.state.tasks) {
    if (task.status !== 'running') continue
    task.recovered = true
    changed = true
    if (alive(task.pid)) continue
    // 宿主退出期间任务早就结束了：pid 不在，退出码永远拿不到，如实记 lost
    task.status = 'lost'
    task.endedAt = task.endedAt ?? now
    // 不自动补报：重启瞬间可能有一批任务同时变 lost，一次性推给模型只是噪声，
    // 而且日志尾巴早被截断，报出来的结果也没什么价值。但也不能写成 'pending'——
    // 那表示「马上会来」，而实际上没有任何调度路径会送它（面板会一直挂着「待回报」）。
    // 记成 skipped + 原因，面板据此给出「重新回报」入口，语义与事实一致。
    task.report = 'skipped'
    task.reportNote = '宿主重启时丢失进程，需手动重新回报'
  }
  // 只在确实动过表时落盘：任务表都没读到（load 失败）时这里若写盘，
  // 空表会把磁盘上那份还没读出来的记录整个抹掉
  if (changed) save()
  // 超时定时器不落盘：接管来的任务按 startedAt 重算剩余时间，已过期的立刻到点
  for (const task of rt.state.tasks) {
    if (task.status === 'running') armTimeout(task)
  }

  probeTimer = setInterval(() => {
    let changed = false
    const cap = Math.max(1, Number(rt.settings.maxLogMb) || SETTING_DEFAULTS.maxLogMb) * 1024 * 1024
    for (const task of rt.state.tasks) {
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

/**
 * 插件停用时的清理。
 *
 * 只解定时器与句柄记账，**不杀任务**：用户可能正等它出结果，重启后 recover() 再接管。
 * 超时定时器只是「谁盯着」而非「任务本身」，插件卸载后不再兜底。
 */
export function disposeTasks() {
  disposed = true
  if (probeTimer) clearInterval(probeTimer)
  probeTimer = null
  for (const timer of timeouts.values()) clearTimeout(timer)
  timeouts.clear()
  // 进程句柄保留（不杀任务），但监听必须摘掉：exit 回调闭包捕获的是本代的
  // state/save/report——留着它们，旧代就会跨代写盘、重复回报（见 disposed 注释）。
  // 只摘 exit/close（Node 22 实测 child 上没有内部 EventEmitter 监听，但按事件名摘
  // 更稳）；'error' 补一个 noop——无监听的 error 事件是 uncaught exception，会崩宿主
  for (const child of children.values()) {
    try {
      child.removeAllListeners('exit')
      child.removeAllListeners('close')
      child.on('error', () => {})
    } catch {
      /* 句柄已经失效就不必再处理 */
    }
  }
  children.clear()
}
