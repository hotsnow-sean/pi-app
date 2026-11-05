import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 会话条容器：宿主对它的全部理解是「一条跟着当前会话走的 iframe」。
 * 这里只验两件事——目录里声明的条会渲染出来、没声明就什么都不渲染。
 */

const catalogWithBar = {
  plugins: [
    {
      id: 'background-tasks',
      name: '后台任务',
      enabled: true,
      sessionBars: [{ id: 'tasks', title: '后台任务条', entry: 'ui/session-bar.html', height: 40 }],
    },
  ],
}

const catalogWithoutBar = {
  plugins: [{ id: 'background-tasks', name: '后台任务', enabled: true, sessionBars: [] }],
}

async function mountWith(catalog: unknown) {
  vi.resetModules()
  vi.doMock('@renderer/lib/ipc-client', () => ({
    ipcClient: { invoke: vi.fn(async () => catalog) },
    onAppEvent: () => () => {},
  }))
  const { PluginSessionBar } = await import('./plugin-session-bar')
  // 目录是异步拉的：让 setState 落在 act 里，避免 act 警告淹掉真正的失败
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<PluginSessionBar />)
  })
  return view
}

beforeEach(() => {
  vi.resetModules()
})

describe('PluginSessionBar', () => {
  it('mounts one frame per declared session bar', async () => {
    const { container } = await mountWith(catalogWithBar)
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy())
    const frame = container.querySelector('iframe') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('pi-plugin://background-tasks/ui/session-bar.html')
    expect(frame.getAttribute('title')).toBe('后台任务条')
  })

  it('renders nothing when no plugin declares a session bar', async () => {
    const { container } = await mountWith(catalogWithoutBar)
    await waitFor(() => expect(container.querySelector('iframe')).toBeNull())
  })
})
