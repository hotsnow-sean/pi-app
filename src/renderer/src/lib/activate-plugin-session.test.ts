import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'

const mocks = vi.hoisted(() => ({
  switchInPlace: vi.fn(),
  activateWorkspace: vi.fn(),
  revealPreview: vi.fn(),
}))

vi.mock('@renderer/lib/activate-workspace', () => ({
  switchSessionInPlace: (...args: unknown[]) => mocks.switchInPlace(...args),
  activateWorkspace: (...args: unknown[]) => mocks.activateWorkspace(...args),
  previewSessionInPlace: vi.fn(),
}))

vi.mock('@renderer/lib/reveal-session', () => ({
  revealSessionPreview: (...args: unknown[]) => mocks.revealPreview(...args),
}))

vi.mock('@shared/workspace-path', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // 测试里 workspace 路径就是普通字符串，直接比相等即可
  workspacePathsEqual: (a: unknown, b: unknown) => a === b,
}))

import { activatePluginSession } from './activate-plugin-session'

/**
 * 插件 `ctx.sessions.activate` 的 renderer 落地。
 *
 * 二分规则的全部意义：主会话在侧栏里，用户点「返回主会话」要拿到**可写**的对话
 * （跟自己点侧栏一样），而不是又一个预览；子会话不在侧栏，才退化为预览。
 */
const CURRENT = '/sessions/parent/current.jsonl'
const CHILD = '/sessions/parent/run-1/session.jsonl'
const OTHER_WS = '/other-workspace'

function seedSessions(
  sessions: Array<{ sessionId: string; sessionFile: string; workspaceId?: string }>,
  currentWorkspace = '/ws',
): void {
  useUIStore.setState({ sessions: sessions as never, currentWorkspace, historySessionFile: null })
}

beforeEach(() => {
  mocks.switchInPlace.mockReset()
  mocks.switchInPlace.mockResolvedValue(undefined)
  mocks.activateWorkspace.mockReset()
  mocks.activateWorkspace.mockResolvedValue(undefined)
  mocks.revealPreview.mockReset()
  mocks.revealPreview.mockResolvedValue(true)
})

describe('activate plugin session', () => {
  it('空路径直接返回 false', async () => {
    expect(await activatePluginSession('   ')).toBe(false)
    expect(mocks.switchInPlace).not.toHaveBeenCalled()
    expect(mocks.revealPreview).not.toHaveBeenCalled()
  })

  it('目标会话在当前工作区侧栏：就地激活（可写），不走预览', async () => {
    seedSessions([{ sessionId: 'parent-id', sessionFile: CURRENT, workspaceId: '/ws' }])
    expect(await activatePluginSession(CURRENT)).toBe(true)
    expect(mocks.switchInPlace).toHaveBeenCalledWith('parent-id', CURRENT)
    expect(mocks.activateWorkspace).not.toHaveBeenCalled()
    expect(mocks.revealPreview).not.toHaveBeenCalled()
  })

  it('目标会话在其它工作区：激活那个工作区并落到目标会话', async () => {
    seedSessions([{ sessionId: 'other-id', sessionFile: CURRENT, workspaceId: OTHER_WS }])
    expect(await activatePluginSession(CURRENT)).toBe(true)
    expect(mocks.activateWorkspace).toHaveBeenCalledWith(OTHER_WS, { sessionId: 'other-id', sessionFile: CURRENT })
    expect(mocks.switchInPlace).not.toHaveBeenCalled()
  })

  it('不在侧栏（子会话）：退化为只读预览', async () => {
    seedSessions([{ sessionId: 'parent-id', sessionFile: CURRENT, workspaceId: '/ws' }])
    expect(await activatePluginSession(CHILD)).toBe(true)
    expect(mocks.revealPreview).toHaveBeenCalledWith(CHILD)
    expect(mocks.switchInPlace).not.toHaveBeenCalled()
  })

  it('侧栏条目缺 workspaceId 且没有当前工作区：退化预览而不是扔进空工作区', async () => {
    seedSessions([{ sessionId: 'parent-id', sessionFile: CURRENT }], '')
    expect(await activatePluginSession(CURRENT)).toBe(true)
    expect(mocks.revealPreview).toHaveBeenCalledWith(CURRENT)
  })

  it('已经停在这段会话：不重放导航', async () => {
    seedSessions([{ sessionId: 'parent-id', sessionFile: CURRENT, workspaceId: '/ws' }])
    useUIStore.setState({ historySessionFile: CURRENT })
    expect(await activatePluginSession(CURRENT)).toBe(true)
    expect(mocks.switchInPlace).not.toHaveBeenCalled()
  })
})
