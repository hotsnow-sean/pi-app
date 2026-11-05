/* 后台任务会话条。
 *
 * 它是「这个会话后台在干什么」的常驻答案，贴在对话区顶部：
 *   - 没任务 → 高度 0，完全消失，一个字都不占
 *   - 有任务 → 一行摘要，点开是一列任务，再点某条 → 右栏看命令与实时输出
 *
 * 宿主对内容一无所知，只认两件事：`plugin-content-height`（报多高）和
 * `plugin-open-panel`（把右栏面板亮出来）。所以这里自己判断归属、自己排序、自己收放。
 */

const PANEL_ID = 'plugin:background-tasks:tasks'
const POLL_MS = 2000
/** 折叠行高度，与 session-bar.css 的 .summary 一致 */
const H_SUMMARY = 34
/** 单行任务高度 */
const H_ROW = 28
/** 展开区的上下留白 */
const H_PAD = 6
/** 展开后最多撑到这么高，再高就内部滚动 */
const H_MAX = 268
/** 折叠态最多露几行，多的收进「还有 N 条」 */
const MAX_ROWS = 12

const ICON_CLOCK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/></svg>'
const ICON_CHEV =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'
const ICON_STOP =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'

const els = {
  bar: document.getElementById('bar'),
  summary: document.getElementById('summary'),
  ico: document.getElementById('ico'),
  text: document.getElementById('text'),
  chev: document.getElementById('chev'),
  rows: document.getElementById('rows'),
}

const state = {
  expanded: false,
  /** 当前会话路径，由宿主推的 plugin-context 给 */
  sessionFile: '',
  data: null,
  error: '',
}

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
  if (data.type === 'plugin-context') {
    const next = String(data.context?.sessionFile || '')
    if (next !== state.sessionFile) {
      state.sessionFile = next
      // 换了会话就是换了一批任务：立刻重拉，别让旧会话的任务多显示两秒
      void tick(true)
    }
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

function post(message) {
  window.parent.postMessage(message, '*')
}

// ---------- 格式化 ----------

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  if (m < 60) return `${m}m${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function rowMeta(task, now) {
  if (task.status === 'running') return fmtDuration(now - task.startedAt)
  if (task.status === 'exited') return fmtDuration((task.endedAt || task.startedAt) - task.startedAt)
  if (task.status === 'failed') return `退出码 ${task.exitCode ?? '?'}`
  if (task.status === 'stopped') {
    if (task.stopReason === 'timeout') return '超时'
    if (task.stopReason === 'log-limit') return '日志超限'
    return '已停止'
  }
  if (task.status === 'lost') return '状态丢失'
  return task.status
}

// ---------- 渲染 ----------

/** 与渲染保持一致的可见行：运行中的排前面，再按开始时间倒序 */
function orderedTasks(data) {
  const mine = Array.isArray(data?.mine) ? data.mine.slice() : []
  const rank = (t) => (t.status === 'running' ? 0 : 1)
  return mine.sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt)
}

function summaryText(data) {
  const mine = data.mine || []
  const running = data.runningMine || 0
  const finished = mine.length - running
  if (running && finished) return `<b>${running}</b> 个任务在跑 · ${finished} 个已完成`
  if (running) return `<b>${running}</b> 个任务在跑`
  if (finished) return `${finished} 个任务已完成`
  if (data.runningOthers) return `其他会话有 <b>${data.runningOthers}</b> 个任务在运行`
  return ''
}

function render() {
  const data = state.data
  const text = data ? summaryText(data) : ''
  // 没本会话任务、也没有别处在跑的：整条收起（高度 0），一个字都不占
  if (!text) {
    els.bar.hidden = true
    els.bar.classList.remove('expanded')
    state.expanded = false
    applyHeight(0)
    return
  }
  els.bar.hidden = false
  els.text.innerHTML = state.error ? esc(state.error) : text
  els.ico.innerHTML = ICON_CLOCK
  els.chev.innerHTML = ICON_CHEV

  const tasks = data.mine?.length ? orderedTasks(data) : []
  const canExpand = tasks.length > 0
  els.bar.classList.toggle('expanded', state.expanded && canExpand)
  els.bar.classList.toggle('collapsed', !state.expanded || !canExpand)

  if (state.expanded && canExpand) {
    const now = Number(data.serverNow) || Date.now()
    const shown = tasks.slice(0, MAX_ROWS)
    const rest = tasks.length - shown.length
    els.rows.innerHTML =
      shown
        .map((task) => {
          const running = task.status === 'running'
          const metaClass = task.status === 'failed' ? 'meta failed' : 'meta'
          return `<div class="row" data-id="${esc(task.id)}" title="${esc(task.label)}">
            <span class="dot ${esc(task.status)}"></span>
            <span class="label">${esc(task.label)}</span>
            <span class="${metaClass}">${esc(rowMeta(task, now))}</span>
            ${running ? `<button class="stop" data-act="stop" data-id="${esc(task.id)}" title="停止">${ICON_STOP}</button>` : ''}
          </div>`
        })
        .join('') + (rest > 0 ? `<div class="row more">还有 ${rest} 条…</div>` : '')
  } else {
    els.rows.innerHTML = ''
  }
  applyHeight(heightOf(canExpand ? tasks.length : 0))
}

function heightOf(rowCount) {
  if (!rowCount) return H_SUMMARY
  if (!state.expanded) return H_SUMMARY
  const shown = Math.min(rowCount, MAX_ROWS) + (rowCount > MAX_ROWS ? 1 : 0)
  return Math.min(H_SUMMARY + shown * H_ROW + H_PAD, H_MAX)
}

/**
 * 高度由这里算、由这里报：宿主只管把容器撑到这么高。
 * 报 0 时容器塌缩但 iframe 不卸载——所以「有任务了」随时能再撑开。
 */
function applyHeight(height) {
  const h = Math.max(0, Math.round(height))
  document.body.style.height = `${h}px`
  post({ type: 'plugin-content-height', height: h })
}

// ---------- 数据 ----------

let busy = false

async function tick(force = false) {
  if (busy && !force) return
  busy = true
  try {
    const data = await api('sessionBarState', { sessionFile: state.sessionFile })
    state.error = ''
    const before = JSON.stringify(state.data)
    state.data = data
    // 内容没变就不重绘：否则每秒重建 DOM，展开态里选中的文本会被清掉
    if (before !== JSON.stringify(data) || force) render()
  } catch (error) {
    // 宿主重载/插件停用时 invoke 会失败：显示一行提示，别让条子凭空消失
    const message = String(error?.message || error)
    if (message !== state.error) {
      state.error = message
      render()
    }
  } finally {
    busy = false
  }
}

// ---------- 交互 ----------

async function openTask(id) {
  try {
    await api('focusTask', { id })
  } catch {
    /* 任务刚被删掉：右栏仍会打开，只是定位不到，不算错 */
  }
  post({ type: 'plugin-open-panel', panelId: PANEL_ID })
  state.expanded = false
  render()
}

els.summary.addEventListener('click', () => {
  const hasMine = (state.data?.mine?.length || 0) > 0
  if (!hasMine) {
    // 「其他会话有任务」这种摘要没有行可展开，点它就是去看右栏
    post({ type: 'plugin-open-panel', panelId: PANEL_ID })
    return
  }
  state.expanded = !state.expanded
  render()
})

els.rows.addEventListener('click', (event) => {
  const stopBtn = event.target.closest('[data-act="stop"]')
  if (stopBtn) {
    event.stopPropagation()
    const id = stopBtn.dataset.id
    void (async () => {
      try {
        await api('stopTask', { id })
      } catch (error) {
        // 停止失败要说出来：静默失败会让用户以为任务已停
        state.error = String(error?.message || error)
      }
      await tick(true)
    })()
    return
  }
  const row = event.target.closest('.row[data-id]')
  if (!row) return
  void openTask(row.dataset.id)
})

// 页面不可见时不轮询：切到中央视图或别的应用等于没人看
setInterval(() => {
  if (document.visibilityState === 'visible') void tick()
}, POLL_MS)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void tick(true)
})

post({ type: 'plugin-hello' })
void tick(true)
