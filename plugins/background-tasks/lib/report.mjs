// @ts-check
/**
 * 回报队列：任务结束后把结果投回发起它的会话。
 *
 * 投递模型（v0.6.0 拍板）：走 `deliverAs:'steer'` 插话——忙时在下一个工具调用边界
 * 注入，闲时宿主立即开一轮。不再做合并窗口（steer 化后唤醒风暴天然有界），0ms 的
 * tick 只用来把同一事件循环里连续结束的任务凑进同一批。
 *
 * 「已删除」的判定要压到同步段：删除流程里有 await（停进程最多 3s），队列可能刚好
 * 在窗口里被 flush 取走。deletedIds 在删除动作的**第一个 await 之前**写入，
 * deliver 前统一比对；保留 60s 兜住晚到的 exit 回调。
 */

// 插件内模块一律走 imp() 动态加载并透传 ?v=（见 main.mjs 顶部）：静态 import 解析
// 相对路径时会丢掉 query，热重载会命中旧模块缓存。import.meta.url 自带本次激活的
// v，链条从入口自然向下传，每个模块都拿到同一代。
import { pathToFileURL } from 'node:url'
import { join as joinPath } from 'node:path'
// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析——
// jsdom 测试环境会给 URL 构造器打补丁，相对解析会落到 document.baseURI 上
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(joinPath(import.meta.dirname, `${name}.mjs`)).href + Q)
const { rt, pluginId, SETTING_DEFAULTS } = await imp('runtime')
const { fmtDuration, fmtBytes, normSession, statusText } = await imp('format')
const { tailOf, countLines } = await imp('log-io')
const { save } = await imp('store')

const MAX_DETAILED_REPORTS = 3

/** sessionFile（归一化 key）→ { items, timer } 待投递批次 */
const reportQueues = new Map()
/**
 * 已判定「不该再有任何回报」的 id。
 *
 * 为什么不只靠 state.tasks.includes：删除流程里有 await（停进程最多 3s），而队列
 * 可能刚好在这段窗口里被 flush 取走——取走之后 dropQueuedReports 就找不到它了。
 * 这个集合在删除动作的**第一个 await 之前**写入，deliver 前统一比对，把窗口压到同步段。
 * 保留 60s 是为了兜住「进程退出事件晚于记录删除」的回调。
 */
const deletedIds = new Set()

export function scheduleReport(task) {
  // 防御性去重：同一个任务只允许被自动回报一次（retryReport 走的是显式通道）
  if (task.report === 'queued') return
  // 记录已被清理（进程退出事件可能晚于 bg_clear 到达）：再入队就是一条死链
  if (deletedIds.has(task.id)) return
  // 显式动作（内联回执 / bg_stop 等终态）正拿着回报权：flush 现在是即时的，
  // 不扣住的话自动回报会在显式路径的 suppressReport 之前跑掉，变成重复消息
  if (task.reportHold) return
  const policy = String(rt.settings.reportPolicy || 'long')
  const skip = (reason) => {
    task.report = 'skipped'
    task.reportNote = reason
  }
  if (!task.sessionFile) return skip('没有关联会话')
  if (policy === 'off') return skip('回报策略为 off')
  const succeeded = task.status === 'exited'
  if (policy === 'failures' && succeeded) return skip('策略只回报失败')
  const duration = (task.endedAt ?? Date.now()) - task.startedAt
  const threshold = Number(rt.settings.reportThresholdMs) || SETTING_DEFAULTS.reportThresholdMs
  if (policy === 'long' && succeeded && duration < threshold) {
    return skip(`成功且耗时 ${Math.round(duration / 1000)}s 短于阈值 ${Math.round(threshold / 1000)}s`)
  }
  enqueueReport(task)
}

export function enqueueReport(task) {
  // 队列 key 与托盘/面板用同一套归一化（normSession）：工具侧与推送侧拿到同一会话的
  // 不同写法（相对路径 vs 绝对路径）时，否则会拆成两个队列、发成两条消息，
  // 而面板上只有一个会话。原始写法存在 queue.sessionFile 里，投递时仍用它。
  const key = normSession(task.sessionFile) || task.sessionFile
  let queue = reportQueues.get(key)
  if (!queue) {
    queue = { items: [], timer: null, sessionFile: task.sessionFile }
    reportQueues.set(key, queue)
  }
  // 同一任务只排一次：exit / close 两个回调都可能触发 scheduleReport
  if (queue.items.some((t) => t.id === task.id)) return
  task.report = 'pending'
  queue.items.push(task)
  if (queue.timer) return
  // 不再等合并窗口：任务一结束就投。0ms 的 tick 只用来把同一事件循环里
  // 连续结束的任务（比如并行批次被一起杀掉）凑进同一批，不引入真实延迟。
  queue.timer = setTimeout(() => {
    queue.timer = null
    void flushReports(key)
  }, 0)
}

/**
 * 撤掉排队中、但已经不该发的回报。
 *
 * 两种来源：记录被删/被清（回报会指向一个不存在的任务，用户看到的是死链），
 * 以及用户已经在 bg_stop 里同步拿到了终态（再推一遍是重复信息）。
 */
export function dropQueuedReports(ids) {
  const set = new Set(ids)
  if (set.size === 0) return
  for (const [sessionFile, queue] of reportQueues) {
    const kept = queue.items.filter((t) => !set.has(t.id))
    if (kept.length === queue.items.length) continue
    queue.items = kept
    if (kept.length === 0) {
      if (queue.timer) clearTimeout(queue.timer)
      reportQueues.delete(sessionFile)
    }
  }
}

/** 显式动作已经交付过结果：把这条的自动回报关掉，并记下原因 */
export function suppressReport(task, reason) {
  dropQueuedReports([task.id])
  if (task.report === 'queued') return
  task.report = 'suppressed'
  task.reportNote = reason
}

/**
 * 删除流程的统一入口：先「宣布死亡」，再慢慢收尸。
 *
 * 调用点必须在任何 await 之前——队列的 flush 是异步的（读日志文件），
 * 只删记录不先标记，就会出现「记录没了、回报照发」的孤儿消息。
 */
export function markDeleted(ids) {
  if (!ids.length) return
  for (const id of ids) {
    deletedIds.add(id)
    // 60s 足够覆盖晚到的 exit 回调；unref 避免拖住宿主退出
    setTimeout(() => deletedIds.delete(id), 60_000).unref?.()
  }
  dropQueuedReports(ids)
}

export async function flushReports(key) {
  const queue = reportQueues.get(key)
  if (!queue) return
  reportQueues.delete(key)
  const items = queue.items.splice(0)
  // 从「队列取走」到「真正投递」之间记录可能已被清理：先剔掉，别让 skipped 计数跟着虚高
  const alive = items.filter((t) => !deletedIds.has(t.id))
  if (!alive.length) return
  const detailed = alive.slice(0, MAX_DETAILED_REPORTS)
  const skipped = alive.length - detailed.length
  for (const task of detailed) {
    task.tailText = await tailOf(task)
    task.lineCount = await countLines(task)
    // stderr 有内容就带上：失败了它是唯一有用的一段，成功了往往也埋着警告
    if (task.errBytes > 0 || task.status !== 'exited') {
      const err = await tailOf(task, 'err')
      if (err) task.errTailText = err
    }
  }
  // 队列 key 是归一化的，投递要用原始路径（大小写/分隔符原样），否则在区分大小写的
  // 文件系统上会找不到会话
  await deliver(queue.sessionFile || detailed[0].sessionFile, detailed, skipped)
}

export function buildReport(items, skipped) {
  const blocks = []
  for (const task of items) {
    const head = `【后台任务回报】${task.id}「${task.label}」${statusText(task)}，耗时 ${fmtDuration(
      (task.endedAt ?? Date.now()) - task.startedAt,
    )}。`
    const lines = [head]
    if (task.tailText) {
      lines.push('最后输出（stdout）：')
      lines.push('```')
      lines.push(task.tailText)
      lines.push('```')
    } else {
      lines.push('（该任务没有 stdout 输出）')
    }
    if (task.errTailText) {
      lines.push('stderr：')
      lines.push('```')
      lines.push(task.errTailText)
      lines.push('```')
    }
    const size = task.bytes ? fmtBytes(task.bytes) : ''
    const errSize = task.errBytes ? fmtBytes(task.errBytes) : ''
    const count = task.lineCount ? `共 ${task.lineCount} 行` : ''
    const meta = [count, size, errSize ? `stderr ${errSize}` : ''].filter(Boolean).join(' / ')
    lines.push(`完整日志：${task.logPath}${meta ? `（${meta}）` : ''}，需要更多内容时用 bg_output 读（传 stream:'err' 看错误输出）。`)
    blocks.push(lines.join('\n'))
  }
  if (skipped > 0) blocks.push(`另外还有 ${skipped} 个任务也结束了，详见面板「后台任务」。`)
  // 处理指令随批次状态切换（方案 C）：回报与当前工作的相关性插件判断不了，
  // 但「有没有失败项」是事实——成功的轻描淡写，失败的提示及时处理。
  blocks.push(
    items.some((t) => t.status !== 'exited')
      ? '以上有失败任务，可能影响后续步骤：与当前工作相关时请及时调整计划；否则向用户简报失败情况后继续。不要盲目重启失败的任务——先用 bg_output 确认原因或与用户确认。'
      : '以上任务仅供知晓，继续当前工作即可；若与手头工作直接相关，可顺手利用其结果，不要重复启动相同的任务。',
  )
  return blocks.join('\n\n')
}

export async function deliver(sessionFile, items, skipped) {
  // 二次校验：从入队到真正投递之间，这条记录可能已经被删除/清理了。
  // 投一条「bg-14 已失败」而 bg-14 早已不存在，用户只会去查一个空 id。
  // 按 id 比对而不是对象引用：插件重载后 state 里的对象可能被重建过。
  const live = items.filter((t) => !deletedIds.has(t.id) && rt.state.tasks.some((x) => x.id === t.id))
  if (live.length === 0) {
    for (const task of items) delete task.tailText
    return
  }
  const content = buildReport(live, skipped)
  try {
    await rt.ctx.sessions.send({
      sessionFile,
      content,
      // 忙时插话：回报的价值就在及时——模型布置完任务可能去跑长活，等到轮边界
      // 才送达会拖几分钟甚至整个回合。steer 在下一个工具调用边界注入，正好是
      // 模型有空看一眼的位置；会话空闲时宿主照旧立即开新轮，两条路都覆盖。
      deliverAs: 'steer',
      origin: {
        pluginId: pluginId(),
        label: '后台任务',
        kind: 'report',
        // kind 的界面文案由插件自带：宿主不认识 'report'，也不该为它维护一张映射表
        kindLabel: '回报',
        detail: live.map((t) => t.id).join(', '),
      },
    })
    for (const task of live) {
      task.report = 'queued'
      task.reportedAt = Date.now()
      delete task.reportError
      delete task.tailText
    }
  } catch (error) {
    rt.ctx.log('report delivery failed', error)
    for (const task of live) {
      task.report = 'failed'
      // 单独一个字段：task.error 装的是**任务本身**为什么失败（超时说明、spawn 错误），
      // 面板与 bg_list 都在读它。投递失败覆盖上去，用户就再也看不到任务的真实原因了。
      task.reportError = error?.message || String(error)
      delete task.tailText
    }
  }
  save()
}

/** 插件停用时收掉待投队列与死亡标记：重载后任务 id 不复用，旧标记只是内存垃圾 */
export function disposeReports() {
  for (const queue of reportQueues.values()) {
    if (queue.timer) clearTimeout(queue.timer)
  }
  reportQueues.clear()
  deletedIds.clear()
}
