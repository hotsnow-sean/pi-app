// 插件「会话进程入口」注入。
//
// 插件在 plugin.json 里声明 agent（默认 agent.mjs），main 把启用插件的入口清单随 init
// 消息下发，这里把每个入口包成一条 inline extension 交给 pi 的 extensionFactories。
//
// 三条硬约束：
// 1. **绝不影响会话创建**。插件代码是第三方代码，import 失败、factory 抛错、返回垃圾，
//    都必须收敛成一条诊断，而不是让 init 失败（那会让用户整个工作区打不开）。
// 2. **隔离到插件粒度**。一条扩展坏掉只跳过它自己，其它插件与宿主扩展照常。
// 3. **名字带命名空间**。`plugin:<id>`，撞不上宿主扩展名，也方便在启动日志里认人。
//
// 不实现热重载：清单是 worker 启动时的快照，插件启停/改代码要新会话才生效。
// 插件侧写多文件时记得走带 `?v=` 的动态 import 自刷新（见插件文档的热重载铁律）。

import { pathToFileURL } from 'node:url'
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'

export type PluginAgentExtensionSpec = {
  pluginId: string
  /** agent.mjs 绝对路径（main 侧已确认存在） */
  entry: string
  pluginDir: string
  dataDir: string
}

/**
 * 传给插件入口的第二个参数。
 *
 * 为什么不塞进 pi 对象：pi 是 pi 内核的 API，插件在 CLI 里也用它，往里加宿主私货会
 * 让插件分不清"哪些是 pi 给的、哪些只有桌面端有"。单独一个参数，插件一眼能看出依赖。
 */
export type PluginAgentContext = {
  pluginId: string
  pluginDir: string
  dataDir: string
  /** 前缀已带插件 id 的日志函数；写 stdout 会被宿主的 worker 日志收集到 */
  log: (message: string, ...rest: unknown[]) => void
}

let specs: PluginAgentExtensionSpec[] = []

function isSpec(raw: unknown): raw is PluginAgentExtensionSpec {
  const s = raw as Partial<PluginAgentExtensionSpec> | null
  return (
    !!s &&
    typeof s.pluginId === 'string' &&
    typeof s.entry === 'string' &&
    typeof s.pluginDir === 'string' &&
    typeof s.dataDir === 'string'
  )
}

/** main 随 init 下发的清单（非法条目直接丢弃，不做兼容猜测） */
export function setPluginAgentExtensions(raw: unknown): void {
  specs = Array.isArray(raw) ? raw.filter(isSpec) : []
}

/** 测试/诊断：当前生效的插件扩展 */
export function pluginAgentExtensionIds(): string[] {
  return specs.map((s) => s.pluginId)
}

/**
 * 插件入口的模块 URL。
 *
 * 必须走 `pathToFileURL`：插件目录在 userData 下，可能含空格、`#`、中文；
 * 手拼 `file://` 再替换分隔符的写法，遇到 `#` 会被当 fragment、遇到 `?` 会被当 query，
 * 于是「插件目录里有个 # 就再也加载不了」——这类坑排查起来极其费时间。
 */
export function pluginAgentEntryUrl(entry: string): string {
  return pathToFileURL(entry).href
}

/**
 * 加载插件入口。
 *
 * `@vite-ignore` 是给打包器看的：入口是运行期才知道的绝对路径，不能被静态分析。
 * 这里**不用** `new Function('return import(url)')` 那套（plugin-host 里为绕开打包器
 * 用的是它）——在 vitest 的 vm 环境里会报 "A dynamic import callback was not
 * specified"，而这一层的隔离性恰恰靠测试守着。
 */
function loadEntryFromDisk(entry: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ pluginAgentEntryUrl(entry)) as Promise<Record<string, unknown>>
}

/**
 * 加载器可替换**仅为测试**：vite-node 不认 `file://` 形态的 specifier，也不认
 * 绝对路径（会拼成 `/@id/...`），所以测试里换成直接给假模块——被测的是这层包装
 * （吞错、隔离、ctx 传递），不是 Node 的模块解析。
 */
let loadEntry: (entry: string) => Promise<Record<string, unknown>> = loadEntryFromDisk

/** @internal 测试专用 */
export function setPluginAgentExtensionLoader(
  loader: ((entry: string) => Promise<Record<string, unknown>>) | null,
): void {
  loadEntry = loader ?? loadEntryFromDisk
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 生成 inline extension 列表。每次会话创建时调用（factory 逐个在 pi 初始化时执行）。
 *
 * 用 async factory 而不是在这里 await import：pi 的 `ExtensionFactory` 支持
 * `void | Promise<void>`，把加载推迟到 factory 里，加载失败就只死这一条扩展；
 * 若在生成列表时 await，一个坏插件会让整个数组构造抛错，连宿主扩展都没了。
 */
export function pluginAgentExtensions(): InlineExtension[] {
  return specs.map((spec) => {
    const log: PluginAgentContext['log'] = (msg, ...rest) =>
      console.log(`[plugin:${spec.pluginId}] ${msg}`, ...rest)
    return {
      name: `plugin:${spec.pluginId}`,
      hidden: true,
      factory: async (pi: ExtensionAPI): Promise<void> => {
        try {
          const mod = await loadEntry(spec.entry)
          const factory = mod.default
          if (typeof factory !== 'function') {
            log('agent entry has no default export function, skipped')
            return
          }
          const context: PluginAgentContext = {
            pluginId: spec.pluginId,
            pluginDir: spec.pluginDir,
            dataDir: spec.dataDir,
            log,
          }
          await (factory as (api: ExtensionAPI, ctx: PluginAgentContext) => unknown)(pi, context)
        } catch (error) {
          // 这里必须吞掉：插件代码的一半错误会以 rejection 形式冒出来，放出去就是会话创建失败
          log('agent extension failed:', message(error))
        }
      },
    }
  })
}
