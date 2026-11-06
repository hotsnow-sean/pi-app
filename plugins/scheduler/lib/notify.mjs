// @ts-check
/**
 * 条件通知：让「有变化才告诉我」真的能落地。
 *
 * 三件事必须同时存在，缺一件事就只能退化成「每次弹」或「从不弹」：
 *   1. **判定**：谁来判断有没有变化。文件 mtime / git HEAD 这类能机械判的，交给
 *      agent 用工具判；判不了的（读新闻、查 issue），交给 agent 的语义判断。
 *   2. **信号**：agent 怎么把结论告诉插件。两条通道，任一命中即采信：
 *      - 结果文件 `<dataDir>/signals/<runId>.json`（可靠，不受措辞影响）；
 *      - 输出协议 `SCHED:changed` / `SCHED:unchanged` 最后一行（零成本，最常用）。
 *   3. **策略**：插件按 `notifyPolicy` 决定弹不弹。
 *
 * 兜底方向是 **fail-open to notify**：两条通道都没有时按「有变化」处理。宁可用户
 * 多被打扰一次，也不能漏掉真变化——漏一次，这个功能就再也没人信了。
 *
 * 另一个坑（宿主实现细节）：`runAgentPrompt` 返回的 `getLastAssistantText()` 是
 * **倒序找第一条带文本的 assistant 消息**。如果 agent 最后一步只写了信号文件、
 * 没有再补一句总结，拿到的可能是空串。所以通知正文优先取信号文件里的 summary，
 * 文本只当兜底。
 */
import fs from 'node:fs'

import { pathToFileURL } from 'node:url'
import path from 'node:path'
// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析（jsdom 会打补丁）
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(path.join(import.meta.dirname, `${name}.mjs`)).href + Q)

const { rt, isLive, log, BASELINE_CHARS } = await imp('runtime')
const { signalPath } = await imp('runs')
const { oneLine, fmtWhen } = await imp('format')

/** 任务级策略优先；没设就跟随全局设置；再没有就 on-change */
export function resolvePolicy(task) {
  const policy = task?.notifyPolicy || rt.settings.notifyPolicy || 'on-change'
  return ['always', 'on-change', 'failures', 'never'].includes(policy) ? policy : 'on-change'
}

/**
 * 是否打扰用户。
 *
 * | 策略 | 成功且有变化 | 成功无变化 | 失败 |
 * | always | ✓ | ✓ | ✓ |
 * | on-change | ✓ | ✗ | ✓ |
 * | failures | ✗ | ✗ | ✓ |
 * | never | ✗ | ✗ | ✗ |
 *
 * 失败在任何策略下都通知（`never` 除外）：「没变化」和「跑挂了」是两件事。
 * @param {any} task
 * @param {{ ok: boolean, changed: boolean }} info
 */
export function decideNotify(task, info) {
  const policy = resolvePolicy(task)
  let send
  switch (policy) {
    case 'never':
      send = false
      break
    case 'always':
      send = true
      break
    case 'failures':
      send = !info.ok
      break
    case 'on-change':
    default:
      send = !info.ok || info.changed
      break
  }
  return { send, policy }
}

/** 输出协议：最后一行 `SCHED:changed` / `SCHED:unchanged`（大小写不敏感） */
export function parseToken(text) {
  const matches = [...String(text ?? '').matchAll(/^[ \t]*SCHED:(changed|unchanged)[ \t]*$/gim)]
  if (matches.length === 0) return null
  return matches[matches.length - 1][1].toLowerCase()
}

/** 把协议行从正文里摘掉：它是给插件的指令，不该出现在用户读的结果里 */
export function stripToken(text) {
  return String(text ?? '')
    .replace(/^[ \t]*SCHED:(?:changed|unchanged)[ \t]*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 读结果文件（读完即删）。agent 没写、写坏、写晚了都返回 null——信号是可选增强，
 * 不是必须履行的契约。
 * @param {string} runId
 * @returns {{ changed: boolean, summary: string } | null}
 */
export function readSignal(runId) {
  const file = signalPath(runId)
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(raw)
    if (typeof data?.changed === 'boolean') {
      return { changed: data.changed, summary: String(data.summary ?? '').trim() }
    }
    return null
  } catch {
    return null
  } finally {
    // 无论读到没读到都清掉：留着只会在下一轮变成噪声（runId 不会复用）
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* 删不掉留给 sweepSignals */
    }
  }
}

/**
 * 把任务原文包装成「带基线、带协议」的执行 prompt。
 *
 * 用户不需要知道这套约定：创建任务时插件自动追加，用户只管写「检查 issue #138，
 * 有新评论就告诉我」。
 * @param {any} task
 * @param {string} runId
 */
export function buildPrompt(task, runId) {
  const signal = signalPath(runId)
  const baseline = task?.baseline?.text
  const lines = [String(task.prompt || '').trim(), '', '---']
  lines.push('【定时任务执行约定（由定时任务插件追加，请遵守）】')
  lines.push('- 这是一次无人值守的定时执行：你看不到任何对话上下文，也没有插件工具，只能用内置工具。')
  lines.push(
    '- 如果这次结论与下面的「上次结论」相比没有任何实质变化：在最终答复的最后一行写 `SCHED:unchanged`。',
  )
  lines.push('- 如果有变化，或者这是首次执行：最后一行写 `SCHED:changed`。')
  lines.push(
    `- 可选（更可靠）：把一句话摘要写成 JSON 文件 \`${signal}\`，内容形如 {"changed":true,"summary":"一句话结论"}。写完仍然要用一句话回复结论，但不要再调用任何工具。`,
  )
  lines.push('- 最终答复会被存为运行记录，请直接给结论（不超过 15 行），不要复述这段约定。')
  lines.push('')
  if (baseline) {
    const at = task.baseline?.at
    lines.push(`【上次执行结论${at ? `（${fmtWhen(at)}）` : ''}】`)
    lines.push(String(baseline).slice(0, BASELINE_CHARS))
    lines.push('（以上是你上一次跑完的结论，仅用于判断有没有变化，不要照抄。）')
  } else {
    lines.push('【上次执行结论】暂无（这是首次执行，任何结论都算「有变化」）')
  }
  return lines.join('\n')
}

/** 通知正文：优先信号摘要，其次结果首行；失败永远带错误原因 */
export function summaryLine(run) {
  if (run.status === 'failed') {
    const reason = run.error ? oneLine(run.error, 120) : '未知错误'
    return `执行失败：${reason}`
  }
  const summary = run.signal?.summary
  if (summary) return `有变化：${oneLine(summary, 120)}`
  if (run.signal?.changed === false) return '执行完成，没有变化'
  return run.output ? oneLine(run.output, 120) : '执行完成'
}

/**
 * 结束通知。手动触发的（trigger==='manual'）不弹：用户就在跟前，结果在面板里。
 * @param {any} task
 * @param {any} run
 */
export function notifyFinished(task, run) {
  if (!isLive()) return false
  if (run.trigger === 'manual') return false
  try {
    rt.ctx?.notify(`定时任务：${task.name}`, summaryLine(run))
    return true
  } catch (error) {
    log('notify failed', error)
    return false
  }
}

/** 开始通知（设置项可关；手动运行不弹） */
export function notifyStarted(task, trigger) {
  if (!isLive()) return false
  if (rt.settings.notifyOnStart === false) return false
  if (trigger === 'manual') return false
  try {
    rt.ctx?.notify(`定时任务：${task.name}`, trigger === 'missed' ? '错过调度，正在补跑' : '任务开始执行')
    return true
  } catch (error) {
    log('notify failed', error)
    return false
  }
}

/**
 * 队列满的提示：一波积压只提醒一次（60s 节流）。任务本身照常记 skipped，
 * 用户点「立即运行」时不会被这一条静音。
 * @param {any} task
 */
export function notifyQueueFull(task) {
  if (!isLive()) return false
  const now = Date.now()
  if (now - rt.lastQueueFullAt < 60_000) return false
  rt.lastQueueFullAt = now
  try {
    rt.ctx?.notify('定时任务排队过多', `「${task.name}」本次跳过；已完成/删除积压的任务后会自动恢复`)
    return true
  } catch (error) {
    log('notify failed', error)
    return false
  }
}
