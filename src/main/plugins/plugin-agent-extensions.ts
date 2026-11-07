import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { discoverPlugins, pluginDiscoveryVersion } from './plugin-manager'

/**
 * 插件「会话进程入口」清单（plugin.json 的 `agent` 字段 → `agent.mjs`）。
 *
 * 为什么需要这一层：有些能力只在会话进程（worker）内成立——pi 扩展的 eventBus、
 * 会话内的扩展状态、worker 内才有的资源。main 进程再怎么有权也够不到，唯一办法
 * 是把插件的一段代码送进 worker，作为 inline extension 参与会话创建。
 *
 * 边界（写代码时守住）：
 * - **只算清单，不加载代码**。main 侧永远不 import 插件的 agent.mjs——那是 worker 的事。
 * - 宿主不认识任何具体插件：这里只处理「谁声明了 agent、文件在哪、数据目录在哪」。
 * - 一个插件坏了只影响它自己（worker 侧逐个 try/catch），清单生成本身不允许抛。
 * - 不热更新：清单随 worker 启动下发，插件启停/改代码后**下次会话（新 worker）生效**。
 *   worker 是长驻的，为这点收益做动态重注入不划算，也不安全（旧实例的订阅收不回来）。
 *
 * WSL 模式下清单会被置空（见 worker-manager-pool）：插件装在 Windows 侧的 userData，
 * WSL 里的 worker 读不到那个路径，硬传只会换来一堆 ENOENT。
 */

export type PluginAgentExtensionDescriptor = {
  pluginId: string
  /** agent.mjs 的绝对路径（已确认存在且未越出插件目录） */
  entry: string
  /** 插件根目录：插件可能要读自己的静态资源 */
  pluginDir: string
  /** 插件私有数据目录，与 main 侧 ctx.dataDir 是同一个目录 */
  dataDir: string
}

/** desktop 的插件数据根：`<userData>/plugin-data/<id>`（与 plugin-host 保持一致） */
function pluginDataDir(pluginId: string): string {
  return path.join(app.getPath('userData'), 'plugin-data', pluginId)
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

let cache: { version: number; descriptors: PluginAgentExtensionDescriptor[] } | null = null

/**
 * 所有启用插件声明的会话扩展入口。
 *
 * 缓存键是插件发现代数（安装/卸载/启停/manifest 变化都会抬代），所以这里不做 TTL。
 * 单个插件的问题只记日志并跳过——设置页的诊断行不因为这个字段就整行消失，
 * 那样用户会以为插件根本没装上。
 */
export function pluginAgentExtensionDescriptors(): PluginAgentExtensionDescriptor[] {
  const version = pluginDiscoveryVersion()
  if (cache && cache.version === version) return cache.descriptors

  const out: PluginAgentExtensionDescriptor[] = []
  for (const plugin of discoverPlugins()) {
    if (!plugin.manifest || !plugin.enabled || !plugin.manifest.agent) continue
    const pluginId = plugin.manifest.id
    const entry = path.resolve(plugin.dir, plugin.manifest.agent.entry)
    if (!isInside(plugin.dir, entry)) {
      console.warn(`[plugin:${pluginId}] agent entry escapes plugin dir: ${entry}`)
      continue
    }
    if (!fs.existsSync(entry)) {
      console.warn(`[plugin:${pluginId}] agent entry not found: ${entry}`)
      continue
    }
    const dataDir = pluginDataDir(pluginId)
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch {
      // 建不出来也要把清单交出去：worker 侧写盘失败时插件自己会报错，比静默不注入更好排查
    }
    out.push({ pluginId, entry, pluginDir: path.resolve(plugin.dir), dataDir })
  }

  cache = { version, descriptors: out }
  return out
}

/** 测试/诊断用：列表里都有谁 */
export function pluginAgentExtensionIds(): string[] {
  return pluginAgentExtensionDescriptors().map((d) => d.pluginId)
}
