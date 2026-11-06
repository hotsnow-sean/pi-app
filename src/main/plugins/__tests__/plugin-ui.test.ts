import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeWindow = ReturnType<typeof fakeWindow>

const state = vi.hoisted(() => ({ main: null as unknown as FakeWindow | null }))

vi.mock('../../window', () => ({ getMainWindow: () => state.main }))

function fakeWindow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    isFocused: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    flashFrame: vi.fn(),
    webContents: { send: vi.fn() },
    ...overrides,
  }
}

import { askInHost, resolvePluginUIResponse } from '../plugin-ui'

const QUESTIONS = [{ question: '用哪个数据库？', header: '数据库', options: [{ label: 'SQLite' }] }]

function sentRequest(win: FakeWindow): { id: string; kind: string } {
  const call = win.webContents.send.mock.calls.find((c) => c[0] === 'ipc:extension-ui-request')
  expect(call).toBeTruthy()
  return call![1] as { id: string; kind: string }
}

describe('plugin ask 的窗口选择', () => {
  beforeEach(() => {
    state.main = null
  })

  it('sends the questionnaire to the main window, never to whatever window happens to be focused', async () => {
    const main = fakeWindow()
    const notificationHost = fakeWindow({ isFocused: () => true })
    state.main = main

    void askInHost('ask', QUESTIONS as never)

    expect(sentRequest(main).kind).toBe('ask_user_question')
    // 通知卡窗口也是 BrowserWindow，但它挂的是另一个 preload，收到也画不出问卷
    expect(notificationHost.webContents.send).not.toHaveBeenCalled()
  })

  it('restores a minimized window and shows a hidden one before asking', () => {
    const main = fakeWindow({ isMinimized: () => true, isVisible: () => false })
    state.main = main

    void askInHost('ask', QUESTIONS as never)

    expect(main.restore).toHaveBeenCalledOnce()
    expect(main.show).toHaveBeenCalledOnce()
  })

  it('flashes the taskbar instead of stealing focus when the app is in the background', () => {
    const main = fakeWindow({ isFocused: () => false })
    state.main = main

    void askInHost('ask', QUESTIONS as never)

    expect(main.flashFrame).toHaveBeenCalledWith(true)
    expect(main.show).not.toHaveBeenCalled()
  })

  it('does not touch a window that is already focused and visible', () => {
    const main = fakeWindow()
    state.main = main

    void askInHost('ask', QUESTIONS as never)

    expect(main.flashFrame).not.toHaveBeenCalled()
    expect(main.restore).not.toHaveBeenCalled()
    expect(main.show).not.toHaveBeenCalled()
  })

  it('gives up (cancelled) instead of hanging when there is no main window', async () => {
    state.main = null

    const result = await askInHost('ask', QUESTIONS as never)

    expect(result.cancelled).toBe(true)
  })

  it('resolves with the renderer answer', async () => {
    const main = fakeWindow()
    state.main = main

    const pending = askInHost('ask', QUESTIONS as never)
    const { id } = sentRequest(main)
    expect(resolvePluginUIResponse({ id, result: { answers: [{ questionIndex: 0, kind: 'single', answer: 'SQLite' }] } } as never)).toBe(true)

    await expect(pending).resolves.toMatchObject({ answers: [{ answer: 'SQLite' }] })
  })
})
