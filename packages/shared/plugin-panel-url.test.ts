import { describe, expect, it } from 'vitest'
import { DEFAULT_PLUGIN_UI_ENTRY, pluginEntryPath, pluginEntryUrl } from './plugin-panel-url'

/**
 * 这条规则以前有三份实现（shared / protocol / renderer），只有 renderer 那份生效，
 * 且三份的斜杠处理规则不同。测试守着「拼出来能还原回去」这个不变式。
 */
describe('pluginEntryUrl', () => {
  it('拼出 pi-plugin:// URL，默认入口是 ui/index.html', () => {
    expect(pluginEntryUrl('scheduler')).toBe(`pi-plugin://scheduler/${DEFAULT_PLUGIN_UI_ENTRY}`)
  })

  it('前导斜杠统一剥掉（插件里手写 /ui/x.html 很常见）', () => {
    expect(pluginEntryUrl('scheduler', '/ui/index.html')).toBe('pi-plugin://scheduler/ui/index.html')
    expect(pluginEntryUrl('scheduler', '//ui/index.html')).toBe('pi-plugin://scheduler/ui/index.html')
  })

  it('空 entry 回落到默认入口', () => {
    expect(pluginEntryUrl('scheduler', '')).toBe(`pi-plugin://scheduler/${DEFAULT_PLUGIN_UI_ENTRY}`)
  })
})

describe('pluginEntryPath', () => {
  it('把 pathname 还原成相对路径，与 pluginEntryUrl 互逆', () => {
    const url = new URL(pluginEntryUrl('scheduler', 'ui/session-bar.html'))
    expect(pluginEntryPath(url.pathname)).toBe('ui/session-bar.html')
  })

  it('空路径回落到默认入口，而不是插件根目录', () => {
    expect(pluginEntryPath('/')).toBe(DEFAULT_PLUGIN_UI_ENTRY)
    expect(pluginEntryPath('')).toBe(DEFAULT_PLUGIN_UI_ENTRY)
  })

  it('解码百分号转义（文件名里有空格也能取到）', () => {
    expect(pluginEntryPath('/ui/my%20page.html')).toBe('ui/my page.html')
  })
})
