import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PLUGIN_BRIDGE_PROTOCOL } from '@shared/plugin-bridge'

/**
 * 桥脚本（src/main/plugins/bridge/bridge.js）的回归测试。
 *
 * 为什么不用 jsdom 跑：jsdom 里 `window.parent === window`，桥会当场 return；而桥的
 * 全部价值就在于「对面是父窗口、消息是单向的、回包要自己配对」这套语义。这里用 `vm`
 * 造一个干净 realm：`window.parent` 是我们自己的对象，postMessage 只是记账，于是
 * 超时、销毁、乱序回包这些分支都能直接驱动。
 */

const source = readFileSync(join(import.meta.dirname, '..', 'bridge', 'bridge.js'), 'utf8')

type SentMessage = { message: Record<string, unknown>; targetOrigin: string }

type PiApi = {
  protocol: number
  panelId: string
  disposed: boolean
  theme: Record<string, unknown>
  settings: Record<string, unknown>
  context: Record<string, unknown>
  invoke(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  openPanel(panelId: string): Promise<boolean>
  setContentHeight(height: number): void
  forwardKey(key: string, options?: { mod?: boolean }): void
  on(name: string, handler: (payload: unknown) => void): () => void
  dispose(): void
}

function loadBridge() {
  const sent: SentMessage[] = []
  const listeners: Array<(event: unknown) => void> = []
  const style = new Map<string, string>()

  const parentWindow = {
    postMessage(message: Record<string, unknown>, targetOrigin: string) {
      sent.push({ message, targetOrigin })
    },
  }
  const documentElement = {
    style: {
      setProperty(name: string, value: string) {
        style.set(name, value)
      },
    },
  }
  const sandboxWindow: Record<string, unknown> = {
    parent: parentWindow,
    document: { documentElement },
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (type === 'message') listeners.push(handler)
    },
  }

  const context = vm.createContext({
    window: sandboxWindow,
    document: { documentElement },
    // 桥只用到 warn / error，其余 console 方法不必提供
    console: { warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
  })
  const run = (): void => {
    vm.runInContext(source, context)
  }
  run()

  return {
    pi: sandboxWindow.pi as PiApi,
    sent,
    style,
    /** 模拟宿主回包（source 必须是父窗口，否则桥按设计丢弃） */
    host(data: Record<string, unknown>) {
      for (const listener of listeners) listener({ source: parentWindow, data })
    },
    /** 模拟别的 frame 发来的消息：桥必须无视 */
    stranger(data: Record<string, unknown>) {
      for (const listener of listeners) listener({ source: {}, data })
    },
    /** 同一个 realm 里再跑一遍脚本（模拟页面把它引了两次） */
    rerun(): PiApi {
      run()
      return sandboxWindow.pi as PiApi
    },
  }
}

describe('插件面板桥', () => {
  it('加载即握手，且 targetOrigin 只能是 *', () => {
    const { sent } = loadBridge()
    expect(sent).toHaveLength(1)
    expect(sent[0].message).toMatchObject({ type: 'plugin-hello', bridge: PLUGIN_BRIDGE_PROTOCOL })
    // opaque origin 是 "null"，不是合法 URL，传具体 origin 会抛 SyntaxError
    expect(sent[0].targetOrigin).toBe('*')
  })

  it('ready 之后能读到 panelId 与协议版本，并触发一次 ready 事件', () => {
    const { pi, host } = loadBridge()
    const seen: string[] = []
    pi.on('ready', (panelId) => seen.push(String(panelId)))

    host({ type: 'plugin-ready', panelId: 'scheduler:main', protocol: PLUGIN_BRIDGE_PROTOCOL })
    expect(pi.panelId).toBe('scheduler:main')
    expect(seen).toEqual(['scheduler:main'])
  })

  it('invoke 发请求、按 requestId 配对回包', async () => {
    const { pi, sent, host } = loadBridge()
    const pending = pi.invoke('snapshot', { a: 1 })

    expect(sent).toHaveLength(2)
    const request = sent[1].message
    expect(request).toMatchObject({ type: 'plugin-invoke', method: 'snapshot', params: { a: 1 } })

    host({ type: 'plugin-invoke-result', requestId: request.requestId, ok: true, result: { tasks: 3 } })
    await expect(pending).resolves.toEqual({ tasks: 3 })
  })

  it('宿主报错时 reject 并带 code', async () => {
    const { pi, sent, host } = loadBridge()
    const pending = pi.invoke('saveTask')
    const requestId = sent[1].message.requestId

    host({ type: 'plugin-invoke-result', requestId, ok: false, error: '渠道名重复' })
    await expect(pending).rejects.toMatchObject({ message: '渠道名重复', code: 'invoke_failed' })
  })

  it('没人回包时按默认超时兜底，不会永远转圈', async () => {
    const { pi } = loadBridge()
    // 默认 10s 太久，用 options 缩短到 20ms 验证同一条分支
    const pending = pi.invoke('snapshot', {}, { timeoutMs: 20 })
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
  })

  it('回包晚于超时就被丢弃，不会二次 settle', async () => {
    const { pi, sent, host } = loadBridge()
    const pending = pi.invoke('snapshot', {}, { timeoutMs: 20 })
    const requestId = sent[1].message.requestId
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })

    // 迟到的回包不该抛（waiter 已经删了），也不该改变任何状态
    expect(() => host({ type: 'plugin-invoke-result', requestId, ok: true, result: 1 })).not.toThrow()
  })

  it('面板卸载时把挂起的调用全部 reject，之后的 invoke 直接失败', async () => {
    const { pi, host } = loadBridge()
    const first = pi.invoke('snapshot')
    const second = pi.invoke('listRuns')
    host({ type: 'plugin-dispose', reason: 'unmount' })

    await expect(first).rejects.toMatchObject({ code: 'disposed' })
    await expect(second).rejects.toMatchObject({ code: 'disposed' })
    expect(pi.disposed).toBe(true)
    await expect(pi.invoke('snapshot')).rejects.toMatchObject({ code: 'disposed' })
  })

  it('dispose 事件只触发一次', () => {
    const { pi, host } = loadBridge()
    const reasons: string[] = []
    pi.on('dispose', (reason) => reasons.push(String(reason)))
    host({ type: 'plugin-dispose', reason: 'unmount' })
    host({ type: 'plugin-dispose', reason: 'unmount' })
    pi.dispose()
    expect(reasons).toEqual(['unmount'])
  })

  it('主题落到 documentElement，并触发 theme 事件', () => {
    const { pi, style, host } = loadBridge()
    const vars = { '--pi-background': '#ffffff', '--pi-foreground': 'oklch(0.2 0 0)' }
    host({ type: 'plugin-theme', vars })

    expect(style.get('--pi-background')).toBe('#ffffff')
    expect(style.get('--pi-foreground')).toBe('oklch(0.2 0 0)')
    expect(pi.theme).toEqual(vars)
  })

  it('设置与上下文是只读快照，每次推送替换引用', () => {
    const { pi, host } = loadBridge()
    host({ type: 'plugin-settings', values: { notify: false } })
    expect(pi.settings).toEqual({ notify: false })

    host({ type: 'plugin-settings', values: { notify: true } })
    expect(pi.settings).toEqual({ notify: true })

    host({ type: 'plugin-context', context: { sessionFile: 'a.jsonl' } })
    expect(pi.context).toEqual({ sessionFile: 'a.jsonl' })
  })

  it('openPanel 等宿主确认，路径不存在时回 false', async () => {
    const { pi, sent, host } = loadBridge()
    const ok = pi.openPanel('background-tasks:main')
    const request = sent[1].message
    expect(request).toMatchObject({ type: 'plugin-open-panel', panelId: 'background-tasks:main' })

    host({ type: 'plugin-open-panel-result', requestId: request.requestId, ok: false })
    await expect(ok).resolves.toBe(false)
  })

  it('高度与按键上报用宿主认得的形状', () => {
    const { pi, sent } = loadBridge()
    pi.setContentHeight(73.6)
    pi.setContentHeight(-1)
    pi.forwardKey('k', { mod: true })

    expect(sent[1].message).toEqual({ type: 'plugin-content-height', height: 74 })
    // 负数直接丢弃，不上报
    expect(sent).toHaveLength(3)
    expect(sent[2].message).toEqual({ type: 'plugin-key', key: 'k', mod: true })
  })

  it('不认来自其它 frame 的消息', async () => {
    const { pi, sent, host, stranger } = loadBridge()
    const pending = pi.invoke('snapshot', {}, { timeoutMs: 20 })
    const requestId = sent[1].message.requestId

    stranger({ type: 'plugin-invoke-result', requestId, ok: true, result: 'hijacked' })
    stranger({ type: 'plugin-theme', vars: { '--pi-background': 'red' } })
    stranger({ type: 'plugin-context', context: { sessionFile: 'evil.jsonl' } })

    expect(pi.theme).toEqual({})
    expect(pi.context).toEqual({})
    // 真正的回包没来，调用应该照常超时——冒名的回包没有把它 resolve 掉
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
    host({ type: 'plugin-invoke-result', requestId, ok: true, result: 'late' })
  })

  it('重复加载不会覆盖已存在的 window.pi，也不再重复握手', () => {
    const { pi, sent, rerun } = loadBridge()
    const before = sent.length
    // 页面把它引了两次：第二次必须原地返回，否则插件已经挂上的监听与 pending 全丢
    expect(rerun()).toBe(pi)
    expect(sent).toHaveLength(before)
  })

  it('协议版本与 shared 常量一致（两份都是构建期定死，没有运行时同步手段）', () => {
    const declared = Number(/var PROTOCOL = (\d+)/.exec(source)?.[1])
    expect(declared).toBe(PLUGIN_BRIDGE_PROTOCOL)
  })
})
