// 用 jsdom 环境只是因为全局 setup 会摸 window；被测代码是纯 node（子进程 + fs）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activate, deactivate } from './main.mjs'

/**
 * 后台任务插件的 main 侧单测。
 *
 * 直接驱动 activate() 返回的 invoke，走真实子进程——这几条测的正是「shell 契约」与
 * 「分页/停止语义」这类只有跑起来才暴露的问题（cmd 吞掉 bash 语法、1KB 隐式下限）。
 */

let dataDir
let handle
let sent = []

function fakeCtx() {
  let stored = {}
  return {
    dataDir,
    storage: {
      get: () => stored,
      set: (value) => {
        stored = value
      },
    },
    settings: { get: () => ({}), onChange: () => {} },
    log: () => {},
    sessions: {
      send: async (payload) => {
        sent.push(payload)
      },
      onRunEvent: () => () => {},
    },
  }
}

async function start(args, meta = {}) {
  return handle.invoke('tool.execute', {
    name: 'bg_start',
    args,
    sessionFile: 's1.jsonl',
    cwd: process.cwd(),
    ...meta,
  })
}

async function waitDone(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await handle.invoke('listTasks', {})
    const task = res.tasks.find((t) => t.id === id)
    if (task && task.status !== 'running') return task
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`task ${id} did not finish in ${timeoutMs}ms`)
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-plugin-test-'))
  sent = []
  handle = await activate(fakeCtx())
})

afterEach(async () => {
  await deactivate()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('shell contract', () => {
  it('runs bash syntax under the default shell', async () => {
    const res = await start({ command: 'for i in 1 2 3; do echo line-$i; done', label: 'bash 循环' })
    expect(res.text).toContain('已在后台启动')
    expect(res.details.shell).toBe('bash')

    const task = await waitDone(res.details.id)
    expect(task.status).toBe('exited')
    const out = await handle.invoke('tool.execute', {
      name: 'bg_output',
      args: { id: task.id },
      sessionFile: 's1.jsonl',
    })
    // cmd 会把这段语法吃掉、输出为空却退出码 0——这正是要防的假成功
    expect(out.details.chunk).toContain('line-1')
    expect(out.details.chunk).toContain('line-3')
  }, 60_000)

  it('rejects bash syntax instead of silently mangling it under cmd', async () => {
    const res = await start({ command: 'echo $(date)', shell: 'cmd' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('bash 语法')
    expect(res.text).toContain("shell:'bash'")
  }, 20_000)
})

describe('pagination and stop semantics', () => {
  it('honours small maxBytes instead of silently rounding up to 1KB', async () => {
    const res = await start({ command: 'for i in $(seq 1 40); do echo "0123456789-$i"; done' })
    const task = await waitDone(res.details.id)
    const chunk = await handle.invoke('tool.execute', {
      name: 'bg_output',
      args: { id: task.id, offset: 0, maxBytes: 64 },
      sessionFile: 's1.jsonl',
    })
    expect(chunk.details.chunkBytes).toBe(64)
    expect(chunk.details.nextOffset).toBe(64)
    expect(chunk.details.hasMore).toBe(true)
  }, 60_000)

  it('bg_stop waits for the terminal state and reports a null exit code', async () => {
    const res = await start({ command: 'sleep 60', label: '长睡' })
    const stopped = await handle.invoke('tool.execute', {
      name: 'bg_stop',
      args: { id: res.details.id, waitMs: 8_000 },
      sessionFile: 's1.jsonl',
    })
    expect(stopped.details.settled).toBe(true)
    expect(stopped.details.status).toBe('stopped')
    expect(stopped.details.exitCode).toBeNull()
    expect(stopped.text).toContain('已停止')
  }, 60_000)
})

describe('report transparency', () => {
  it('tells the model at start time whether the task will report back', async () => {
    const res = await start({ command: 'sleep 3', label: '会回报的任务' })
    expect(res.details.report.willReport).toBe(true)
    expect(res.text).toContain('回报')
    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: res.details.id, waitMs: 8_000 } })
  }, 60_000)

  it('skips the report for short successes and records why', async () => {
    const res = await start({ command: 'sleep 3.5 && echo ok', label: '短任务' })
    const task = await waitDone(res.details.id)
    if (task.status === 'exited') {
      const listed = await handle.invoke('listTasks', {})
      const row = listed.tasks.find((t) => t.id === task.id)
      expect(row.report).toBe('skipped')
      expect(row.reportNote).toContain('短于阈值')
    }
  }, 60_000)
})
