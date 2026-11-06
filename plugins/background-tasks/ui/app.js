/* 后台任务插件 UI：列表 / 展开看命令与输出 / 停止 / 重新回报。
   数据通过 invoke 桥拉取，1.5 秒轮询一次（只在页面可见时）。 */

// ---------- invoke 桥 ----------

let invokeSeq = 0
const waiters = new Map()
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
    if (data.ok) waiter.resolve(data.result)
    else waiter.reject(new Error(data.error || 'invoke failed'))
  }
})

/** 主题：vars 是 `--pi-*` → 完整 CSS 值的映射，落到 documentElement 行内样式 */
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

/** iframe 里的 keydown 上不了宿主：Esc / Cmd-K 主动转发（契约见 plugin-panel-frame） */
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (state.open) {
      state.open = null
      rebuild()
      return
    }
    window.parent.postMessage({ type: 'plugin-key', key: 'Escape' }, '*')
    return
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    window.parent.postMessage({ type: 'plugin-key', key: 'k', mod: true }, '*')
  }
})

// ---------- 状态 ----------

const state = {
  tasks: [],
  open: null,
  /** `${id}:${stream}` → { offset, text }：每个流独立的增量读游标 */
  outputs: new Map(),
  /** id → 'out' | 'err'：这个任务当前看的是哪个流 */
  streams: new Map(),
  policy: 'long',
  thresholdMs: 15000,
  serverNow: Date.now(),
  /** main 侧 focus.seq：会话条点任务时递增，变了就把那一条展开 */
  focusSeq: 0,
  /** 待滚动到可见处的任务 id（本轮重建之后执行一次） */
  pendingScroll: null,
}
let lastSignature = ''
let lastError = ''
let busy = false

const root = document.getElementById('app')

// ---------- 格式化 ----------

const POLICY_TEXT = {
  all: '每个任务都回报',
  long: '只回报长任务与失败的',
  failures: '只回报失败的',
  off: '不回报',
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m} 分 ${s} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function statusText(task) {
  if (task.status === 'running') return `已运行 ${fmtDuration(state.serverNow - task.startedAt)}`
  if (task.status === 'exited') return `已完成 · ${fmtDuration((task.endedAt || task.startedAt) - task.startedAt)}`
  if (task.status === 'failed') return `退出码 ${task.exitCode === null || task.exitCode === undefined ? '?' : task.exitCode}`
  if (task.status === 'stopped') {
    if (task.stopReason === 'log-limit') return '已停止（日志超限）'
    if (task.stopReason === 'timeout') return '已超时终止'
    return '已停止'
  }
  if (task.status === 'lost') return '状态丢失'
  return task.status
}

/** 这个任务有没有独立的 stderr 可看（旧任务只有合并日志） */
function hasErr(task) {
  return !!task.errPath && ((task.errBytes || 0) > 0 || task.status === 'failed' || task.stopReason === 'timeout')
}

function streamOf(id) {
  return state.streams.get(id) === 'err' ? 'err' : 'out'
}

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------- 渲染 ----------

const ICON_STOP =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>'
const ICON_CHEV =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'

function reportBadge(task) {
  if (task.status === 'running') return ''
  if (task.report === 'queued') return '<span class="report-badge sent">已投递</span>'
  if (task.report === 'failed') return '<span class="report-badge failed">回报失败</span>'
  // 为什么没回报要能一眼看到：规则不透明比不回报更让人困惑
  if (task.report === 'skipped' || task.report === 'suppressed')
    return `<span class="report-badge" title="${esc(task.reportNote || '按当前回报策略跳过')}">未回报</span>`
  if (task.report === 'pending') return '<span class="report-badge">待回报</span>'
  return ''
}

function rowHtml(task) {
  const running = task.status === 'running'
  const open = state.open === task.id
  const metaClass = task.status === 'failed' ? 'row-meta failed' : 'row-meta'
  const size = fmtBytes(task.bytes)
  const errSize = fmtBytes(task.errBytes)
  const stream = streamOf(task.id)
  const tabs = hasErr(task)
    ? `<div class="streams">
        <button class="stream-tab${stream === 'out' ? ' active' : ''}" data-act="stream" data-stream="out" data-id="${esc(task.id)}">stdout</button>
        <button class="stream-tab err${stream === 'err' ? ' active' : ''}" data-act="stream" data-stream="err" data-id="${esc(task.id)}">stderr${errSize ? `<span class="n">${errSize}</span>` : ''}</button>
      </div>`
    : ''
  return `
  <div class="row${open ? ' open' : ''}" data-id="${esc(task.id)}">
    <div class="row-head">
      <span class="dot ${esc(task.status)}"></span>
      <span class="row-title" title="${esc(task.command)}">${esc(task.label)}</span>
      <span class="${metaClass}" data-field="meta">${esc(statusText(task))}</span>
      ${running ? `<button class="icon-btn danger" data-act="stop" data-id="${esc(task.id)}" title="停止">${ICON_STOP}</button>` : ''}
      <span class="chev">${ICON_CHEV}</span>
    </div>
    <div class="row-body">
      <div class="cmd" title="${esc(`${task.shell || ''} · ${task.cwd}`)}">${esc(task.command)}</div>
      ${tabs}
      <pre class="out${stream === 'err' ? ' err' : ''}" data-out="${esc(task.id)}"></pre>
      <div class="foot">
        ${reportBadge(task)}
        ${task.timeoutMs ? `<span class="report-badge">超时 ${fmtDuration(task.timeoutMs)}</span>` : ''}
        <span class="path" title="${esc(task.logPath)}">${esc(task.logPath)}${size ? ` · ${size}` : ''}</span>
        ${task.report === 'failed' || task.report === 'skipped' || task.report === 'suppressed' ? `<button class="link-btn" data-act="retry" data-id="${esc(task.id)}">重新回报</button>` : ''}
        ${running ? `<button class="link-btn" data-act="stop" data-id="${esc(task.id)}">停止</button>` : `<button class="link-btn" data-act="rerun" data-id="${esc(task.id)}">重跑</button><button class="link-btn" data-act="remove" data-id="${esc(task.id)}">删除记录</button>`}
      </div>
    </div>
  </div>`
}

function rebuild() {
  const counts = state.tasks.filter((t) => t.status === 'running').length
  const finished = state.tasks.length - counts
  const head = `
  <div class="head">
    <h1>后台任务</h1>
    <span class="count" data-field="count">${counts ? `${counts} 个运行中` : `${state.tasks.length} 条记录`}</span>
    <span class="spacer"></span>
    ${finished ? '<button class="ghost-btn" data-act="clear">清空已结束</button>' : ''}
    <span class="policy" data-field="policy">完成后：${esc(POLICY_TEXT[state.policy] || state.policy)}</span>
  </div>`
  if (!state.tasks.length) {
    const err = lastError
      ? `<div class="empty" style="border-color:var(--err);color:var(--err)"><strong>读不到任务列表</strong>${esc(lastError)}</div>`
      : '<div class="empty"><strong>还没有后台任务</strong>让 agent 跑个长命令，它会出现在这里；跑完还能自己把结果说完。</div>'
    root.innerHTML = `${head}${err}`
    lastSignature = ''
    return
  }
  root.innerHTML = `${head}<div class="list">${state.tasks.map(rowHtml).join('')}</div>`
  if (state.open) paintOutput(state.open)
}

/** 只更新文本类字段，避免整表重建导致展开态/滚动跳动 */
function updateMeta() {
  const running = state.tasks.filter((t) => t.status === 'running').length
  const countEl = root.querySelector('[data-field="count"]')
  if (countEl) countEl.textContent = running ? `${running} 个运行中` : `${state.tasks.length} 条记录`
  const policyEl = root.querySelector('[data-field="policy"]')
  if (policyEl) policyEl.textContent = `完成后：${POLICY_TEXT[state.policy] || state.policy}`
  for (const task of state.tasks) {
    const row = root.querySelector(`.row[data-id="${task.id}"]`)
    if (!row) continue
    const meta = row.querySelector('[data-field="meta"]')
    if (meta) {
      meta.textContent = statusText(task)
      meta.className = task.status === 'failed' ? 'row-meta failed' : 'row-meta'
    }
  }
}

function paintOutput(id) {
  const pre = root.querySelector(`pre[data-out="${id}"]`)
  if (!pre) return
  const stream = streamOf(id)
  const entry = state.outputs.get(`${id}:${stream}`)
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40
  pre.classList.toggle('err', stream === 'err')
  pre.textContent = entry?.text || ''
  if (atBottom) pre.scrollTop = pre.scrollHeight
}

// ---------- 数据 ----------

async function pullOutput(id) {
  const stream = streamOf(id)
  const key = `${id}:${stream}`
  const cur = state.outputs.get(key)
  const res = await api('readOutput', {
    id,
    stream,
    offset: cur && Number.isFinite(cur.offset) ? cur.offset : undefined,
    tailLines: 200,
  })
  const chunk = String(res.chunk || '')
  if (!cur || !Number.isFinite(cur.offset)) {
    state.outputs.set(key, { offset: res.nextOffset, text: chunk })
  } else if (chunk) {
    // 只保留最后 500 行：日志文件才是真相，界面不做无限回滚
    const merged = `${cur.text}${chunk}`.split('\n').slice(-500).join('\n')
    state.outputs.set(key, { offset: res.nextOffset, text: merged })
  } else if (res.nextOffset !== cur.offset) {
    state.outputs.set(key, { ...cur, offset: res.nextOffset })
  }
  paintOutput(id)
}

async function tick() {
  if (busy) return
  busy = true
  try {
    const res = await api('listTasks')
    lastError = ''
    state.tasks = Array.isArray(res.tasks) ? res.tasks : []
    state.policy = String(res.policy || 'long')
    state.thresholdMs = Number(res.thresholdMs) || 15000
    state.serverNow = Number(res.serverNow) || Date.now()
    // 会话条点了某条任务：seq 变了就把那一条展开并滚到可见处。
    // 用 seq 而不是「是否等于当前展开项」——用户可能刚手动收起，再点一次还得能翻回来。
    const focus = res.focus && typeof res.focus === 'object' ? res.focus : null
    const focusHit = !!(focus && focus.id && Number(focus.seq) !== state.focusSeq)
    if (focusHit) {
      state.focusSeq = Number(focus.seq)
      if (state.tasks.some((t) => t.id === focus.id)) {
        state.open = focus.id
        if (!state.streams.has(focus.id)) state.streams.set(focus.id, 'out')
        lastSignature = ''
        state.pendingScroll = focus.id
      }
    }
    const signature = state.tasks.map((t) => `${t.id}:${t.status}:${t.report}`).join(',')
    if (signature !== lastSignature) {
      lastSignature = signature
      if (state.open && !state.tasks.some((t) => t.id === state.open)) state.open = null
      rebuild()
    } else {
      updateMeta()
    }
    if (state.open) await pullOutput(state.open)
    if (state.pendingScroll) {
      const el = root.querySelector(`.row[data-id="${state.pendingScroll}"]`)
      state.pendingScroll = null
      el?.scrollIntoView({ block: 'nearest' })
    }
  } catch (error) {
    // 宿主重载 / invoke 失败：把原因摆到界面上，别让面板空着还不说话
    const message = String(error?.message || error)
    if (message !== lastError) {
      lastError = message
      rebuild()
    }
  } finally {
    busy = false
  }
}

// ---------- 交互 ----------

document.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-act]')
  if (action) {
    event.stopPropagation()
    const id = action.dataset.id
    if (action.dataset.act === 'stop') {
      try {
        await api('stopTask', { id })
      } catch (error) {
        window.alert(String(error?.message || error))
      }
      await tick()
      return
    }
    if (action.dataset.act === 'retry') {
      try {
        await api('retryReport', { id })
      } catch (error) {
        window.alert(String(error?.message || error))
      }
      await tick()
      return
    }
    if (action.dataset.act === 'remove') {
      try {
        await api('removeTask', { id })
      } catch (error) {
        window.alert(String(error?.message || error))
      }
      state.outputs.delete(`${id}:out`)
      state.outputs.delete(`${id}:err`)
      state.streams.delete(id)
      lastSignature = ''
      await tick()
      return
    }
    if (action.dataset.act === 'rerun') {
      try {
        const res = await api('rerunTask', { id })
        state.open = res.id
        lastSignature = ''
        await tick()
        await pullOutput(res.id)
      } catch (error) {
        window.alert(String(error?.message || error))
      }
      return
    }
    if (action.dataset.act === 'clear') {
      try {
        await api('clearTasks', {})
      } catch (error) {
        window.alert(String(error?.message || error))
      }
      state.outputs.clear()
      state.streams.clear()
      lastSignature = ''
      await tick()
      return
    }
    if (action.dataset.act === 'stream') {
      const stream = action.dataset.stream === 'err' ? 'err' : 'out'
      state.streams.set(id, stream)
      rebuild()
      await pullOutput(id)
      return
    }
  }

  const head = event.target.closest('.row-head')
  if (!head) return
  const id = head.closest('.row')?.dataset.id
  if (!id) return
  if (state.open === id) {
    state.open = null
    rebuild()
    return
  }
  state.open = id
  if (!state.streams.has(id)) state.streams.set(id, 'out')
  rebuild()
  await pullOutput(id)
})

// 页面可见时才轮询：切到别的视图等于没人看，白白占 CPU
let timer = setInterval(() => {
  if (document.visibilityState === 'visible') void tick()
}, 1500)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void tick()
})
window.addEventListener('beforeunload', () => clearInterval(timer))

void tick()
