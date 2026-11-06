// @ts-check
/// <reference path="../../plugin-sdk.d.ts" />
/**
 * 纯格式化与会话工具：不碰 fs、不碰子进程、不读写共享状态。
 *
 * 拆出去的动机：这一层被所有上层模块依赖（托盘、回报、工具回执、面板），
 * 但它自己谁也不依赖——放在依赖图的最底层，永远可以先加载、可以放心内联测试。
 *
 * 会话归一化只该有一份实现：工具侧的 sessionFile 来自 worker，推送侧只是插件
 * 自己知道的值，两边写法可能不同（相对路径 vs 绝对路径），同一份实现保证
 * 归属判断在所有入口一致。
 */

import path from 'node:path'

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m} 分 ${s} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 工具返回里的结构化出口：`format:'json'` 时把 details 原样交出去，省得调用方用正则解析排版 */
export function jsonBlock(payload) {
  return ['```json', JSON.stringify(payload, null, 2), '```'].join('\n')
}

export function labelOf(command) {
  const first = String(command || '').trim().split(/\r?\n/)[0].trim()
  return first.length > 60 ? `${first.slice(0, 57)}…` : first || '未命名命令'
}

/** 会话路径归一化：大小写、分隔符、尾斜杠在两端都可能不一致 */
export function normSession(p) {
  const s = String(p || '').trim()
  if (!s) return ''
  return s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 判断两个 sessionFile 是不是同一个会话。
 * 全路径相等最可靠；退一步比 basename——同一份会话在不同入口可能带不同的前缀
 * （工作区相对路径 vs 绝对路径），而 pi 的会话文件名本身带唯一 id，撞名几乎不可能。
 */
export function sameSession(a, b) {
  const x = normSession(a)
  const y = normSession(b)
  if (!x || !y) return false
  if (x === y) return true
  return path.posix.basename(x) === path.posix.basename(y)
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程在，只是不归我们管
    return error?.code === 'EPERM'
  }
}

export function statusText(task) {
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
export function stopReasonText(task) {
  if (task.stopReason === 'log-limit') return '日志超限'
  if (task.stopReason === 'timeout') return '超时'
  return '主动停止'
}
