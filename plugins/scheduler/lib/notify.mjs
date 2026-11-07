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
const { notePath, memoryForPrompt } = await imp('memory')
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

/**
 * 没发送时记下**为什么**，供运行记录展示（`format.notifyLabel` 负责翻译成中文）。
 *
 * 不记原因就只能靠「有没有标注」猜，`never` / `failures` 成功那两格会被误读成
 * 「通知过了」。手动执行也记（但它已有「手动」标记，不再额外显示文案）。
 * @param {{ policy: string, ok: boolean, changed: boolean, manual: boolean }} info
 */
export function notifySkipReason(info) {
  if (info.manual) return 'manual'
  if (info.policy === 'never') return 'never'
  if (info.policy === 'failures' && info.ok) return 'failures-ok'
  if (info.policy === 'on-change' && info.ok && !info.changed) return 'unchanged'
  return ''
}

/**
 * 输出协议：
 * - `SCHED:changed` / `SCHED:unchanged`：结果有没有变化；
 * - `SCHED:failed[: 原因]`：本次任务**整体**没做成（关键命令退出码非 0、页面没打开、数据没取到）。
 *
 * 「失败」必须由 agent 自报：插件的 ok 只代表**会话**跑完了，不代表任务目标达成。
 * 自动拿退出码判失败会大面积误报——agent 探索时敲错一条命令是常态。
 *
 * failed 优先级最高（它与 changed/unchanged 互斥，混写说明 agent 自己没想清楚，
 * 按更严重的那个算）。@returns {{ kind: 'changed'|'unchanged'|'failed', reason: string } | null}
 */
export function parseToken(text) {
  const matches = [
    ...String(text ?? '').matchAll(/^[ \t]*SCHED:(changed|unchanged|failed)(?:[ \t]*[:：][ \t]*(.*))?[ \t]*$/gim),
  ]
  if (matches.length === 0) return null
  const failed = matches.filter((m) => m[1].toLowerCase() === 'failed').pop()
  const last = failed ?? matches[matches.length - 1]
  return { kind: last[1].toLowerCase(), reason: String(last[2] ?? '').trim() }
}

/** 把协议行从正文里摘掉：它是给插件的指令，不该出现在用户读的结果里 */
export function stripToken(text) {
  return String(text ?? '')
    .replace(/^[ \t]*SCHED:(?:changed|unchanged|failed)(?:[ \t]*[:：].*)?[ \t]*$/gim, '')
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
  const note = notePath(runId)
  const baseline = task?.baseline?.text
  const memory = memoryForPrompt(task?.id)
  const lines = [String(task.prompt || '').trim(), '', '---']
  lines.push('【定时任务执行约定（由定时任务插件追加，请遵守）】')
  lines.push('- 这是一次无人值守的定时执行：你看不到任何对话上下文，也没有插件工具，只能用内置工具。')
  lines.push(
    '- 如果这次结论与下面的「上次结论」相比没有任何实质变化：在最终答复的最后一行写 `SCHED:unchanged`。',
  )
  lines.push('- 如果有变化，或者这是首次执行：最后一行写 `SCHED:changed`。')
  lines.push(
    '- 只有**整个任务没做成**才算失败：关键命令退出码非 0、窗口/页面没打开、数据没取到。' +
      '辅助命令（grep / ls / test 之类）非 0 是正常探索，不要因此判失败。' +
      '判失败时最后一行写 `SCHED:failed: 一句话原因`，代替上面两个标记。',
  )
  lines.push(
    `- 可选（更可靠）：把一句话摘要写成 JSON 文件 \`${signal}\`，内容形如 {"changed":true,"summary":"一句话结论"}。写完仍然要用一句话回复结论，但不要再调用任何工具。`,
  )
  lines.push(
    `- 可选（长期记忆）：如果有**值得跨轮长期记住**的事实（基线数值、已处理条目的 ID、判断口径变更、这次踩的坑），把纯文本写进 \`${note}\`，最多 5 行、合计 300 字以内。不要写本次结论（插件会自动记录），不要编辑或覆盖其他文件。`,
  )
  lines.push('- 最终答复会被存为运行记录，请直接给结论（不超过 15 行），不要复述这段约定。')
  lines.push('')
  if (memory) {
    lines.push(memory)
    lines.push('')
  }
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

/**
 * 投一条到宿主顶栏信箱（`ctx.ui.inbox`）。
 *
 * 与系统通知的分工：系统通知是「现在打扰你」，信箱是「回来时还看得到」。
 * 两者独立成败——通知被系统设置吞掉、或用户当场划走，信箱里仍然留一条；
 * 而信箱不落盘（宿主重启即空），所以**完整流水仍然在应用入口的 runs.jsonl**。
 *
 * 条件与系统通知一致（`decision.send` 且非手动）。同一任务按 taskId 去重：
 * 每分钟跑一次的监控任务只会在信箱里留最新一条，不会把 200 格刷满。
 * @param {any} task
 * @param {any} run
 */
export function sendInbox(task, run) {
  if (!isLive()) return false
  if (run.trigger === 'manual') return false
  const inbox = rt.ctx?.ui?.inbox
  // 老宿主没有这个能力（或插件被降级加载）：静默跳过，不影响执行与系统通知
  if (typeof inbox !== 'function') return false
  const failed = run.status === 'failed'
  try {
    inbox({
      title: failed ? `定时任务失败：${task.name}` : `定时任务：${task.name}`,
      body: summaryLine(run),
      tone: failed ? 'error' : 'success',
      target: { pluginId: rt.ctx.pluginId, viewId: 'main' },
      dedupeKey: task.id,
    })
    return true
  } catch (error) {
    log('inbox failed', error)
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
