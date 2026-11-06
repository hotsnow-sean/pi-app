// @ts-check
/**
 * 任务输入的规范化与校验——**UI 与 agent 工具共用这一份**。
 *
 * 以前校验只长在 methods.saveTask 里，工具如果另写一套，两边必然漂移：
 * 比如「once 的执行时刻已经过去」，UI 是静默标成已完成，工具那边应该直接报错让
 * 模型重来。差异只保留在 `mode` 上，其余规则一字不改。
 *
 * 返回 `{ task, errors, pastOnce }`：
 * - `errors` 非空时不要落盘，原文回给调用方（UI 显示、工具 isError）；
 * - `pastOnce` 只给 UI 用：编辑页允许保存一个「已过去的一次性任务」（按已完成处理），
 *   工具不允许——模型应该当场纠正时间，而不是建一条永远不跑的任务。
 */
import fs from 'node:fs'
import path from 'node:path'

export const KINDS = ['once', 'daily', 'weekly', 'monthly', 'interval']
export const NOTIFY_POLICIES = ['always', 'on-change', 'failures', 'never']

/** 名称/提示词上限：任务数已有 50 的上限，单条也不该无限大 */
export const NAME_MAX = 60
export const PROMPT_MAX = 8_000

/**
 * @param {any} input
 * @param {{ mode?: 'ui' | 'tool', now?: number }} [opts]
 * @returns {{ task: any, errors: string[], pastOnce: boolean }}
 */
export function normalizeTaskInput(input, opts = {}) {
  const mode = opts.mode ?? 'ui'
  const now = opts.now ?? Date.now()
  const src = input && typeof input === 'object' ? input : {}
  /** @type {string[]} */
  const errors = []

  // ---- 名称与提示词 ----
  const name = String(src.name ?? '').trim()
  if (!name) errors.push('任务名称不能为空')
  else if (name.length > NAME_MAX) errors.push(`任务名称最长 ${NAME_MAX} 字`)

  const prompt = String(src.prompt ?? '').trim()
  if (!prompt) errors.push('提示词不能为空')
  else if (prompt.length > PROMPT_MAX) errors.push(`提示词最长 ${PROMPT_MAX} 字`)

  // ---- 调度 ----
  const kind = String(src.schedule?.kind ?? 'daily')
  if (!KINDS.includes(kind)) errors.push(`重复方式只能是 ${KINDS.join(' / ')}`)

  let time = '09:00'
  const rawTime = src.schedule?.time
  if (rawTime !== undefined && rawTime !== null && String(rawTime) !== '') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(rawTime))) errors.push('时间必须是 HH:mm（24 小时制）')
    else time = String(rawTime)
  }

  let weekday = 1
  if (src.schedule?.weekday !== undefined && src.schedule?.weekday !== null) {
    const value = Number(src.schedule.weekday)
    if (!Number.isInteger(value) || value < 0 || value > 6) errors.push('星期必须是 0（周日）到 6（周六）')
    else weekday = value
  }

  let day = 1
  if (src.schedule?.day !== undefined && src.schedule?.day !== null) {
    const value = Number(src.schedule.day)
    if (!Number.isInteger(value) || value < 1 || value > 31) errors.push('日期必须是 1 到 31')
    else day = value
  }

  let everyMinutes = 60
  if (src.schedule?.everyMinutes !== undefined && src.schedule?.everyMinutes !== null) {
    const value = Number(src.schedule.everyMinutes)
    if (!Number.isInteger(value) || value < 1 || value > 43_200) errors.push('间隔必须是 1 到 43200 分钟')
    else everyMinutes = value
  }

  let at
  let pastOnce = false
  if (kind === 'once') {
    const raw = src.schedule?.at
    const fallback = new Date(now + 5 * 60_000).toISOString()
    const value = raw ? new Date(String(raw)) : new Date(fallback)
    if (Number.isNaN(value.getTime())) {
      errors.push('执行时刻不是合法时间（需要 ISO 8601，如 2026-11-07T09:00）')
    } else if (value.getTime() <= now) {
      pastOnce = true
      if (mode === 'tool') errors.push(`执行时刻已经过去（${value.toLocaleString('zh-CN')}），请换一个将来的时间`)
      at = value.toISOString()
    } else {
      at = value.toISOString()
    }
    if (!at) at = new Date(fallback).toISOString()
  }

  // ---- 工作目录 ----
  const cwd = String(src.cwd ?? '').trim()
  if (cwd) {
    if (!path.isAbsolute(cwd)) {
      errors.push(`工作目录必须是绝对路径：${cwd}`)
    } else {
      try {
        if (!fs.statSync(cwd).isDirectory()) errors.push(`工作目录不是文件夹：${cwd}`)
      } catch {
        errors.push(`工作目录不存在：${cwd}`)
      }
    }
  }

  // ---- 有效期 ----
  let validUntil = null
  if (src.validUntil !== undefined && src.validUntil !== null && String(src.validUntil) !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(src.validUntil))) errors.push('有效期格式必须是 YYYY-MM-DD')
    else validUntil = String(src.validUntil)
  }

  // ---- 通知策略（任务级覆盖全局；null = 跟随全局）----
  let notifyPolicy = null
  const rawPolicy = src.notifyPolicy
  if (rawPolicy !== undefined && rawPolicy !== null && String(rawPolicy) !== '') {
    if (!NOTIFY_POLICIES.includes(String(rawPolicy))) {
      errors.push(`通知策略只能是 ${NOTIFY_POLICIES.join(' / ')}`)
    } else {
      notifyPolicy = String(rawPolicy)
    }
  }

  return {
    task: {
      name,
      prompt,
      schedule: { kind, time, weekday, day, everyMinutes, at },
      cwd,
      validUntil,
      enabled: src.enabled !== false,
      notifyPolicy,
    },
    errors,
    pastOnce,
  }
}
