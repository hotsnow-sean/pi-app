/* 定时任务插件 UI：任务（主从）/ 运行记录 / 新建编辑 三个视图，通过 invoke 桥与 main 侧通信。
 *
 * 宽屏是「左任务列 + 右详情/时间线」的主从布局；窄屏（<900px，右栏面板）退化成
 * 「列表 → 详情」的跳转，同一份 DOM 由 CSS 媒体查询切换，不写两套渲染。
 *
 * 轮询：有任务在跑时 2s，空闲 5s；数据签名没变就不重绘——否则每 2 秒重排一次 DOM，
 * 正在读结果的人会被反复打断。倒计时与「执行中 12s」由本地 500ms 的轻量 ticker 更新，
 * 不依赖轮询。
 */

// ---------- invoke 桥 ----------

let invokeSeq = 0
const waiters = new Map()

/** 声明式设置项的当前值（宿主握手时下发一次，见 plugin-panel-frame 的 plugin-settings） */
let pluginSettings = {}

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data.type === 'plugin-theme') {
    applyTheme(data.vars)
    return
  }
  if (data.type === 'plugin-settings') {
    pluginSettings = data.values && typeof data.values === 'object' ? data.values : {}
    return
  }
  if (data.type === 'plugin-invoke-result') {
    const waiter = waiters.get(data.requestId)
    if (!waiter) return
    waiters.delete(data.requestId)
    clearTimeout(waiter.timer)
    if (data.ok) waiter.resolve(data.result)
    else waiter.reject(new Error(data.error || 'invoke failed'))
  }
})

/**
 * 应用宿主主题：vars 是 `--pi-*` → 完整 CSS 值的映射（见宿主 plugin-panel-frame 主题契约）。
 * 落到 documentElement 行内样式，优先级高于 style.css 的 :root 兜底值。
 */
function applyTheme(vars) {
  if (!vars || typeof vars !== 'object') return
  const root = document.documentElement
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value === 'string' && value) root.style.setProperty(name, value)
  }
}

/** 面板失联时不能让按钮永远转圈：10s 没回包就报错，用户还能重试 */
function api(method, params) {
  const requestId = ++invokeSeq
  window.parent.postMessage({ type: 'plugin-invoke', requestId, method, params }, '*')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(requestId)
      reject(new Error('宿主没有响应，请稍后重试'))
    }, 10_000)
    waiters.set(requestId, { resolve, reject, timer })
  })
}

/**
 * 转发宿主全局快捷键：iframe 有焦点时宿主 window 收不到 keydown（子文档独立），
 * 由插件主动上报（契约见宿主 plugin-panel-frame 的 plugin-key）。
 */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (expanded.size > 0) {
      expanded.clear()
      render({ keepScroll: true })
      return
    }
    if (view === 'edit') {
      backToList()
      return
    }
    if (view === 'runs') {
      view = 'tasks'
      render()
      return
    }
    if (document.body.classList.contains('show-detail')) {
      document.body.classList.remove('show-detail')
      render()
      return
    }
    window.parent.postMessage({ type: 'plugin-key', key: 'Escape' }, '*')
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    window.parent.postMessage({ type: 'plugin-key', key: 'k', mod: true }, '*')
  }
})

// ---------- 状态 ----------

let snap = {
  tasks: [],
  active: [],
  lastRunByTask: {},
  unreadByTask: {},
  serverNow: Date.now(),
  settings: {},
}
let view = 'tasks' // tasks | runs | edit
let selectedId = null
let detailRuns = []
let allRuns = []
let runsTotal = 0
let statusFilter = 'all' // all | ok | failed | active
let taskFilter = ''
const expanded = new Set()
let search = ''
let editing = null
let formError = ''
let clockSkew = 0
let lastSig = ''
let pollTimer = null
let uiTimer = null
let refreshInFlight = false

const $app = document.getElementById('app')

// ---------- 工具 ----------

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><polyline points="12 7 12 12 16 14"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
}

function h(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function nowTs() {
  return Date.now() - clockSkew
}

function fmtClock(ts) {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function dayLabel(ts, now = nowTs()) {
  const start = (value) => {
    const d = new Date(value)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const delta = Math.round((start(ts) - start(now)) / 86_400_000)
  if (delta === 0) return '今天'
  if (delta === 1) return '明天'
  if (delta === -1) return '昨天'
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return sameYear ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function fmtWhen(ts, now = nowTs()) {
  return `${dayLabel(ts, now)} ${fmtClock(ts)}`
}

function humanizeSpan(ms) {
  const abs = Math.abs(ms)
  if (abs < 60_000) return `${Math.max(1, Math.round(abs / 1000))} 秒`
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} 分钟`
  if (abs < 86_400_000) return `${Math.round((abs / 3_600_000) * 10) / 10} 小时`
  return `${Math.round((abs / 86_400_000) * 10) / 10} 天`
}

/** 明天 08:30 · 还有 13 小时 —— 倒计时块与卡片共用 */
function describeNext(ts, now = nowTs()) {
  if (!ts) return '不再执行'
  const when = fmtWhen(ts, now)
  if (ts <= now) return `${when} · 即将执行`
  return `${when} · 还有 ${humanizeSpan(ts - now)}`
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const STATUS_TEXT = {
  queued: '排队中',
  running: '执行中',
  ok: '成功',
  failed: '失败',
  interrupted: '已中断',
  skipped: '已跳过',
}

const STATUS_TONE = {
  queued: 'idle',
  running: 'active',
  ok: 'ok',
  failed: 'error',
  interrupted: 'warn',
  skipped: 'warn',
}

function skipText(reason) {
  if (reason === 'overlap') return '上次还没结束'
  if (reason === 'queue_full') return '排队过多'
  if (reason === 'app_exit') return '应用退出'
  if (reason === 'disabled') return '任务已停用'
  return ''
}

function statusOf(run) {
  return run ? STATUS_TEXT[run.status] || run.status : ''
}

function toneOf(run) {
  return run ? STATUS_TONE[run.status] || 'idle' : 'idle'
}

// ---------- 渲染 ----------

function render(opts = {}) {
  const scroll = opts.keepScroll ? (document.scrollingElement?.scrollTop ?? 0) : 0
  if (view === 'edit') renderEdit()
  else if (view === 'runs') renderRuns()
  else renderTasks()
  if (opts.keepScroll) document.scrollingElement?.scrollTo?.({ top: scroll })
  lastSig = signature()
  // 重绘会换掉整个 DOM：已展开的记录要把正文重新挂回去（走缓存，不重复拉）
  if (expanded.size > 0) void hydrateExpanded()
}

function renderHead(active) {
  return `
    <header class="head">
      <div class="head-nav">
        <button class="nav-item ${active === 'tasks' ? 'active' : ''}" data-nav="tasks">定时任务</button>
        <button class="nav-item ${active === 'runs' ? 'active' : ''}" data-nav="runs">运行记录</button>
      </div>
      <div class="head-meta">${snap.tasks.filter((t) => t.enabled).length} 个已启用</div>
    </header>
  `
}

function bindHeadNav() {
  $app.querySelectorAll('[data-nav]').forEach((el) =>
    el.addEventListener('click', () => {
      view = el.dataset.nav === 'runs' ? 'runs' : 'tasks'
      if (view === 'runs') void openRuns()
      else render()
    }),
  )
}

/** 任务列表的三组：执行中 / 已启用 / 已结束 */
function groupedTasks() {
  const activeByTask = new Map(snap.active.map((item) => [item.taskId, item]))
  const match = (task) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return `${task.name}\n${task.prompt}`.toLowerCase().includes(q)
  }
  const visible = snap.tasks.filter(match)
  const running = visible
    .filter((task) => activeByTask.has(task.id))
    .sort((a, b) => activeByTask.get(a.id).queuedAt - activeByTask.get(b.id).queuedAt)
  const enabled = visible
    .filter((task) => !activeByTask.has(task.id) && task.enabled && !task.done)
    .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))
  const finished = visible
    .filter((task) => !activeByTask.has(task.id) && (!task.enabled || task.done))
    .sort((a, b) => (b.lastRunAt ?? b.createdAt ?? 0) - (a.lastRunAt ?? a.createdAt ?? 0))
  return { running, enabled, finished, activeByTask }
}

function renderTasks() {
  const { running, enabled, finished, activeByTask } = groupedTasks()
  const empty = snap.tasks.length === 0
  const html = `
    ${renderHead('tasks')}
    <div class="layout">
      <aside class="col-list" id="col-list">
        <div class="list-head">
          <span class="list-title">任务 <span class="muted">${snap.tasks.length}</span></span>
          <button class="btn sm" id="btn-new">＋ 新建</button>
        </div>
        <input class="search" id="f-search" type="search" placeholder="搜索任务" value="${esc(search)}" />
        <div class="groups">
          ${empty ? emptyTasksHtml() : ''}
          ${running.length > 0 ? groupHtml('执行中', running, activeByTask, 'running') : ''}
          ${enabled.length > 0 ? groupHtml('已启用', enabled, activeByTask, 'enabled') : ''}
          ${finished.length > 0 ? groupHtml(`已停用 / 已完成 (${finished.length})`, finished, activeByTask, 'finished') : ''}
          ${!empty && running.length + enabled.length + finished.length === 0 ? '<div class="empty small">没有匹配的任务</div>' : ''}
        </div>
      </aside>
      <section class="col-detail" id="col-detail">${detailHtml()}</section>
    </div>
  `
  $app.replaceChildren(h(html))
  bindHeadNav()
  bindList()
  bindDetail()
  const input = $app.querySelector('#f-search')
  if (input) {
    input.addEventListener('input', (e) => {
      search = e.target.value
      const groups = $app.querySelector('.groups')
      if (groups) renderListInto(groups)
    })
  }
  $app.querySelector('#btn-new')?.addEventListener('click', () => openEdit(null))
  updateUi()
}

/** 只重绘左列（搜索输入时），不打断右侧详情 */
function renderListInto(container) {
  const { running, enabled, finished, activeByTask } = groupedTasks()
  const empty = snap.tasks.length === 0
  container.replaceChildren(
    h(`
      ${empty ? emptyTasksHtml() : ''}
      ${running.length > 0 ? groupHtml('执行中', running, activeByTask, 'running') : ''}
      ${enabled.length > 0 ? groupHtml('已启用', enabled, activeByTask, 'enabled') : ''}
      ${finished.length > 0 ? groupHtml(`已停用 / 已完成 (${finished.length})`, finished, activeByTask, 'finished') : ''}
      ${!empty && running.length + enabled.length + finished.length === 0 ? '<div class="empty small">没有匹配的任务</div>' : ''}
    `),
  )
  bindList()
}

function groupHtml(title, tasks, activeByTask, kind) {
  return `
    <div class="group">
      <div class="group-head">${kind === 'running' ? '<span class="pulse-dot"></span>' : ''}${esc(title)}</div>
      ${tasks.map((task) => cardHtml(task, activeByTask.get(task.id), kind)).join('')}
    </div>
  `
}

function cardHtml(task, active, kind) {
  const unread = snap.unreadByTask[task.id] ?? 0
  const last = snap.lastRunByTask[task.id]
  const selected = task.id === selectedId
  const meta = active
    ? `执行中 · <span data-elapsed="${active.startedAt ?? active.queuedAt}">—</span>`
    : task.enabled
      ? `${esc(task.scheduleLabel)} · <span data-countdown="${task.nextRunAt ?? ''}">${esc(task.nextRunAt ? describeNext(task.nextRunAt) : '不再执行')}</span>`
      : `${esc(task.scheduleLabel)} · 已停用`
  const sub = active
    ? `开始于 ${fmtClock(active.startedAt ?? active.queuedAt)}`
    : task.prompt
      ? esc(task.prompt.replace(/\s+/g, ' ').slice(0, 60))
      : '（无提示词）'
  return `
    <div class="task-card ${selected ? 'selected' : ''} ${active ? 'is-active' : ''}" data-id="${task.id}" tabindex="0">
      <div class="tc-top">
        <span class="dot ${active ? 'active' : toneOf(last)}"></span>
        <span class="tc-name" title="${esc(task.name)}">${esc(task.name)}</span>
        ${task.createdBy === 'agent' ? '<span class="tag">由助理创建</span>' : ''}
        ${unread > 0 ? `<span class="unread" title="${unread} 条未读运行">${unread}</span>` : ''}
        <label class="switch" title="${task.enabled ? '停用' : '启用'}">
          <input type="checkbox" data-act="toggle" ${task.enabled ? 'checked' : ''}/>
          <span class="track"></span>
        </label>
      </div>
      <div class="tc-meta">${meta}</div>
      <div class="tc-prompt">${sub}</div>
      <div class="tc-actions">
        ${active ? '' : `<button class="icon-btn" data-act="run" title="立即运行">${ICONS.play}</button>`}
        <button class="icon-btn" data-act="edit" title="编辑">${ICONS.edit}</button>
        <button class="icon-btn danger" data-act="delete" title="删除">${ICONS.trash}</button>
      </div>
    </div>
  `
}

function emptyTasksHtml() {
  const templates = [
    {
      name: '每日简报',
      desc: '每天 09:00 · 整理今天的工作安排',
      prompt: '整理今天的工作安排：读一遍当前项目的待办和最近改动，输出 3 条要点，每条一句话。',
      schedule: { kind: 'daily', time: '09:00' },
      notifyPolicy: 'always',
    },
    {
      name: '每周周报',
      desc: '每周一 09:30 · 汇总上周改动',
      prompt: '汇总上周我改过的文件，写一份周报草稿，分「做了什么 / 遇到的问题 / 下周计划」三段。',
      schedule: { kind: 'weekly', weekday: 1, time: '09:30' },
      notifyPolicy: 'on-change',
    },
    {
      name: '构建检查',
      desc: '每小时 · 构建失败时说明原因',
      prompt: '检查当前目录的构建是否仍然通过（先看有没有 package.json，再跑对应的构建命令）。失败时说明原因和修复建议。',
      schedule: { kind: 'interval', everyMinutes: 60 },
      notifyPolicy: 'on-change',
    },
  ]
  return `
    <div class="empty">
      <p class="empty-title">还没有定时任务</p>
      <p class="empty-sub">从下面的模板开始，或点「新建」自己写。</p>
      <div class="templates">
        ${templates
          .map(
            (tpl, index) => `
          <button class="template" data-template="${index}">
            <span class="tpl-name">${esc(tpl.name)}</span>
            <span class="tpl-desc">${esc(tpl.desc)}</span>
          </button>`,
          )
          .join('')}
      </div>
    </div>
    <script type="application/json" id="template-data">${JSON.stringify(templates)}</script>
  `
}

function detailHtml() {
  const task = snap.tasks.find((item) => item.id === selectedId)
  if (!task) {
    return `<div class="detail-empty">
      <p class="empty-title">从左侧选择一个任务</p>
      <p class="empty-sub">这里会显示它的下次执行时间、提示词和运行记录。</p>
    </div>`
  }
  const active = snap.active.find((item) => item.taskId === task.id)
  const last = snap.lastRunByTask[task.id]
  const badge = active
    ? `<span class="badge active"><span class="pulse-dot"></span>执行中</span>`
    : task.enabled
      ? '<span class="badge ok">已启用</span>'
      : `<span class="badge">${task.done ? '已完成' : '已停用'}</span>`
  const nextBlock = active
    ? `<div class="next-box active">
        <div class="next-label">执行中</div>
        <div class="next-value">已运行 <span data-elapsed="${active.startedAt ?? active.queuedAt}">—</span></div>
        <div class="next-sub">开始于 ${fmtWhen(active.startedAt ?? active.queuedAt)}</div>
      </div>`
    : task.enabled && task.nextRunAt
      ? `<div class="next-box">
          <div class="next-label">下次执行</div>
          <div class="next-value" data-countdown="${task.nextRunAt}">${esc(describeNext(task.nextRunAt))}</div>
          <div class="next-sub">${esc(task.scheduleLabel)}${task.validUntil ? ` · 有效期至 ${esc(task.validUntil)}` : ''}</div>
        </div>`
      : `<div class="next-box">
          <div class="next-label">下次执行</div>
          <div class="next-value muted">不会再执行</div>
          <div class="next-sub">${task.done ? '这个任务已经完成或被停用' : '已停用'}</div>
        </div>`
  return `
    <div class="detail-head">
      <button class="back-btn" id="btn-back" title="返回列表">${ICONS.back}<span>返回</span></button>
      <h2 class="detail-title">${esc(task.name)}</h2>
      ${badge}
      ${task.createdBy === 'agent' ? '<span class="tag">由助理创建</span>' : ''}
    </div>
    ${nextBlock}
    <div class="detail-actions">
      <button class="btn" data-act="run" ${active ? 'disabled' : ''}>${active ? '执行中…' : '立即运行'}</button>
      <button class="btn ghost" data-act="toggle">${task.enabled ? '停用' : '启用'}</button>
      <button class="btn ghost" data-act="edit">编辑</button>
      <button class="btn danger-ghost" data-act="delete">删除</button>
    </div>
    <div class="prompt-block">
      <button class="prompt-toggle" id="btn-prompt">提示词 <span class="chev">▾</span></button>
      <pre class="prompt-body" id="prompt-body" hidden>${esc(task.prompt)}</pre>
    </div>
    <div class="detail-meta">
      <span>通知策略：${esc(task.notifyPolicyLabel)}</span>
      <span>累计完成 ${task.runCount} 次</span>
      ${last ? `<span>上次 ${esc(statusOf(last))} · ${esc(fmtWhen(last.finishedAt ?? last.queuedAt))}</span>` : '<span>还没有运行过</span>'}
      ${task.cwd ? `<span class="mono">${esc(task.cwd)}</span>` : ''}
    </div>
    <h3 class="section-title">运行记录</h3>
    ${detailRuns.length === 0 ? '<div class="empty small">这个任务还没有运行记录。到点执行或点「立即运行」后，记录会出现在这里。</div>' : timelineHtml(detailRuns, { showTask: false })}
  `
}

function timelineHtml(runs, opts = {}) {
  const groups = []
  for (const run of runs) {
    const key = dayKey(run.finishedAt ?? run.startedAt ?? run.queuedAt)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.runs.push(run)
    else groups.push({ key, runs: [run] })
  }
  return `
    <div class="timeline">
      ${groups
        .map(
          (group) => `
        <div class="tl-group">
          <div class="tl-day">${esc(dayLabel(group.runs[0].finishedAt ?? group.runs[0].queuedAt))}</div>
          ${group.runs.map((run) => runRowHtml(run, opts)).join('')}
        </div>`,
        )
        .join('')}
    </div>
  `
}

function runRowHtml(run, opts) {
  const open = expanded.has(run.id)
  const tone = toneOf(run)
  const flags = []
  if (run.trigger === 'missed') flags.push('补跑')
  if (run.trigger === 'manual') flags.push('手动')
  if (run.status === 'skipped' && run.skipReason) flags.push(skipText(run.skipReason))
  if (run.status === 'interrupted' && run.skipReason === 'app_exit') flags.push('应用退出')
  // 未通知的原因由插件侧算好（notifyLabel），UI 不再靠 signal.changed 自己推断
  if (run.notifyLabel) flags.push(run.notifyLabel)
  const when = run.finishedAt ?? run.startedAt ?? run.queuedAt
  return `
    <div class="tl-row ${open ? 'open' : ''}" data-run="${run.id}">
      <div class="tl-line" data-act="expand">
        <span class="dot ${tone}"></span>
        ${opts.showTask ? `<span class="tl-task" title="${esc(run.taskName)}">${esc(run.taskName)}</span>` : ''}
        <span class="tl-status ${tone}">${esc(statusOf(run))}</span>
        <span class="tl-time">${fmtClock(when)}</span>
        ${flags.map((flag) => `<span class="tl-flag">${esc(flag)}</span>`).join('')}
        <span class="tl-dur">${run.status === 'queued' || run.status === 'running' ? '进行中' : fmtDuration(run.durationMs)}</span>
        <span class="tl-chev ${open ? 'open' : ''}">${ICONS.chevron}</span>
        <button class="icon-btn danger tl-del" data-act="del-run" title="删除这条记录">${ICONS.trash}</button>
      </div>
    </div>
  `
}

function expandedBody(run) {
  const err = run.error ? `<div class="run-error">${esc(run.error)}</div>` : ''
  const out = run.output
    ? `<pre class="run-body">${esc(run.output)}</pre>`
    : run.status === 'skipped'
      ? `<div class="run-empty">本次没有执行：${esc(skipText(run.skipReason) || '已跳过')}</div>`
      : run.status === 'queued' || run.status === 'running'
        ? '<div class="run-empty">还在执行，稍后会自动刷新。</div>'
        : '<div class="run-empty">（没有输出）</div>'
  return `
    <div class="tl-body">
      ${err}
      ${out}
      <div class="tl-body-foot">
        <span class="muted">${esc(fmtWhen(run.finishedAt ?? run.startedAt ?? run.queuedAt))}${run.cwd ? ` · ${esc(run.cwd)}` : ''}</span>
        <button class="btn ghost sm" data-act="copy" data-run="${run.id}">${ICONS.copy}<span>复制</span></button>
      </div>
    </div>
  `
}

function renderRuns() {
  const html = `
    ${renderHead('runs')}
    <div class="runs-page">
      <div class="filters">
        ${[
          ['all', '全部'],
          ['ok', '成功'],
          ['failed', '失败'],
          ['active', '执行中'],
        ]
          .map(
            ([value, label]) =>
              `<button class="chip ${statusFilter === value ? 'active' : ''}" data-filter="${value}">${label}</button>`,
          )
          .join('')}
        <select class="select sm" id="filter-task">
          <option value="">全部任务</option>
          ${snap.tasks.map((task) => `<option value="${task.id}" ${taskFilter === task.id ? 'selected' : ''}>${esc(task.name)}</option>`).join('')}
        </select>
        <span class="muted" style="margin-left:auto">${runsTotal} 条</span>
      </div>
      ${allRuns.length === 0 ? '<div class="empty">还没有运行记录。<br/>任务到点执行或点「立即运行」后，记录会出现在这里。</div>' : timelineHtml(allRuns, { showTask: true })}
    </div>
  `
  $app.replaceChildren(h(html))
  bindHeadNav()
  $app.querySelectorAll('[data-filter]').forEach((el) =>
    el.addEventListener('click', () => {
      statusFilter = el.dataset.filter
      void openRuns()
    }),
  )
  $app.querySelector('#filter-task')?.addEventListener('change', (e) => {
    taskFilter = e.target.value
    void openRuns()
  })
  bindTimeline()
  updateUi()
}

function renderEdit() {
  const t = editing ?? {}
  const s = t.schedule ?? { kind: 'daily', time: '09:00', weekday: 1, day: 1 }
  const kind = s.kind || 'daily'
  const needTime = kind === 'daily' || kind === 'weekly' || kind === 'monthly'
  const ivMins = Math.max(1, Number(s.everyMinutes) || 60)
  const ivUnit = ivMins >= 60 && ivMins % 60 === 0 ? 'h' : 'm'
  const ivValue = ivUnit === 'h' ? ivMins / 60 : ivMins
  const onceDefault = toLocalInput(new Date(Date.now() + 5 * 60_000).toISOString())
  const policy = t.notifyPolicy ?? ''
  const html = `
    ${renderHead('tasks')}
    <div class="edit-page">
      <div class="edit-head">
        <button class="back-btn" id="btn-cancel" title="返回">${ICONS.back}<span>返回</span></button>
        <h2>${t.id ? '编辑定时任务' : '新建定时任务'}</h2>
      </div>
      <div class="card form">
        <div class="field">
          <label>任务名称</label>
          <input type="text" id="f-name" placeholder="输入任务名称" value="${esc(t.name ?? '')}" maxlength="60"/>
        </div>
        <div class="field">
          <label>提示词（到点交给 agent 执行）</label>
          <textarea id="f-prompt" placeholder="例如：检查一下今天的工作安排，并生成一份简报">${esc(t.prompt ?? '')}</textarea>
          <div class="hint">执行时是全新会话，看不到当前对话，也调不到插件工具。所以要写清做什么、在哪做、输出什么格式。</div>
        </div>
        <div class="row">
          <div class="field">
            <label>重复</label>
            <select id="f-kind">
              <option value="once" ${kind === 'once' ? 'selected' : ''}>仅一次</option>
              <option value="daily" ${kind === 'daily' ? 'selected' : ''}>每天</option>
              <option value="weekly" ${kind === 'weekly' ? 'selected' : ''}>每周</option>
              <option value="monthly" ${kind === 'monthly' ? 'selected' : ''}>每月</option>
              <option value="interval" ${kind === 'interval' ? 'selected' : ''}>间隔</option>
            </select>
          </div>
          ${
            needTime
              ? `<div class="field" id="f-time-field">
                  <label>时间</label>
                  <input type="time" id="f-time" value="${esc(s.time ?? '09:00')}"/>
                </div>`
              : ''
          }
        </div>
        <div class="row" id="f-weekday-row" style="display:${kind === 'weekly' ? 'flex' : 'none'}">
          <div class="field">
            <label>星期</label>
            <select id="f-weekday">
              ${['周日', '周一', '周二', '周三', '周四', '周五', '周六']
                .map((d, i) => `<option value="${i}" ${Number(s.weekday) === i ? 'selected' : ''}>${d}</option>`)
                .join('')}
            </select>
          </div>
        </div>
        <div class="row" id="f-day-row" style="display:${kind === 'monthly' ? 'flex' : 'none'}">
          <div class="field">
            <label>几号（当月没有该日时取最后一天）</label>
            <input type="number" id="f-day" min="1" max="31" value="${Number(s.day) || 1}"/>
          </div>
        </div>
        <div class="row" id="f-once-row" style="display:${kind === 'once' ? 'flex' : 'none'}">
          <div class="field">
            <label>执行时刻</label>
            <input type="datetime-local" id="f-at" value="${s.at ? toLocalInput(s.at) : onceDefault}"/>
          </div>
        </div>
        <div class="row" id="f-interval-row" style="display:${kind === 'interval' ? 'flex' : 'none'}">
          <div class="field">
            <label>每隔</label>
            <input type="number" id="f-interval-value" min="1" step="1" value="${ivValue}"/>
          </div>
          <div class="field" style="align-self:end">
            <select id="f-interval-unit">
              <option value="m" ${ivUnit === 'm' ? 'selected' : ''}>分钟</option>
              <option value="h" ${ivUnit === 'h' ? 'selected' : ''}>小时</option>
            </select>
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label>通知策略</label>
            <select id="f-policy">
              <option value="" ${policy === '' ? 'selected' : ''}>跟随全局默认（${esc(snap.settings.defaultNotifyPolicy || 'on-change') === 'always' ? '每次都通知' : '有变化才通知'}）</option>
              <option value="on-change" ${policy === 'on-change' ? 'selected' : ''}>有变化才通知（失败也通知）</option>
              <option value="always" ${policy === 'always' ? 'selected' : ''}>每次都通知</option>
              <option value="failures" ${policy === 'failures' ? 'selected' : ''}>仅失败时通知</option>
              <option value="never" ${policy === 'never' ? 'selected' : ''}>不通知，只看记录</option>
            </select>
          </div>
          <div class="field">
            <label>有效期至（留空 = 长期有效）</label>
            <input type="date" id="f-valid-until" value="${esc(t.validUntil ?? '')}"/>
          </div>
        </div>
        <div class="field">
          <label>工作空间目录（留空 = 设置里的默认目录）</label>
          <input type="text" id="f-cwd" placeholder="例如 C:\\Users\\me\\projects\\demo" value="${esc(t.cwd || (!t.id ? snap.settings.defaultCwd || '' : ''))}"/>
        </div>
        <div class="form-error" id="form-error" ${formError ? '' : 'hidden'}>${esc(formError)}</div>
        <div class="form-actions">
          <span class="next-preview muted" id="next-preview"></span>
          <button class="btn ghost" id="btn-cancel-2">取消</button>
          <button class="btn" id="btn-save">保存</button>
        </div>
      </div>
    </div>
  `
  $app.replaceChildren(h(html))
  bindHeadNav()
  const kindSelect = $app.querySelector('#f-kind')
  kindSelect.addEventListener('change', (e) => {
    const k = e.target.value
    const timeField = $app.querySelector('#f-time-field')
    if (timeField) timeField.style.display = ['daily', 'weekly', 'monthly'].includes(k) ? '' : 'none'
    $app.querySelector('#f-weekday-row').style.display = k === 'weekly' ? 'flex' : 'none'
    $app.querySelector('#f-day-row').style.display = k === 'monthly' ? 'flex' : 'none'
    $app.querySelector('#f-once-row').style.display = k === 'once' ? 'flex' : 'none'
    $app.querySelector('#f-interval-row').style.display = k === 'interval' ? 'flex' : 'none'
    void updatePreview()
  })
  for (const id of ['#f-time', '#f-weekday', '#f-day', '#f-at', '#f-interval-value', '#f-interval-unit']) {
    $app.querySelector(id)?.addEventListener('change', () => void updatePreview())
  }
  $app.querySelector('#btn-cancel').addEventListener('click', backToList)
  $app.querySelector('#btn-cancel-2').addEventListener('click', backToList)
  $app.querySelector('#btn-save').addEventListener('click', () => void saveTask())
  void updatePreview()
  lastSig = signature()
}

function toLocalInput(iso) {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 编辑页底部实时显示「按当前设置，下次执行是…」——比让用户自己心算可靠 */
async function updatePreview() {
  const el = $app.querySelector('#next-preview')
  if (!el) return
  const kind = $app.querySelector('#f-kind')?.value
  const ivValue = Number($app.querySelector('#f-interval-value')?.value)
  const ivUnit = $app.querySelector('#f-interval-unit')?.value ?? 'm'
  const schedule = {
    kind,
    time: $app.querySelector('#f-time')?.value || '09:00',
    weekday: Number($app.querySelector('#f-weekday')?.value ?? 1),
    day: Number($app.querySelector('#f-day')?.value ?? 1),
    everyMinutes: kind === 'interval' ? Math.max(1, Math.round((Number.isFinite(ivValue) && ivValue > 0 ? ivValue : 30) * (ivUnit === 'h' ? 60 : 1))) : undefined,
    at: kind === 'once' ? new Date($app.querySelector('#f-at')?.value || Date.now() + 5 * 60_000).toISOString() : undefined,
  }
  try {
    const res = await api('nextRunPreview', { schedule })
    if (!el.isConnected) return
    el.textContent = res.nextRunAt ? `下次执行：${describeNext(res.nextRunAt)}` : '按当前设置不会执行'
  } catch {
    if (el.isConnected) el.textContent = ''
  }
}

async function saveTask() {
  const kind = $app.querySelector('#f-kind').value
  const atInput = $app.querySelector('#f-at')?.value
  const ivValue = Number($app.querySelector('#f-interval-value')?.value)
  const ivUnit = $app.querySelector('#f-interval-unit')?.value ?? 'm'
  const task = {
    id: editing?.id,
    name: $app.querySelector('#f-name').value.trim(),
    prompt: $app.querySelector('#f-prompt').value,
    schedule: {
      kind,
      time: ['daily', 'weekly', 'monthly'].includes(kind) ? $app.querySelector('#f-time')?.value || '09:00' : undefined,
      weekday: Number($app.querySelector('#f-weekday')?.value ?? 1),
      day: Number($app.querySelector('#f-day')?.value ?? 1),
      at: kind === 'once' ? new Date(atInput || Date.now() + 5 * 60_000).toISOString() : undefined,
      everyMinutes:
        kind === 'interval'
          ? Math.max(1, Math.round((Number.isFinite(ivValue) && ivValue > 0 ? ivValue : 30) * (ivUnit === 'h' ? 60 : 1)))
          : undefined,
    },
    notifyPolicy: $app.querySelector('#f-policy').value || null,
    validUntil: $app.querySelector('#f-valid-until').value || null,
    cwd: $app.querySelector('#f-cwd').value.trim(),
    // 编辑时保持原来的启停状态；新建默认启用
    enabled: editing?.id ? editing.enabled !== false : true,
    createdBy: editing?.createdBy,
  }
  if (!task.name) task.name = '未命名任务'
  const btn = $app.querySelector('#btn-save')
  btn.disabled = true
  try {
    const res = await api('saveTask', { task })
    editing = null
    formError = ''
    selectedId = res.task?.id ?? selectedId
    view = 'tasks'
    await refresh()
    render()
  } catch (error) {
    formError = error.message || '保存失败'
    const box = $app.querySelector('#form-error')
    if (box) {
      box.textContent = formError
      box.hidden = false
    }
  } finally {
    if (btn.isConnected) btn.disabled = false
  }
}

// ---------- 列表 / 详情的事件 ----------

function bindList() {
  $app.querySelectorAll('.task-card').forEach((card) => {
    const task = snap.tasks.find((item) => item.id === card.dataset.id)
    if (!task) return
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-act]') || e.target.closest('.switch')) return
      void selectTask(task.id)
    })
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void selectTask(task.id)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = card.nextElementSibling
        if (next && next.classList.contains('task-card')) {
          next.focus()
          void selectTask(next.dataset.id)
        }
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = card.previousElementSibling
        if (prev && prev.classList.contains('task-card')) {
          prev.focus()
          void selectTask(prev.dataset.id)
        }
      }
    })
    card.querySelector('[data-act="run"]')?.addEventListener('click', () => void runNow(task))
    card.querySelector('[data-act="edit"]')?.addEventListener('click', () => openEdit(task))
    card.querySelector('[data-act="delete"]')?.addEventListener('click', () => void deleteTask(task))
    card.querySelector('[data-act="toggle"]')?.addEventListener('change', (e) => void toggleTask(task, e.target.checked))
  })
  $app.querySelectorAll('[data-template]').forEach((el) =>
    el.addEventListener('click', () => {
      // 只预填、不直接创建：用户得先看见 prompt 长什么样，才知道到点会去干什么
      const data = JSON.parse($app.querySelector('#template-data')?.textContent || '[]')
      openEdit(data[Number(el.dataset.template)] ?? null)
    }),
  )
}

function bindDetail() {
  const task = snap.tasks.find((item) => item.id === selectedId)
  $app.querySelector('#btn-back')?.addEventListener('click', () => {
    document.body.classList.remove('show-detail')
    render()
  })
  $app.querySelector('#btn-prompt')?.addEventListener('click', () => {
    const body = $app.querySelector('#prompt-body')
    if (!body) return
    body.hidden = !body.hidden
    $app.querySelector('#btn-prompt .chev').textContent = body.hidden ? '▾' : '▴'
  })
  if (!task) return
  $app.querySelector('.col-detail [data-act="run"]')?.addEventListener('click', () => void runNow(task))
  $app.querySelector('.col-detail [data-act="toggle"]')?.addEventListener('click', () => void toggleTask(task, !task.enabled))
  $app.querySelector('.col-detail [data-act="edit"]')?.addEventListener('click', () => openEdit(task))
  $app.querySelector('.col-detail [data-act="delete"]')?.addEventListener('click', () => void deleteTask(task))
  bindTimeline()
}

function bindTimeline() {
  $app.querySelectorAll('.tl-row').forEach((row) => {
    const runId = row.dataset.run
    row.querySelector('[data-act="expand"]')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="del-run"]')) return
      if (expanded.has(runId)) expanded.delete(runId)
      else expanded.add(runId)
      void toggleRunBody(runId)
    })
    row.querySelector('[data-act="del-run"]')?.addEventListener('click', async (e) => {
      e.stopPropagation()
      await api('deleteRun', { id: runId })
      expanded.delete(runId)
      runCache.delete(runId)
      await refresh()
      render({ keepScroll: true })
    })
    row.querySelector('[data-act="copy"]')?.addEventListener('click', (e) => {
      e.stopPropagation()
      void copyRun(row)
    })
  })
}

/** 已拉到的全文：重绘后补挂正文时不再重复请求 */
const runCache = new Map()

async function fullRunOf(id) {
  if (runCache.has(id)) return runCache.get(id)
  const res = await api('getRun', { id })
  runCache.set(id, res.run)
  return res.run
}

function insertRunBody(row, run) {
  if (row.querySelector('.tl-body')) return
  row.insertAdjacentHTML('beforeend', expandedBody(run))
  // 只给新插入的正文绑复制；整页重绑会把已有行的监听叠成两份
  row.querySelector('[data-act="copy"]')?.addEventListener('click', (e) => {
    e.stopPropagation()
    void copyRun(row)
  })
}

/** 重绘后把「已展开但还没正文」的行补上 */
async function hydrateExpanded() {
  for (const id of [...expanded]) {
    const row = $app.querySelector(`.tl-row[data-run="${id}"]`)
    if (!row || row.querySelector('.tl-body')) continue
    try {
      const run = await fullRunOf(id)
      if (run && row.isConnected) insertRunBody(row, run)
    } catch {
      /* 单条拉不到就保持折叠，不影响其它行 */
    }
  }
}

/** 展开/折叠只换这一行，避免整页重排（读长结果时最讨人厌） */
async function toggleRunBody(runId) {
  const row = $app.querySelector(`.tl-row[data-run="${runId}"]`)
  if (!row) return
  const open = expanded.has(runId)
  row.classList.toggle('open', open)
  const existing = row.querySelector('.tl-body')
  if (open) {
    try {
      const run = await fullRunOf(runId)
      if (run && row.isConnected) insertRunBody(row, run)
    } catch {
      /* 拉不到全文就保持折叠 */
    }
  } else if (existing) {
    existing.remove()
  }
  const chev = row.querySelector('.tl-chev')
  if (chev) chev.classList.toggle('open', open)
}

async function copyRun(row) {
  const runId = row.dataset.run
  let text = ''
  try {
    const run = await fullRunOf(runId)
    text = run.error ? `${run.error}\n\n${run.output}` : run.output
  } catch {
    text = row.querySelector('.run-body')?.textContent ?? ''
  }
  try {
    await navigator.clipboard.writeText(text || '')
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  const btn = row.querySelector('[data-act="copy"] span')
  if (btn) {
    btn.textContent = '已复制'
    setTimeout(() => {
      if (btn.isConnected) btn.textContent = '复制'
    }, 1200)
  }
}

// ---------- 动作 ----------

async function selectTask(id) {
  selectedId = id
  document.body.classList.add('show-detail')
  try {
    await refresh()
  } catch (error) {
    console.error('refresh failed', error)
  }
  render()
  // 打开详情 = 看到结果，清未读（失败时不该继续闪红点）
  try {
    await api('markSeen', { taskId: id })
    snap.unreadByTask[id] = 0
    render({ keepScroll: true })
  } catch {
    /* 标已读失败不影响阅读 */
  }
}

async function openRuns() {
  view = 'runs'
  await refresh()
  render()
  try {
    await api('markSeen', {})
    snap.unreadByTask = {}
  } catch {
    /* 忽略 */
  }
}

function backToList() {
  view = 'tasks'
  editing = null
  formError = ''
  document.body.classList.remove('show-detail')
  render()
}

function openEdit(task) {
  editing = task ? { ...task } : null
  formError = ''
  view = 'edit'
  render()
}

async function runNow(task) {
  try {
    const res = await api('runNow', { id: task.id })
    if (res && res.ok === false) {
      if (res.skipped === 'overlap') formError = ''
    }
  } catch (error) {
    console.error('runNow failed', error)
  }
  await refresh()
  render({ keepScroll: true })
}

async function deleteTask(task) {
  // runCount 只数「跑完的」，拿它当记录条数会少报（跳过的、进行中的都不在内）
  if (!window.confirm(`删除任务「${task.name}」？\n它的全部运行记录也会一并删除，且不可撤销。`)) return
  try {
    await api('deleteTask', { id: task.id })
  } catch (error) {
    console.error('deleteTask failed', error)
    return
  }
  if (selectedId === task.id) {
    selectedId = null
    document.body.classList.remove('show-detail')
  }
  await refresh()
  render()
}

async function toggleTask(task, enabled) {
  try {
    await api('setTaskEnabled', { id: task.id, enabled })
  } catch (error) {
    console.error('setTaskEnabled failed', error)
  }
  await refresh()
  render({ keepScroll: true })
}

// ---------- 刷新与轮询 ----------

async function refresh() {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    const data = await api('snapshot')
    snap = data
    clockSkew = Date.now() - (data.serverNow ?? Date.now())
    if (view === 'tasks' && selectedId) {
      const res = await api('listRuns', { taskId: selectedId, limit: 60 })
      detailRuns = res.runs ?? []
    } else if (view === 'runs') {
      const res = await api('listRuns', {
        limit: 200,
        taskId: taskFilter || undefined,
        status: statusFilter === 'all' ? undefined : statusFilter,
      })
      allRuns = res.runs ?? []
      runsTotal = res.total ?? allRuns.length
      // 运行记录页只为「有结果」的记录拉全文：展开时再 getRun
      for (const run of allRuns) {
        if (expanded.has(run.id) && run.hasOutput) {
          try {
            const full = await api('getRun', { id: run.id })
            run.output = full.run.output
            run.error = full.run.error
          } catch {
            /* 忽略单条失败 */
          }
        }
      }
    }
  } finally {
    refreshInFlight = false
  }
}

/** 重绘判定：数据没变就只更新倒计时，别打断阅读 */
function signature() {
  const tasks = snap.tasks
    .map((t) => [t.id, t.name, t.enabled, t.nextRunAt, t.lastRunAt, t.lastRunOk, t.runCount, t.notifyPolicy, t.prompt.length].join('|'))
    .join(';')
  const active = snap.active.map((a) => `${a.runId}:${a.status}`).join(',')
  const runs = (view === 'runs' ? allRuns : detailRuns)
    .map((r) => [r.id, r.status, r.outputPreview.length, r.seen, expanded.has(r.id) ? 1 : 0].join('|'))
    .join(';')
  return [view, selectedId, tasks, active, runs, JSON.stringify(snap.unreadByTask)].join('‖')
}

function updateUi() {
  const now = nowTs()
  $app.querySelectorAll('[data-elapsed]').forEach((el) => {
    el.textContent = fmtDuration(now - Number(el.dataset.elapsed))
  })
  $app.querySelectorAll('[data-countdown]').forEach((el) => {
    const ts = Number(el.dataset.countdown)
    el.textContent = ts ? describeNext(ts, now) : '不再执行'
  })
}

function pollDelay() {
  return snap.active.length > 0 ? 2_000 : 5_000
}

function schedulePoll() {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    if (view !== 'edit') {
      try {
        await refresh()
        if (signature() !== lastSig) render({ keepScroll: true })
        else updateUi()
      } catch {
        /* 面板短暂失联时静默重试 */
      }
    }
    schedulePoll()
  }, pollDelay())
}

// ---------- 启动 ----------

async function boot() {
  window.parent.postMessage({ type: 'plugin-hello', panelId: 'scheduler:main' }, '*')
  try {
    await refresh()
  } catch (error) {
    // 宿主还没准备好（或握手失败）也要把骨架画出来：空白页比空态更难判断
    console.error('scheduler: initial refresh failed', error)
  }
  render()
  uiTimer = setInterval(updateUi, 500)
  schedulePoll()
}

void boot()
