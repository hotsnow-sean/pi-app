import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 会话扩展清单（plugin.json 的 agent 字段）的发现逻辑。
 *
 * 这里只关心「谁该被注入、路径对不对、坏声明怎么处置」——真正的加载在 worker，
 * 那边有单独的隔离性测试。清单层的失误（比如把越界路径交出去）就是安全事故，
 * 所以条目过滤比功能覆盖更重要。
 */

const env = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: () => env.userData,
    getAppPath: () => '/tmp/pi-test-app',
    isPackaged: false,
    getVersion: () => '1.0.0',
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

import { pluginAgentExtensionDescriptors, pluginAgentExtensionIds } from '../plugin-agent-extensions'
import { setPluginEnabled } from '../plugin-manager'

let root: string

/** 造一个插件目录；`agent` 传 undefined 表示不声明，传字符串表示自定义入口 */
function writePlugin(id: string, agent: string | null = 'agent.mjs', writeEntry = true): string {
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  const manifest: Record<string, unknown> = { id, name: id, version: '1.0.0' }
  if (agent !== null) manifest.agent = { entry: agent }
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest))
  if (writeEntry && agent !== null) fs.writeFileSync(path.join(dir, agent), 'export default () => {}')
  return dir
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-agent-manifest-'))
  env.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-agent-userdata-'))
  process.env.PI_PLUGINS_DIR = root
  for (const k of Object.keys(enabledMap)) delete enabledMap[k]
})

describe('pluginAgentExtensionDescriptors', () => {
  it('声明了 agent 的启用插件进清单：入口为绝对路径，dataDir 落在 userData 下', () => {
    const dir = writePlugin('board')
    const [descriptor] = pluginAgentExtensionDescriptors()

    expect(descriptor).toEqual({
      pluginId: 'board',
      entry: path.join(dir, 'agent.mjs'),
      pluginDir: dir,
      dataDir: path.join(env.userData, 'plugin-data', 'board'),
    })
    // dataDir 必须真的存在：插件拿到就开始写盘，不能指望它自己 mkdir
    expect(fs.existsSync(descriptor.dataDir)).toBe(true)
  })

  it('没声明 agent 的插件不注入（纯 UI / 纯 main 插件很常见）', () => {
    writePlugin('ui-only', null)
    writePlugin('board')
    expect(pluginAgentExtensionIds()).toEqual(['board'])
  })

  it('被禁用的插件不注入', () => {
    writePlugin('board')
    setPluginEnabled('board', false)
    expect(pluginAgentExtensionIds()).toEqual([])
  })

  it('入口文件不存在 → 跳过（不把注定 ENOENT 的路径交出去）', () => {
    writePlugin('broken', 'agent.mjs', false)
    writePlugin('board')
    expect(pluginAgentExtensionIds()).toEqual(['board'])
  })

  it('入口越出插件目录 → 拒绝', () => {
    writePlugin('escape', '../../evil.mjs')
    fs.writeFileSync(path.join(path.dirname(root), 'evil.mjs'), 'export default () => {}')
    expect(pluginAgentExtensionIds()).toEqual([])
  })

  it('自定义入口名生效', () => {
    const dir = writePlugin('board', 'custom/entry.mjs', false)
    fs.mkdirSync(path.join(dir, 'custom'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'custom', 'entry.mjs'), 'export default () => {}')
    expect(pluginAgentExtensionDescriptors()[0]?.entry).toBe(path.join(dir, 'custom', 'entry.mjs'))
  })

  it('清单按插件发现代数缓存：启停后立刻反映', () => {
    writePlugin('board')
    expect(pluginAgentExtensionIds()).toEqual(['board'])
    setPluginEnabled('board', false)
    expect(pluginAgentExtensionIds()).toEqual([])
    setPluginEnabled('board', true)
    expect(pluginAgentExtensionIds()).toEqual(['board'])
  })
})
