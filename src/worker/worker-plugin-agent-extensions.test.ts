import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pluginAgentEntryUrl,
  pluginAgentExtensionIds,
  pluginAgentExtensions,
  setPluginAgentExtensionLoader,
  setPluginAgentExtensions,
} from './worker-plugin-agent-extensions'

/**
 * 插件会话扩展注入的隔离性回归。
 *
 * 这层的唯一职责是「把插件代码塞进会话，但绝不让它拖垮会话」。所以测试的重心不是
 * 功能多全，而是：坏插件（缺默认导出 / 抛错 / 加载失败 / 清单是垃圾）必须全部收敛成
 * 诊断，扩展列表的构造永远成功。
 *
 * 模块加载本身被换成假加载器：被测的是外层包装（吞错、隔离、ctx 传递），而不是
 * Node 的模块解析——真加载的路径形态由 `pluginAgentEntryUrl` 单独守。
 */

type Loaded = Record<string, unknown>

let root: string
/** 每次加载时收到的入口路径，用来断言"交给加载器的是插件的 entry 原样" */
let loadedEntries: string[]

function fakeLoader(module: Loaded | (() => Promise<Loaded>)): void {
  setPluginAgentExtensionLoader(async (entry) => {
    loadedEntries.push(entry)
    return typeof module === 'function' ? module() : module
  })
}

function spec(entry: string, pluginId = 'probe'): Record<string, string> {
  return { pluginId, entry, pluginDir: root, dataDir: path.join(root, 'data') }
}

/** 调一条扩展的 factory（pi 的参数就用空对象：这层不读它） */
async function run(factory: unknown): Promise<void> {
  await (factory as (pi: unknown) => Promise<void>)({})
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-agent-ext-'))
  loadedEntries = []
  setPluginAgentExtensions([])
  fakeLoader({ default: () => {} })
})

describe('setPluginAgentExtensions', () => {
  it('非数组 / 缺字段的条目一律丢弃，不做兼容猜测', () => {
    setPluginAgentExtensions([
      { pluginId: 'a', entry: '/x.mjs', pluginDir: '/', dataDir: '/d' },
      { pluginId: 'b', entry: '/y.mjs' }, // 缺 pluginDir / dataDir
      { pluginId: 'c', entry: 1, pluginDir: '/', dataDir: '/d' },
      null,
      'nope',
    ])
    expect(pluginAgentExtensionIds()).toEqual(['a'])
  })

  it('非数组输入 = 清空', () => {
    setPluginAgentExtensions([spec('/x.mjs')])
    setPluginAgentExtensions(undefined)
    expect(pluginAgentExtensionIds()).toEqual([])
  })
})

describe('pluginAgentExtensions', () => {
  it('没有插件时不产生任何扩展', () => {
    expect(pluginAgentExtensions()).toEqual([])
  })

  it('扩展名带 plugin: 前缀且 hidden（不占启动列表）', () => {
    setPluginAgentExtensions([spec('/a.mjs', 'board')])
    const ext = pluginAgentExtensions()[0] as { name: string; hidden?: boolean }
    expect(ext.name).toBe('plugin:board')
    expect(ext.hidden).toBe(true)
  })

  it('把 pi 与插件上下文一起交给入口，入口路径原样转发', async () => {
    const entry = path.join(root, 'ok.mjs')
    setPluginAgentExtensions([spec(entry, 'board')])
    let seen: Record<string, unknown> = {}
    fakeLoader({
      default: (pi: unknown, ctx: { pluginId: string; pluginDir: string; dataDir: string }) => {
        seen = { hasPi: !!pi, pluginId: ctx.pluginId, pluginDir: ctx.pluginDir, dataDir: ctx.dataDir }
      },
    })

    await run((pluginAgentExtensions()[0] as { factory: unknown }).factory)

    expect(seen).toEqual({
      hasPi: true,
      pluginId: 'board',
      pluginDir: root,
      dataDir: path.join(root, 'data'),
    })
    expect(loadedEntries).toEqual([entry])
  })

  it('入口同步抛错被吞掉：会话照常创建，只留日志', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    setPluginAgentExtensions([spec('/boom.mjs')])
    fakeLoader({
      default: () => {
        throw new Error('boom')
      },
    })
    await expect(run((pluginAgentExtensions()[0] as { factory: unknown }).factory)).resolves.toBeUndefined()
    expect(log.mock.calls.some((c) => String(c[0]).includes('agent extension failed'))).toBe(true)
    log.mockRestore()
  })

  it('异步工厂的 rejection 也被吞掉（一半插件错误是这个形状）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    setPluginAgentExtensions([spec('/reject.mjs')])
    fakeLoader({
      default: async () => {
        throw new Error('nope')
      },
    })
    await expect(run((pluginAgentExtensions()[0] as { factory: unknown }).factory)).resolves.toBeUndefined()
    expect(log.mock.calls.some((c) => c.join(' ').includes('nope'))).toBe(true)
    log.mockRestore()
  })

  it('入口没有默认导出函数 → 跳过并记日志', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    setPluginAgentExtensions([spec('/noexport.mjs')])
    fakeLoader({ x: 1 })
    await expect(run((pluginAgentExtensions()[0] as { factory: unknown }).factory)).resolves.toBeUndefined()
    expect(log.mock.calls.some((c) => String(c[0]).includes('no default export'))).toBe(true)
    log.mockRestore()
  })

  it('加载失败 → 跳过，不影响排在后面的插件', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    let second = false
    setPluginAgentExtensions([spec('/missing.mjs', 'gone'), spec('/fine.mjs', 'fine')])
    setPluginAgentExtensionLoader(async (entry) => {
      if (entry === '/missing.mjs') throw new Error('ENOENT')
      return {
        default: () => {
          second = true
        },
      }
    })

    const list = pluginAgentExtensions()
    expect(list).toHaveLength(2)
    await run((list[0] as { factory: unknown }).factory)
    await run((list[1] as { factory: unknown }).factory)
    expect(second).toBe(true)
    log.mockRestore()
  })
})

describe('pluginAgentEntryUrl', () => {
  it('用 file URL 而非手拼字符串：空格、#、中文都不会被解析成 query/fragment', () => {
    const url = pluginAgentEntryUrl(path.join(os.tmpdir(), '张三 的插件', '#agent.mjs'))
    expect(url.startsWith('file:///')).toBe(true)
    expect(url).toContain('%20')
    expect(url).toContain('%23')
    expect(url).not.toContain('#')
  })
})
