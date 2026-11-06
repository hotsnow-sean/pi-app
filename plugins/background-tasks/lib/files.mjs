// @ts-check
/**
 * 日志/脚本文件的删除与孤儿扫尾。
 *
 * 删除在这个插件里从来不是一步：Windows 上进程句柄未释放时 rm 会 EBUSY/EPERM，
 * 所以删不掉的先记进 pendingDeletes，靠扫尾定时器有限次重试；而「没有任务记录」
 * 的孤儿文件（被拒绝的启动、历史上漏删的 ps1）bg_clear 永远够不着——它按记录工作，
 * 只能扫目录收。启动时与每次清理后各扫一遍。
 */
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
const { rt } = await imp('runtime')

/** 日志/脚本目录里的文件名：bg-<数字>.log|err|ps1 */
const TASK_FILE_RE = /^(bg-\d+)\.(log|err|ps1)$/
/** 删不掉的文件（句柄未释放）：扫尾时重试 */
const pendingDeletes = new Set()
const SWEEP_RETRY_MS = 1_200
const SWEEP_MAX_ATTEMPTS = 5
let sweepTimer = null
let sweepAttempts = 0

export function tryRemoveFile(file) {
  if (!file) return true
  try {
    fs.rmSync(file, { force: true })
    pendingDeletes.delete(file)
    return true
  } catch {
    // Windows 上进程句柄还没释放时会 EBUSY/EPERM：先记下，扫尾时再收
    pendingDeletes.add(file)
    return false
  }
}

/** 一条任务的两个输出文件（及 powershell 脚本），删记录时一起收掉，别留孤儿 */
export function removeTaskFiles(task) {
  const files = [task.logPath, task.errPath]
  if (task.id && rt.scriptDir) files.push(path.join(rt.scriptDir, `${task.id}.ps1`))
  let failed = false
  for (const file of files) {
    if (!tryRemoveFile(file)) failed = true
  }
  // 删不掉的别默不作声：稍后再扫一遍，句柄释放后就收走了
  if (failed) scheduleSweep()
}

/**
 * 扫目录，收掉**没有任务记录**的 bg-* 文件。
 *
 * 这类孤儿用 bg_clear 永远清不到（它按记录工作），而它们会一直累积：被拒绝的启动、
 * 删除时句柄未释放、历史上漏删的 powershell 脚本。启动时与每次清理后各扫一遍；
 * 删除失败的文件也靠它兜底重试（最多 5 轮）。
 */
export function sweepOrphanFiles() {
  const known = new Set(rt.state.tasks.map((t) => t && t.id).filter(Boolean))
  for (const dir of [rt.logDir, rt.scriptDir]) {
    if (!dir) continue
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const m = TASK_FILE_RE.exec(name)
      if (!m || known.has(m[1])) continue
      tryRemoveFile(path.join(dir, name))
    }
  }
  if (pendingDeletes.size > 0) {
    // 还有收不掉的（多半是句柄冲突）：再等一会儿重试，但只重试有限次
    if (sweepAttempts < SWEEP_MAX_ATTEMPTS) {
      sweepAttempts += 1
      scheduleSweep(SWEEP_RETRY_MS)
    }
  } else {
    sweepAttempts = 0
  }
}

export function scheduleSweep(delay = SWEEP_RETRY_MS) {
  if (sweepTimer) return
  sweepTimer = setTimeout(() => {
    sweepTimer = null
    sweepOrphanFiles()
  }, delay)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
}

/** 插件停用时收掉扫尾定时器与重试记账：重载后 id 不复用，旧状态只是内存垃圾 */
export function disposeFiles() {
  if (sweepTimer) clearTimeout(sweepTimer)
  sweepTimer = null
  sweepAttempts = 0
  pendingDeletes.clear()
}
