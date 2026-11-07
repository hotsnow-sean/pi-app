import { captureVisibleLiveSessionTimeline } from '@renderer/lib/capture-live-session-timeline'
import { ipcClient } from '@renderer/lib/ipc-client'
import { reportVisibleSession } from '@renderer/lib/visible-session-report'
import { beginSessionNavigation } from '@renderer/lib/session-navigation'
import { clearSessionFocus } from '@renderer/lib/session-shell'
import { revealConversation } from '@renderer/lib/reveal-conversation'
import { EPHEMERAL_DRAFT_SESSION_ID, PENDING_NEW_SESSION_ID } from '@renderer/lib/session-ids'
import { useExtensionUIStore } from '@renderer/stores/extension-ui-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { flushStreamPendingSync } from '@renderer/stores/ui-store-stream'
import type { RunState, UIState } from '@renderer/stores/ui-store-types'

export type BlankSessionKind = 'pending-project' | 'ephemeral-sandbox'

/**
 * Run state a blank composer starts with: idle, nothing from the previous session's turn or usage,
 * but the user's current model and thinking choice so a new chat continues with them.
 */
function blankRunState(state: UIState): RunState {
  const prev = state.runState
  const model = state.lastModel ?? prev.model
  const thinkingLevel = state.lastThinking ?? prev.thinkingLevel
  return {
    status: 'idle',
    toolCount: 0,
    errorCount: 0,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(model && model === prev.model && prev.availableThinkingLevels
      ? { availableThinkingLevels: prev.availableThinkingLevels }
      : {}),
  }
}

/** Display state of an empty conversation; written together with the view pointer it belongs to. */
function blankSessionPatch(state: UIState): Partial<UIState> {
  return {
    timelineItems: [],
    streamingAssistantId: null,
    pendingSteering: [],
    pendingFollowUp: [],
    optimisticPendingUserText: null,
    agentTurnBootstrapping: false,
    pendingTurnStage: null,
    fileChanges: [],
    historyTotalCount: 0,
    historyLoadedCount: 0,
    historySessionFile: null,
    historyLoading: false,
    composerWidget: null,
    subagentSessionGroup: null,
    // 空白会话不是预览：不清掉的话，之后碰巧打开同一个文件仍会被判成只读
    readOnlyPreviewFile: null,
    workerLiveSnapshot: { sessionId: null, sessionFile: null, status: 'idle' },
    runState: blankRunState(state),
  }
}

function leaveVisibleSession(): void {
  captureVisibleLiveSessionTimeline()
  clearSessionFocus()
  flushStreamPendingSync(useUIStore.getState, useUIStore.setState)
  useExtensionUIStore.getState().resetForSessionContext()
}

/** Clear the visible conversation to an empty one (the session itself keeps its state). */
export function resetBlankSessionProjection(): void {
  leaveVisibleSession()
  useUIStore.setState((state) => blankSessionPatch(state))
}

export function enterBlankSession(kind: BlankSessionKind): void {
  // 「新对话」同样是"我要看对话"的意图：已经在空白会话里时状态不变，视图仍需让位（见 revealConversation）
  revealConversation()
  beginSessionNavigation()
  leaveVisibleSession()
  useUIStore.setState((state) => ({
    ...blankSessionPatch(state),
    ephemeralSandboxDraft: kind === 'ephemeral-sandbox',
    pendingNewSessionPlaceholder: kind === 'pending-project',
    ...(kind === 'ephemeral-sandbox' ? { currentWorkspace: null } : {}),
    currentSessionId: kind === 'ephemeral-sandbox' ? EPHEMERAL_DRAFT_SESSION_ID : PENDING_NEW_SESSION_ID,
  }))

  reportVisibleSession(null)
  if (kind === 'ephemeral-sandbox') {
    void ipcClient.invoke('session.setEphemeralDraft', { active: true }).catch(() => {})
  } else {
    void ipcClient.invoke('session.setPendingBind', { sessionFile: null }).catch(() => {})
  }
}
