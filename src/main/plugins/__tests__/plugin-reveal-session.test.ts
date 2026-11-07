import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendEvent = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false }] },
}))

vi.mock('../../ipc/registry', () => ({
  sendEvent: (...args: unknown[]) => sendEvent(...args),
  broadcastEvent: (event: unknown) => sendEvent({ isDestroyed: () => false }, event as never),
}))

import { publishPluginActivateSession, publishPluginRevealSession } from '../plugin-reveal-session'

/**
 * `ctx.sessions.reveal` 的 main 侧。
 *
 * 这里的校验不是洁癖：调用方是插件后台轮询，路径来自事件载荷与工具 details，
 * 相对路径 / 目录 / 已删除的会话都会出现。放过去的结果是 renderer 先清空时间线
 * 再失败——用户看到闪一下白，比什么都不做更糟。
 */
let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-reveal-'))
  sendEvent.mockClear()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function writeSession(name = 'session.jsonl'): string {
  const file = path.join(root, name)
  fs.writeFileSync(file, '{"type":"session"}\n')
  return file
}

describe('plugin reveal session', () => {
  it('存在的 jsonl 绝对路径：广播一次，带 pluginId 与路径', () => {
    const file = writeSession()
    expect(publishPluginRevealSession('subagents-board', file)).toBe(true)
    expect(sendEvent).toHaveBeenCalledTimes(1)
    const event = sendEvent.mock.calls[0]![1]
    expect(event).toMatchObject({
      type: 'plugin_reveal_session',
      pluginId: 'subagents-board',
      sessionFile: file,
    })
    expect(typeof event.seq).toBe('number')
    expect(typeof event.timestamp).toBe('number')
  })

  it('相对路径拒绝（插件的 cwd 不是用户的工作区，相对路径必然指错）', () => {
    const file = writeSession()
    expect(publishPluginRevealSession('p', path.relative(process.cwd(), file))).toBe(false)
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('非 jsonl 扩展名拒绝（挡住「传了个目录」和任意文件）', () => {
    const file = path.join(root, 'notes.md')
    fs.writeFileSync(file, '# hi')
    expect(publishPluginRevealSession('p', file)).toBe(false)
    expect(publishPluginRevealSession('p', root)).toBe(false)
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('文件已删：静默 false，不抛错（run 目录被清理是常态）', () => {
    const file = path.join(root, 'gone.jsonl')
    expect(publishPluginRevealSession('p', file)).toBe(false)
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('空串 / 纯空白不广播', () => {
    expect(publishPluginRevealSession('p', '   ')).toBe(false)
    expect(publishPluginRevealSession('p', '')).toBe(false)
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('连续调用 seq 单调递增（renderer 靠它判「这是新的」）', () => {
    const a = writeSession('a.jsonl')
    const b = writeSession('b.jsonl')
    publishPluginRevealSession('p', a)
    publishPluginRevealSession('p', b)
    const first = sendEvent.mock.calls[0]![1].seq
    const second = sendEvent.mock.calls[1]![1].seq
    expect(second).toBeGreaterThan(first)
  })
})

describe('plugin activate session', () => {
  it('存在的 jsonl 绝对路径：广播 plugin_activate_session，与 reveal 各自独立', () => {
    const file = writeSession()
    expect(publishPluginActivateSession('subagents-board', file)).toBe(true)
    expect(sendEvent).toHaveBeenCalledTimes(1)
    const event = sendEvent.mock.calls[0]![1]
    expect(event).toMatchObject({
      type: 'plugin_activate_session',
      pluginId: 'subagents-board',
      sessionFile: file,
    })
    // seq 与 reveal 共用一个计数器：两类事件交错也不会重号
    expect(publishPluginRevealSession('p', file)).toBe(true)
    const revealEvent = sendEvent.mock.calls[1]![1]
    expect(revealEvent.type).toBe('plugin_reveal_session')
    expect(revealEvent.seq).toBeGreaterThan(event.seq)
  })

  it('相对路径 / 非 jsonl / 已删除 / 空白：一律静默 false', () => {
    const file = writeSession()
    expect(publishPluginActivateSession('p', path.relative(process.cwd(), file))).toBe(false)
    expect(publishPluginActivateSession('p', path.join(root, 'notes.md'))).toBe(false)
    expect(publishPluginActivateSession('p', path.join(root, 'gone.jsonl'))).toBe(false)
    expect(publishPluginActivateSession('p', '   ')).toBe(false)
    expect(sendEvent).not.toHaveBeenCalled()
  })
})
