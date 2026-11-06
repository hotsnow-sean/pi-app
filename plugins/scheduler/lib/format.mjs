// @ts-check
/**
 * 纯展示层的时间/状态文案。
 *
 * 主侧（工具返回给模型的话）与 UI 都需要「明天 08:30」这种说法，但两边语言不同：
 * 工具要的是能读的句子，UI 要的是短标签。这里只放**两边都要、且不依赖 DOM** 的
 * 基础格式，UI 自己的布局文案留在 ui/app.js。
 *
 * 统一走本地时区：schedule.time 一直是本地 HH:mm，别在别处偷偷用 UTC。
 */

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** HH:mm */
export function fmtClock(ts) {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 本地日期键，用于时间线按日分组 */
export function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 相差多少个自然日：-1 = 昨天，1 = 明天（按本地零点算，不受夏令时小时数影响） */
export function dayDelta(ts, now) {
  return Math.round((startOfDay(ts) - startOfDay(now)) / 86_400_000)
}

/** 今天 / 明天 / 昨天 / 11 月 4 日（跨年补年份） */
export function dayLabel(ts, now) {
  const delta = dayDelta(ts, now)
  if (delta === 0) return '今天'
  if (delta === 1) return '明天'
  if (delta === -1) return '昨天'
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return sameYear ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/**
 * 今天 08:30 / 11 月 4 日 08:30。
 * `seconds` 只给「马上就要跑」的场景用：间隔任务显示到分钟会让人以为调度晚了
 * （创建于 20:09:25、下次 20:10:25，列表上看着像「20:10 却没跑」）。
 * @param {number} ts
 * @param {number} [now]
 * @param {{ seconds?: boolean }} [opts]
 */
export function fmtWhen(ts, now = Date.now(), opts = {}) {
  const clock = opts.seconds ? `${fmtClock(ts)}:${pad2(new Date(ts).getSeconds())}` : fmtClock(ts)
  return `${dayLabel(ts, now)} ${clock}`
}

/** 13 小时 / 45 分钟 / 2 天 */
export function humanizeSpan(ms) {
  const abs = Math.abs(ms)
  if (abs < 60_000) return `${Math.max(1, Math.round(abs / 1000))} 秒`
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} 分钟`
  if (abs < 86_400_000) {
    const hours = Math.round((abs / 3_600_000) * 10) / 10
    return `${hours} 小时`
  }
  return `${Math.round((abs / 86_400_000) * 10) / 10} 天`
}

/** 明天 08:30（还有 13 小时）——工具回执里复述下次执行时刻，模型不用自己算 */
export function describeNext(ts, now = Date.now()) {
  if (!ts || !Number.isFinite(ts)) return '不再执行'
  const gap = ts - now
  // 2 分钟内带上秒：这个尺度上「分钟」的四舍五入比不显示更误导
  const when = fmtWhen(ts, now, { seconds: gap > 0 && gap < 120_000 })
  if (gap <= 0) return `${when}（已到点，等待调度）`
  return `${when}（还有 ${humanizeSpan(gap)}）`
}

/** 刚刚 / 3 分钟前 / 2 小时前 / 3 天前 */
export function fmtRelative(ts, now = Date.now()) {
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 12s / 2m 5s / 1h 3m */
export function fmtDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** 内部状态 → 中文词。UI 只做颜色映射，不复述这些词之外的东西 */
export function statusText(status) {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '执行中'
    case 'ok':
      return '成功'
    case 'failed':
      return '失败'
    case 'interrupted':
      return '已中断'
    case 'skipped':
      return '已跳过'
    default:
      return String(status || '未知')
  }
}

/** 跳过原因只给一句人话，不把内部枚举丢给用户 */
export function skipText(reason) {
  switch (reason) {
    case 'overlap':
      return '上次执行还没结束'
    case 'queue_full':
      return '排队过多'
    case 'app_exit':
      return '应用退出'
    case 'disabled':
      return '任务已停用'
    default:
      return ''
  }
}

/**
 * 「这次为什么没打扰你」。
 *
 * 早期版本靠 `notify === 'none' && signal.changed === false` 推「无变化」，于是
 * `never` / `failures` 策略下的记录完全没有标注——读起来像「通知了」。现在原因码
 * （run.notifyWhy）由引擎在收尾时记下来，文案只在这一处维护。
 *
 * 返回空串表示不必标注：已发送、手动执行（触发方式已标「手动」）、老记录但推不出原因。
 * @param {any} run
 */
export function notifyLabel(run) {
  switch (run?.notifyWhy) {
    case 'never':
      return '从不通知（策略）'
    case 'failures-ok':
      return '未失败（策略不提示）'
    case 'unchanged':
      return '无变化（策略不提示）'
    case 'manual':
      return ''
    default:
      // v0.3 之前的记录没有 notifyWhy：只能按「结果没变」这一条推
      return run?.notify === 'none' && run?.signal?.changed === false ? '无变化（未提示）' : ''
  }
}

/** 触发方式：scheduled 是常态，不标——标了等于噪声 */
export function triggerText(trigger) {
  if (trigger === 'missed') return '补跑'
  if (trigger === 'manual') return '手动'
  return ''
}

/** 单行截断，列表/预览用 */
export function oneLine(text, max = 120) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1))}…`
}
