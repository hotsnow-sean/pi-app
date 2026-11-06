/* 提问台 UI：agent 问过什么、你答了什么。数据全部来自 main 侧（window.pi.invoke）。 */

// ---------- 与宿主的通道 ----------
// 桥由宿主下发（pi-plugin://__host/bridge.js）：握手、主题落地、invoke 超时、销毁都在
// 那边，这里不再自己维护 requestId / waiters。缺桥时降级成失败而不是白屏——空面板
// 比一句「桥未加载」难查得多。

const bridge = window.pi || {
  invoke: () => Promise.reject(new Error('插件桥未加载，面板无法读取数据')),
  forwardKey: () => {},
  on: () => () => {},
  settings: {},
  context: {},
}

/** 业务侧对桥的短名字：数据都从插件 main 侧的 methods 来 */
const api = (method, params) => bridge.invoke(method, params)

/** iframe 有焦点时宿主收不到键盘事件：Esc 上抛（回对话），Cmd/Ctrl+K 上抛（命令面板） */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    bridge.forwardKey('Escape')
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    bridge.forwardKey('k', { mod: true })
  }
})

// ---------- 状态 ----------

let records = []
let expanded = new Set()
let signature = ''
let loading = true
let errorText = ''

// ---------- 工具函数 ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))
}

function relTime(ts) {
  const now = Date.now()
  const diff = now - ts
  if (!Number.isFinite(ts)) return ''
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const d = new Date(ts)
  const today = new Date(now)
  const sameDay = d.toDateString() === today.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `今天 ${hh}:${mm}`
  const yesterday = new Date(now - 86_400_000)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hh}:${mm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}

function answerText(answer) {
  if (!answer) return '（未回答）'
  if (answer.kind === 'multi') {
    const selected = Array.isArray(answer.selected) ? answer.selected : []
    return selected.length > 0 ? selected.join('、') : '（未选择）'
  }
  if (answer.kind === 'custom') return answer.answer || '（空）'
  return answer.answer || '（未选择）'
}

function isCancelled(record) {
  return record.cancelled === true || !Array.isArray(record.answers) || record.answers.length === 0
}

// ---------- 数据 ----------

function dataSignature(list) {
  return list.map((r) => `${r.id}:${r.at}:${r.cancelled ? 1 : 0}`).join('|')
}

async function refresh() {
  try {
    const result = await api('listRecords')
    const next = Array.isArray(result?.records) ? result.records : []
    const sig = dataSignature(next)
    errorText = ''
    if (sig !== signature) {
      signature = sig
      records = next
      // 清掉已经不存在的展开项
      const ids = new Set(records.map((r) => r.id))
      expanded = new Set([...expanded].filter((id) => ids.has(id)))
      loading = false
      render()
      return
    }
    if (loading) {
      loading = false
      render()
    }
  } catch (error) {
    loading = false
    errorText = error?.message || String(error)
    render()
  }
}

// ---------- 渲染 ----------

function renderEmpty() {
  return `
    <div class="empty">
      <div class="empty-icon" aria-hidden="true">?</div>
      <div class="empty-title">还没有提问记录</div>
      <p class="empty-text">
        agent 在会话里需要你拍板时，会通过 <code>ask_user</code> 工具弹出一张问卷。
        问过什么、你怎么答的，都会留在这里。
      </p>
      <p class="empty-hint">试试对 agent 说：「先问我要用哪种数据库，再开始改代码。」</p>
    </div>`
}

function renderRecord(record) {
  const open = expanded.has(record.id)
  const cancelled = isCancelled(record)
  const questions = Array.isArray(record.questions) ? record.questions : []
  const first = questions[0]?.question || '（空提问）'
  const extra = questions.length > 1 ? `<span class="count">+${questions.length - 1}</span>` : ''
  const titles = questions.length > 1 ? questions.map((q) => q.header || q.question).filter(Boolean) : []
  const summary = cancelled
    ? '未回答'
    : questions
        .map((q, i) => answerText(record.answers.find((a) => a.questionIndex === i) ?? record.answers[i]))
        .filter(Boolean)
        .join(' · ')

  const rows = questions
    .map((q, i) => {
      const answer = (record.answers || []).find((a) => a.questionIndex === i) ?? (record.answers || [])[i]
      const chips = (q.options || [])
        .map((option) => {
          const chosen = answer && (answer.answer === option.label || (answer.selected || []).includes(option.label))
          return `<span class="chip${chosen ? ' chosen' : ''}">${esc(option.label)}</span>`
        })
        .join('')
      return `
        <div class="qa">
          <div class="q"><span class="q-index">${i + 1}</span>${esc(q.question)}</div>
          <div class="q-options">${chips}</div>
          <div class="a"><span class="a-label">回答</span>${esc(answerText(answer))}</div>
        </div>`
    })
    .join('')

  return `
    <article class="rec${open ? ' open' : ''}${cancelled ? ' cancelled' : ''}" data-id="${esc(record.id)}">
      <header class="rec-head" data-toggle="${esc(record.id)}">
        <span class="dot" aria-hidden="true"></span>
        <span class="rec-title">${esc(first)}</span>
        ${extra}
        ${titles.length > 1 ? `<span class="rec-sub">${esc(titles.slice(0, 3).join(' / '))}</span>` : ''}
        <span class="rec-summary">${esc(summary)}</span>
        <span class="rec-time">${esc(relTime(record.at))}</span>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="m6 9 6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </header>
      ${open ? `<div class="rec-body">${rows}</div>` : ''}
    </article>`
}

function render() {
  const app = document.getElementById('app')
  if (!app) return
  if (loading) {
    app.innerHTML = '<div class="loading">读取提问记录…</div>'
    return
  }
  const count = records.length
  app.innerHTML = `
    <div class="head">
      <div class="head-text">
        <h1>提问台</h1>
        <p class="sub">${count > 0 ? `共 ${count} 次提问` : 'agent 需要你拍板时会在这里留下记录'}</p>
      </div>
      <button class="btn ghost" id="clear" ${count === 0 ? 'disabled' : ''}>清空记录</button>
    </div>
    ${errorText ? `<div class="error">读取失败：${esc(errorText)}</div>` : ''}
    <div class="list">
      ${count === 0 ? renderEmpty() : records.map(renderRecord).join('')}
    </div>
    <footer class="foot">ask 插件 · 模型调用 <code>ask_user</code> 时弹出问卷，答案直接回灌给会话</footer>`
  bind()
}

function bind() {
  document.querySelectorAll('[data-toggle]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-toggle')
      if (expanded.has(id)) expanded.delete(id)
      else expanded.add(id)
      render()
    })
  })
  const clear = document.getElementById('clear')
  clear?.addEventListener('click', async () => {
    if (!window.confirm('清空全部提问记录？这不影响任何任务，只是让列表回到空白。')) return
    clear.disabled = true
    try {
      await api('clearRecords')
      signature = ''
      await refresh()
    } finally {
      clear.disabled = false
    }
  })
}

// 打开页面即读数；之后每 4s 拉一次（agent 提问时列表会自动出现新记录）
refresh()
setInterval(refresh, 4_000)
