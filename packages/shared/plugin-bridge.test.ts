import { describe, expect, it } from 'vitest'
import {
  PLUGIN_BRIDGE_HOST,
  PLUGIN_BRIDGE_PATH,
  PLUGIN_BRIDGE_PROTOCOL,
  isPluginBridgeRequest,
  pluginBridgeUrl,
} from './plugin-bridge'
import { PLUGIN_ID_PATTERN } from './plugin-manifest'

describe('插件面板桥定址', () => {
  it('桥脚本走保留 hostname，不是某个插件目录', () => {
    expect(pluginBridgeUrl()).toBe(`pi-plugin://${PLUGIN_BRIDGE_HOST}/${PLUGIN_BRIDGE_PATH}`)
  })

  it('保留 hostname 永远不可能等于插件 id', () => {
    // 这条是「桥会不会跟插件目录撞车」的唯一保证：插件 id 必须字母开头
    expect(PLUGIN_ID_PATTERN.test(PLUGIN_BRIDGE_HOST)).toBe(false)
  })

  it('只有 reserved host 命中桥分支，大小写不敏感', () => {
    expect(isPluginBridgeRequest(PLUGIN_BRIDGE_HOST)).toBe(true)
    expect(isPluginBridgeRequest('__HOST')).toBe(true)
    expect(isPluginBridgeRequest('scheduler')).toBe(false)
    expect(isPluginBridgeRequest('__host2')).toBe(false)
    expect(isPluginBridgeRequest('')).toBe(false)
  })

  it('协议版本是个正整数（桥脚本里那份必须与它相同，由 main 侧测试守着）', () => {
    expect(Number.isInteger(PLUGIN_BRIDGE_PROTOCOL)).toBe(true)
    expect(PLUGIN_BRIDGE_PROTOCOL).toBeGreaterThan(0)
  })
})
