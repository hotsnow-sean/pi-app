// @ts-check
/**
 * 调度时间计算（纯函数，无副作用、不碰 rt）。
 *
 * 语义与 v0.1 完全一致，只是从 main.mjs 搬出来——这批改动不动调度规则，改的是
 * 「执行过程可见」与「谁来决定通知」。保持纯函数也让单测可以不激活插件直接验算。
 */

/**
 * 计算某任务的下一个执行时刻；null = 不再执行（禁用 / once 已跑 / 超出有效期）。
 * @param {any} task
 * @param {Date} [from]
 * @returns {number | null}
 */
export function computeNextRun(task, from = new Date()) {
  if (!task.enabled) return null
  const [h, m] = String(task.schedule?.time || '09:00')
    .split(':')
    .map(Number)
  const now = from.getTime()
  let next
  switch (task.schedule?.kind) {
    case 'daily':
      next = nextDaily(from, h, m)
      break
    case 'weekly':
      next = nextWeekly(from, h, m, Number(task.schedule.weekday ?? 1))
      break
    case 'monthly':
      next = nextMonthly(from, h, m, Number(task.schedule.day ?? 1))
      break
    case 'once':
    default:
      next = task.schedule?.at ? new Date(task.schedule.at).getTime() : null
      if (next !== null && next <= now) return null
      break
    case 'interval': {
      const step = Math.max(1, Number(task.schedule?.everyMinutes) || 60) * 60_000
      next = now + step
      break
    }
  }
  if (next === null || !Number.isFinite(next)) return null
  if (task.validUntil) {
    const until = new Date(`${task.validUntil}T23:59:59`).getTime()
    if (Number.isFinite(until) && next > until) return null
  }
  return next
}

/** @param {Date} base @param {number} h @param {number} m */
function atTime(base, h, m) {
  const d = new Date(base)
  d.setHours(h, m, 0, 0)
  return d
}

/** @param {Date} from @param {number} h @param {number} m */
function nextDaily(from, h, m) {
  const next = atTime(from, h, m)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime()
}

/** @param {Date} from @param {number} h @param {number} m @param {number} weekday */
function nextWeekly(from, h, m, weekday) {
  const next = atTime(from, h, m)
  let delta = (weekday - next.getDay() + 7) % 7
  if (delta === 0 && next.getTime() <= from.getTime()) delta = 7
  next.setDate(next.getDate() + delta)
  return next.getTime()
}

/** @param {Date} from @param {number} h @param {number} m @param {number} day */
function nextMonthly(from, h, m, day) {
  const probe = new Date(from)
  for (let i = 0; i < 48; i++) {
    // 无该日的月份（如 2 月没有 30 号）取当月最后一天
    const lastDay = new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate()
    const anchor = new Date(probe.getFullYear(), probe.getMonth(), Math.min(day, lastDay), h, m, 0, 0)
    if (anchor.getTime() > from.getTime()) return anchor.getTime()
    probe.setMonth(probe.getMonth() + 1)
  }
  // 48 个月都找不到（理论上不可能）——退回一个月后
  return from.getTime() + 30 * 86_400_000
}

/**
 * 调度的人话描述：每天 08:30 / 每周一 09:30 / 每月 1 日 09:00 / 每小时 / 一次 · 11月7日 09:00
 * @param {any} task
 */
export function scheduleLabel(task) {
  const s = task.schedule ?? {}
  const time = s.time || '09:00'
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  switch (s.kind) {
    case 'daily':
      return `每天 ${time}`
    case 'weekly':
      return `每${weekdays[Number(s.weekday ?? 1)] ?? '周一'} ${time}`
    case 'monthly':
      return `每月 ${s.day ?? 1} 日 ${time}`
    case 'once':
      return s.at
        ? `一次 · ${new Date(s.at).toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}`
        : '一次'
    case 'interval': {
      const mins = Math.max(1, Number(s.everyMinutes) || 60)
      if (mins >= 60 && mins % 60 === 0) {
        const h = mins / 60
        return h === 1 ? '每小时' : `每隔 ${h} 小时`
      }
      return mins === 1 ? '每分钟' : `每隔 ${mins} 分钟`
    }
    default:
      return time
  }
}
