import fs from 'node:fs'
import path from 'node:path'
import { broadcastEvent } from '../ipc/registry'
import type { AppEvent } from '@shared/app-events'

/**
 * 插件请求宿主打开一段会话（`ctx.sessions.reveal` 的落点）。
 *
 * 这是插件唯一能改宿主 UI 状态的能力，所以刻意做得比「打开会话」更窄：**只预览**——
 * 不绑定 worker、不能发提示词。校验放在 main：插件拿到的路径多来自事件载荷与工具
 * details，可能是相对路径、可能有拼错的 runId；不合规就静默不动，别把 renderer
 * 拖进一次注定失败的导航（它会先清空时间线再报错，用户看到的是闪一下白）。
 *
 * 为什么是**静默**而不是抛错：调用方是插件的后台逻辑（轮询循环里顺手 reveal），
 * 一次无效目标不该中断整轮；插件自己知道发生了什么。
 */
let seq = 0

export function publishPluginRevealSession(pluginId: string, sessionFile: string): boolean {
  const file = validatePluginSessionFile(sessionFile)
  if (!file) return false
  seq += 1
  const event: AppEvent = {
    type: 'plugin_reveal_session',
    seq,
    // workspaceId 留空：renderer 靠 sessionFile 定位，工作区由会话自己带出来
    workspaceId: '',
    sessionFile: file,
    timestamp: Date.now(),
    pluginId,
  }
  broadcastEvent(event)
  return true
}

/**
 * 插件请求宿主**切到**一段会话（`ctx.sessions.activate` 的落点）。
 *
 * 与 reveal 的分工：reveal 恒为只读预览（「看一眼」），activate 是「回去」——
 * 目标在当前工作区侧栏就正常激活（可写），不在才退化为预览。renderer 侧的
 * 二分逻辑见 `activate-plugin-session.ts`；这里只做与 reveal 相同的入口校验。
 */
export function publishPluginActivateSession(pluginId: string, sessionFile: string): boolean {
  const file = validatePluginSessionFile(sessionFile)
  if (!file) return false
  seq += 1
  const event: AppEvent = {
    type: 'plugin_activate_session',
    seq,
    workspaceId: '',
    sessionFile: file,
    timestamp: Date.now(),
    pluginId,
  }
  broadcastEvent(event)
  return true
}

/** reveal / activate 共用的入口校验：绝对路径 + .jsonl + 确实存在 */
function validatePluginSessionFile(sessionFile: string): string | null {
  const file = String(sessionFile || '').trim()
  if (!file || !path.isAbsolute(file)) return null
  // 只接受 .jsonl：会话是 jsonl，顺带挡掉「传了个目录」和「传了个任意文件」
  if (path.extname(file).toLowerCase() !== '.jsonl') return null
  try {
    if (!fs.statSync(file).isFile()) return null
  } catch {
    return null
  }
  return file
}
