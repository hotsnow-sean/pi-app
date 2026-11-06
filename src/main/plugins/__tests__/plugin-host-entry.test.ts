import { describe, expect, it, vi } from 'vitest'

// plugin-host 顶层 import 了一堆会摸 electron / worker 的模块，测路径校验只需要
// findPlugin 这一个，其余全部换成空实现。
vi.mock('electron', () => ({
  Notification: class {},
  app: { getPath: () => '/tmp/pi-test', focus: () => {} },
}))
vi.mock('../plugin-manager', () => ({
  findPlugin: (id: string) =>
    id === 'bg' ? { manifest: { id: 'bg' }, dir: '/plugins/bg', enabled: true } : null,
  setPluginEnabled: () => {},
}))
vi.mock('../plugin-settings', () => ({
  getPluginSettings: () => ({}),
  onPluginSettingsChanged: () => () => {},
}))
vi.mock('../plugin-ui', () => ({
  askInHost: async () => ({ answers: [] }),
  cancelPluginUIRequests: () => {},
}))
vi.mock('../plugin-composer-bar', () => ({
  clearPluginComposerBars: () => {},
  publishPluginComposerBar: () => {},
}))
vi.mock('../plugin-tools', () => ({
  cancelPluginToolCallsFor: () => {},
  pluginToolDescriptors: () => [],
}))
vi.mock('../../worker-manager', () => ({ workerManager: {} }))
// ctx.ui.inbox 的落点在 completion-notification；这里测的是路径校验，不需要真的信箱
// （不 mock 会把 main/window.ts 的 electron 依赖拉进来，node 环境直接炸）
vi.mock('../../completion-notification', () => ({ pushPluginInbox: () => {} }))

import { resolvePluginPanelEntry } from '../plugin-host'

describe('resolvePluginPanelEntry', () => {
  it('resolves an entry inside the plugin directory', () => {
    const full = resolvePluginPanelEntry('bg', 'ui/index.html')
    expect(full).not.toBeNull()
    expect(full).toContain('ui')
  })

  it('rejects entries that escape the plugin directory', () => {
    // 前缀比较挡不住同前缀兄弟目录：/plugins/bg-evil 也以 /plugins/bg 开头
    expect(resolvePluginPanelEntry('bg', '../bg-evil/x.html')).toBeNull()
    expect(resolvePluginPanelEntry('bg', '../../etc/passwd')).toBeNull()
  })

  it('returns null for an unknown plugin', () => {
    expect(resolvePluginPanelEntry('nope', 'ui/index.html')).toBeNull()
  })
})
