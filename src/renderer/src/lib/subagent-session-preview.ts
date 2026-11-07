import { sessionFilesEqual } from '@renderer/lib/session-file-key'
import type { SubagentSessionGroup } from '@renderer/lib/subagent-session-types'
import { useUIStore } from '@renderer/stores/ui-store'

export function isSubagentSessionPreview(
  group: SubagentSessionGroup | null | undefined,
  sessionFile: string | null | undefined,
): boolean {
  return !!group && sessionFilesEqual(group.previewSessionFile, sessionFile)
}

/**
 * 「这段会话正被只读预览」的**统一判定**：兄弟组那一路 + 通用预览那一路。
 *
 * 两条来源必须分开存，因为它们的附产品不同：
 * - 兄弟组（时间线子代理卡片点进来）还带一串兄弟会话导航条；
 * - 通用预览（插件 `ctx.sessions.reveal`、信箱退回只读）跟当前时间线无关，
 *   伪造兄弟组会在侧栏列出无关会话。
 * 但对「能不能发消息 / 能不能 fork」来说它们是同一件事，所以判定收敛在这里。
 */
export function isReadOnlyPreviewSession(
  previewFile: string | null | undefined,
  sessionFile: string | null | undefined,
): boolean {
  return !!previewFile && sessionFilesEqual(previewFile, sessionFile)
}

/** 当前视图是只读预览吗（任何一种来源）。用于禁发送、禁 fork/rewind。 */
export function isCurrentReadOnlyPreview(): boolean {
  const state = useUIStore.getState()
  return (
    isSubagentSessionPreview(state.subagentSessionGroup, state.historySessionFile) ||
    isReadOnlyPreviewSession(state.readOnlyPreviewFile, state.historySessionFile)
  )
}
