/**
 * Per-session conversation state, keyed by session (see doc/dev/per-session-state-design.md).
 *
 * `sessionStates[key]` holds everything that belongs to one conversation. The visible session is
 * `viewSessionKey`; the legacy top-level fields of the same names are a projection of
 * `sessionStates[viewSessionKey]` kept by `reconcileSessionMirror` until every reader uses the
 * keyed state.
 */
import type { AdapterWidgetProjection } from '@shared/adapter-widget'
import type { PluginComposerBarState } from '@shared/plugin-composer-bar'
import { normalizeSessionFileKey } from '@shared/session-file-key'
import { workspacePathKey } from '@shared/workspace-path'
import type { WorkerLiveSnapshot } from '@renderer/lib/session-worker-sync'
import type { FileChange, RunState, TimelineItem } from '@renderer/stores/ui-store-types'

export interface SessionState {
  key: string
  timelineItems: TimelineItem[]
  streamingAssistantId: string | null
  historyTotalCount: number
  historyLoadedCount: number
  runState: RunState
  workerLiveSnapshot: WorkerLiveSnapshot
  optimisticPendingUserText: string | null
  agentTurnBootstrapping: boolean
  pendingTurnStage: 'starting' | 'sending' | null
  pendingSteering: string[]
  pendingFollowUp: string[]
  fileChanges: FileChange[]
  composerWidget: AdapterWidgetProjection | null
  /** 插件推到输入框上方的那条摘要，按 pluginId 归并（同一会话可以有多条） */
  pluginComposerBars: Record<string, PluginComposerBarState>
  /** Text pushed into this session's composer (fork / rewind / line refs), consumed once shown. */
  composerPrefill: string | null
  composerPrefillMode: 'replace' | 'append'
}

export type SessionField = Exclude<keyof SessionState, 'key'>

/** Fields mirrored between `sessionStates[viewSessionKey]` and the legacy top-level store fields. */
export const SESSION_FIELDS: readonly SessionField[] = [
  'timelineItems',
  'streamingAssistantId',
  'historyTotalCount',
  'historyLoadedCount',
  'runState',
  'workerLiveSnapshot',
  'optimisticPendingUserText',
  'agentTurnBootstrapping',
  'pendingTurnStage',
  'pendingSteering',
  'pendingFollowUp',
  'fileChanges',
  'composerWidget',
  'pluginComposerBars',
  'composerPrefill',
  'composerPrefillMode',
]

/**
 * Fields whose source of truth is `sessionStates[key]`. The top-level copy is re-projected from the
 * viewed session after every store write, so switching the view never carries a value across.
 * Fields not listed here are still owned by the top-level store and copied into the viewed entry.
 */
export const KEYED_SESSION_FIELDS: ReadonlySet<SessionField> = new Set<SessionField>([
  // Timeline: each session keeps its own rows; a switch shows the target's rows, never copies.
  'timelineItems',
  'streamingAssistantId',
  'historyTotalCount',
  'historyLoadedCount',
  // Run state: a switch shows the target session's own run, never the previous one's.
  'runState',
  'workerLiveSnapshot',
  'optimisticPendingUserText',
  'agentTurnBootstrapping',
  'pendingTurnStage',
  // Queue, touched files and composer inputs belong to the session they were made in.
  'pendingSteering',
  'pendingFollowUp',
  'fileChanges',
  'composerWidget',
  'pluginComposerBars',
  'composerPrefill',
  'composerPrefillMode',
])

const IDLE_RUN: RunState = { status: 'idle', toolCount: 0, errorCount: 0 }

export function emptySessionState(key: string): SessionState {
  return {
    key,
    timelineItems: [],
    streamingAssistantId: null,
    historyTotalCount: 0,
    historyLoadedCount: 0,
    runState: IDLE_RUN,
    workerLiveSnapshot: { sessionId: null, sessionFile: null, status: 'idle' },
    optimisticPendingUserText: null,
    agentTurnBootstrapping: false,
    pendingTurnStage: null,
    pendingSteering: [],
    pendingFollowUp: [],
    fileChanges: [],
    composerWidget: null,
    pluginComposerBars: {},
    composerPrefill: null,
    composerPrefillMode: 'replace',
  }
}

/** Shared empty value for selectors when no session is viewed; never mutate. */
export const EMPTY_SESSION_STATE: SessionState = Object.freeze(emptySessionState('')) as SessionState

export type SessionDefaults = {
  lastModel?: string | null
  lastThinking?: string | null
  /** The view's run state when the session is created (a new draft continues with its model). */
  runState?: RunState
}

/**
 * First state of a session the renderer has not seen yet: idle, bound to its own file, showing the
 * user's last chosen model / thinking level until the session's own meta arrives. A blank draft
 * also falls back to the model the view showed, so a new chat continues with it.
 */
export function seedSessionState(key: string, defaults: SessionDefaults): SessionState {
  const state = emptySessionState(key)
  const runState: RunState = { ...state.runState }
  const draft = isDraftSessionKey(key)
  const model = defaults.lastModel || (draft ? defaults.runState?.model : undefined)
  const thinkingLevel = defaults.lastThinking || (draft ? defaults.runState?.thinkingLevel : undefined)
  if (model) runState.model = model
  if (thinkingLevel) runState.thinkingLevel = thinkingLevel
  return {
    ...state,
    runState,
    workerLiveSnapshot: {
      sessionId: null,
      sessionFile: isDraftSessionKey(key) ? null : key || null,
      status: 'idle',
    },
  }
}

const DRAFT_PREFIX = 'draft:'

let lastFile: string | null | undefined
let lastFileKey = ''

/** Store key for a session file (normalized path). Empty string when there is no file. */
export function sessionKeyOf(sessionFile: string | null | undefined): string {
  if (sessionFile === lastFile) return lastFileKey
  lastFile = sessionFile
  lastFileKey = normalizeSessionFileKey(sessionFile)
  return lastFileKey
}

export function isDraftSessionKey(key: string | null | undefined): boolean {
  return !!key && key.startsWith(DRAFT_PREFIX)
}

export type ViewKeyInput = {
  historySessionFile: string | null
  ephemeralSandboxDraft: boolean
  pendingNewSessionPlaceholder: boolean
  currentWorkspace: string | null
  currentSessionId: string | null
}

/**
 * Which session the view shows. A conversation with a file is keyed by it; a blank composer
 * (new chat placeholder, ephemeral sandbox, or a workspace with nothing open) gets a draft key.
 */
export function viewSessionKeyOf(s: ViewKeyInput): string {
  const file = sessionKeyOf(s.historySessionFile)
  if (file) return file
  if (s.ephemeralSandboxDraft) return `${DRAFT_PREFIX}ephemeral`
  if (s.pendingNewSessionPlaceholder) return `${DRAFT_PREFIX}pending:${workspacePathKey(s.currentWorkspace)}`
  if (s.currentSessionId) {
    return `${DRAFT_PREFIX}session:${workspacePathKey(s.currentWorkspace)}:${s.currentSessionId}`
  }
  return `${DRAFT_PREFIX}workspace:${workspacePathKey(s.currentWorkspace)}`
}

type MirrorState = ViewKeyInput &
  SessionDefaults &
  Pick<SessionState, SessionField> & {
    sessionStates: Record<string, SessionState>
    viewSessionKey: string | null
  }

const VIEW_KEY_FIELDS: ReadonlyArray<keyof ViewKeyInput> = [
  'historySessionFile',
  'ephemeralSandboxDraft',
  'pendingNewSessionPlaceholder',
  'currentWorkspace',
  'currentSessionId',
]

/**
 * Turn a store patch into one that keeps `sessionStates[viewSessionKey]` and the legacy top-level
 * fields consistent:
 * - top-level writes of session fields land in the session that is visible *after* the patch;
 * - keyed fields are then projected back from that session (a view switch shows the new session's
 *   values, not the previous one's);
 * - not-yet-keyed fields are copied from the top level into the viewed session.
 */
export function reconcileSessionMirror<S extends MirrorState>(
  prev: S,
  patch: Partial<S>,
  keyed: ReadonlySet<SessionField> = KEYED_SESSION_FIELDS,
): Partial<S> {
  const has = (field: string): boolean => Object.prototype.hasOwnProperty.call(patch, field)
  const read = <K extends keyof S>(field: K): S[K] => (has(field as string) ? (patch[field] as S[K]) : prev[field])

  const keyInputChanged = VIEW_KEY_FIELDS.some((f) => has(f) && patch[f] !== prev[f])
  const key =
    keyInputChanged || !prev.viewSessionKey
      ? viewSessionKeyOf({
          historySessionFile: read('historySessionFile'),
          ephemeralSandboxDraft: read('ephemeralSandboxDraft'),
          pendingNewSessionPlaceholder: read('pendingNewSessionPlaceholder'),
          currentWorkspace: read('currentWorkspace'),
          currentSessionId: read('currentSessionId'),
        })
      : prev.viewSessionKey

  const states = read('sessionStates')
  const current = states[key]
  let entry: SessionState | null = null
  const write = (field: SessionField, value: unknown): void => {
    const base = entry ?? current ?? seedSessionState(key, prev)
    if (current && base[field] === value) return
    if (!entry) entry = { ...base }
    ;(entry as unknown as Record<string, unknown>)[field] = value
  }
  for (const field of SESSION_FIELDS) {
    if (keyed.has(field)) {
      if (has(field)) write(field, patch[field as keyof S])
    } else {
      write(field, read(field as keyof S))
    }
  }

  const out: Partial<S> = { ...patch }
  const nextEntry: SessionState = entry ?? current ?? seedSessionState(key, prev)
  if (entry || !current) {
    out.sessionStates = { ...states, [key]: nextEntry } as S['sessionStates']
  }
  if (key !== prev.viewSessionKey) out.viewSessionKey = key as S['viewSessionKey']
  for (const field of keyed) {
    const value = nextEntry[field]
    if (read(field as keyof S) !== value) (out as Record<string, unknown>)[field] = value
  }
  return out
}

export function selectViewSession(s: {
  sessionStates: Record<string, SessionState>
  viewSessionKey: string | null
}): SessionState {
  return (s.viewSessionKey && s.sessionStates[s.viewSessionKey]) || EMPTY_SESSION_STATE
}

export function selectSessionState(
  s: { sessionStates: Record<string, SessionState> },
  key: string | null | undefined,
): SessionState | null {
  if (!key) return null
  return s.sessionStates[key] ?? s.sessionStates[sessionKeyOf(key)] ?? null
}
