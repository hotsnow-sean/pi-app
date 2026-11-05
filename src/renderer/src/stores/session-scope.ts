/**
 * A `StoreApi` scoped to one session's entry in `sessionStates`, so the AppEvent handlers written
 * against the view store can reduce events of any session — the background session's state is
 * kept by the same code as the visible one instead of a separate cache reducer.
 *
 * `get()` returns the root store state with that session's fields (and actions that write them)
 * layered on top; everything else (runtime maps, compaction flags, defaults) is the root store's.
 */
import { isAbortQueueIgnoreActive } from '@renderer/lib/abort-ui-hold'
import type { StoreApi } from '@renderer/stores/apply-app-event-types'
import {
  applyRunStatePatch,
  insertTimelineItemBefore,
  patchTimelineItem,
  pruneEmptyAssistantItems,
} from '@renderer/stores/session-ops'
import {
  isDraftSessionKey,
  SESSION_FIELDS,
  seedSessionState,
  sessionKeyOf,
  type SessionField,
  type SessionState,
} from '@renderer/stores/session-state'
import {
  deleteStreamPendingForId,
  flushStreamPendingSync,
  queueStreamDelta,
} from '@renderer/stores/ui-store-stream'
import { useUIStore } from '@renderer/stores/ui-store'
import type { UIState } from '@renderer/stores/ui-store-types'

const SESSION_FIELD_SET = new Set<string>(SESSION_FIELDS)

type EntryUpdate = (entry: SessionState) => Partial<SessionState> | null

/** Keys of deleted sessions: late events for them are dropped instead of re-seeding an entry. */
const removedKeys = new Set<string>()
const MAX_REMOVED_KEYS = 500

function updateSession(key: string, update: EntryUpdate): void {
  useUIStore.setState((root) => {
    if (removedKeys.has(key) && !root.sessionStates[key]) return root
    const entry = root.sessionStates[key] ?? seedSessionState(key, root)
    const patch = update(entry)
    if (!patch) return root
    let changed = !root.sessionStates[key]
    for (const field of Object.keys(patch) as SessionField[]) {
      if (patch[field] !== entry[field]) changed = true
    }
    if (!changed) return root
    return { sessionStates: { ...root.sessionStates, [key]: { ...entry, ...patch } } }
  })
}

/** Write fields of one session's state (seeding the entry if needed); the view mirror follows. */
export function patchSessionState(key: string, patch: Partial<Omit<SessionState, 'key'>>): void {
  updateSession(key, () => patch)
}

/**
 * A session's turn ended outside its event stream (abort click, worker snapshot): retire its own
 * streaming / optimistic markers so it is no longer treated as running.
 */
export function markSessionTurnEnded(sessionFile: string, status: 'idle' | 'failed'): void {
  const key = sessionKeyOf(sessionFile)
  if (!key || !useUIStore.getState().sessionStates[key]) return
  updateSession(key, (e) => ({
    streamingAssistantId: null,
    agentTurnBootstrapping: false,
    optimisticPendingUserText: null,
    runState: { ...e.runState, status, activeRunId: undefined, activeTool: undefined, activeToolStatus: undefined },
  }))
}

function splitPatch(patch: Partial<UIState>): { session: Partial<SessionState>; root: Partial<UIState> | null } {
  const session: Record<string, unknown> = {}
  let root: Record<string, unknown> | null = null
  for (const [field, value] of Object.entries(patch)) {
    if (SESSION_FIELD_SET.has(field)) session[field] = value
    else (root ??= {})[field] = value
  }
  return { session: session as Partial<SessionState>, root: root as Partial<UIState> | null }
}

const scopes = new Map<string, StoreApi>()

/** Store API whose reads and writes target `sessionStates[key]`. Stable per key. */
export function sessionStoreApi(key: string, nextItemId: () => string): StoreApi {
  const cached = scopes.get(key)
  if (cached) return cached

  const set: StoreApi['set'] = (update) => {
    const patch = typeof update === 'function' ? update(get()) : update
    if (!patch || patch === get()) return
    const { session, root } = splitPatch(patch as Partial<UIState>)
    if (Object.keys(session).length > 0) updateSession(key, () => session)
    if (root) useUIStore.setState(root)
  }

  const actions: Partial<UIState> = {
    appendTimeline: (item) => updateSession(key, (e) => ({ timelineItems: [...e.timelineItems, item] })),
    insertTimelineBefore: (beforeId, item) =>
      updateSession(key, (e) => ({ timelineItems: insertTimelineItemBefore(e.timelineItems, beforeId, item) })),
    updateTimelineItem: (id, patch) =>
      updateSession(key, (e) => ({ timelineItems: patchTimelineItem(e.timelineItems, id, patch) })),
    appendDeltaToStreamingAssistant: (delta) => queueStreamDelta(get, set, 'text', delta),
    appendThinkingDelta: (delta) => queueStreamDelta(get, set, 'thinking', delta),
    setStreamingAssistantFinalText: (text) => {
      flushStreamPendingSync(get, set)
      updateSession(key, (e) => {
        const id = e.streamingAssistantId
        if (!id) return { streamingAssistantId: null }
        deleteStreamPendingForId(id)
        return {
          streamingAssistantId: null,
          timelineItems: e.timelineItems.map((i) => (i.id === id ? { ...i, text: text ?? i.text } : i)),
        }
      })
    },
    pruneEmptyAssistantBubbles: () =>
      updateSession(key, (e) => {
        const items = pruneEmptyAssistantItems(e.timelineItems, e.streamingAssistantId)
        return items === e.timelineItems ? null : { timelineItems: items }
      }),
    setRunState: (patch) => updateSession(key, (e) => ({ runState: applyRunStatePatch(e.runState, patch).runState })),
    setWorkerLiveSnapshot: (snap) => updateSession(key, () => ({ workerLiveSnapshot: snap })),
    addFileChange: (fc) =>
      updateSession(key, (e) => ({ fileChanges: [...e.fileChanges.filter((f) => f.path !== fc.path), fc] })),
    clearFileChanges: () => updateSession(key, () => ({ fileChanges: [] })),
    setPendingQueue: (steering, followUp) => {
      if (isAbortQueueIgnoreActive(key) && (steering.length > 0 || followUp.length > 0)) return
      updateSession(key, () => ({ pendingSteering: steering, pendingFollowUp: followUp }))
    },
    clearPendingQueue: () => updateSession(key, () => ({ pendingSteering: [], pendingFollowUp: [] })),
    setComposerWidget: (widget) => updateSession(key, () => ({ composerWidget: widget })),
    setPluginComposerBar: (pluginId, bar) =>
      updateSession(key, (e) => {
        const current = e.pluginComposerBars[pluginId]
        if (!bar) {
          if (!current) return null
          const next = { ...e.pluginComposerBars }
          delete next[pluginId]
          return { pluginComposerBars: next }
        }
        return { pluginComposerBars: { ...e.pluginComposerBars, [pluginId]: bar } }
      }),
  }

  function get(): UIState {
    const root = useUIStore.getState()
    const entry = root.sessionStates[key] ?? seedSessionState(key, root)
    const scoped = Object.create(root) as UIState
    for (const field of SESSION_FIELDS) {
      ;(scoped as unknown as Record<string, unknown>)[field] = entry[field]
    }
    scoped.historySessionFile = key
    scoped.currentSessionId = entry.workerLiveSnapshot.sessionId ?? null
    return Object.assign(scoped, actions)
  }

  const api: StoreApi = { get, set, nextItemId }
  scopes.set(key, api)
  return api
}

/**
 * Forget a session the renderer will not show again (deleted, or a draft key that was promoted):
 * drop its `sessionStates` entry and cached scope. Unless `allowReseed`, later events for it are
 * ignored so they cannot resurrect the entry.
 */
export function removeSessionState(sessionFileOrKey: string, opts: { allowReseed?: boolean } = {}): void {
  const key = isDraftSessionKey(sessionFileOrKey) ? sessionFileOrKey : sessionKeyOf(sessionFileOrKey)
  if (!key) return
  scopes.delete(key)
  if (!opts.allowReseed) {
    removedKeys.add(key)
    if (removedKeys.size > MAX_REMOVED_KEYS) removedKeys.delete(removedKeys.values().next().value as string)
  }
  const root = useUIStore.getState()
  if (!root.sessionStates[key] || key === root.viewSessionKey) return
  const next = { ...root.sessionStates }
  delete next[key]
  useUIStore.setState({ sessionStates: next })
}

/** Test helper: forget cached scopes. */
export function clearSessionScopesForTests(): void {
  scopes.clear()
  removedKeys.clear()
}
