// @ts-check
/**
 * 任务记忆：给每个定时任务一份跨轮保留的纯文本笔记。
 *
 * 为什么单独一个文件，而不是复用 runs.jsonl 或 data.json：
 *   - runs.jsonl 会被 pruneRuns() 按 historyLimit 裁掉，「记忆」不能跟着消失；
 *   - data.json 走 ctx.storage.set() 整份覆盖，写入时会把 50 个任务的表全量重写；
 *   - 纯文本让人（用户）和 agent 都能直接读、直接改，这是记忆该有的样子。
 *
 * 文件形状（两段固定标题，解析容忍手写内容）：
 *   # 定时任务记忆：<任务名>
 *   ## 长期备注        ← agent 写的 notes / 用户手改，跨轮长期有效
 *   ## 执行记录        ← 插件收尾自动追加，每轮一行，按时间先后
 *
 * 写入方向有三条，但**只有插件写这个文件**：
 *   1. 插件收尾追加执行记录（零信任：agent 什么都不写，记忆也在长）；
 *   2. agent 写 notes/<runId>.md，插件读走并入「长期备注」——不让它碰 memory.md，
 *      因为内置 write 是整份覆盖，一次半截写盘就能抹掉全部历史；
 *   3. 用户在 UI / sched_memory 里编辑或清空。
 *
 * 一切写盘走 .tmp + renameSync（宿主 storage 是整份覆盖 + fail-open，血泪教训）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { pathToFileURL } from 'node:url'
// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析（jsdom 会打补丁）
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(path.join(import.meta.dirname, `${name}.mjs`)).href + Q)

const {
  rt,
  log,
  MEMORY_MAX_CHARS,
  MEMORY_NOTES_CHARS,
  MEMORY_RECORD_LINES,
  MEMORY_RECORD_CHARS,
  MEMORY_INJECT_LINES,
  NOTE_MAX_CHARS,
} = await imp('runtime')

const HEAD_NOTES = '## 长期备注'
const HEAD_RECORDS = '## 执行记录'
/** 用户编辑时允许的最大输入（防误粘贴把整本书塞进来） */
export const USER_TEXT_LIMIT = 20_000

/** 任务 id / runId 只允许安全字符：它们会直接进文件名 */
function safeId(id) {
  const value = String(id ?? '')
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : ''
}

/** @param {string} taskId */
export function memoryPath(taskId) {
  const id = safeId(taskId)
  return id && rt.memoryDir ? path.join(rt.memoryDir, `${id}.md`) : ''
}

/** agent 本轮可选的长期笔记落点（与 signals/ 同构，已实测运行会话能写绝对路径） */
/** @param {string} runId */
export function notePath(runId) {
  const id = safeId(runId)
  return id && rt.notesDir ? path.join(rt.notesDir, `${id}.md`) : ''
}

/** YYYY-MM-DD HH:mm：记忆要跨天读，fmtWhen 的「今天」隔天就失效了 */
function stamp(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 解析记忆文件。用户手改、老版本文件、缺段都按「能读多少读多少」处理。
 * @param {string} text
 * @returns {{ notes: string, records: string[] }}
 */
export function parseMemory(text) {
  let section = ''
  /** @type {string[]} */
  const noteLines = []
  /** @type {string[]} */
  const records = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    if (trimmed === HEAD_NOTES) {
      section = 'notes'
      continue
    }
    if (trimmed === HEAD_RECORDS) {
      section = 'records'
      continue
    }
    if (trimmed.startsWith('# ')) continue
    if (trimmed.startsWith('## ')) {
      section = '' // 不认识的段落：跳过，别把它当成记忆
      continue
    }
    if (section === 'notes') noteLines.push(line)
    else if (section === 'records' && trimmed) records.push(trimmed.replace(/^-\s*/, ''))
  }
  return { notes: noteLines.join('\n').trim(), records }
}

/**
 * 生成文件内容。记录按时间先后（旧→新），注入时再决定怎么取。
 * @param {string} name
 * @param {{ notes: string, records: string[] }} mem
 */
export function formatMemory(name, mem) {
  const notes = String(mem.notes ?? '').trim()
  const records = (mem.records ?? []).map((line) => `- ${String(line).trim()}`)
  return [
    `# 定时任务记忆：${String(name ?? '').trim() || '未命名任务'}`,
    '',
    HEAD_NOTES,
    notes || '（暂无）',
    '',
    HEAD_RECORDS,
    ...(records.length > 0 ? records : ['（暂无）']),
    '',
  ].join('\n')
}

/**
 * 限幅：备注留尾部（新写的在后面）、记录留最近 N 条，再按总字数兜底丢最旧记录。
 * 纯函数，单测可以直接喂超长文本。
 * @param {{ notes: string, records: string[] }} mem
 * @returns {{ notes: string, records: string[] }}
 */
export function clampMemory(mem) {
  let notes = String(mem.notes ?? '')
  if (notes.length > MEMORY_NOTES_CHARS) notes = notes.slice(-MEMORY_NOTES_CHARS)
  /** @type {string[]} */
  let records = (mem.records ?? [])
    .map((line) => String(line).replace(/^-\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-MEMORY_RECORD_LINES)
    .map((line) => line.slice(0, MEMORY_RECORD_CHARS))
  // 备注与记录都限了幅，仍可能因为任务名很长超限；按时间丢最旧的即可
  while (records.length > 1 && formatMemory('', { notes, records }).length > MEMORY_MAX_CHARS) {
    records = records.slice(1)
  }
  return { notes, records }
}

/** @param {string} taskId */
export function readMemory(taskId) {
  const file = memoryPath(taskId)
  if (!file) return { notes: '', records: [] }
  try {
    return parseMemory(fs.readFileSync(file, 'utf8'))
  } catch {
    return { notes: '', records: [] }
  }
}

/** @param {string} taskId */
export function memoryExists(taskId) {
  const file = memoryPath(taskId)
  return !!file && fs.existsSync(file)
}

/**
 * 原子写。调用方给的是「完整语义」，这里统一限幅 + 落盘。
 * @param {string} taskId
 * @param {string} name
 * @param {{ notes: string, records: string[] }} mem
 */
export function writeMemory(taskId, name, mem) {
  const file = memoryPath(taskId)
  if (!file) return 0
  const clamped = clampMemory(mem)
  const text = formatMemory(name, clamped)
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    return text.length
  } catch (error) {
    log('memory write failed', error)
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 删不掉就留着，下一次覆盖 */
    }
    return 0
  }
}

/** 给 UI 编辑框用：不存在时给一份带说明的空模板（不落盘） */
/** @param {string} taskId @param {string} name */
export function readMemoryText(taskId, name) {
  const file = memoryPath(taskId)
  if (file && fs.existsSync(file)) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      /* 落到模板 */
    }
  }
  return formatMemory(name, { notes: '', records: [] })
}

/**
 * 用户整份编辑：解析成两段再限幅写回，标题与手写噪声都会规范化。
 * @param {string} taskId @param {string} name @param {string} text
 */
export function writeMemoryText(taskId, name, text) {
  const parsed = parseMemory(text)
  return writeMemory(taskId, name, parsed)
}

/** 清空：记忆与任务表里的基线是两回事，调用方自己决定是否一起清 */
/** @param {string} taskId */
export function clearMemory(taskId) {
  const file = memoryPath(taskId)
  if (!file) return false
  try {
    fs.rmSync(file, { force: true })
    return true
  } catch (error) {
    log('memory clear failed', error)
    return false
  }
}

/**
 * 换 prompt 时：旧执行记录是关于旧目标的，留着会误导「有没有变化」；
 * 但「长期备注」是用户/agent 沉淀的事实，不该跟着一起消失。
 * @param {string} taskId @param {string} name
 */
export function resetMemoryRecords(taskId, name) {
  if (!memoryExists(taskId)) return 0
  const mem = readMemory(taskId)
  return writeMemory(taskId, name, { notes: mem.notes, records: [] })
}

/**
 * 把 agent 本轮写的 note 并进长期备注。
 * 清洗：去掉 Markdown 标题（会破坏分段）、逐行限长、去重、限行数。
 * @param {{ notes: string, records: string[] }} mem
 * @param {string} noteText
 */
export function mergeNote(mem, noteText) {
  const incoming = String(noteText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('```'))
    .slice(0, 5)
    .map((line) => line.replace(/^-\s*/, '').slice(0, 160))
  if (incoming.length === 0) return mem
  // 已有备注可能是用户手写的「- xxx」或纯文本，统一去掉项目符号再比，
  // 否则 agent 重述同一条事实时会留下两行一模一样的内容
  const plain = (line) => line.trim().replace(/^-\s*/, '')
  const existing = mem.notes.split('\n').map(plain).filter(Boolean)
  const seen = new Set(existing)
  const added = incoming.filter((line) => !seen.has(line))
  if (added.length === 0) return mem
  return { ...mem, notes: [...existing, ...added].join('\n') }
}

/**
 * 收尾追加一条执行记录。note 由调用方（engine）在 run 结束后读入。
 * 失败轮不带输出正文——「失败不污染基线」同理，半截结论不该进下一轮上下文。
 * @param {string} taskId
 * @param {string} name
 * @param {{ at: number, ok: boolean, changed: boolean, summary: string, note?: string }} info
 */
export function appendRunRecord(taskId, name, info) {
  const mem = readMemory(taskId)
  const withNote = info.note ? mergeNote(mem, info.note) : mem
  const state = info.ok ? '成功' : '失败'
  const change = info.ok ? (info.changed ? '有变化' : '无变化') : '未产出结论'
  const summary = String(info.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_RECORD_CHARS)
  const line = `${stamp(info.at || Date.now())} ${state} · ${change} · ${summary}`
  const chars = writeMemory(taskId, name, { notes: withNote.notes, records: [...withNote.records, line] })
  return { chars, records: withNote.records.length + 1 }
}

/**
 * 读走 agent 本轮的长期笔记（读完即删）。没写、写坏、写晚了都返回空串。
 * @param {string} runId
 */
export function consumeNote(runId) {
  const file = notePath(runId)
  if (!file) return ''
  try {
    const text = fs.readFileSync(file, 'utf8').trim().slice(0, NOTE_MAX_CHARS)
    return text
  } catch {
    return ''
  } finally {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* 删不掉留给 sweepMemory 按天收 */
    }
  }
}

/**
 * 注入下一次 prompt 的记忆片段。
 * 预算固定：备注 ≤800 字 + 最近 8 条记录，避免每轮把整本流水都灌进上下文。
 * @param {string} taskId
 */
export function memoryForPrompt(taskId) {
  const mem = readMemory(taskId)
  if (!mem.notes && mem.records.length === 0) return ''
  const notes = mem.notes.length > MEMORY_NOTES_CHARS ? mem.notes.slice(-MEMORY_NOTES_CHARS) : mem.notes
  const records = mem.records.slice(-MEMORY_INJECT_LINES)
  const lines = ['【任务记忆（跨轮保留，由插件维护）】', '长期备注：', notes || '（暂无）', '', '最近执行记录（旧→新，最后一条是上一轮）：']
  if (records.length > 0) lines.push(...records.map((line) => `- ${line}`))
  else lines.push('（暂无）')
  lines.push('（以上是过去几轮的事实记录，用来判断「与上次相比有没有变化」，不要照抄成本次结论。）')
  return lines.join('\n')
}

/** UI / 工具展示用摘要 */
/** @param {string} taskId */
export function memoryInfo(taskId) {
  if (!memoryExists(taskId)) return { exists: false, chars: 0, records: 0 }
  const mem = readMemory(taskId)
  return { exists: true, chars: readMemoryText(taskId, '').length, records: mem.records.length }
}

/**
 * 孤儿文件清理：任务删了、热重载换代了，磁盘上可能留下没人认的 .md。
 * 按目录扫一遍是唯一兜底（只靠删除路径上的显式调用一定会漏）。
 * @param {Iterable<string>} validTaskIds
 */
export function sweepMemory(validTaskIds) {
  const valid = new Set(validTaskIds)
  let removed = 0
  const cutoff = Date.now() - 86_400_000
  for (const [dir, keep] of [[rt.memoryDir, valid], [rt.notesDir, null]]) {
    if (!dir) continue
    /** @type {string[]} */
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.md') && !name.endsWith('.tmp')) continue
      const file = path.join(dir, name)
      const staleNote = keep === null
      const orphan = keep !== null && !keep.has(name.replace(/\.md$/, '').replace(/\.tmp$/, ''))
      try {
        if (orphan || staleNote) {
          const old = fs.statSync(file).mtimeMs < cutoff
          // 孤儿记忆立即删；notes 是运行时临时文件，留一天防被正在跑的轮次写晚
          if (orphan || old) {
            fs.rmSync(file, { force: true })
            removed += 1
          }
        }
      } catch {
        /* 并发删除 / 权限问题：下一轮再试 */
      }
    }
  }
  if (removed > 0) log(`swept ${removed} orphan memory/note file(s)`)
  return removed
}
