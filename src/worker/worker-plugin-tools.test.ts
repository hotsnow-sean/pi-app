import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent: Record<string, unknown>[] = []
vi.mock('./worker-transport.js', () => ({ sendToMain: (m: Record<string, unknown>) => sent.push(m) }))

const { handlePluginToolResponse, pluginToolsExtension, setPluginTools } = await import('./worker-plugin-tools')
import type { PluginToolDescriptor } from '@shared/plugin-manifest'

type Tool = {
  name: string
  label: string
  description: string
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: { type: string; text: string }[] }>
}

/** Fake pi: registerTool stores by name, getActiveTools is the model-visible set. */
function fakePi(initial: string[] = ['read', 'bash']) {
  let active = [...initial]
  const byName = new Map<string, Tool>()
  const handlers: Record<string, (event?: unknown, ctx?: unknown) => void> = {}
  const pi = {
    registerTool: (t: Tool) => byName.set(t.name, t),
    on: (name: string, fn: (event?: unknown, ctx?: unknown) => void) => (handlers[name] = fn),
    getActiveTools: () => active,
    getAllTools: () => [...byName.values()],
    setActiveTools: (next: string[]) => {
      active = [...next]
    },
  }
  return { pi, tool: (n: string) => byName.get(n), active: () => active, handlers }
}

const askTool: PluginToolDescriptor = {
  pluginId: 'ask',
  name: 'ask_user',
  label: '向你提问',
  description: 'Ask the user structured questions.',
  parameters: { type: 'object', properties: { questions: { type: 'array' } }, required: ['questions'] },
}

describe('worker plugin tools', () => {
  beforeEach(() => {
    sent.length = 0
    setPluginTools([])
  })

  it('registers plugin tools into the session and activates them', () => {
    const f = fakePi()
    ;(pluginToolsExtension as { factory: (pi: unknown) => void }).factory(f.pi)
    setPluginTools([askTool])
    expect(f.tool('ask_user')).toBeTruthy()
    expect(f.active()).toContain('ask_user')
    // 宿主已有的工具不受影响
    expect(f.active()).toContain('read')
  })

  it('drops tools from the active set when the plugin disappears', () => {
    const f = fakePi()
    ;(pluginToolsExtension as { factory: (pi: unknown) => void }).factory(f.pi)
    setPluginTools([askTool])
    setPluginTools([])
    expect(f.active()).not.toContain('ask_user')
  })

  it('forwards calls to main and resolves with its result', async () => {
    const f = fakePi()
    ;(pluginToolsExtension as { factory: (pi: unknown) => void }).factory(f.pi)
    setPluginTools([askTool])
    const tool = f.tool('ask_user')!
    const pending = tool.execute('call-1', { questions: [] })
    const request = sent.find((m) => m.type === 'plugin-tool-request')
    expect(request).toMatchObject({ pluginId: 'ask', tool: 'ask_user' })
    await handlePluginToolResponse(
      { callId: String(request!.callId), result: { content: [{ type: 'text', text: '用户已回答：PostgreSQL' }] } } as never,
      (() => {}) as never,
    )
    await expect(pending).resolves.toMatchObject({ content: [{ text: '用户已回答：PostgreSQL' }] })
  })

  it('surfaces main-side failures as tool errors', async () => {
    const f = fakePi()
    ;(pluginToolsExtension as { factory: (pi: unknown) => void }).factory(f.pi)
    setPluginTools([askTool])
    const pending = f.tool('ask_user')!.execute('call-2', {})
    const request = sent.find((m) => m.type === 'plugin-tool-request')
    await handlePluginToolResponse(
      { callId: String(request!.callId), result: { content: [{ type: 'text', text: 'plugin_error: boom' }], isError: true } } as never,
      (() => {}) as never,
    )
    await expect(pending).rejects.toThrow('plugin_error: boom')
  })

  it('skips a tool whose name collides with an existing one', () => {
    const f = fakePi()
    ;(pluginToolsExtension as { factory: (pi: unknown) => void }).factory(f.pi)
    // 先注册一个同名工具（模拟宿主/扩展已占用）
    f.pi.registerTool({ name: 'ask_user', label: 'x', description: 'x', execute: async () => ({ content: [] }) })
    setPluginTools([askTool])
    expect(f.active().filter((n) => n === 'ask_user')).toHaveLength(0)
  })
})
