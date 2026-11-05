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

describe('stdout/stderr split', () => {
  it('keeps stderr out of the stdout log and readable on demand', async () => {
    const res = await start({ command: 'echo 正常输出; echo 这是错误 >&2', label: '分流' })
    const task = await waitDone(res.details.id)
    expect(task.status).toBe('exited')

    const out = await handle.invoke('tool.execute', { name: 'bg_output', args: { id: task.id }, sessionFile: 's1.jsonl' })
    expect(out.details.chunk).toContain('正常输出')
    // 分流的意义：正常输出里不该混进错误行
    expect(out.details.chunk).not.toContain('这是错误')
    expect(out.details.errBytes).toBeGreaterThan(0)

    const err = await handle.invoke('tool.execute', {
      name: 'bg_output',
      args: { id: task.id, stream: 'err' },
      sessionFile: 's1.jsonl',
    })
    expect(err.details.stream).toBe('err')
    expect(err.details.chunk).toContain('这是错误')
  }, 60_000)

  it('routes the two streams to separate files', async () => {
    const res = await start({ command: 'echo out-line; echo err-line >&2', label: '两个文件' })
    const task = await waitDone(res.details.id)
    const listed = await handle.invoke('listTasks', {})
    const row = listed.tasks.find((t) => t.id === task.id)
    expect(row.logPath).not.toBe(row.errPath)
    expect(fs.readFileSync(row.logPath, 'utf8')).toContain('out-line')
    expect(fs.readFileSync(row.errPath, 'utf8')).toContain('err-line')
  }, 60_000)
})

describe('timeout guard', () => {
  it('kills a task that outlives timeoutSeconds and says why', async () => {
    // 5 秒是下限：传 1 秒会被抬到 5 秒，仍然按「防呆」的意图工作
    const res = await start({ command: 'sleep 30', label: '会超时', timeoutSeconds: 1 })
    expect(res.details.timeoutMs).toBe(5_000)
    const task = await waitDone(res.details.id, 20_000)
    expect(task.status).toBe('stopped')
    expect(task.stopReason).toBe('timeout')
    expect(task.exitCode).toBeNull()
  }, 40_000)
})

describe('rerun and clear', () => {
  it('reruns a finished task under a new id and keeps the old record', async () => {
    const first = await start({ command: 'echo first-run' })
    const done = await waitDone(first.details.id)
    expect(done.status).toBe('exited')

    const again = await handle.invoke('tool.execute', {
      name: 'bg_rerun',
      args: { id: first.details.id },
      sessionFile: 's1.jsonl',
      cwd: process.cwd(),
    })
    expect(again.details.id).not.toBe(first.details.id)
    expect(again.details.rerunOf).toBe(first.details.id)
    await waitDone(again.details.id)

    const listed = await handle.invoke('listTasks', {})
    // 老记录留着：它的结果和日志是独立事实，不该被新一次覆盖
    expect(listed.tasks.some((t) => t.id === first.details.id)).toBe(true)
  }, 60_000)

  it('clears finished records but leaves running ones alone', async () => {
    const running = await start({ command: 'sleep 20', label: '运行中' })
    const finished = await start({ command: 'echo done' })
    await waitDone(finished.details.id)

    const cleared = await handle.invoke('tool.execute', { name: 'bg_clear', args: {}, sessionFile: 's1.jsonl' })
    expect(cleared.details.cleared).toBeGreaterThanOrEqual(1)
    expect(cleared.details.ids).toContain(finished.details.id)
    expect(cleared.details.running).toBeGreaterThanOrEqual(1)

    const listed = await handle.invoke('listTasks', {})
    expect(listed.tasks.some((t) => t.id === running.details.id)).toBe(true)
    expect(listed.tasks.some((t) => t.id === finished.details.id)).toBe(false)

    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: running.details.id, waitMs: 8_000 } })
  }, 60_000)

  it('stops the process before deleting a running task when keepRunning is false', async () => {
    const running = await start({ command: 'sleep 30', label: '全清' })
    const pid = running.details.pid
    const cleared = await handle.invoke('tool.execute', {
      name: 'bg_clear',
      args: { keepRunning: false },
      sessionFile: 's1.jsonl',
    })
    expect(cleared.details.cleared).toBe(1)

    const listed = await handle.invoke('listTasks', {})
    expect(listed.tasks.length).toBe(0)

    // 记录删了进程还在 = 孤儿进程。给 taskkill 一点时间，然后确认真的没了
    const deadline = Date.now() + 5_000
    let stillAlive = true
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 100))
      } catch {
        stillAlive = false
        break
      }
    }
    expect(stillAlive).toBe(false)
  }, 60_000)
})

describe('session bar', () => {
  it('reports only the current session tasks, plus a count of others still running', async () => {
    const mine = await start({ command: 'sleep 20', label: '本会话' }, { sessionFile: 'C:/w/a/sess-1.jsonl' })
    const other = await start({ command: 'sleep 20', label: '别的会话' }, { sessionFile: 'C:/w/b/sess-2.jsonl' })

    // 分隔符/大小写差异不该影响归属判断
    const bar = await handle.invoke('sessionBarState', { sessionFile: 'c:\\w\\a\\sess-1.jsonl' })
    const ids = bar.mine.map((t) => t.id)
    expect(ids).toContain(mine.details.id)
    expect(ids).not.toContain(other.details.id)
    expect(bar.runningMine).toBe(1)
    expect(bar.runningOthers).toBe(1)

    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: mine.details.id, waitMs: 8_000 }, sessionFile: 's1.jsonl' })
    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: other.details.id, waitMs: 8_000 }, sessionFile: 's1.jsonl' })
  }, 60_000)

  it('bumps focus seq so the panel knows to scroll to that task', async () => {
    const res = await start({ command: 'sleep 20', label: '要定位的' })
    const before = await handle.invoke('listTasks', {})
    const seq0 = before.focus.seq

    const focused = await handle.invoke('focusTask', { id: res.details.id })
    expect(focused.focus.id).toBe(res.details.id)
    expect(focused.focus.seq).toBe(seq0 + 1)

    // 连点同一条也要再涨一次：面板靠 seq 变化重放定位
    const again = await handle.invoke('focusTask', { id: res.details.id })
    expect(again.focus.seq).toBe(seq0 + 2)

    await expect(handle.invoke('focusTask', { id: 'bg-999' })).rejects.toThrow(/unknown task/)
    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: res.details.id, waitMs: 8_000 }, sessionFile: 's1.jsonl' })
  }, 60_000)
})
