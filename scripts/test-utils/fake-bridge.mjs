/**
 * 面板 UI 测试用的桥替身。
 *
 * 真的桥（`pi-plugin://__host/bridge.js`）由 `src/main/plugins/__tests__/plugin-bridge.test.ts`
 * 直接跑源码覆盖——超时、销毁、冒名消息都在那里验。UI 测试关心的是面板逻辑本身，
 * 所以这里只复刻「发请求、按 requestId 收结果、把 context/theme/settings 分发给监听器」
 * 这一层，省得每个 UI 测试都去搭一个假父窗口。
 *
 * 用法：在 `beforeEach` 里、`installHost()` 之前调用；它把 `window.pi` 装好，
 * `ui/app.js` 里 `const bridge = window.pi || ...` 就会用上它。
 */
export function installFakeBridge(overrides = {}) {
  let seq = 0
  /** requestId → { resolve, reject } */
  const waiters = new Map()
  /** 事件名 → Set<handler> */
  const handlers = new Map()

  function emit(name, payload) {
    for (const handler of handlers.get(name) || []) handler(payload)
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'plugin-invoke-result') {
      const waiter = waiters.get(data.requestId)
      if (!waiter) return
      waiters.delete(data.requestId)
      if (data.ok) waiter.resolve(data.result)
      else waiter.reject(new Error(data.error || 'invoke failed'))
      return
    }
    if (data.type === 'plugin-context') emit('context', data.context)
    if (data.type === 'plugin-theme') emit('theme', data.vars)
    if (data.type === 'plugin-settings') emit('settings', data.values)
    if (data.type === 'plugin-dispose') emit('dispose', data.reason)
  })

  const api = {
    protocol: 1,
    panelId: 'test:main',
    disposed: false,
    settings: {},
    context: {},
    theme: {},
    /** 最近一次上报的按键，便于断言 Esc / mod+K 有没有上抛 */
    lastKey: null,
    invoke(method, params) {
      const requestId = ++seq
      return new Promise((resolve, reject) => {
        waiters.set(requestId, { resolve, reject })
        // jsdom 里 window.parent === window，所以「发往父窗口」等价于派发给自己，
        // 假宿主（installHost）就是在 window 上等这条消息的
        window.dispatchEvent(
          new MessageEvent('message', { data: { type: 'plugin-invoke', requestId, method, params } }),
        )
      })
    },
    openPanel: () => Promise.resolve(true),
    setContentHeight: () => {},
    forwardKey(key, options) {
      api.lastKey = { key, mod: !!(options && options.mod) }
    },
    on(name, handler) {
      const key = String(name)
      if (!handlers.has(key)) handlers.set(key, new Set())
      handlers.get(key).add(handler)
      return () => handlers.get(key)?.delete(handler)
    },
    off(name, handler) {
      handlers.get(String(name))?.delete(handler)
    },
    dispose() {
      api.disposed = true
    },
    ...overrides,
  }

  Object.defineProperty(window, 'pi', { value: api, configurable: true, writable: true })
  return api
}
