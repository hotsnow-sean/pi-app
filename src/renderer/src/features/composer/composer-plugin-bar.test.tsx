import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerPluginBars } from './composer-plugin-bar'
import type { PluginComposerBarState } from '@shared/plugin-composer-bar'

/**
 * 托盘是宿主原生渲染的，所以「收到什么就画什么」这件事值得钉住：
 * 没有状态时不能占位（会话条曾因为一直渲染空壳，把输入框顶下去 34px）。
 */
const state = {
  pluginComposerBars: {} as Record<string, PluginComposerBarState>,
  historySessionFile: '/s.jsonl',
  adapterWidgetExpandedBySession: {} as Record<string, boolean>,
  toggleAdapterWidget: vi.fn((key: string) => {
    state.adapterWidgetExpandedBySession[key] = !state.adapterWidgetExpandedBySession[key]
  }),
  rightPanelCatalog: [] as Array<{ id: string }>,
  setActivePanel: vi.fn(),
  revealRightPanel: vi.fn(),
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@renderer/lib/ipc-client', () => ({
  ipcClient: { invoke: vi.fn().mockResolvedValue({ ok: true }) },
}))

import { ipcClient } from '@renderer/lib/ipc-client'

vi.mock('@renderer/stores/ui-store', () => ({
  useUIStore: Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}))

describe('ComposerPluginBars', () => {
  beforeEach(() => {
    state.pluginComposerBars = {}
    state.adapterWidgetExpandedBySession = {}
    state.toggleAdapterWidget.mockClear()
    state.setActivePanel.mockClear()
    state.revealRightPanel.mockClear()
    vi.mocked(ipcClient.invoke).mockClear()
  })

  it('renders nothing when no plugin has anything to say', () => {
    const { container } = render(<ComposerPluginBars />)
    expect(container).toBeEmptyDOMElement()
  })

  it('collapses to one summary line and expands into rows', () => {
    state.pluginComposerBars = {
      'background-tasks': {
        summary: '1 个任务在运行',
        detail: '构建桌面端',
        tone: 'active',
        rows: [
          {
            id: 'bg-1',
            label: '构建桌面端',
            state: 'active',
            startedAt: Date.now(),
            actions: [{ id: 'stop', icon: 'stop' }],
          },
        ],
        panelId: 'plugin:background-tasks:tasks',
      },
    }
    const { rerender } = render(<ComposerPluginBars />)

    const trigger = screen.getByRole('button', { name: /1 个任务在运行/ })
    expect(trigger).toHaveTextContent('构建桌面端')
    expect(document.querySelector('[data-row-id]')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(state.toggleAdapterWidget).toHaveBeenCalledWith('/s.jsonl\u0000plugin-bar\u0000background-tasks')
    state.adapterWidgetExpandedBySession['/s.jsonl\u0000plugin-bar\u0000background-tasks'] = true
    rerender(<ComposerPluginBars />)

    expect(document.querySelector('[data-row-id="bg-1"]')).toHaveTextContent('构建桌面端')
    // 运行中的行给停止按钮，否则用户只能去右栏
    expect(screen.getByTitle('composer:pluginBar.stop')).toBeInTheDocument()
  })

  it('keeps the list open when a row opens its detail', () => {
    // 点一行 → 右栏开详情，但托盘本身不该收起来：
    // 收起后用户每次看完一条都得重新展开，是纯粹的重复劳动。
    state.pluginComposerBars = {
      'background-tasks': {
        summary: '2 个任务在运行',
        tone: 'active',
        rows: [
          {
            id: 'bg-1',
            label: '构建桌面端',
            state: 'active',
            startedAt: Date.now(),
            actions: [{ id: 'stop', icon: 'stop' }],
          },
          {
            id: 'bg-2',
            label: '跑测试',
            state: 'active',
            startedAt: Date.now(),
            actions: [{ id: 'stop', icon: 'stop' }],
          },
        ],
        panelId: 'plugin:background-tasks:tasks',
      },
    }
    state.adapterWidgetExpandedBySession['/s.jsonl\u0000plugin-bar\u0000background-tasks'] = true
    state.rightPanelCatalog = [{ id: 'plugin:background-tasks:tasks' }]
    render(<ComposerPluginBars />)

    fireEvent.click(screen.getByTitle('构建桌面端'))
    expect(state.toggleAdapterWidget).not.toHaveBeenCalled()
    expect(state.setActivePanel).toHaveBeenCalledWith('plugin:background-tasks:tasks')
    expect(state.revealRightPanel).toHaveBeenCalled()
  })

  it('forwards the plugin-defined action id instead of a host-owned verb', () => {
    // 宿主不认识 'kill' 是什么——它只负责把插件定义的 id 原样回传。
    // 这正是「托盘词表去业务化」的核心：新插件不必说后台任务的方言。
    state.pluginComposerBars = {
      'some-plugin': {
        summary: '1 个作业',
        tone: 'active',
        rows: [
          {
            id: 'job-1',
            label: '导出报表',
            state: 'active',
            startedAt: Date.now(),
            actions: [{ id: 'kill', icon: 'stop', title: '终止' }],
          },
        ],
      },
    }
    state.adapterWidgetExpandedBySession['/s.jsonl\u0000plugin-bar\u0000some-plugin'] = true
    render(<ComposerPluginBars />)

    fireEvent.click(screen.getByTitle('终止'))
    expect(vi.mocked(ipcClient.invoke)).toHaveBeenCalledWith('plugin.invoke', {
      pluginId: 'some-plugin',
      method: 'composerBarAction',
      params: { action: 'kill', id: 'job-1' },
    })

    fireEvent.click(screen.getByTitle('导出报表'))
    expect(vi.mocked(ipcClient.invoke)).toHaveBeenCalledWith('plugin.invoke', {
      pluginId: 'some-plugin',
      method: 'composerBarAction',
      params: { action: 'select', id: 'job-1' },
    })
  })

  it('shows a finished bar without a stale duration', () => {
    state.pluginComposerBars = {
      'background-tasks': {
        summary: '1 个任务已结束',
        detail: '构建桌面端',
        tone: 'ok',
        rows: [{ id: 'bg-2', label: '构建桌面端', state: 'ok', meta: '1.2s' }],
      },
    }
    render(<ComposerPluginBars />)
    const trigger = screen.getByRole('button', { name: /1 个任务已结束/ })
    expect(trigger).toBeInTheDocument()
    expect(trigger.closest('section')).toHaveAttribute('data-plugin-bar', 'background-tasks')
  })
})
