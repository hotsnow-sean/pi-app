/* 定时任务插件 UI：列表 / 新建编辑 / 详情历史 三个视图，通过 invoke 桥与 main 侧服务通信。 */

// ---------- invoke 桥 ----------

let invokeSeq = 0
const waiters = new Map()

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data.type === 'plugin-theme') {
    applyTheme(data.vars)
    return
  }
  if (data.type === 'plugin-invoke-result') {
    const waiter = waiters.get(data.requestId)
    if (!waiter) return
    waiters.delete(data.requestId)
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

function api(method, params) {
  const requestId = ++invokeSeq
  window.parent.postMessage({ type: 'plugin-invoke', requestId, method, params }, '*')
  return new Promise((resolve, reject) => waiters.set(requestId, { resolve, reject }))
}

// ---------- 状态 ----------

let tasks = []
let serverNow = Date.now()
let view = { name: 'list' } // list | edit | detail | runs
let tab = 'all' // all | enabled | disabled
let editingTask = null
let detailTaskId = null
let runs = []
let expandedRunId = null // 运行记录页当前展开查看结果的行
let lastRunsSig = '' // 运行记录页轮询去重：数据没变不重绘，避免打断阅读/选中
let refreshTimer = null

const $app = document.getElementById('app')

// ---------- 工具 ----------

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
}

function h(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function fmtCountdown(nextRunAt) {
  if (!nextRunAt) return null
  const diff = nextRunAt - serverNow
  if (diff <= 0) return '即将执行'
  if (diff < 60_000) return `${Math.ceil(diff / 1000)} 秒后执行`
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)} 分钟后执行`
  const next = new Date(nextRunAt)
  const now = new Date(serverNow)
  const sameDay = next.toDateString() === now.toDateString()
  const hm = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `今天 ${hm} 执行`
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (next.toDateString() === tomorrow.toDateString()) return `明天 ${hm} 执行`
  return `${next.getMonth() + 1} 月 ${next.getDate()} 日 ${hm} 执行`
}

function fmtTime(ts) {
  const d = new Date(ts)
  const now = new Date(serverNow)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return `今天 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function fmtRelative(ts) {
  const diff = serverNow - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 顶部导航：定时任务 / 运行记录（对齐 WorkBuddy 的两个一级页签） */
function headNav(active) {
  return `
    <div class="head-nav">
      <button class="nav-item ${active === 'tasks' ? 'active' : ''}" id="nav-tasks">定时任务</button>
      <button class="nav-item ${active === 'runs' ? 'active' : ''}" id="nav-runs">运行记录</button>
    </div>
  `
}

function bindHeadNav() {
  $app.querySelector('#nav-tasks')?.addEventListener('click', () => {
    view = { name: 'list' }
    render()
  })
  $app.querySelector('#nav-runs')?.addEventListener('click', async () => {
    view = { name: 'runs' }
    expandedRunId = null
    await refresh()
    render()
  })
}

// ---------- 渲染 ----------

function render() {
  if (view.name === 'edit') renderEdit()
  else if (view.name === 'detail') renderDetail()
  else if (view.name === 'runs') renderRuns()
  else renderList()
}

function renderList() {
  const filtered = tasks.filter((t) => (tab === 'all' ? true : tab === 'enabled' ? t.enabled : !t.enabled))
  const count = (f) => tasks.filter(f).length
  const html = `
    <div class="head">
      ${headNav('tasks')}
      <button class="btn" id="btn-new">＋ 新建</button>
    </div>
    <div class="tabs">
      <button class="tab ${tab === 'all' ? 'active' : ''}" data-tab="all">全部 (${count(() => true)})</button>
      <button class="tab ${tab === 'enabled' ? 'active' : ''}" data-tab="enabled">已启用 (${count((t) => t.enabled)})</button>
      <button class="tab ${tab === 'disabled' ? 'active' : ''}" data-tab="disabled">已停用 (${count((t) => !t.enabled)})</button>
    </div>
    <div id="task-list"></div>
  `
  $app.replaceChildren(h(html))
  bindHeadNav()
  const list = $app.querySelector('#task-list')
  if (filtered.length === 0) {
    list.append(h(`<div class="empty">还没有定时任务<br/>点击右上角「新建」创建一个</div>`))
  }
  for (const t of filtered) {
    const countdown = t.enabled ? fmtCountdown(t.nextRunAt) : null
    const lastRun = t.lastRunAt
      ? `<span class="last-run ${t.lastRunOk === false ? 'err' : 'ok'}">${t.lastRunOk === false ? '上次失败' : '上次成功'} · ${fmtRelative(t.lastRunAt)}</span>`
      : ''
    const card = h(`
      <div class="card" data-id="${t.id}">
        <div class="card-head">
          <span class="card-title" title="${esc(t.name)}">${esc(t.name)}</span>
          <button class="icon-btn act-run" title="立即运行">${ICONS.play}</button>
          <button class="icon-btn act-history" title="运行记录">${ICONS.clock}</button>
          <button class="icon-btn act-edit" title="编辑">${ICONS.edit}</button>
          <button class="icon-btn act-delete" title="删除">${ICONS.trash}</button>
          <label class="switch"><input type="checkbox" class="act-toggle" ${t.enabled ? 'checked' : ''}/><span class="track"></span></label>
        </div>
        <div class="card-desc">${esc(t.prompt) || '<span style="opacity:.5">（无提示词）</span>'}</div>
        <div class="card-foot">
          <span>${esc(t.scheduleLabel)}</span>
          ${lastRun}
          ${t.enabled
            ? countdown
              ? `<span class="next">${esc(countdown)}</span>`
              : `<span class="expired">已到期或不可调度</span>`
            : `<span class="expired">已停用</span>`}
        </div>
      </div>
    `)
    card.querySelector('.card-title').addEventListener('click', () => openDetail(t.id))
    card.querySelector('.act-history').addEventListener('click', () => openDetail(t.id))
    card.querySelector('.act-run').addEventListener('click', () => runNow(t))
    card.querySelector('.act-edit').addEventListener('click', () => openEdit(t))
    card.querySelector('.act-delete').addEventListener('click', () => deleteTask(t))
    card.querySelector('.act-toggle').addEventListener('change', (e) => toggleTask(t, e.target.checked))
    list.append(card)
  }
  $app.querySelectorAll('.tab').forEach((el) =>
    el.addEventListener('click', () => {
      tab = el.dataset.tab
      render()
    }),
  )
  $app.querySelector('#btn-new').addEventListener('click', () => openEdit(null))
}

function renderEdit() {
  const t = editingTask ?? {}
  const s = t.schedule ?? { kind: 'daily', time: '09:00', weekday: 1, day: 1 }
  const kind = s.kind || 'daily'
  const needTime = kind === 'daily' || kind === 'weekly' || kind === 'monthly'
  // 间隔任务的单位：能被 60 整除且 ≥60 用小时，否则用分钟
  const ivMins = Math.max(1, Number(s.everyMinutes) || 60)
  const ivUnit = ivMins >= 60 && ivMins % 60 === 0 ? 'h' : 'm'
  const ivValue = ivUnit === 'h' ? ivMins / 60 : ivMins
  const onceDefault = toLocalInput(new Date(Date.now() + 5 * 60_000).toISOString())
  const html = `
    <div class="head">
      <h1>${t.id ? '编辑定时任务' : '新建定时任务'}</h1>
    </div>
    <div class="card">
      <div class="field">
        <label>任务名称</label>
        <input type="text" id="f-name" placeholder="输入任务名称" value="${esc(t.name ?? '')}" maxlength="60"/>
      </div>
      <div class="field">
        <label>提示词（到点交给 agent 执行）</label>
        <textarea id="f-prompt" placeholder="例如：检查一下今天的工作安排，并生成一份简报">${esc(t.prompt ?? '')}</textarea>
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
        ${needTime ? `
        <div class="field" id="f-time-field">
          <label>时间</label>
          <input type="time" id="f-time" value="${esc(s.time ?? '09:00')}"/>
        </div>` : ''}
      </div>
      <div class="row" id="f-weekday-row" style="display:${kind === 'weekly' ? 'flex' : 'none'}">
        <div class="field">
          <label>星期</label>
          <select id="f-weekday">
            ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((d, i) => `<option value="${i}" ${Number(s.weekday) === i ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="row" id="f-day-row" style="display:${kind === 'monthly' ? 'flex' : 'none'}">
        <div class="field">
          <label>几号（无该日时取当月最后一天）</label>
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
          <label>有效期至（留空 = 长期有效）</label>
          <input type="date" id="f-valid-until" value="${esc(t.validUntil ?? '')}"/>
        </div>
      </div>
      <div class="field">
        <label>工作空间目录（留空 = 用户主目录）</label>
        <input type="text" id="f-cwd" placeholder="例如 C:\\Users\\me\\projects\\demo" value="${esc(t.cwd ?? '')}"/>
      </div>
      <div class="form-actions">
        <button class="btn ghost" id="btn-cancel">取消</button>
        <button class="btn" id="btn-save">确定</button>
      </div>
    </div>
  `
  $app.replaceChildren(h(html))
  $app.querySelector('#f-kind').addEventListener('change', (e) => {
    const k = e.target.value
    const timeField = $app.querySelector('#f-time-field')
    if (timeField) timeField.style.display = ['daily', 'weekly', 'monthly'].includes(k) ? '' : 'none'
    $app.querySelector('#f-weekday-row').style.display = k === 'weekly' ? 'flex' : 'none'
    $app.querySelector('#f-day-row').style.display = k === 'monthly' ? 'flex' : 'none'
    $app.querySelector('#f-once-row').style.display = k === 'once' ? 'flex' : 'none'
    $app.querySelector('#f-interval-row').style.display = k === 'interval' ? 'flex' : 'none'
  })
  $app.querySelector('#btn-cancel').addEventListener('click', () => {
    view = { name: 'list' }
    render()
  })
  $app.querySelector('#btn-save').addEventListener('click', saveTask)
}

function toLocalInput(iso) {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function saveTask() {
  const kind = $app.querySelector('#f-kind').value
  const atInput = $app.querySelector('#f-at')?.value
  const ivValue = Number($app.querySelector('#f-interval-value')?.value)
  const ivUnit = $app.querySelector('#f-interval-unit')?.value ?? 'm'
  const task = {
    id: editingTask?.id,
    name: $app.querySelector('#f-name').value.trim(),
    prompt: $app.querySelector('#f-prompt').value,
    schedule: {
      kind,
      // 时间只对每天/每周/每月有意义
      time: ['daily', 'weekly', 'monthly'].includes(kind) ? ($app.querySelector('#f-time')?.value || '09:00') : undefined,
      weekday: Number($app.querySelector('#f-weekday')?.value ?? 1),
      day: Number($app.querySelector('#f-day')?.value ?? 1),
      at: kind === 'once' ? new Date(atInput || Date.now() + 5 * 60_000).toISOString() : undefined,
      everyMinutes: kind === 'interval' ? Math.max(1, Math.round(Number.isFinite(ivValue) && ivValue > 0 ? ivValue : 30) * (ivUnit === 'h' ? 60 : 1)) : undefined,
    },
    validUntil: $app.querySelector('#f-valid-until').value || null,
    cwd: $app.querySelector('#f-cwd').value.trim(),
    enabled: true,
  }
  if (!task.name) task.name = '未命名任务'
  await api('saveTask', { task })
  editingTask = null
  view = { name: 'list' }
  await refresh()
  render()
}

function renderDetail() {
  const t = tasks.find((x) => x.id === detailTaskId)
  if (!t) {
    view = { name: 'list' }
    render()
    return
  }
  const countdown = t.enabled ? fmtCountdown(t.nextRunAt) : null
  const html = `
    <div class="head">
      <div>
        <h1 style="display:inline">${esc(t.name)}</h1>
        <span style="color:var(--text-2);margin-left:8px">${esc(t.scheduleLabel)}</span>
      </div>
      <button class="back-link" id="btn-back">← 返回列表</button>
    </div>
    <div class="card">
      <div class="card-desc" style="margin:0">${esc(t.prompt) || '<span style="opacity:.5">（无提示词）</span>'}</div>
      <div class="card-foot" style="margin-top:10px">
        <span>${t.enabled ? esc(countdown ?? '已到期或不可调度') : '已停用'}</span>
        ${t.lastRunAt ? `<span>上次：${fmtTime(t.lastRunAt)} ${t.lastRunOk === true ? '· 成功' : t.lastRunOk === false ? '· 失败' : ''}</span>` : ''}
      </div>
    </div>
    <h2 style="font-size:13px;font-weight:600;margin:14px 0 8px">执行历史</h2>
    <div id="run-list"></div>
  `
  $app.replaceChildren(h(html))
  $app.querySelector('#btn-back').addEventListener('click', () => {
    view = { name: 'list' }
    render()
  })
  const list = $app.querySelector('#run-list')
  if (runs.length === 0) list.append(h(`<div class="empty">还没有执行记录</div>`))
  for (const r of runs) {
    const dot = r.ok ? 'ok' : 'err'
    const item = h(`
      <div class="run">
        <div class="run-head">
          <span class="dot ${dot}"></span>
          <span>${fmtTime(r.startedAt)}</span>
          <span>· 用时 ${fmtDuration(r.durationMs)}</span>
          ${r.missed ? '<span>· 错过补跑</span>' : ''}
        </div>
        ${r.error ? `<div class="run-error">${esc(r.error)}</div>` : ''}
        ${r.resultText ? `<div class="run-body">${esc(r.resultText)}</div>` : ''}
      </div>
    `)
    list.append(item)
  }
}

/** 运行记录总览（对齐 WorkBuddy：全部任务的执行流水，点行展开看结果） */
function renderRuns() {
  const html = `
    <div class="head">
      ${headNav('runs')}
      <span></span>
    </div>
    <div id="runs-list"></div>
  `
  $app.replaceChildren(h(html))
  bindHeadNav()
  const list = $app.querySelector('#runs-list')
  if (runs.length === 0) {
    list.append(h(`<div class="empty">还没有运行记录<br/>任务到点执行或手动运行后，记录会出现在这里</div>`))
    return
  }
  for (const r of runs) {
    const expanded = expandedRunId === r.id
    const status = r.ok ? '<span class="run-status ok">成功</span>' : '<span class="run-status err">失败</span>'
    const row = h(`
      <div class="run-row" data-id="${r.id}">
        <div class="run-line">
          <span class="run-status-dot ${r.ok ? 'ok' : 'err'}"></span>
          <span class="run-name" title="${esc(r.taskName)}">${esc(r.taskName)}</span>
          ${status}
          <span class="run-when">${fmtRelative(r.startedAt)}</span>
          <span class="run-dur">${fmtDuration(r.durationMs)}</span>
          ${r.missed ? '<span class="run-missed">补跑</span>' : ''}
          <button class="icon-btn act-del-run" title="删除记录">${ICONS.trash}</button>
        </div>
        ${expanded
          ? `<div class="run-result">${r.resultText ? esc(r.resultText) : r.error ? esc(r.error) : '<span style="opacity:.5">（无输出）</span>'}</div>`
          : ''}
      </div>
    `)
    row.querySelector('.run-line').addEventListener('click', (e) => {
      if (e.target.closest('.act-del-run')) return
      expandedRunId = expanded ? null : r.id
      render()
    })
    row.querySelector('.act-del-run').addEventListener('click', async () => {
      await api('deleteRun', { id: r.id })
      await refresh()
      render()
    })
    list.append(row)
  }
}

// ---------- 动作 ----------

async function refresh() {
  const data = await api('listTasks')
  tasks = data.tasks ?? []
  serverNow = data.serverNow ?? Date.now()
  if (view.name === 'detail' && detailTaskId) {
    const data2 = await api('listRuns', { taskId: detailTaskId, limit: 50 })
    runs = data2.runs ?? []
  } else if (view.name === 'runs') {
    const data2 = await api('listRuns', { limit: 200 })
    runs = data2.runs ?? []
  }
}

function runsSignature() {
  return JSON.stringify(runs.map((r) => [r.id, r.ok, r.resultText.length]))
}

function openEdit(task) {
  editingTask = task ? { ...task } : null
  view = { name: 'edit' }
  render()
}

async function openDetail(id) {
  detailTaskId = id
  view = { name: 'detail' }
  await refresh()
  render()
}

async function runNow(t) {
  await api('runNow', { id: t.id })
  await refresh()
  if (view.name === 'list') render()
}

async function deleteTask(t) {
  if (!window.confirm(`删除任务「${t.name}」？此操作不可撤销。`)) return
  await api('deleteTask', { id: t.id })
  await refresh()
  render()
}

async function toggleTask(t, enabled) {
  await api('setTaskEnabled', { id: t.id, enabled })
  await refresh()
  render()
}

// ---------- 启动 ----------

async function boot() {
  window.parent.postMessage({ type: 'plugin-hello', panelId: 'scheduler:tasks' }, '*')
  await refresh()
  render()
  // 5s 轮询：倒计时推进 + 立即运行 / 触发执行后的状态同步
  refreshTimer = setInterval(async () => {
    try {
      await refresh()
      if (view.name === 'runs') {
        // 数据没变化就不重绘，避免阅读结果时每 5 秒被打断
        const sig = runsSignature()
        if (sig !== lastRunsSig) {
          lastRunsSig = sig
          render()
        }
        return
      }
      if (view.name === 'list' || view.name === 'detail') render()
    } catch {
      /* 面板短暂失联时静默重试 */
    }
  }, 5_000)
}

void boot()
