import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  coercePluginSettingValue,
  pluginSettingDefaults,
  type PluginManifest,
  type PluginSettingField,
} from '@shared/plugin-manifest'
import { findPlugin } from './plugin-manager'
import { errorMessage } from '@shared/error-message'

/**
 * 插件设置：host-owned 的键值存储。
 *
 * 与 ctx.storage（插件自己的 data.json）的区别是**所有权**：
 * - settings.json 由宿主写入（设置页表单 / 未来的 CLI / 远程下发），插件只读；
 * - data.json 由插件自己增删改，宿主不解释其内容。
 *
 * 分开的好处：插件升级不会覆盖用户设置，设置表单也不会把插件运行时数据打散。
 *
 * 文件：<userData>/plugin-data/<pluginId>/settings.json
 */

type SettingsListener = (pluginId: string, values: Record<string, unknown>) => void

const listeners = new Set<SettingsListener>()

function settingsFile(pluginId: string): string {
  return path.join(app.getPath('userData'), 'plugin-data', pluginId, 'settings.json')
}

function readRaw(pluginId: string): Record<string, unknown> {
  try {
    const file = settingsFile(pluginId)
    if (!fs.existsSync(file)) return {}
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeRaw(pluginId: string, data: Record<string, unknown>): void {
  const file = settingsFile(pluginId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

/** 只保留 schema 里声明过的键，并按类型强制；非法值回落到默认值，不落盘 */
function shape(fields: readonly PluginSettingField[], raw: Record<string, unknown>): Record<string, unknown> {
  const defaults = pluginSettingDefaults(fields)
  const out: Record<string, unknown> = { ...defaults }
  for (const field of fields) {
    if (!(field.key in raw)) continue
    const value = coercePluginSettingValue(field, raw[field.key])
    if (value !== undefined) out[field.key] = value
  }
  return out
}

function fieldsOf(manifest: PluginManifest | null): readonly PluginSettingField[] {
  return manifest?.settings ?? []
}

/** 当前生效值 = 默认值 ⊕ 已存值 */
export function getPluginSettings(pluginId: string): Record<string, unknown> {
  const found = findPlugin(pluginId)
  return shape(fieldsOf(found?.manifest ?? null), readRaw(pluginId))
}

export type SetPluginSettingsResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; error: string }

/** 合并写入（只影响传入的键），返回合并后的完整值 */
export function setPluginSettings(pluginId: string, patch: Record<string, unknown>): SetPluginSettingsResult {
  const found = findPlugin(pluginId)
  if (!found?.manifest) return { ok: false, error: `plugin not found: ${pluginId}` }
  if (fieldsOf(found.manifest).length === 0) return { ok: false, error: 'plugin declares no settings' }
  try {
    const current = readRaw(pluginId)
    const merged = shape(fieldsOf(found.manifest), { ...current, ...patch })
    writeRaw(pluginId, merged)
    for (const listener of listeners) {
      try {
        listener(pluginId, merged)
      } catch (error) {
        console.warn(`[plugin-settings] listener for ${pluginId} failed:`, errorMessage(error))
      }
    }
    return { ok: true, values: merged }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/** 重置为默认值（删除文件即可，读取时回落默认） */
export function resetPluginSettings(pluginId: string): SetPluginSettingsResult {
  const found = findPlugin(pluginId)
  if (!found?.manifest) return { ok: false, error: `plugin not found: ${pluginId}` }
  try {
    fs.rmSync(settingsFile(pluginId), { force: true })
    const values = shape(fieldsOf(found.manifest), {})
    for (const listener of listeners) {
      try {
        listener(pluginId, values)
      } catch {
        /* 监听者失败不影响写入结果 */
      }
    }
    return { ok: true, values }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/** 插件 main 侧订阅设置变更；返回取消函数 */
export function onPluginSettingsChanged(listener: SettingsListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 卸载时清理设置与插件数据（仅在用户确认"同时删除数据"时调用） */
export function purgePluginData(pluginId: string): void {
  const dir = path.join(app.getPath('userData'), 'plugin-data', pluginId)
  fs.rmSync(dir, { recursive: true, force: true })
}
