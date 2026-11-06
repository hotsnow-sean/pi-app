import { describe, expect, it, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// plugin-manager 顶层 import electron（app.getPath / getVersion / isPackaged）
// 与 configStore（pluginEnabled 的持久层）。都用内存替身，插件的 plugin.json
// 用临时目录承载——PI_PLUGINS_DIR 在每次 pluginRoots() 调用时读取，测试里可换。
const HOST_VERSION = '1.4.2'
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/pi-test-userdata',
    getAppPath: () => '/tmp/pi-test-app',
    isPackaged: false,
    getVersion: () => HOST_VERSION,
  },
}))
const enabledMap: Record<string, boolean> = {}
vi.mock('../../config-store', () => ({
  configStore: {
    get: (key: string) => (key === 'pluginEnabled' ? enabledMap : {}),
    set: (key: string, value: unknown) => {
      if (key === 'pluginEnabled') Object.assign(enabledMap, value as Record<string, boolean>)
    },
  },
}))

import { discoverPlugins, findPlugin, pluginDiscoveryVersion, setPluginEnabled } from '../plugin-manager'

function writePlugin(root: string, id: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', main: 'main.mjs', ...extra }),
  )
}

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-manager-test-'))
  process.env.PI_PLUGINS_DIR = root
  for (const k of Object.keys(enabledMap)) delete enabledMap[k]
})

describe('discoverPlugins', () => {
  it('engines 满足 → 正常发现；不满足 → 不可激活并保留身份进设置页（P2-7 + 复审 P1）', () => {
    writePlugin(root, 'ok-plugin', { engines: { 'pi-desktop': '>=1.0.0' } })
    writePlugin(root, 'greedy-plugin', { engines: { 'pi-desktop': `>=99.0.0` } })

    const plugins = discoverPlugins()
    const ok = plugins.find((p) => p.manifest?.id === 'ok-plugin')
    const greedy = plugins.find((p) => p.error?.includes('engines'))
    expect(ok?.manifest).toBeTruthy()
    // 声明了「需要 host ≥ x」就要真的有人管：不满足 = 不可激活，但清单本身是好的——
    // manifest 保留（blockedManifest），设置页才能显示这行插件是谁、为什么没加载
    expect(greedy?.manifest ?? null).toBeNull()
    expect(greedy?.blockedManifest?.id).toBe('greedy-plugin')
    expect(greedy?.errorKind).toBe('engines')
    expect(greedy?.error).toContain(`host version ${HOST_VERSION} does not satisfy`)
    expect(greedy?.enabled).toBe(false)
  })

  it('engines 语法不合法 → fail open，插件仍被发现（fail open 承诺的接线测试）', () => {
    // satisfiesHostRange 自身测过 fail open，这条守住 readManifest 的接线没有把它接反
    writePlugin(root, 'junk', { engines: { 'pi-desktop': 'latest!!!' } })
    const p = discoverPlugins().find((x) => x.manifest?.id === 'junk')
    expect(p?.manifest).toBeTruthy()
    expect(p?.error).toBeUndefined()
  })

  it('目录缓存：相邻两次调用不重扫；根目录变化后失效重扫（P2-8）', () => {
    writePlugin(root, 'a')
    expect(discoverPlugins().map((p) => p.manifest?.id)).toEqual(['a'])
    const versionAfterFirst = pluginDiscoveryVersion()

    // 目录没变：命中缓存，代数不涨
    expect(discoverPlugins().map((p) => p.manifest?.id)).toEqual(['a'])
    expect(pluginDiscoveryVersion()).toBe(versionAfterFirst)

    // 根目录变了（新插件目录）：失效重建，代数 +1
    writePlugin(root, 'b')
    expect(discoverPlugins().map((p) => p.manifest?.id)).toEqual(['a', 'b'])
    expect(pluginDiscoveryVersion()).toBe(versionAfterFirst + 1)

    // 删除也走同一条失效路径
    fs.rmSync(path.join(root, 'b'), { recursive: true, force: true })
    expect(discoverPlugins().map((p) => p.manifest?.id)).toEqual(['a'])
  })

  it('启停不重扫目录但抬代数：工具描述符等派生缓存能跟着失效', () => {
    writePlugin(root, 'a')
    discoverPlugins()
    const v = pluginDiscoveryVersion()
    setPluginEnabled('a', false)
    expect(pluginDiscoveryVersion()).toBe(v + 1)
    // enabled 现算：缓存命中时也能读到最新启停状态
    expect(discoverPlugins().find((p) => p.manifest?.id === 'a')?.enabled).toBe(false)
  })

  it('findPlugin 走同一条缓存链', () => {
    writePlugin(root, 'only')
    expect(findPlugin('only')?.dir).toBe(path.join(root, 'only'))
    expect(findPlugin('nope')).toBeNull()
  })
})
