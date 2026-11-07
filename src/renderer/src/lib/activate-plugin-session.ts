import { activateWorkspace, switchSessionInPlace } from '@renderer/lib/activate-workspace'
import { sessionFilesEqual } from '@renderer/lib/session-file-key'
import { useUIStore } from '@renderer/stores/ui-store'
import { workspacePathsEqual } from '@shared/workspace-path'

/**
 * 插件请求宿主**切到**一段会话（`ctx.sessions.activate` 的落点，对应
 * `plugin_activate_session` 事件）。
 *
 * 与 `revealSessionPreview` 的分工：reveal 恒为只读预览（「看一眼」），这里是
 * 「回去」——目标在当前工作区侧栏里就正常激活（可写、绑 worker），和用户自己
 * 点侧栏一样；不在（子代理的子会话、跨工作区）才退化为只读预览，因为那段会话
 * 本来就不能作为普通会话打开。
 *
 * 二分逻辑与信箱条目的「会话优先」跳转（`jumpToSessionFile`）一致，但信箱那份
 * 活在组件里（依赖组件 state），这里是全局事件处理器要用的，直接读 store。
 *
 * @returns 是否发起了导航（false = 目标已不可用，调用方可忽略）
 */
export async function activatePluginSession(sessionFile: string): Promise<boolean> {
  const target = String(sessionFile || '').trim()
  if (!target) return false

  // 已经停在这段会话：不重放导航，避免无谓的闪动
  if (sessionFilesEqual(useUIStore.getState().historySessionFile, target)) return true

  const store = useUIStore.getState()
  const match = store.sessions.find((s) => sessionFilesEqual(s.sessionFile, target))
  if (!match) {
    // 不在侧栏（子会话 / 跨工作区）：退化为只读预览。动态 import：这条路径平时不走。
    const { revealSessionPreview } = await import('@renderer/lib/reveal-session')
    return revealSessionPreview(target)
  }

  // 会话行上的 workspaceId 可能缺（未加载的工作区）：用当前工作区兜底，都没有就预览
  const workspace = match.workspaceId || store.currentWorkspace
  if (!workspace) {
    const { revealSessionPreview } = await import('@renderer/lib/reveal-session')
    return revealSessionPreview(target)
  }

  // 路径比较必须走归一化：`C:\x` 与 `c:/x` 是同一个工作区，用 `!==` 会误判成跨项目
  if (workspacePathsEqual(workspace, store.currentWorkspace)) {
    await switchSessionInPlace(match.sessionId, target)
  } else {
    await activateWorkspace(workspace, { sessionId: match.sessionId, sessionFile: target })
  }
  return true
}
