/* 面板 UI 的回归测试：用 jsdom 起一个假宿主，跑真实的 ui/app.js。
   只驱动 DOM 与宿主消息，不碰 main.mjs——这里守的是「点完按钮界面立刻变」
   这类不刷新问题（v0.6.2 修的就是清空后列表还挂着旧数据）。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installFakeBridge } from '../../../scripts/test-utils/fake-bridge.mjs'

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

/**
 * 监听器隔离。
 *
 * jsdom 的 window / document 在用例之间是同一份，而 `ui/app.js` 与假宿主都是靠
 * `addEventListener` 接事件（message / click / visibilitychange）、没有卸载入口。
 * 每个用例都重新 `loadUi()` + `installHost()`，不清掉旧的就会累积：第 3 个用例发出
 * 一次 `clearTasks`，前两个用例留下的 app 实例与假宿主也会响应，`calls` 里混进
 * 上一个用例的记录（表现为「断言偶尔拿到 done1 而不是 mine」）。
 *
 * 做法：把两个 EventTarget 的 addEventListener 包一层，记下每次注册；
 * afterEach 逐个 removeEventListener。
 */
const listenerTargets = [window, document].map((target) => ({
  target,
  realAdd: target.addEventListener.bind(target),
  realRemove: target.removeEventListener.bind(target),
  added: [],
}))

function isolateListeners() {
  for (const entry of listenerTargets) {
    entry.added = []
    entry.target.addEventListener = (type, handler, opts) => {
      entry.added.push([type, handler, opts])
      entry.realAdd(type, handler, opts)
    }
  }
}

function removeListeners() {
  for (const entry of listenerTargets) {
    for (const [type, handler, opts] of entry.added) {
      entry.realRemove(type, handler, opts)
    }
    entry.added = []
    entry.target.addEventListener = entry.realAdd
  }
}

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
  isolateListeners()
  // 桥由宿主下发，UI 只认 window.pi；这里装一个替身（真桥有独立单测）
  installFakeBridge()
  installHost()
})

afterEach(() => {
  removeListeners()
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

  it('P3-4：ui 与 main 的 normSession/sameSession 等价（两份实现，一份语义）', async () => {
    // iframe 里没有 node 模块，这两份实现物理上合不了；但「面板按会话过滤」和
    // 「托盘按会话归属」必须永远判到一起去，漂了就是「托盘在、面板空」这类鬼病。
    loadUi()
    await waitFor(() => window.__sessionMatch, 'app.js 暴露了会话匹配函数')
    const ui = window.__sessionMatch
    const main = await import('../lib/format.mjs')

    const cases = [
      // [a, b, 期望 sameSession]
      ['/c/w/s-abc.jsonl', '/c/w/s-abc.jsonl', true],
      ['/c/w/s-abc.jsonl/', '/c/w/s-abc.jsonl', true], // 尾斜杠
      ['/C/W/S-ABC.JSONL', '/c/w/s-abc.jsonl', true], // 大小写
      ['c:\\w\\s-abc.jsonl', 'c:/w/s-abc.jsonl', true], // 分隔符
      ['/other/prefix/s-abc.jsonl', '/c/w/s-abc.jsonl', true], // 前缀不同、basename 同
      ['/c/w/s-abc.jsonl', '/c/w/s-other.jsonl', false],
      ['/c/w/s-abc.jsonl', '', false],
      ['', '', false],
      [undefined, '/c/w/s-abc.jsonl', false],
      ['', null, false],
    ]
    for (const [a, b, expected] of cases) {
      expect(ui.sameSession(a, b)).toBe(expected)
      expect(main.sameSession(a, b)).toBe(expected)
    }

    const norm = ['/C/W/S-ABC.JSONL/', 'c:\\w\\s-abc.jsonl', '', null, undefined, '  ']
    for (const p of norm) {
      expect(ui.normSession(p)).toBe(main.normSession(p))
    }
  })
})
