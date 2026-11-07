import { previewSessionInPlace } from '@renderer/lib/activate-workspace'
import { ipcClient } from '@renderer/lib/ipc-client'
import { sessionFilesEqual } from '@renderer/lib/session-file-key'
import { assertSessionNavigation, beginSessionNavigation } from '@renderer/lib/session-navigation'
import { useUIStore } from '@renderer/stores/ui-store'

/**
 * 把一段会话以**只读预览**的方式打开到主区域（插件 `ctx.sessions.reveal` 的落点）。
 *
 * 与 `openSubagentSessionPreview` 的区别：那条要求目标会话已经出现在当前时间线的
 * 子代理卡片里（它顺带维护兄弟会话导航条），而插件的会话来源是 RPC 事件载荷，
 * 跟当前时间线毫无关系——所以这里不碰 `subagentSessionGroup`，路径不存在就干脆不动。
 *
 * 只读是有意的：预览态不绑定 worker，用户想接手得自己从侧栏切过去。插件能命令
 * 宿主「看一眼」，不能命令宿主「接管」。
 *
 * @returns 是否真的发起了导航（false = 目标已不可用，调用方可忽略）
 */
export async function revealSessionPreview(sessionFile: string): Promise<boolean> {
  const target = String(sessionFile || '').trim()
  if (!target) return false

  // 已经停在这段会话（含它作为子会话被预览的情形）：不重放导航。
  // 重放会 capture → focus → hydrate 一整轮，用户看到的是无谓的闪动。
  if (sessionFilesEqual(useUIStore.getState().historySessionFile, target)) return true

  const navToken = beginSessionNavigation()
  const prepared = await ipcClient.invoke('session.prepare', { sessionFile: target, bind: false }).catch(() => null)
  if (!prepared?.sessionId || !assertSessionNavigation(navToken)) return false

  const resolved = typeof prepared.sessionFile === 'string' && prepared.sessionFile.trim()
    ? prepared.sessionFile
    : target
  // 换了一段会话：旧的子代理兄弟导航不属于这里，留着会显示一串无关会话
  useUIStore.getState().setSubagentSessionGroup(null)
  await previewSessionInPlace(prepared.sessionId, resolved, navToken)
  return true
}
