// @ts-check
/**
 * 任务生命周期：启动、子进程绑定、终态、超时、停止、重启接管。
 *
 * 三条与 Electron 相关的硬约束（写代码前必看，都是踩过的坑）：
 *   1. 刻意不 detached——Electron 主进程里 detached 子进程表现为「起了但从不退出、
 *      也不产出任何输出」。宿主退出时 Node 不会主动杀子进程，所以任务照样能活；
 *      停任务时按 pid 直接杀（Windows 走 taskkill /T 连带子进程树）。
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
const { buildSpawnSpec } = await imp('shell')
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
  fs.mkdirSync(rt.logDir, { recursive: true })

  let spec
  try {
    // 先建空文件：路径/权限问题要在启动时暴露，而不是让 shell 悄悄失败
    fs.writeFileSync(logPath, '')
    fs.writeFileSync(errPath, '')
    spec = buildSpawnSpec({ command: cmd, logPath, errPath, requestedShell: shell, id })
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

export function stopTask(task, force, reason = 'user') {
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
export async function waitForTerminal(task, waitMs) {
  const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), MAX_STOP_WAIT_MS)
  while (task.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return task.status !== 'running'
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
  // state/save/report——留着它们，旧代就会跨代写盘、重复回报（见 disposed 注释）
  for (const child of children.values()) {
    try {
      child.removeAllListeners()
    } catch {
      /* 句柄已经失效就不必再处理 */
    }
  }
  children.clear()
}
