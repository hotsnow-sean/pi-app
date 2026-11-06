/**
 * 插件面板桥：宿主下发给 sandbox iframe 的通信客户端。
 *
 * 由 `pi-plugin://__host/bridge.js` 提供（见 src/main/plugins/protocol.ts），插件 HTML
 * 里一行 `<script src="pi-plugin://__host/bridge.js"></script>` 即可，之后只用 `window.pi`。
 *
 * 为什么桥归宿主：面板是 `sandbox="allow-scripts"`（**不含** allow-same-origin）的
 * opaque origin，读不到宿主 DOM、没有 preload、也不能 require。它和 main 之间唯一的通路
 * 就是 `window.parent.postMessage`，而 postMessage 是单向广播、没有返回值、没有
 * 「这条回包对应哪次请求」的概念——请求/响应语义、超时、销毁全得自己造。这套东西
 * 每个插件抄一遍就会分叉（事实上已经分叉了），所以收归宿主。
 *
 * 本文件是**构建期内联的裸脚本**（`import ... from './bridge/bridge.js?raw'`），
 * 不经过打包器处理：不能 import、不能用宿主模块，语法保持 ES2017 以内。
 *
 * 契约（与 src/renderer/src/features/plugins/plugin-panel-frame.tsx 一一对应）：
 *   → plugin-hello                      桥就绪
 *   → plugin-invoke { requestId, method, params }
 *   → plugin-open-panel { requestId, panelId }
 *   → plugin-content-height { height }
 *   → plugin-key { key, mod }
 *   ← plugin-ready { panelId, protocol }
 *   ← plugin-invoke-result { requestId, ok, result?, error? }
 *   ← plugin-open-panel-result { requestId, ok }
 *   ← plugin-theme { vars } / plugin-settings { values } / plugin-context { context }
 *   ← plugin-dispose { reason }         面板卸载 / 插件停用
 */
(function () {
  'use strict'

  /** 与 packages/shared/plugin-bridge.ts 的 PLUGIN_BRIDGE_PROTOCOL 必须一致（有测试守着） */
  var PROTOCOL = 1

  /** 一次 invoke 等多久。宿主正常路径都会回包，超时只在 renderer 重载 / IPC 抛错时兜底 */
  var DEFAULT_TIMEOUT_MS = 10000

  if (typeof window === 'undefined' || !window.parent || window.parent === window) return
  if (window.pi) return

  var seq = 0
  /** requestId → { resolve, reject, timer }，invoke 与 openPanel 共用一套 id 空间 */
  var pending = new Map()
  /** 事件名 → Set<handler> */
  var listeners = new Map()

  var state = {
    ready: false,
    protocol: 0,
    panelId: '',
    disposed: false,
    theme: {},
    settings: {},
    context: {},
  }

  function makeError(message, code) {
    var error = new Error(message)
    error.code = code
    return error
  }

  function emit(name, payload) {
    var set = listeners.get(name)
    if (!set) return
    set.forEach(function (handler) {
      try {
        handler(payload)
      } catch (error) {
        // 一个监听器炸了不该带塌整条桥（它会连累后面的监听器和调用方）
        console.error('[pi] listener failed: ' + name, error)
      }
    })
  }

  /** postMessage 的 targetOrigin 只能是 '*'：iframe 是 opaque origin，其 origin 是字符串
   *  "null"，而 "null" 不是合法 URL，传给 targetOrigin 会抛 SyntaxError。安全性由
   *  「只认 window.parent」+ 收包侧校验 event.source 承担。 */
  function post(message) {
    window.parent.postMessage(message, '*')
  }

  function take(requestId) {
    var entry = pending.get(requestId)
    if (!entry) return null
    pending.delete(requestId)
    if (entry.timer) clearTimeout(entry.timer)
    return entry
  }

  function applyTheme(vars) {
    if (!vars || typeof vars !== 'object') return
    var root = document.documentElement
    Object.keys(vars).forEach(function (name) {
      var value = vars[name]
      if (typeof value === 'string' && value) root.style.setProperty(name, value)
    })
  }

  function waitFor(send) {
    if (state.disposed) return Promise.reject(makeError('插件面板已关闭', 'disposed'))
    var requestId = ++seq
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        var entry = take(requestId)
        if (entry) entry.reject(makeError('插件面板没有响应（' + DEFAULT_TIMEOUT_MS / 1000 + 's），请重试', 'timeout'))
      }, DEFAULT_TIMEOUT_MS)
      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer })
      send(requestId)
    })
  }

  function invoke(method, params, options) {
    var name = String(method || '')
    if (!name) return Promise.reject(makeError('invoke 需要 method', 'bad_request'))
    if (state.disposed) return Promise.reject(makeError('插件面板已关闭', 'disposed'))

    var timeoutMs =
      options && typeof options.timeoutMs === 'number' && options.timeoutMs >= 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS
    var requestId = ++seq
    return new Promise(function (resolve, reject) {
      // timeoutMs = 0 表示不设超时（长任务轮询用），但默认必须有一个：
      // 没有出口的 promise 会在宿主卡住时把按钮永远留在转圈状态。
      var timer =
        timeoutMs > 0
          ? setTimeout(function () {
              var entry = take(requestId)
              if (entry) entry.reject(makeError('插件面板没有响应（' + Math.round(timeoutMs / 1000) + 's），请重试', 'timeout'))
            }, timeoutMs)
          : null
      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer })
      post({ type: 'plugin-invoke', requestId: requestId, method: name, params: params || {} })
    })
  }

  function openPanel(panelId) {
    return waitFor(function (requestId) {
      post({ type: 'plugin-open-panel', requestId: requestId, panelId: String(panelId || '') })
    }).then(function (ok) {
      return ok === true
    })
  }

  /** content 模式：上报自身高度（0 = 收起）。非 content 模式下宿主会忽略 */
  function setContentHeight(height) {
    var value = Number(height)
    if (!isFinite(value) || value < 0) return
    post({ type: 'plugin-content-height', height: Math.round(value) })
  }

  /** iframe 有焦点时宿主 window 收不到 keydown，Esc / mod+K 得主动上抛 */
  function forwardKey(key, options) {
    post({ type: 'plugin-key', key: String(key || ''), mod: !!(options && options.mod) })
  }

  function on(name, handler) {
    if (typeof handler !== 'function') return function () {}
    var key = String(name)
    var set = listeners.get(key)
    if (!set) {
      set = new Set()
      listeners.set(key, set)
    }
    set.add(handler)
    return function () {
      set.delete(handler)
    }
  }

  function off(name, handler) {
    var set = listeners.get(String(name))
    if (set) set.delete(handler)
  }

  function dispose(reason) {
    if (state.disposed) return
    state.disposed = true
    pending.forEach(function (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(makeError('插件面板已关闭', 'disposed'))
    })
    pending.clear()
    state.ready = false
    emit('dispose', String(reason || 'host'))
  }

  window.addEventListener('message', function (event) {
    // opaque origin 下 event.origin 恒为 "null"，没有鉴权价值；能查的只有「来自父窗口」
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || typeof data !== 'object') return

    if (data.type === 'plugin-ready') {
      state.ready = true
      state.protocol = Number(data.protocol) || 0
      state.panelId = String(data.panelId || '')
      if (state.protocol && state.protocol !== PROTOCOL) {
        console.warn('[pi] 桥协议版本不一致：宿主 ' + state.protocol + '，脚本 ' + PROTOCOL)
      }
      emit('ready', state.panelId)
      return
    }
    if (data.type === 'plugin-invoke-result') {
      var entry = take(Number(data.requestId))
      if (!entry) return
      if (data.ok) entry.resolve(data.result)
      else entry.reject(makeError(String(data.error || 'invoke 失败'), 'invoke_failed'))
      return
    }
    if (data.type === 'plugin-open-panel-result') {
      var panelEntry = take(Number(data.requestId))
      if (panelEntry) panelEntry.resolve(data.ok === true)
      return
    }
    if (data.type === 'plugin-theme') {
      state.theme = data.vars && typeof data.vars === 'object' ? data.vars : {}
      applyTheme(state.theme)
      emit('theme', state.theme)
      return
    }
    if (data.type === 'plugin-settings') {
      state.settings = data.values && typeof data.values === 'object' ? data.values : {}
      emit('settings', state.settings)
      return
    }
    if (data.type === 'plugin-context') {
      state.context = data.context && typeof data.context === 'object' ? data.context : {}
      emit('context', state.context)
      return
    }
    if (data.type === 'plugin-dispose') {
      dispose(data.reason)
    }
  })

  var api = {
    protocol: PROTOCOL,
    invoke: invoke,
    on: on,
    off: off,
    openPanel: openPanel,
    setContentHeight: setContentHeight,
    forwardKey: forwardKey,
    dispose: function () {
      dispose('plugin')
    },
  }

  Object.defineProperty(api, 'settings', {
    enumerable: true,
    get: function () {
      return state.settings
    },
  })
  Object.defineProperty(api, 'context', {
    enumerable: true,
    get: function () {
      return state.context
    },
  })
  Object.defineProperty(api, 'theme', {
    enumerable: true,
    get: function () {
      return state.theme
    },
  })
  Object.defineProperty(api, 'panelId', {
    enumerable: true,
    get: function () {
      return state.panelId
    },
  })
  Object.defineProperty(api, 'disposed', {
    enumerable: true,
    get: function () {
      return state.disposed
    },
  })

  // 不可写不可配：插件里后来的脚本不该能把它换掉（换了就等于把调用偷偷改道）
  Object.defineProperty(window, 'pi', { value: api, writable: false, configurable: false, enumerable: true })

  // 握手。宿主在 iframe load 时也会补发一次 ready，所以这条丢了也不会卡死。
  post({ type: 'plugin-hello', bridge: PROTOCOL })
})()
