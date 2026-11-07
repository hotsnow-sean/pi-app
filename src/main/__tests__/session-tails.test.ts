import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 会话文件监听。
 *
 * 钉住的都是「错了会静默」的点：多订阅者是否共用一个句柄、退订是否真的释放、
 * 文件被重写时有没有报 truncated（不报的话 renderer 会把缩短的文件当追加，
 * 界面上留下幽灵行）。推送次数也断言——逐次推送会让 renderer 反复重读整段尾巴。
 */

type FakeContents = {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
}

const windows: Array<{ isDestroyed: () => boolean; webContents: FakeContents }> = []

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
}))

import {
  activeSessionTailCount,
  releaseSessionTailsForSender,
  setSessionTailTimingForTests,
  shutdownSessionTails,
  subscribeSessionTail,
  unsubscribeSessionTail,
} from '../session-tails'

let root = ''
let nextId = 1

function makeSender(): { contents: FakeContents; sent: Array<{ channel: string; payload: unknown }> } {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const contents: FakeContents = {
    id: nextId++,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  }
  windows.push({ isDestroyed: () => false, webContents: contents })
  return { contents, sent }
}

function writeSession(name = 'session.jsonl'): string {
  const file = path.join(root, name)
  fs.writeFileSync(file, '{"type":"session"}\n')
  return file
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tails-'))
  windows.length = 0
  shutdownSessionTails()
  setSessionTailTimingForTests({ pollMs: 40, debounceMs: 10 })
})

afterEach(() => {
  shutdownSessionTails()
  windows.length = 0
  fs.rmSync(root, { recursive: true, force: true })
  setSessionTailTimingForTests({})
})

describe('session tails', () => {
  it('文件变大：推送一次，带新大小且 truncated=false', async () => {
    const file = writeSession()
    const { contents, sent } = makeSender()
    subscribeSessionTail(file, contents as never)
    fs.appendFileSync(file, '{"type":"message"}\n')
    await sleep(120)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.channel).toBe('ipc:session-tail')
    expect(sent[0]!.payload).toMatchObject({ sessionFile: file, truncated: false })
    expect((sent[0]!.payload as { size: number }).size).toBe(fs.statSync(file).size)
  })

  it('短时间多次追加合并成一次推送（否则 renderer 会反复重读整段尾巴）', async () => {
    const file = writeSession()
    const { contents, sent } = makeSender()
    subscribeSessionTail(file, contents as never)
    fs.appendFileSync(file, 'a\n')
    fs.appendFileSync(file, 'b\n')
    fs.appendFileSync(file, 'c\n')
    await sleep(120)
    expect(sent).toHaveLength(1)
  })

  it('文件被重写变小：truncated=true（renderer 要整段重读而不是追加）', async () => {
    const file = writeSession()
    const { contents, sent } = makeSender()
    subscribeSessionTail(file, contents as never)
    fs.appendFileSync(file, 'x'.repeat(200) + '\n')
    await sleep(120)
    sent.length = 0
    fs.writeFileSync(file, '{}\n')
    await sleep(120)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.payload).toMatchObject({ truncated: true })
  })

  it('同文件多订阅者：共用句柄，两个窗口都收到', async () => {
    const file = writeSession()
    const a = makeSender()
    const b = makeSender()
    subscribeSessionTail(file, a.contents as never)
    subscribeSessionTail(file, b.contents as never)
    expect(activeSessionTailCount()).toBe(1)
    fs.appendFileSync(file, 'z\n')
    await sleep(120)
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)
  })

  it('同一窗口重复订阅同一文件幂等（切回预览会重复调 subscribe）', async () => {
    const file = writeSession()
    const a = makeSender()
    subscribeSessionTail(file, a.contents as never)
    subscribeSessionTail(file, a.contents as never)
    fs.appendFileSync(file, 'z\n')
    await sleep(120)
    expect(a.sent).toHaveLength(1)
  })

  it('最后一个订阅者退订即释放句柄（否则切走的会话一直在耗 IO）', () => {
    const file = writeSession()
    const a = makeSender()
    subscribeSessionTail(file, a.contents as never)
    expect(activeSessionTailCount()).toBe(1)
    unsubscribeSessionTail(file, a.contents as never)
    expect(activeSessionTailCount()).toBe(0)
  })

  it('两个窗口订阅同一文件，退掉其中一个不释放', () => {
    const file = writeSession()
    const a = makeSender()
    const b = makeSender()
    subscribeSessionTail(file, a.contents as never)
    subscribeSessionTail(file, b.contents as never)
    unsubscribeSessionTail(file, a.contents as never)
    expect(activeSessionTailCount()).toBe(1)
  })

  it('窗口关闭：整批收回它的订阅', () => {
    const one = writeSession('one.jsonl')
    const two = writeSession('two.jsonl')
    const a = makeSender()
    const b = makeSender()
    subscribeSessionTail(one, a.contents as never)
    subscribeSessionTail(two, a.contents as never)
    subscribeSessionTail(one, b.contents as never)
    expect(activeSessionTailCount()).toBe(2)
    releaseSessionTailsForSender(a.contents as never)
    expect(activeSessionTailCount()).toBe(1)
  })

  it('文件不存在：订阅不崩，删掉后也不会抛', async () => {
    const file = path.join(root, 'missing.jsonl')
    const { contents, sent } = makeSender()
    expect(() => subscribeSessionTail(file, contents as never)).not.toThrow()
    await sleep(80)
    expect(sent).toHaveLength(0)
  })

  it('空路径不建立监听', () => {
    const { contents } = makeSender()
    subscribeSessionTail('   ', contents as never)
    expect(activeSessionTailCount()).toBe(0)
  })
})
