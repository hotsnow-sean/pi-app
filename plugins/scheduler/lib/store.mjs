// @ts-check
/**
 * 存储层：`data.json` 放任务，`runs.jsonl` 放运行流水。
 *
 * 为什么分两个文件：`ctx.storage` 的定位是「按插件隔离的 JSON 小状态」，宿主每次
 * `set()` 都会整份序列化重写。运行记录是只追加的流水，混在里面意味着每写一次
 * 「排队中」都要把 200 条历史重新排一遍——记录越多越慢，而它本来只需要 append。
 *
 * JSONL 的折叠规则：同一 id 后写覆盖先写，`{op:'delete'}` 是墓碑。读的时候逐行
 * try/catch，末行截断（进程被杀）与中间坏行都跳过——运行记录是观测数据，不值得
 * 为了它让插件激活失败。
 */
import fs from 'node:fs'
import path from 'node:path'

// 插件内模块一律走 imp() 动态加载并透传 ?v=（见 main.mjs 顶部）：静态 import 解析
// 相对路径时会丢掉 query，热重载会命中旧模块缓存。
import { pathToFileURL } from 'node:url'
// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析——
// jsdom 测试环境会给 URL 构造器打补丁，相对解析会落到 document.baseURI 上
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(path.join(import.meta.dirname, `${name}.mjs`)).href + Q)

const { rt, log, SETTING_DEFAULTS, OUTPUT_LIMIT, MAX_RUNS, COMPACT_MIN_RUNS, RUNS_MAX_BYTES } = await imp('runtime')

/** 读取 manifest 设置项。失败就用默认值——设置读不到不该让插件起不来 */
export function loadSettings() {
  try {
    rt.settings = { ...SETTING_DEFAULTS, ...(rt.ctx?.settings?.get?.() ?? {}) }
  } catch {
    rt.settings = { ...SETTING_DEFAULTS }
  }
}

/** 老版本（v0.1）的任务补上这批新增字段，避免 UI/工具到处判 undefined */
function normalizeStoredTask(task) {
  return {
    ...task,
    createdBy: task.createdBy === 'agent' ? 'agent' : 'user',
    notifyPolicy: task.notifyPolicy ?? null,
    runCount: Number.isFinite(task.runCount) ? task.runCount : 0,
    updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : task.createdAt ?? Date.now(),
    baseline: task.baseline && typeof task.baseline.text === 'string' ? task.baseline : null,
  }
}

/** v0.1 的记录形状 → v0.2。迁移只做一次，之后 runs.jsonl 就是唯一真相 */
function fromLegacyRun(run, index) {
  const startedAt = Number(run.startedAt) || Date.now()
  const durationMs = Number(run.durationMs) || 0
  return {
    id: String(run.id || `run-${startedAt}-legacy${index}`),
    taskId: String(run.taskId || ''),
    taskName: String(run.taskName || ''),
    status: run.ok ? 'ok' : 'failed',
    trigger: run.missed ? 'missed' : 'scheduled',
    queuedAt: startedAt,
    startedAt,
    finishedAt: startedAt + durationMs,
    durationMs,
    cwd: '',
    promptPreview: '',
    output: String(run.resultText || '').slice(0, OUTPUT_LIMIT),
    error: String(run.error || ''),
    skipReason: '',
    notify: 'none',
    signal: null,
    // 老记录一律视为已读：用户升级后不该被一堆历史顶出未读红点
    seen: true,
    v: 1,
  }
}

/** 磁盘上的记录可能来自更早的版本，缺字段就补默认值 */
function normalizeRun(run) {
  return {
    id: String(run.id),
    taskId: String(run.taskId || ''),
    taskName: String(run.taskName || ''),
    status: String(run.status || 'ok'),
    trigger: String(run.trigger || 'scheduled'),
    queuedAt: Number(run.queuedAt) || Number(run.startedAt) || 0,
    startedAt: Number.isFinite(run.startedAt) ? run.startedAt : null,
    finishedAt: Number.isFinite(run.finishedAt) ? run.finishedAt : null,
    durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
    cwd: String(run.cwd || ''),
    promptPreview: String(run.promptPreview || ''),
    output: String(run.output || ''),
    error: String(run.error || ''),
    skipReason: String(run.skipReason || ''),
    notify: String(run.notify || 'none'),
    signal: run.signal && typeof run.signal === 'object' ? run.signal : null,
    seen: run.seen !== false,
    v: 1,
  }
}

/**
 * 读任务表与运行记录（激活时一次）。
 *
 * `storageUsable` = 读到了本插件写过的表。读失败时宿主的 readStorage 是 fail open
 * （静默返回 {}），这时候**不能**拿空表把磁盘覆盖掉——那会把「暂时读不出」变成
 * 「合法空表」，用户的任务就真没了。
 */
export function load() {
  /** @type {Record<string, any>} */
  let data = {}
  let usable = false
  try {
    data = rt.ctx?.storage?.get?.() ?? {}
    usable =
      data !== null &&
      typeof data === 'object' &&
      (data.schemaVersion !== undefined || Array.isArray(data.tasks))
  } catch (error) {
    log('storage load failed', error)
  }
  rt.storageUsable = usable
  const tasks = Array.isArray(data.tasks)
    ? data.tasks.filter((task) => task && typeof task.id === 'string').map(normalizeStoredTask)
    : []
  rt.state = { schemaVersion: 2, tasks }

  loadRuns()

  // v0.1 → v0.2：老记录的 runs 数组搬进 JSONL，然后从 data.json 里删掉
  const legacy = Array.isArray(data.runs) ? data.runs : null
  if (legacy && legacy.length > 0) {
    const converted = legacy
      .map(fromLegacyRun)
      // 升序写入：同一 id 后写覆盖先写，折叠后仍保持时间顺序（虽然 UI 会再排一次）
      .sort((a, b) => a.queuedAt - b.queuedAt)
    for (const run of converted) {
      if (rt.runs.has(run.id)) continue
      rt.runs.set(run.id, run)
      writeLine({ v: 1, op: 'upsert', run })
    }
    log(`migrated ${converted.length} legacy run(s) into runs.jsonl`)
  }
  if (usable && (legacy !== null || data.schemaVersion !== 2)) saveTasks()
}

/** 写任务表（整份覆盖，宿主 storage 的语义就是如此） */
export function saveTasks() {
  if (!rt.ctx) return
  // 读失败一代不拿空表覆盖磁盘；本代自己建过任务时照写（新数据优先）
  if (!rt.storageUsable && rt.state.tasks.length === 0) {
    log('save skipped: storage unreadable and there is nothing to persist')
    return
  }
  try {
    rt.ctx.storage.set({ schemaVersion: 2, tasks: rt.state.tasks })
    if (rt.state.tasks.length > 0) rt.storageUsable = true
  } catch (error) {
    log('storage save failed', error)
  }
}

/** 从 data.json 删掉一条任务（运行记录由调用方一并清理） */
export function removeTaskRecord(id) {
  rt.state.tasks = rt.state.tasks.filter((task) => task.id !== id)
  saveTasks()
}

// ---------- runs.jsonl ----------

function writeLine(payload) {
  if (!rt.runsFile || !rt.ctx) return
  const line = JSON.stringify(payload)
  try {
    fs.mkdirSync(path.dirname(rt.runsFile), { recursive: true })
    fs.appendFileSync(rt.runsFile, `${line}\n`, 'utf8')
    rt.fileBytes += Buffer.byteLength(line) + 1
  } catch (error) {
    // 观测数据的写入失败不该影响任务本身；内存里还有一份，UI 照常能看
    log('runs.jsonl append failed', error)
  }
}

/** 运行记录落盘（状态每变一次追加一行） */
export function appendRun(run) {
  writeLine({ v: 1, op: 'upsert', run })
  maybeCompact()
}

/** 删除单条：墓碑，不重写文件 */
export function appendDelete(id) {
  writeLine({ v: 1, op: 'delete', id })
  rt.tombstones += 1
  maybeCompact()
}

/** 读 JSONL 折叠成 Map。坏行跳过、末行截断容忍 */
export function loadRuns() {
  rt.runs = new Map()
  rt.fileBytes = 0
  let text = ''
  try {
    text = fs.readFileSync(rt.runsFile, 'utf8')
  } catch {
    return
  }
  rt.fileBytes = Buffer.byteLength(text)
  let bad = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const record = JSON.parse(line)
      if (record?.op === 'upsert' && record.run?.id) rt.runs.set(String(record.run.id), normalizeRun(record.run))
      else if (record?.op === 'delete' && record.id) rt.runs.delete(String(record.id))
    } catch {
      bad += 1
    }
  }
  if (bad > 0) log(`runs.jsonl: skipped ${bad} unreadable line(s)`)
}

/** 全部记录按入队时间倒序（新→旧） */
export function runsSorted() {
  return [...rt.runs.values()].sort((a, b) => b.queuedAt - a.queuedAt)
}

/**
 * 压缩：把当前有效记录按时间升序重写成一份新文件（tmp + rename，原子替换）。
 * 删除墓碑、被裁剪的历史、坏行都在这一步消失。
 */
export function compact() {
  if (!rt.runsFile || !rt.ctx) return
  const tmp = `${rt.runsFile}.tmp`
  const runs = [...rt.runs.values()].sort((a, b) => a.queuedAt - b.queuedAt)
  try {
    fs.mkdirSync(path.dirname(rt.runsFile), { recursive: true })
    const body = runs.map((run) => JSON.stringify({ v: 1, op: 'upsert', run })).join('\n')
    fs.writeFileSync(tmp, runs.length > 0 ? `${body}\n` : '', 'utf8')
    fs.renameSync(tmp, rt.runsFile)
    rt.tombstones = 0
    rt.fileBytes = runs.length > 0 ? Buffer.byteLength(body) + 1 : 0
    log(`runs.jsonl compacted, ${runs.length} record(s)`)
  } catch (error) {
    // 压缩失败不影响正确性（旧文件仍然完整），下次再试
    log('runs.jsonl compact failed', error)
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 删不掉就留着，下一次覆盖 */
    }
  }
}

/** 记录数或文件大小过线才压缩：每次执行都重写一份太奢侈 */
export function maybeCompact() {
  const limit = Math.max(COMPACT_MIN_RUNS, MAX_RUNS * 4)
  if (rt.runs.size + rt.tombstones <= limit && rt.fileBytes <= RUNS_MAX_BYTES) return
  compact()
}

/** 就绪：任务表 + 运行记录都读完了 */
export function ready() {
  return rt.storageUsable
}
