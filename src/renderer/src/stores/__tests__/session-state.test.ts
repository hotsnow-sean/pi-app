import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: vi.fn().mockResolvedValue({}) } }))

import {
  EMPTY_SESSION_STATE,
  emptySessionState,
  reconcileSessionMirror,
  selectViewSession,
  viewSessionKeyOf,
  type SessionField,
} from '../session-state'
import { useUIStore } from '../ui-store'
import type { TimelineItem } from '../ui-store-types'

const item = (id: string): TimelineItem => ({ id, type: 'user-message', text: id, timestamp: 1 })

function baseMirror() {
  const s = emptySessionState('')
  return {
    historySessionFile: null as string | null,
    ephemeralSandboxDraft: false,
    pendingNewSessionPlaceholder: false,
    currentWorkspace: 'C:/w' as string | null,
    currentSessionId: null as string | null,
    sessionStates: {} as Record<string, ReturnType<typeof emptySessionState>>,
    viewSessionKey: null as string | null,
    timelineItems: s.timelineItems,
    streamingAssistantId: s.streamingAssistantId,
    historyTotalCount: 0,
    historyLoadedCount: 0,
    runState: s.runState,
    workerLiveSnapshot: s.workerLiveSnapshot,
    optimisticPendingUserText: null as string | null,
    agentTurnBootstrapping: false,
    pendingTurnStage: null as 'starting' | 'sending' | null,
    pendingSteering: [] as string[],
    pendingFollowUp: [] as string[],
    fileChanges: s.fileChanges,
    composerWidget: null,
    pluginComposerBars: {},
    composerPrefill: null as string | null,
    composerPrefillMode: 'replace' as 'replace' | 'append',
  }
}

function apply<S extends ReturnType<typeof baseMirror>>(
  prev: S,
  patch: Partial<S>,
  keyed?: ReadonlySet<SessionField>,
): S {
  return { ...prev, ...reconcileSessionMirror(prev, patch, keyed) }
}

describe('viewSessionKeyOf', () => {
  it('keys a conversation by its normalized session file', () => {
    expect(
      viewSessionKeyOf({
        historySessionFile: 'c:\\w\\a.jsonl',
        ephemeralSandboxDraft: false,
        pendingNewSessionPlaceholder: false,
        currentWorkspace: 'C:/w',
        currentSessionId: 'a',
      }),
    ).toBe('C:/w/a.jsonl')
  })

  it('gives blank composers distinct draft keys', () => {
    const base = {
      historySessionFile: null,
      ephemeralSandboxDraft: false,
      pendingNewSessionPlaceholder: false,
      currentWorkspace: 'C:/w',
      currentSessionId: null,
    }
    const keys = new Set([
      viewSessionKeyOf({ ...base, ephemeralSandboxDraft: true }),
      viewSessionKeyOf({ ...base, pendingNewSessionPlaceholder: true }),
      viewSessionKeyOf({ ...base, pendingNewSessionPlaceholder: true, currentWorkspace: 'C:/other' }),
      viewSessionKeyOf(base),
    ])
    expect(keys.size).toBe(4)
    for (const key of keys) expect(key.startsWith('draft:')).toBe(true)
  })
})

describe('reconcileSessionMirror', () => {
  it('copies top-level session fields into the viewed session entry', () => {
    let s = apply(baseMirror(), { historySessionFile: 'C:/w/a.jsonl' })
    s = apply(s, { timelineItems: [item('a1')] })
    expect(s.viewSessionKey).toBe('C:/w/a.jsonl')
    expect(s.sessionStates['C:/w/a.jsonl'].timelineItems.map((i) => i.id)).toEqual(['a1'])
  })

  it('writes a switch patch into the session that is visible after it', () => {
    let s = apply(baseMirror(), { historySessionFile: 'C:/w/a.jsonl', timelineItems: [item('a1')] })
    s = apply(s, { historySessionFile: 'C:/w/b.jsonl', timelineItems: [item('b1')] })
    expect(s.sessionStates['C:/w/a.jsonl'].timelineItems.map((i) => i.id)).toEqual(['a1'])
    expect(s.sessionStates['C:/w/b.jsonl'].timelineItems.map((i) => i.id)).toEqual(['b1'])
  })

  it('projects keyed fields from the newly viewed session instead of carrying them over', () => {
    const keyed = new Set<SessionField>(['pendingSteering'])
    let s = apply(baseMirror(), { historySessionFile: 'C:/w/a.jsonl', pendingSteering: ['for A'] }, keyed)
    s = apply(s, { historySessionFile: 'C:/w/b.jsonl' }, keyed)
    expect(s.pendingSteering).toEqual([])
    expect(s.sessionStates['C:/w/a.jsonl'].pendingSteering).toEqual(['for A'])
    s = apply(s, { historySessionFile: 'C:/w/a.jsonl' }, keyed)
    expect(s.pendingSteering).toEqual(['for A'])
  })

  it('projects a keyed write to a background session without touching the view', () => {
    const keyed = new Set<SessionField>(['pendingSteering'])
    let s = apply(baseMirror(), { historySessionFile: 'C:/w/b.jsonl' }, keyed)
    const a = { ...emptySessionState('C:/w/a.jsonl'), pendingSteering: ['bg'] }
    s = apply(s, { sessionStates: { ...s.sessionStates, [a.key]: a } }, keyed)
    expect(s.pendingSteering).toEqual([])
    expect(s.sessionStates[a.key].pendingSteering).toEqual(['bg'])
  })

  it('keeps references when nothing session-related changed', () => {
    const s = apply(baseMirror(), { historySessionFile: 'C:/w/a.jsonl' })
    const patch = reconcileSessionMirror(s, { currentWorkspace: 'C:/w' })
    expect(patch.sessionStates).toBeUndefined()
    expect(patch.viewSessionKey).toBeUndefined()
  })
})

describe('useUIStore session mirror', () => {
  beforeEach(() => {
    useUIStore.setState({ historySessionFile: null, currentSessionId: null, timelineItems: [], sessionStates: {} })
  })

  it('keeps the viewed entry in step with useUIStore.setState and internal actions', () => {
    useUIStore.setState({ historySessionFile: 'C:/w/a.jsonl', currentSessionId: 'a' })
    useUIStore.getState().appendTimeline(item('a1'))
    const view = selectViewSession(useUIStore.getState())
    expect(view.key).toBe('C:/w/a.jsonl')
    expect(view.timelineItems.map((i) => i.id)).toEqual(['a1'])
  })

  it('selects an empty frozen state when no session entry exists', () => {
    expect(selectViewSession({ sessionStates: {}, viewSessionKey: 'missing' })).toBe(EMPTY_SESSION_STATE)
  })
})
