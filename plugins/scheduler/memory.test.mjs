// 任务记忆：纯函数 + 端到端（真的走 activate → runNow → 收尾写盘 → 下一轮注入）。
// 单独一个文件，别把 main.test.mjs 的 42 个用例和记忆的临时文件搅在一起。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activate, deactivate } from './main.mjs'
import {
  parseMemory,
  formatMemory,
  clampMemory,
  mergeNote,
  memoryPath,
  notePath,
  readMemoryText,
  sweepMemory,
} from './lib/memory.mjs'

const WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let dataDir
let handle
let promptCalls = []
let reply = async () => ({ ok: true, text: '一切正常' })

function fakeCtx() {
  return {
    dataDir,
    pluginId: 'scheduler',
    storage: { get: () => ({}), set: () => {} },
    settings: { get: () => ({ notifyOnStart: false }), onChange: () => () => {} },
    log: () => {},
    notify: () => {},
    ui: { ask: async () => ({ cancelled: true, answers: [] }), setComposerBar: () => {}, inbox: () => {} },
    runAgentPrompt: async (spec) => {
      promptCalls.push(spec)
      return reply(spec)
    },
  }
}

const invoke = (method, params) => handle.invoke(method, params)
const tool = (name, args = {}) => invoke('tool.execute', { name, args, cwd: process.cwd() })

async function createTask(args = {}) {
  const res = await tool('sched_create', {
    name: '监控 issue',
    prompt: '检查上游 issue 有无新评论',
    kind: 'daily',
    time: '09:00',
    ...args,
  })
  expect(res.isError, res.text).toBeFalsy()
  return res.details.id
}

async function waitRuns(taskId, count = 1, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await invoke('listRuns', { taskId, limit: 50 })
    const terminal = res.runs.filter((run) => run.status !== 'queued' && run.status !== 'running')
    if (res.runs.length >= count && terminal.length >= count) return res.runs
    await WAIT(20)
  }
  throw new Error(`task ${taskId} did not produce ${count} finished run(s)`)
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-memory-test-'))
  promptCalls = []
  reply = async () => ({ ok: true, text: '一切正常' })
  handle = await activate(fakeCtx())
})

afterEach(async () => {
  await deactivate()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('记忆文件纯函数', () => {
  it('解析与生成可以往返，手写噪声不会混进记录', () => {
    const text = formatMemory('监控 issue', {
      notes: '- 基线 comments=0',
      records: ['2026-11-07 11:02 成功 · 无变化 · 没有新评论'],
    })
    const parsed = parseMemory(text)
    expect(parsed.notes).toBe('- 基线 comments=0')
    expect(parsed.records).toEqual(['2026-11-07 11:02 成功 · 无变化 · 没有新评论'])
    const withJunk = `${text}\n## 随便一段\n不该被记住的内容`
    expect(parseMemory(withJunk).records).toHaveLength(1)
  })

  it('限幅：备注留尾部、记录只留最近 N 条并逐条截断', () => {
    const clamped = clampMemory({
      notes: 'x'.repeat(2_000),
      records: Array.from({ length: 60 }, (_, i) => `记录 ${i} ` + 'y'.repeat(300)),
    })
    expect(clamped.notes.length).toBeLessThanOrEqual(800)
    expect(clamped.records.length).toBeLessThanOrEqual(24)
    expect(Math.max(...clamped.records.map((line) => line.length))).toBeLessThanOrEqual(160)
    expect(formatMemory('x', clamped).length).toBeLessThanOrEqual(6_000)
  })

  it('合并 agent 笔记：去标题、去重、限 5 行', () => {
    const mem = { notes: '- 已处理 comment 6683925104', records: [] }
    const merged = mergeNote(mem, '## 伪装成标题\n已处理 comment 6683925104\n基线 comments=1\n' + ['a', 'b', 'c', 'd', 'e', 'f'].join('\n'))
    expect(merged.notes).toContain('基线 comments=1')
    expect(merged.notes).not.toContain('伪装成标题')
    expect(merged.notes.split('\n').filter((l) => l.includes('已处理 comment')).length).toBe(1)
    expect(merged.notes.split('\n').length).toBeLessThanOrEqual(6)
  })
})

describe('端到端：记忆真的跨轮保留', () => {
  it('第二轮 prompt 带第一轮的执行记录与长期备注，且原基线块仍在', async () => {
    reply = async () => ({ ok: true, text: '首轮结论：comments=0\nSCHED:changed' })
    const id = await createTask()
    await invoke('runNow', { id })
    await waitRuns(id)

    const file = memoryPath(id)
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toContain('首轮结论：comments=0')

    reply = async () => ({ ok: true, text: '没有新动态\nSCHED:unchanged' })
    await invoke('runNow', { id })
    await waitRuns(id, 2)
    const second = promptCalls[1].prompt
    expect(second).toContain('【任务记忆')
    expect(second).toContain('首轮结论：comments=0')
    expect(second).toContain('上次执行结论') // 老契约不能破

    const text = fs.readFileSync(file, 'utf8')
    expect(text.match(/成功 · /g)).toHaveLength(2)
  })

  it('agent 写的长期笔记被并入备注，临时文件读完即删', async () => {
    reply = async (spec) => {
      const match = spec.prompt.match(/把纯文本写进 `([^`]+)`/)
      if (!match) throw new Error('prompt 里没有给 notes 路径')
      fs.writeFileSync(match[1], '基线 comments=1\n维护者已确认收到，非提问无需回复\n', 'utf8')
      return { ok: true, text: '维护者回复了\nSCHED:changed' }
    }
    const id = await createTask()
    await invoke('runNow', { id })
    const [run] = await waitRuns(id)
    const file = memoryPath(id)
    expect(fs.readFileSync(file, 'utf8')).toContain('基线 comments=1')
    expect(fs.readFileSync(file, 'utf8')).toContain('维护者已确认收到')
    expect(fs.existsSync(notePath(run.id))).toBe(false)

    await invoke('runNow', { id })
    await waitRuns(id, 2)
    expect(promptCalls[1].prompt).toContain('基线 comments=1')
  })

  it('失败轮不把半截结论写进记忆，下一轮 prompt 看不到失败正文', async () => {
    reply = async () => ({ ok: true, text: '构建失败：3 个测试挂了\nSCHED:failed: 3 个测试未通过' })
    const id = await createTask()
    await invoke('runNow', { id })
    await waitRuns(id)
    expect(fs.readFileSync(memoryPath(id), 'utf8')).not.toContain('构建失败')

    await invoke('runNow', { id })
    await waitRuns(id, 2)
    expect(promptCalls[1].prompt).not.toContain('构建失败')
    expect(promptCalls[1].prompt).toContain('3 个测试未通过')
  })

  it('改 prompt 清执行记录、保留长期备注', async () => {
    await invoke('appendMemory', { id: await createTask(), text: '长期事实：维护者是 justhil' })
    const [task] = (await invoke('snapshot')).tasks
    reply = async () => ({ ok: true, text: '旧目标结论 XYZ\nSCHED:changed' })
    await invoke('runNow', { id: task.id })
    await waitRuns(task.id)
    expect(fs.readFileSync(memoryPath(task.id), 'utf8')).toContain('旧目标结论 XYZ')

    await tool('sched_update', { id: task.id, prompt: '换成全新的监控目标' })
    const after = fs.readFileSync(memoryPath(task.id), 'utf8')
    expect(after).not.toContain('旧目标结论 XYZ')
    expect(after).toContain('长期事实：维护者是 justhil')
  })

  it('sched_memory 的 read / append / clear 都能用，clear 同时清基线', async () => {
    const id = await createTask()
    const read0 = await tool('sched_memory', { id })
    expect(read0.text).toContain('长期备注')
    const added = await tool('sched_memory', { id, action: 'append', text: '已处理 comment 6683925104' })
    expect(added.isError).toBeFalsy()
    expect((await tool('sched_memory', { id })).text).toContain('已处理 comment 6683925104')

    const cleared = await tool('sched_memory', { id, action: 'clear' })
    expect(cleared.isError).toBeFalsy()
    expect(fs.existsSync(memoryPath(id))).toBe(false)
    expect((await invoke('snapshot')).tasks[0].hasMemory).toBe(false)
  })

  it('删任务带走记忆；孤儿文件由目录扫描兜底', async () => {
    const id = await createTask()
    await invoke('runNow', { id })
    await waitRuns(id)
    expect(fs.existsSync(memoryPath(id))).toBe(true)
    await invoke('deleteTask', { id })
    expect(fs.existsSync(memoryPath(id))).toBe(false)

    const orphan = memoryPath('task-orphan-123')
    fs.writeFileSync(orphan, formatMemory('孤儿', { notes: '', records: [] }), 'utf8')
    expect(fs.existsSync(orphan)).toBe(true)
    sweepMemory(new Set((await invoke('snapshot')).tasks.map((task) => task.id)))
    expect(fs.existsSync(orphan)).toBe(false)
  })

  it('storage 读失败时跳过孤儿扫描，不把「假空表」当成删记忆的依据', async () => {
    const id = await createTask()
    await invoke('runNow', { id })
    await waitRuns(id)
    const file = memoryPath(id)
    expect(fs.existsSync(file)).toBe(true)

    await deactivate()
    const broken = fakeCtx()
    broken.storage = { get: () => { throw new Error('corrupt storage') }, set: () => {} }
    handle = await activate(broken)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('storage 正常时激活会清掉没有任务认领的孤儿记忆', async () => {
    const orphan = memoryPath('task-orphan-xyz')
    fs.writeFileSync(orphan, formatMemory('孤儿', { notes: '', records: [] }), 'utf8')
    await deactivate()
    const ctx = fakeCtx()
    ctx.storage = {
      get: () => ({ schemaVersion: 2, tasks: [{ id: 'task-real', name: '真任务' }] }),
      set: () => {},
    }
    handle = await activate(ctx)
    expect(fs.existsSync(orphan)).toBe(false)
  })

  it('老任务（只有 baseline、没有记忆文件）不会读到空模板之外的内容', async () => {
    const id = await createTask()
    expect(readMemoryText(id, '监控 issue')).toContain('## 长期备注')
    expect((await invoke('snapshot')).tasks[0].hasMemory).toBe(false)
  })
})
