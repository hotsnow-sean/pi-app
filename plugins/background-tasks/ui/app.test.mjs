/* 面板 UI 的回归测试：用 jsdom 起一个假宿主，跑真实的 ui/app.js。
   只驱动 DOM 与宿主消息，不碰 main.mjs——这里守的是「点完按钮界面立刻变」
   这类不刷新问题（v0.6.2 修的就是清空后列表还挂着旧数据）。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'app.js'), 'utf8')

const SESSION = 'C:/ws/demo/sessions/aaaa.jsonl'
const OTHER = 'C:/ws/demo/sessions/bbbb.jsonl'

let store = []
let calls = []

function task(id, extra = {}) {
  return {
    id,
    label: `任务 ${id}`,
    command: 'sleep 1',
    cwd: 'C:/ws/demo',
    shell: 'bash',
    status: 'exited',
    exitCode: 0,
    startedAt: Date.now() - 3000,
    endedAt: Date.now() - 1000,
    logPath: `C:/tmp/${id}.log`,
    bytes: 12,
    errBytes: 0,
    report: 'done',
    sessionFile: SESSION,
    ...extra,
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, label) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (check()) return
    await wait(10)
  }
  throw new Error(`超时：${label}`)
}

/** 假宿主：拦下 UI 的 plugin-invoke，按真实 main 的语义回包 */
function installHost() {
  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || data.type !== 'plugin-invoke') return
    const { requestId, method, params } = data
    calls.push({ method, params })
    let result = {}
    if (method === 'listTasks') {
      result = {
        tasks: store.map((t) => ({ ...t })),
        policy: 'long',
        thresholdMs: 15000,
        serverNow: Date.now(),
      }
    } else if (method === 'clearTasks') {
      const ids = new Set((params && params.ids) || [])
      store = store.filter((t) => !ids.has(t.id))
      result = { cleared: [...ids], missing: [], skippedRunning: [] }
    } else if (method === 'readOutput') {
      result = { chunk: '', nextOffset: 0 }
    }
    // 宿主回包是异步的，别在同一个调用栈里 resolve，免得掩盖时序问题
    setTimeout(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'plugin-invoke-result', requestId, ok: true, result },
        }),
      )
    }, 0)
  })
}

function pushContext(sessionFile) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'plugin-context', context: { sessionFile, sessionId: 'aaaa', workspace: 'C:/ws/demo' } },
    }),
  )
}

function rows() {
  return [...document.querySelectorAll('#app .row')].map((el) => el.dataset.id)
}

beforeEach(() => {
  store = []
  calls = []
  document.body.innerHTML = '<div id="app"></div>'
  // 关掉 1.5s 轮询：这一组用例要证明的是「动作之后立刻刷」，靠轮询兜住的刷新
  // 正是要杜绝的现象。所有重绘都由消息 / 点击驱动。
  window.setInterval = () => 0
  installHost()
})

afterEach(() => {
  window.setInterval = setInterval
})

/** 加载 ui/app.js（纯脚本，没有 export，直接在全局跑） */
function loadUi() {
  new Function(source)()
}

describe('后台任务面板 UI', () => {
  it('清空已结束：列表立刻变空，不等轮询', async () => {
    store = [task('t1'), task('t2', { status: 'failed', exitCode: 2, report: 'done' })]
    loadUi()
    pushContext(SESSION)
    await waitFor(() => rows().length === 2, '列表渲染出两条')

    document.querySelector('#app [data-act="clear"]').click()
    await waitFor(() => rows().length === 0, '清空后列表立刻清空')

    const clearCall = calls.find((c) => c.method === 'clearTasks')
    expect(clearCall.params.ids.sort()).toEqual(['t1', 't2'])
    expect(document.querySelector('#app').textContent).toContain('还没有后台任务')
  })

  it('清空已结束：运行中的任务留着，按钮随之消失', async () => {
    store = [
      task('run1', { status: 'running', endedAt: undefined, report: 'pending' }),
      task('done1'),
    ]
    loadUi()
    pushContext(SESSION)
    await waitFor(() => rows().length === 2, '列表渲染出两条')

    document.querySelector('#app [data-act="clear"]').click()
    await waitFor(() => rows().length === 1, '只留下运行中的那条')

    expect(rows()).toEqual(['run1'])
    expect(calls.find((c) => c.method === 'clearTasks').params.ids).toEqual(['done1'])
    // 没有已结束的任务了，清空按钮不该还挂着
    expect(document.querySelector('#app [data-act="clear"]')).toBeNull()
  })

  it('清空只清当前会话，不动别的会话的记录', async () => {
    store = [task('mine'), task('theirs', { sessionFile: OTHER })]
    loadUi()
    pushContext(SESSION)
    await waitFor(() => rows().length === 1, '只显示本会话的一条')

    document.querySelector('#app [data-act="clear"]').click()
    await waitFor(() => rows().length === 0, '本会话清空')

    expect(calls.find((c) => c.method === 'clearTasks').params.ids).toEqual(['mine'])
    expect(store.map((t) => t.id)).toEqual(['theirs'])
  })
})
