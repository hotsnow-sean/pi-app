// 用 jsdom 环境只是因为全局 setup 会摸 window；被测代码是纯 node（子进程 + fs）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
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
let bars = []
/** 插件注册的设置变更回调：测试里用它改 reportThresholdMs 等运行期设置 */
let settingsChangeCb = null
/** 最近一次 fakeCtx 的持久化存储：重启模拟（二次 activate）时复用 */
let currentStorage = null

function fakeCtx(reuseStorage) {
  // let：save() 会整体替换 stored（const 会抛 TypeError）
  let stored = reuseStorage ?? {}
  return {
    dataDir,
    pluginId: 'bg-test',
    storage: {
      get: () => stored,
      set: (value) => {
        stored = value
        // save() 是整体替换而不是原地改：重启模拟要拿得到最新的一份
        currentStorage = stored
      },
    },
    settings: {
      get: () => ({}),
      onChange: (cb) => {
        settingsChangeCb = cb
      },
    },
    log: () => {},
    ui: {
      setComposerBar: (sessionFile, bar) => {
        bars.push({ sessionFile, bar })
      },
    },
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

/** 与 lib/shell.mjs 同源的 bash 落点（测试里不 import，免得和 ?v= 版本混出两个实例） */
const BASH =
  process.platform === 'win32'
    ? [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\Git\\bin\\bash.exe'),
      ].find((candidate) => candidate && fs.existsSync(candidate))
    : fs.existsSync('/bin/bash')
      ? '/bin/bash'
      : '/bin/sh'

/** 等条件成立（pidfile 是 bash 启动后才写的，不能立刻读） */
async function waitUntil(fn, timeoutMs = 5_000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}

/** MSYS/POSIX 进程组里还有没有活口——报告 §1.1 的关键断言 */
function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false
  const probe = spawnSync(BASH, ['-c', `kill -0 -${pgid} 2>/dev/null`], { windowsHide: true })
  return probe.status === 0
}

/** 任务的进程组 id：Windows 在 pidfile 里（MSYS 的 $$），POSIX 上 detached 后就是 pid */
function pgidOf(taskId, pid) {
  if (process.platform !== 'win32') return pid
  const file = path.join(dataDir, 'logs', `${taskId}.pid`)
  try {
    return Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10) || 0
  } catch {
    return 0
  }
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-plugin-test-'))
  sent = []
  bars = []
  settingsChangeCb = null
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
    if (process.platform !== 'win32') {
      // POSIX 上 cmd/powershell 直接被拒（没有「静默落到 /bin/sh」这回事了）
      const res = await start({ command: 'echo $(date)', shell: 'cmd' })
      expect(res.isError).toBe(true)
      expect(res.text).toContain('只有 Windows 支持')
      return
    }
    const res = await start({ command: 'echo $(date)', shell: 'cmd' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('bash 语法')
    expect(res.text).toContain("shell:'bash'")
  }, 20_000)

  it('rejects a shell value that is not declared in the schema', async () => {
    // schema 只是建议：模型写个 pwsh/zsh 进来，过去会静默落到平台默认 shell 上
    const res = await start({ command: 'echo hi', shell: 'pwsh' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('不认识的 shell')
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

/**
 * 报告 §1.1 的回归：`bg_stop force` 返回「已停止」，但最内层 sleep 还在跑、
 * 日志被锁删不掉。根因不是写法而是 Windows 侧父子链断了（Git Bash 的 fork 把子进程的
 * 父 PID 指向已退出的 helper），只能按 MSYS 进程组收。这三条用例起真进程验证。
 */
describe('process tree termination', () => {
  it('kills the whole process group instead of orphaning the innermost command', async () => {
    const res = await start({ command: 'sleep 120', label: '深睡' })
    const id = res.details.id
    // pidfile 是 bash 起来之后才写的，不能立刻读
    expect(await waitUntil(() => pgidOf(id, res.details.pid) > 0)).toBe(true)
    const pgid = pgidOf(id, res.details.pid)
    expect(groupAlive(pgid)).toBe(true)

    const stopped = await handle.invoke('tool.execute', {
      name: 'bg_stop',
      args: { id, force: true, waitMs: 8_000 },
      sessionFile: 's1.jsonl',
    })
    expect(stopped.details.settled).toBe(true)
    expect(stopped.details.status).toBe('stopped')
    // 修前这里会是 true：launcher 被 taskkill 收掉，sleep 留在 MSYS 组里继续睡
    expect(await waitUntil(() => !groupAlive(pgid), 2_000)).toBe(true)
  }, 60_000)

  it('escalates the timeout path to the same group kill', async () => {
    const res = await start({ command: 'sleep 120', label: '超时深睡', timeoutSeconds: 5 })
    const id = res.details.id
    expect(await waitUntil(() => pgidOf(id, res.details.pid) > 0)).toBe(true)
    const pgid = pgidOf(id, res.details.pid)

    const task = await waitDone(id, 25_000)
    expect(task.status).toBe('stopped')
    expect(task.stopReason).toBe('timeout')
    // 超时链路与手停共用 stopTask：能杀干净才算共用
    expect(await waitUntil(() => !groupAlive(pgid), 3_000)).toBe(true)
  }, 60_000)

  it('leaves no task files behind and says so in the clean-up receipt', async () => {
    const res = await start({ command: 'sleep 120', label: '清掉' })
    const id = res.details.id
    expect(await waitUntil(() => pgidOf(id, res.details.pid) > 0)).toBe(true)

    const cleared = await handle.invoke('tool.execute', {
      name: 'bg_clear',
      args: { keepRunning: false },
      sessionFile: 's1.jsonl',
    })
    expect(cleared.details.cleared).toBe(1)
    // 进程树收干净了，回执就不该出现「文件被占用」——反过来，真的删不掉时必须说
    expect(cleared.details.stuckFiles ?? 0).toBe(0)
    expect(cleared.text).not.toContain('仍被进程占用')
    const leftovers = fs.readdirSync(path.join(dataDir, 'logs')).filter((name) => name.startsWith(`${id}.`))
    expect(leftovers).toEqual([])
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

  it('says it reached the end instead of claiming there is no output', async () => {
    const res = await start({ command: 'echo only-line', label: '读到末尾' })
    const task = await waitDone(res.details.id)
    const first = await handle.invoke('tool.execute', {
      name: 'bg_output',
      args: { id: task.id },
      sessionFile: 's1.jsonl',
    })
    expect(first.text).toContain('only-line')

    const again = await handle.invoke('tool.execute', {
      name: 'bg_output',
      args: { id: task.id, offset: first.details.nextOffset },
      sessionFile: 's1.jsonl',
    })
    expect(again.details.chunk).toBe('')
    // offset 已在末尾：说「没有输出」会被读成「这个任务根本没输出」
    expect(again.text).toContain('已读到末尾')
    expect(again.text).not.toContain('没有输出。')
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

  it('reports running tasks as skipped even without a status filter', async () => {
    const running = await start({ command: 'sleep 20', label: '只有运行中' })
    // 不传 status：运行中的任务本来就「会被选中但被 keepRunning 挡下」，
    // 这必须算进 skippedRunning。否则回执说「没有已结束的任务可清理」，
    // 而实际是一个任务正在跑——排障时这句话会把人带偏
    const res = await handle.invoke('tool.execute', { name: 'bg_clear', args: {}, sessionFile: 's1.jsonl' })
    expect(res.details.cleared).toBe(0)
    expect(res.details.skippedRunning).toBe(1)
    expect(res.text).toContain('1 个运行中任务已跳过')
    expect(res.text).not.toContain('没有已结束的任务可清理')

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

describe('composer bar', () => {
  it('pushes only the tasks of the pushed session, with separator/case differences tolerated', async () => {
    const mine = await start({ command: 'sleep 20', label: '本会话' }, { sessionFile: 'C:/w/a/sess-1.jsonl' })
    const other = await start({ command: 'sleep 20', label: '别的会话' }, { sessionFile: 'C:/w/b/sess-2.jsonl' })

    const last = bars.filter((b) => b.sessionFile === 'C:/w/a/sess-1.jsonl').at(-1)
    expect(last.bar.tone).toBe('active')
    // panelId 必须跟 ctx.pluginId 走（runtime 的 PLUGIN_ID 常量只是测试兜底）：
    // manifest 改 id 而托盘还在推旧 id，宿主就打不开面板
    expect(last.bar.panelId).toBe('plugin:bg-test:tasks')
    const ids = last.bar.rows.map((r) => r.id)
    expect(ids).toContain(mine.details.id)
    expect(ids).not.toContain(other.details.id)
    // 运行中的行必须带 startedAt 与停止动作：宿主靠前者现算耗时，靠后者给按钮。
    // 注意行状态用的是宿主观感词（active），不是本插件的 running。
    const row = last.bar.rows.find((r) => r.id === mine.details.id)
    expect(row.startedAt).toBeGreaterThan(0)
    expect(row.state).toBe('active')
    expect(row.actions).toEqual([{ id: 'stop', icon: 'stop', title: '停止' }])

    // 大小写/分隔符不同也要归到同一个会话（宿主与工具侧的 sessionFile 来源不同）
    const same = await handle.invoke('refreshBar', { sessionFile: 'c:\\w\\a\\sess-1.jsonl' })
    expect(same.bar.rows.map((r) => r.id)).toContain(mine.details.id)
    expect(same.bar.rows.map((r) => r.id)).not.toContain(other.details.id)

    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: mine.details.id, waitMs: 8_000 }, sessionFile: 's1.jsonl' })
    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: other.details.id, waitMs: 8_000 }, sessionFile: 's1.jsonl' })
  }, 60_000)

  it('pushes a terminal state after the task ends and clears when nothing is left', async () => {
    const res = await start({ command: 'echo bye', label: '短命' })
    await waitDone(res.details.id)
    const done = bars.filter((b) => b.sessionFile === 's1.jsonl').at(-1)
    expect(done.bar.tone).toBe('ok')
    // 子进程正常退出 → 观感 ok；宿主不认识 'exited'，那是插件的状态机
    expect(done.bar.rows[0].state).toBe('ok')

    await handle.invoke('removeTask', { id: res.details.id })
    expect(bars.at(-1).bar).toBeNull()
  }, 60_000)

  it('bumps focus seq from composerBarAction so the panel scrolls to that task', async () => {
    const res = await start({ command: 'sleep 20', label: '要定位的' })
    const before = await handle.invoke('listTasks', {})
    const seq0 = before.focus.seq

    const focused = await handle.invoke('composerBarAction', { action: 'select', id: res.details.id })
    expect(focused.focus.id).toBe(res.details.id)
    expect(focused.focus.seq).toBe(seq0 + 1)

    // 连点同一条也要再涨一次：面板靠 seq 变化重放定位
    const again = await handle.invoke('composerBarAction', { action: 'select', id: res.details.id })
    expect(again.focus.seq).toBe(seq0 + 2)

    await expect(handle.invoke('composerBarAction', { action: 'select', id: 'bg-999' })).rejects.toThrow(/unknown task/)
    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: res.details.id, waitMs: 8_000 }, sessionFile: 's1.jsonl' })
  }, 60_000)

  it('stops a task from the bar without waiting for a report', async () => {
    const res = await start({ command: 'sleep 20', label: '托盘停止' })
    const stopped = await handle.invoke('composerBarAction', { action: 'stop', id: res.details.id })
    expect(stopped.ok).toBe(true)
    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: res.details.id, waitMs: 8_000 }, sessionFile: 's1.jsonl' })
  }, 60_000)
})

describe('report queue vs explicit actions', () => {
  it('reports a failed task immediately and does not repeat it after clearing', async () => {
    // 投递即时化后，「已完成任务被清理」几乎不可能抢在回报前面（清理是人的时间尺度，
    // 投递是下一个 tick）；孤儿回报的真防线是 markDeleted-before-await，
    // 由「never reports a task cleared while it was still stopping」覆盖。
    // 这里钉住新的时序：失败 → 立刻回报 → 清理 → 不再有第二条。
    const res = await start({ command: 'echo boom; exit 3', label: '会失败' })
    await waitDone(res.details.id)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(sent).toHaveLength(1)
    expect(sent[0].content).toContain(res.details.id)

    await handle.invoke('tool.execute', {
      name: 'bg_clear',
      args: { status: ['failed'] },
      sessionFile: 's1.jsonl',
    })
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(sent).toHaveLength(1)
  }, 30_000)

  it('suppresses the automatic report once bg_stop delivered the terminal state', async () => {
    const res = await start({ command: 'sleep 20', label: '同步停止' })
    const stopped = await handle.invoke('tool.execute', {
      name: 'bg_stop',
      args: { id: res.details.id, waitMs: 8_000 },
      sessionFile: 's1.jsonl',
    })
    expect(stopped.details.settled).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(sent).toHaveLength(0)
    const listed = await handle.invoke('listTasks', {})
    expect(listed.tasks.find((t) => t.id === res.details.id).report).toBe('suppressed')
  }, 30_000)

  it('keeps the inline receipt promise: a short task never reports again', async (t) => {
    // bg_start 的文案写着「它已经结束，不需要再查询，也不会再单独回报」
    // —— 那就必须真的不再回报，否则这句承诺本身就是 bug。
    // 用 cmd 跑：bash 在 Windows 上启动动辄 200ms，撞不上 120ms 的内联窗口
    const res = await start({ command: 'exit /b 3', label: '内联失败', shell: 'cmd' })
    if (res.details.returnedInline !== true) {
      // 这条用例的前提是「任务在 120ms 内结束」。全量并行跑、机器负载高时，cmd 启动
      // 本身就要 200ms+，前提不成立（此时走的是异步回报路径，不是缺陷）。
      // 跳过而不是放宽断言：放宽了就再也测不到「内联返回后不重复回报」这件事。
      // skip() 内部会抛信号中断本用例，不需要再 return。
      t.skip('当前负载下 cmd 启动超过 120ms 内联窗口，无法验证内联回执')
    }
    expect(res.details.report).toBe('suppressed')

    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(sent).toHaveLength(0)
  }, 30_000)

  it('accepts a single status string in bg_clear', async () => {
    // 工具描述一直写着「单个字符串也接受」，实现也容错，只有 schema 卡住了
    const res = await start({ command: 'exit 5', label: '单值清理' })
    await waitDone(res.details.id)
    const cleared = await handle.invoke('tool.execute', {
      name: 'bg_clear',
      args: { status: 'failed' },
      sessionFile: 's1.jsonl',
    })
    expect(cleared.details.ids).toContain(res.details.id)
  }, 30_000)

  it('clears exact ids via bg_clear({ids}) and reports unknown ones as missing', async () => {
    const a = await start({ command: 'echo a', label: '点名A' })
    await waitDone(a.details.id)
    const cleared = await handle.invoke('tool.execute', {
      name: 'bg_clear',
      args: { ids: [a.details.id, 'bg-404'] },
      sessionFile: 's1.jsonl',
    })
    expect(cleared.details.ids).toEqual([a.details.id])
    expect(cleared.details.missing).toEqual(['bg-404'])

    const listed = await handle.invoke('listTasks', {})
    expect(listed.tasks.some((t) => t.id === a.details.id)).toBe(false)
  }, 30_000)

  it('migrates the legacy report value sent to queued on load', async () => {
    // v4.1 改名：sent 读起来像「用户已收到」，实际只代表已交给宿主投递。
    // 旧持久化记录读入时必须统一迁移，否则列表语义分裂。
    const legacyCtx = fakeCtx()
    legacyCtx.storage.set({
      seq: 2,
      tasks: [
        { id: 'bg-1', label: '旧值', status: 'exited', exitCode: 0, report: 'sent', sessionFile: 's1.jsonl' },
        { id: 'bg-2', label: '新值', status: 'exited', exitCode: 0, report: 'queued', sessionFile: 's1.jsonl' },
      ],
    })
    const legacyHandle = await activate(legacyCtx)
    try {
      const listed = await legacyHandle.invoke('listTasks', {})
      const reports = Object.fromEntries(listed.tasks.map((t) => [t.id, t.report]))
      expect(reports['bg-1']).toBe('queued')
      expect(reports['bg-2']).toBe('queued')
    } finally {
      await deactivate()
    }
  })

  it('skips running tasks when clearing by ids unless keepRunning is false', async () => {
    // v5 实测：ids 路径曾无视 keepRunning 默认值，误传一个 id 就静默杀掉长任务
    const running = await start({ command: 'sleep 30', label: '点名保留' })
    const finished = await start({ command: 'echo done', label: '点名清理' })
    await waitDone(finished.details.id)

    const cleared = await handle.invoke('tool.execute', {
      name: 'bg_clear',
      args: { ids: [running.details.id, finished.details.id] },
      sessionFile: 's1.jsonl',
    })
    expect(cleared.details.ids).toEqual([finished.details.id])
    expect(cleared.details.skippedRunning).toBe(1)
    expect(cleared.text).toContain('运行中任务已跳过')
    // 上面是跳过不是强杀：进程必须还活着
    expect(() => process.kill(running.details.pid, 0)).not.toThrow()

    // 显式 keepRunning:false 才是「连任务一起清」
    const forced = await handle.invoke('tool.execute', {
      name: 'bg_clear',
      args: { ids: running.details.id, keepRunning: false },
      sessionFile: 's1.jsonl',
    })
    expect(forced.details.ids).toEqual([running.details.id])
    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: running.details.id, waitMs: 8_000 } }).catch(() => {})
  }, 60_000)

  it('explains skipped running tasks when clearing by status running', async () => {
    // v5 实测：明明有 3 个运行中任务，文案却说「没有 running 任务可清理」——排障陷阱
    const running = await start({ command: 'sleep 30', label: '状态路径' })
    const res = await handle.invoke('tool.execute', {
      name: 'bg_clear',
      args: { status: 'running' },
      sessionFile: 's1.jsonl',
    })
    expect(res.details.cleared).toBe(0)
    expect(res.details.skippedRunning).toBeGreaterThanOrEqual(1)
    expect(res.text).toContain('运行中任务已跳过')
    expect(res.text).not.toContain('没有状态为 running 的任务')
    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: running.details.id, waitMs: 8_000 } })
  }, 60_000)

  it('never reports a task cleared while it was still stopping', async () => {
    // 真实竞态：bg_clear({keepRunning:false}) 要先等进程退出（最长 3s），
    // 这段窗口里 exit 回调会去入队——队列若在清完之后才 flush，就是一条孤儿回报。
    const res = await start({ command: 'sleep 30', label: '边停边清' })
    const cleared = await handle.invoke('tool.execute', {
      name: 'bg_clear',
      args: { status: 'running', keepRunning: false },
      sessionFile: 's1.jsonl',
    })
    expect(cleared.details.ids).toContain(res.details.id)

    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(sent).toHaveLength(0)
  }, 30_000)
})

describe('structured output', () => {
  it('returns the same payload as JSON when asked', async () => {
    const res = await start({ command: 'echo one' })
    await waitDone(res.details.id)
    const listed = await handle.invoke('tool.execute', {
      name: 'bg_list',
      args: { format: 'json' },
      sessionFile: 's1.jsonl',
    })
    expect(listed.text).toContain('```json')
    const payload = JSON.parse(listed.text.split('```json')[1].split('```')[0])
    expect(payload.tasks.some((t) => t.id === res.details.id)).toBe(true)
  }, 60_000)

  it('echoes the effective maxBytes when the request was clamped', async () => {
    const res = await start({ command: 'echo hello-world' })
    const task = await waitDone(res.details.id)
    const out = await handle.invoke('tool.execute', {
      name: 'bg_output',
      args: { id: task.id, offset: 0, maxBytes: 10 },
      sessionFile: 's1.jsonl',
    })
    expect(out.details.requestedMaxBytes).toBe(10)
    expect(out.details.effectiveMaxBytes).toBe(64)
    expect(out.text).toContain('已按 64B')
  }, 60_000)

  it('returns exactly N lines for tailLines N, including 1', async () => {
    // v5 实测：日志每行带 \n，split 出的末尾空串占了一个名额——
    // tailLines 稳定少一行，传 1 直接拿到空串。这是读日志最常用的参数，钉死。
    const res = await start({ command: 'for i in $(seq 1 120); do echo "line $i"; done' })
    const task = await waitDone(res.details.id)
    for (const [want, firstLine] of [[1, 'line 120'], [2, 'line 119'], [5, 'line 116']]) {
      const out = await handle.invoke('tool.execute', {
        name: 'bg_output',
        args: { id: task.id, tailLines: want, format: 'json' },
        sessionFile: 's1.jsonl',
      })
      const lines = out.details.chunk.split('\n')
      expect(lines.length, `tailLines=${want}`).toBe(want)
      expect(lines[0], `tailLines=${want}`).toBe(firstLine)
      expect(lines.at(-1), `tailLines=${want}`).toBe('line 120')
      // chunkBytes 必须是实际返回文本的大小，不是整个日志的大小
      expect(out.details.chunkBytes, `tailLines=${want}`).toBe(Buffer.byteLength(out.details.chunk, 'utf8'))
      expect(out.details.chunkBytes, `tailLines=${want}`).toBeLessThan(out.details.totalBytes)
    }
  }, 60_000)

  it('defaults to the tail 20 lines when tailLines is omitted', async () => {
    // 拆模块回归（复审 P0）：REPORT_TAIL_LINES 忘了 export，tools 解构拿到 undefined，
    // 尾部截取整段被跳过——省略 tailLines 变成「从头读全文」。manifest 承诺
    // "Call it with only an id to get the tail"，这条钉住默认值真的生效。
    const res = await start({ command: 'for i in $(seq 1 120); do echo "line $i"; done' })
    const task = await waitDone(res.details.id)
    const out = await handle.invoke('tool.execute', {
      name: 'bg_output',
      args: { id: task.id, format: 'json' },
      sessionFile: 's1.jsonl',
    })
    const lines = out.details.chunk.split('\n')
    expect(lines.length).toBe(20)
    expect(lines[0]).toBe('line 101')
    expect(lines.at(-1)).toBe('line 120')
    expect(out.details.truncated).toBe(true)
  }, 60_000)
})

describe('delivery semantics (v0.6.0)', () => {
  it('steers the report into the conversation', async () => {
    // 忙时插话（下一个工具调用边界）、闲时宿主照旧开新轮——及时性是回报的全部价值
    const res = await start({ command: 'exit 3', label: '插话回报' })
    await waitDone(res.details.id)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(sent).toHaveLength(1)
    expect(sent[0].deliverAs).toBe('steer')
    // 回报的 origin 也要跟 ctx.pluginId 走：宿主按它路由插件消息的归属
    expect(sent[0].origin.pluginId).toBe('bg-test')
  }, 30_000)

  it('tailors the directive to the batch: failure gets an action prompt', async () => {
    const res = await start({ command: 'echo boom; exit 3', label: '失败指令' })
    await waitDone(res.details.id)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(sent).toHaveLength(1)
    expect(sent[0].content).toContain('可能影响后续步骤')
    expect(sent[0].content).not.toContain('仅供知晓')
    // 每条任务行自带运行时长
    expect(sent[0].content).toMatch(/耗时 \d/)
  }, 30_000)

  it('tailors the directive to the batch: pure success stays low-key', async () => {
    // 成功但超过 15s 阈值才回报：sleep 16 太慢，把阈值调到 1s
    settingsChangeCb?.({ reportThresholdMs: 1_000 })
    const res = await start({ command: 'sleep 2 && echo ok', label: '成功指令' })
    await waitDone(res.details.id)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(sent).toHaveLength(1)
    expect(sent[0].content).toContain('仅供知晓')
    expect(sent[0].content).not.toContain('可能影响后续步骤')
  }, 30_000)
})

describe('restart and wording (v0.6.1)', () => {
  it('pushes composer bars for persisted sessions on activate', async () => {
    // 重启后没有任何任务事件，托盘若只在事件时推送就永远不出现——
    // 而面板里有列表，两边可见性必须一致
    const res = await start({ command: 'exit 3', label: '重启可见' })
    await waitDone(res.details.id)
    await deactivate()
    bars = []
    handle = await activate(fakeCtx(currentStorage))
    try {
      expect(bars.length).toBeGreaterThan(0)
      expect(JSON.stringify(bars)).toContain(res.details.id)
    } finally {
      await deactivate()
    }
  }, 30_000)

  it('distinguishes running-skipped from missing ids in bg_clear', async () => {
    // v6 实测：运行中被跳过的 id 被报成「id 不存在」，让人以为记错了 id
    const running = await start({ command: 'sleep 30', label: '还在跑' })
    const cleared = await handle.invoke('tool.execute', {
      name: 'bg_clear',
      args: { ids: [running.details.id, 'bg-999'] },
      sessionFile: 's1.jsonl',
    })
    expect(cleared.details.cleared).toBe(0)
    expect(cleared.details.skippedRunning).toBe(1)
    expect(cleared.details.missing).toEqual(['bg-999'])
    expect(cleared.text).toContain('运行中任务已跳过')
    expect(cleared.text).toContain('bg-999')
    await handle.invoke('tool.execute', { name: 'bg_stop', args: { id: running.details.id, waitMs: 8_000 } }).catch(() => {})
  }, 30_000)
})

describe("log file hygiene (v8 report)", () => {
  it("a rejected bg_start leaves no orphan log files and does not burn an id", async () => {
    // v8 §八.3：校验发生在日志文件建好之后，被拒绝的启动留下 0 字节 bg-N.log/.err，
    // 它们没有任务记录，bg_clear 永远清不到
    const logsDir = path.join(dataDir, "logs")
    const before = fs.readdirSync(logsDir)

    const rejected = await start({ command: "for i in 1 2; do echo $i; done", shell: "cmd" })
    expect(rejected.isError).toBe(true)
    expect(fs.readdirSync(logsDir)).toEqual(before)

    // seq 也不该被这个失败消耗掉：任务列表里不该出现无解释的空号
    const ok = await start({ command: "echo fine", label: "接着启动" })
    expect(ok.details.id).toBe("bg-1")
    await waitDone(ok.details.id)
  }, 40_000)

  it("bg_clear sweeps orphan files that no record points at", async () => {
    // 句柄未释放导致删不掉、或历史上漏删的文件：扫目录是唯一能把它们收掉的途径
    const logsDir = path.join(dataDir, "logs")
    const scriptsDir = path.join(dataDir, "scripts")
    fs.writeFileSync(path.join(logsDir, "bg-901.log"), "")
    fs.writeFileSync(path.join(logsDir, "bg-901.err"), "")
    fs.writeFileSync(path.join(scriptsDir, "bg-902.ps1"), "")
    // 有记录的任务文件必须留着，别误伤
    const live = await start({ command: "echo keep-me", label: "保留" })
    const task = await waitDone(live.details.id)

    await handle.invoke("clearTasks", {})

    const logs = fs.readdirSync(logsDir)
    const scripts = fs.readdirSync(scriptsDir)
    expect(logs).not.toContain("bg-901.log")
    expect(logs).not.toContain("bg-901.err")
    expect(scripts).not.toContain("bg-902.ps1")
    // 被清掉的任务自身文件也不该留下
    expect(logs).not.toContain(`${task.id}.log`)
  }, 40_000)

  it("activate sweeps leftovers from a previous run", async () => {
    const logsDir = path.join(dataDir, "logs")
    await deactivate()
    fs.writeFileSync(path.join(logsDir, "bg-777.log"), "")
    handle = await activate(fakeCtx(currentStorage))
    try {
      expect(fs.readdirSync(logsDir)).not.toContain("bg-777.log")
    } finally {
      await deactivate()
    }
  }, 20_000)
})

describe("incremental read (review P1-1)", () => {
  it("never skips bytes when a multi-byte character lands on the chunk boundary", async () => {
    // decode() 遇到被切断的多字节字符会退到最后一个换行；若 nextOffset 仍按
    // 「读了多少字节」前进，被退回去的那段既不在本次文本里、也再读不到——
    // 一行内容就这样静默消失了。这里把日志改写成固定宽度的中文行，
    // 用 64B 的切片保证边界正好落在某个字的中间，然后一路读到底拼回来比对。
    const res = await start({ command: "echo seed", label: "编码边界" })
    const task = await waitDone(res.details.id)
    const line = "中文内容测试行"
    const text = `${Array.from({ length: 10 }, () => line).join("\n")}\n`
    fs.writeFileSync(task.logPath, text)

    let offset = 0
    let collected = ""
    for (let i = 0; i < 100; i += 1) {
      const chunk = await handle.invoke("readOutput", { id: task.id, offset, maxBytes: 64 })
      // 返回的文本必须是合法 UTF-8 前缀：出现替换符说明把字切断了
      expect(chunk.chunk).not.toContain("\uFFFD")
      collected += chunk.chunk
      if (!chunk.hasMore) break
      // 每一步都必须真的前进，否则调用方会卡死在同一段
      expect(chunk.nextOffset).toBeGreaterThan(offset)
      offset = chunk.nextOffset
    }
    expect(collected).toBe(text)
  }, 30_000)
})

describe("restart loses the process (review P1-2)", () => {
  it("records lost as skipped-with-reason and offers a manual retry", async () => {
    // 重启后 pid 不在：既不能写成 pending（没有任何调度会送它，面板会一直挂着
    // 「待回报」），也不该自动补一报（重启瞬间一批任务同时 lost 只是噪声）。
    await deactivate()
    const logPath = path.join(dataDir, "logs", "bg-7.log")
    fs.writeFileSync(logPath, "")
    const recovered = await activate(
      fakeCtx({
        seq: 7,
        tasks: [
          {
            id: "bg-7",
            label: "失联任务",
            command: "sleep 100",
            status: "running",
            // 不存在的 pid：alive() 必假
            pid: 2_147_483_647,
            startedAt: Date.now() - 5_000,
            sessionFile: "s1.jsonl",
            logPath,
            errPath: path.join(dataDir, "logs", "bg-7.err"),
          },
        ],
      }),
    )
    handle = recovered
    try {
      const listed = await handle.invoke("listTasks", {})
      const row = listed.tasks.find((t) => t.id === "bg-7")
      expect(row.status).toBe("lost")
      expect(row.report).toBe("skipped")
      expect(row.reportNote).toContain("重新回报")

      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(sent).toHaveLength(0)

      // 面板的「重新回报」走的就是这个方法
      const retried = await handle.invoke("retryReport", { id: "bg-7" })
      expect(retried.ok).toBe(true)
      expect(sent).toHaveLength(1)
      expect(sent[0].content).toContain("bg-7")
    } finally {
      await deactivate()
    }
  }, 30_000)
})

describe("report delivery failure (review P2-3)", () => {
  it("keeps the task error intact and records the delivery problem separately", async () => {
    await deactivate()
    const failing = fakeCtx()
    failing.sessions.send = async () => {
      throw new Error("worker gone")
    }
    handle = await activate(failing)
    try {
      const res = await start({ command: "echo boom; exit 3", label: "投递失败" })
      await waitDone(res.details.id)
      await new Promise((resolve) => setTimeout(resolve, 800))
      const listed = await handle.invoke("listTasks", {})
      const row = listed.tasks.find((t) => t.id === res.details.id)
      expect(row.report).toBe("failed")
      expect(row.reportError).toContain("worker gone")
      // task.error 是「任务为什么失败」，不能被投递问题覆盖
      expect(row.error).toBeNull()
      expect(row.status).toBe("failed")
    } finally {
      await deactivate()
    }
  }, 30_000)
})

describe("storage safety (review re-run)", () => {
  it("keeps owned logs when the task table cannot be read", async () => {
    // 复审 P1：宿主 readStorage 是 fail open，读失败时插件拿到的是一份「合法空表」——
    // 若照旧扫孤儿，磁盘上有主的日志会被全数删光且不可恢复。现在 load() 认不出
    // 「本插件写过的表」就跳过 sweep，这里钉住两条路：get 抛错、get 返回 {}。
    const res = await start({ command: "echo kept", label: "有主日志" })
    const task = await waitDone(res.details.id)
    await deactivate()

    const logsDir = path.join(dataDir, "logs")
    expect(fs.readdirSync(logsDir)).toContain(`${task.id}.log`)

    // 路 1：storage.get 直接抛错
    const brokenCtx = fakeCtx()
    brokenCtx.storage.get = () => {
      throw new Error("disk gone")
    }
    handle = await activate(brokenCtx)
    expect(fs.readdirSync(logsDir)).toContain(`${task.id}.log`)
    await deactivate()

    // 路 2：get 返回 {}（损坏文件被宿主吞掉后的形状）
    handle = await activate(fakeCtx())
    expect(fs.readdirSync(logsDir)).toContain(`${task.id}.log`)
    await deactivate()

    // 对照组：表读得到（有 seq 的表、但没这条记录）时，真孤儿照样收——守卫不能把功能拦死
    handle = await activate(fakeCtx({ seq: 9, tasks: [] }))
    expect(fs.readdirSync(logsDir).filter((n) => /^bg-\d+\.log$/.test(n))).toEqual([])
  }, 30_000)

  it("does not wipe the stored table when recover runs against an unreadable table", async () => {
    // recover() 只在确实动过表时才 save：读失败的一代里没有 running 任务，
    // 不得用空表覆盖磁盘上还没读出来的记录
    const res = await start({ command: "echo kept", label: "落盘对照" })
    await waitDone(res.details.id)
    const snapshot = JSON.parse(JSON.stringify(currentStorage))
    await deactivate()

    const brokenCtx = fakeCtx()
    brokenCtx.storage.get = () => {
      throw new Error("disk gone")
    }
    handle = await activate(brokenCtx)
    await deactivate()

    expect(currentStorage.seq).toBe(snapshot.seq)
    expect(currentStorage.tasks.map((t) => t.id)).toEqual(snapshot.tasks.map((t) => t.id))
  }, 30_000)

  it("clearTasks must not sweep owned logs in a generation whose storage is unreadable", async () => {
    // 二轮复审 P1：sweep 的守卫只设在 activate 调用点，clearTasks 内部的
    // sweepOrphanFiles() 会绕过去——读失败一代 known 集合为空，一次顺手
    // 的 bg_clear 就能把有主日志删光。守卫已下沉到 sweepOrphanFiles 本体
    const res = await start({ command: "echo kept", label: "有主日志" })
    const task = await waitDone(res.details.id)
    await deactivate()

    const logsDir = path.join(dataDir, "logs")
    const brokenCtx = fakeCtx()
    brokenCtx.storage.get = () => {
      throw new Error("disk gone")
    }
    handle = await activate(brokenCtx)
    // 读失败一代里清理照常可用（返回无可清理），但绝不能顺手动磁盘上的日志
    const cleared = await handle.invoke("clearTasks", {})
    expect(cleared.ok).toBe(true)
    expect(fs.readdirSync(logsDir)).toContain(`${task.id}.log`)
    await deactivate()

    // 对照组照旧：表可用时 clear 后的扫尾正常收孤儿
    handle = await activate(fakeCtx({ seq: 9, tasks: [] }))
    expect(fs.readdirSync(logsDir).filter((n) => /^bg-\d+\.log$/.test(n))).toEqual([])
  }, 30_000)
})
