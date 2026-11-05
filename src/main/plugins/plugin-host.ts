import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Notification, app } from 'electron'
import { findPlugin, setPluginEnabled } from './plugin-manager'
import { getPluginSettings, onPluginSettingsChanged } from './plugin-settings'
import { askInHost, cancelPluginUIRequests } from './plugin-ui'
import { cancelPluginToolCallsFor, pluginToolDescriptors } from './plugin-tools'
import { workerManager } from '../worker-manager'
import { PLUGIN_MESSAGE_CUSTOM_TYPE, type PluginMessageOrigin } from '@shared/plugin-message'
import type { PluginManifest } from '@shared/plugin-manifest'
import type { PluginUIQuestion, PluginUIQuestionnaireResult } from '@shared/plugin-ui'
import { errorMessage } from '@shared/error-message'

/**
 * 插件 main 侧宿主：动态加载 main.mjs，注入受控 API（ctx），转发 invoke。
 *
 * 插件入口约定（ESM）：
 *   export async function activate(ctx) → 可返回 { invoke(method, params) }
 *   export async function deactivate()  → 可选
 *
 * 第一版 ctx：
 *   - storage.get() / storage.set(data)   按插件隔离的 JSON 存储
 *   - notify(title, body)                 系统通知
 *   - runAgentPrompt({ cwd, prompt })     headless 执行一次 agent prompt
 *   - log(...args)                        带插件前缀的日志
 */

type PluginInstance = {
  manifest: PluginManifest
  dir: string
  instance: { invoke?: (method: string, params: Record<string, unknown>) => Promise<unknown> }
  deactivate?: () => unknown
}

const active = new Map<string, PluginInstance>()

// 规避 bundler 对动态路径 import() 的静态分析
const dynamicImport = new Function('url', 'return import(url)') as (url: string) => Promise<Record<string, unknown>>

function pluginDataDir(pluginId: string): string {
  return path.join(app.getPath('userData'), 'plugin-data', pluginId)
}

function readStorage(pluginId: string): Record<string, unknown> {
  try {
    const file = path.join(pluginDataDir(pluginId), 'data.json')
    if (!fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeStorage(pluginId: string, data: Record<string, unknown>): void {
  const dir = pluginDataDir(pluginId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data, null, 2))
}

async function runAgentPrompt(opts: {
  cwd: string
  prompt: string
  timeoutMs?: number
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  let session: import('@earendil-works/pi-coding-agent').AgentSession | null = null
  try {
    const pi = await import('@earendil-works/pi-coding-agent')
    const created = await pi.createAgentSession({
      cwd: opts.cwd,
      sessionManager: pi.SessionManager.inMemory(),
    })
    session = created.session
    // PromptOptions 无 signal：超时通过 abort() 中止，prompt 随之返回；race 兜底
    const timer = setTimeout(() => void session?.abort(), timeoutMs)
    try {
      await Promise.race([
        session.prompt(opts.prompt),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`prompt timed out after ${Math.round(timeoutMs / 60_000)} min`)), timeoutMs + 30_000),
        ),
      ])
      return { ok: true, text: session.getLastAssistantText() ?? '' }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  } finally {
    try {
      await session?.dispose()
    } catch {
      /* dispose 二次失败可忽略 */
    }
  }
}

function buildContext(pluginId: string) {
  return {
    pluginId,
    /**
     * 插件的私有目录（`<userData>/plugin-data/<id>`），已确保存在。
     * storage 只存小 JSON；日志、缓存、下载这类体积内容必须落到这里，
     * 不能写安装目录（内置插件可能装在只读位置）也不能写会话工作区。
     */
    dataDir: (() => {
      const dir = pluginDataDir(pluginId)
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {
        /* 建不出来就让调用方在写文件时报错，别在这里炸激活流程 */
      }
      return dir
    })(),
    storage: {
      get: (): Record<string, unknown> => readStorage(pluginId),
      set: (data: Record<string, unknown>): void => writeStorage(pluginId, data),
    },
    /**
     * 声明式设置项（plugin.json 的 settings[]）的只读视图。
     * 写入只发生在宿主侧（设置页表单 / reset），插件不直接改，避免与界面状态打架。
     */
    settings: {
      get: (): Record<string, unknown> => getPluginSettings(pluginId),
      onChange: (callback: (values: Record<string, unknown>) => void): (() => void) =>
        onPluginSettingsChanged((changedId, values) => {
          if (changedId === pluginId) callback(values)
        }),
    },
    notify: (title: string, body?: string): void => {
      try {
        if (!Notification.isSupported()) return
        const n = new Notification({ title, body })
        n.on('click', () => app.focus({ steal: false }))
        n.show()
      } catch (error) {
        console.warn(`[plugin:${pluginId}] notify failed:`, error)
      }
    },
    /**
     * 插件 → 用户的界面请求。目前只有问卷（复用宿主的 QuestionnaireDialog）——
     * 这是"插件工具能在会话里停下来等用户"的前提，也是 ask 那一类插件的全部依赖。
     */
    ui: {
      ask: (
        questions: PluginUIQuestion[],
        opts?: { timeoutMs?: number; signal?: AbortSignal },
      ): Promise<PluginUIQuestionnaireResult> => askInHost(pluginId, questions, opts),
    },
    runAgentPrompt,
    /**
     * 会话：插件向**用户自己的宿主会话**投递消息并驱动一轮。
     *
     * 与 runAgentPrompt 的区别是「落在哪」：runAgentPrompt 另起一个 inMemory 会话，
     * 用户看不见、历史不连续；这里投进用户正在用的那个会话，接上原有上下文。
     * 后台任务的完成回报必须走这条——否则模型得靠用户在两个会话之间人肉转述。
     *
     * 投递是「定向到会话」而不是「定向到前台」：目标会话没有活 worker 时，
     * 宿主按会话 meta.cwd 冷启动，用户切到别的会话不影响投递。
     */
    sessions: {
      send: async (spec: {
        sessionFile: string
        content: string
        origin?: PluginMessageOrigin
        deliverAs?: 'steer' | 'followUp' | 'nextTurn'
      }): Promise<void> => {
        const { sessionFile, content, origin, deliverAs } = spec
        if (!sessionFile?.trim()) throw new Error('sessions.send: sessionFile required')
        if (!content?.trim()) throw new Error('sessions.send: content required')
        // 插件工具目录通常随用户每次 prompt 下发（prompt.send → applyPluginTools）；
        // 但这条链路是 main 直接驱动目标会话（冷启动 worker 不经过 prompt.send），
        // 不补发的话目标会话一个插件工具都没有——回报里让模型调 bg_output 会报
        // "Tool not found"。
        try {
          await workerManager.setPluginTools(pluginToolDescriptors(), sessionFile)
        } catch {
          /* 工具同步失败不拦投递：与 prompt.send 的容错一致 */
        }
        await workerManager.sendCustomPrompt(
          sessionFile,
          {
            customType: PLUGIN_MESSAGE_CUSTOM_TYPE,
            content,
            display: true,
            details: origin,
          },
          { deliverAs },
        )
      },
      /**
       * 订阅会话运行事件（started / running / idle / failed / cancelled）。
       *
       * 用途不是「判断能不能投递」（send 自己处理忙闲），而是决定投递语义：
       * 目标会话正在跑一轮时用 followUp 排队而不是 steer 打断。
       * 返回解除订阅函数——插件停用/重载时必须调用，否则回调悬空。
       */
      onRunEvent: (
        handler: (payload: { sessionFile: string; phase: string; cwd: string }) => void,
      ): (() => void) => {
        if (typeof handler !== 'function') throw new Error('sessions.onRunEvent: handler required')
        return workerManager.onSessionRunEvent(handler)
      },
    },
    log: (...args: unknown[]): void => console.log(`[plugin:${pluginId}]`, ...args),
  }
}

export async function activatePlugin(pluginId: string): Promise<{ ok: boolean; error?: string }> {
  if (active.has(pluginId)) return { ok: true }
  const found = findPlugin(pluginId)
  if (!found || !found.manifest) return { ok: false, error: 'plugin not found' }
  if (!found.enabled) return { ok: false, error: 'plugin disabled' }
  const manifest = found.manifest
  const entry = manifest.main ?? 'main.mjs'
  const entryPath = path.join(found.dir, entry)
  if (!fs.existsSync(entryPath)) {
    // 纯 UI 插件可以没有 main
    return { ok: true }
  }
  try {
    // Node 的 ESM 缓存以 URL 为键：把入口文件的 mtime 编进 query，插件改动后
    // 「停用 → 启用」就能拿到新模块，不必重启应用。
    // 局限：只有入口文件被 bust，相对导入的子模块仍命中缓存——需要热重载的逻辑
    // 请放在入口里；改了子模块仍需重启应用。
    const version = fs.statSync(entryPath).mtimeMs
    const mod = (await dynamicImport(
      `file://${entryPath.split(path.sep).join('/')}?v=${version}`,
    )) as {
      activate?: (ctx: unknown) => Promise<unknown> | unknown
      deactivate?: () => unknown
    }
    const ctx = buildContext(pluginId)
    const instance = (await mod.activate?.(ctx)) ?? {}
    active.set(pluginId, {
      manifest,
      dir: found.dir,
      instance: instance as PluginInstance['instance'],
      deactivate: () => mod.deactivate?.(),
    })
    return { ok: true }
  } catch (error) {
    console.error(`[plugin-host] activate ${pluginId} failed:`, error)
    return { ok: false, error: errorMessage(error) }
  }
}

export function deactivatePlugin(pluginId: string): void {
  const instance = active.get(pluginId)
  if (!instance) return
  active.delete(pluginId)
  // 停用即收回它伸出去的手：挂着的对话框与会话里的工具调用都该结束，别把用户卡在弹窗里
  cancelPluginUIRequests(pluginId)
  cancelPluginToolCallsFor(pluginId)
  try {
    void instance.deactivate?.()
  } catch (error) {
    console.warn(`[plugin-host] deactivate ${pluginId} failed:`, error)
  }
}

/** 启停：更新持久化状态并 activate / deactivate */
export async function applyPluginEnabled(pluginId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  setPluginEnabled(pluginId, enabled)
  if (enabled) return activatePlugin(pluginId)
  deactivatePlugin(pluginId)
  return { ok: true }
}

/** 启动时激活所有 enabled 插件（逐个隔离失败） */
export async function activateEnabledPlugins(): Promise<void> {
  const { discoverPlugins } = await import('./plugin-manager')
  for (const plugin of discoverPlugins()) {
    if (!plugin.manifest || !plugin.enabled) continue
    const r = await activatePlugin(plugin.manifest.id)
    if (!r.ok) console.warn(`[plugin-host] ${plugin.manifest.id} not activated: ${r.error}`)
  }
}

export async function invokePlugin(
  pluginId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const instance = active.get(pluginId)
  if (!instance) return { ok: false, error: `plugin not active: ${pluginId}` }
  if (typeof instance.instance.invoke !== 'function') return { ok: false, error: 'plugin has no invoke handler' }
  try {
    const result = await instance.instance.invoke(method, params)
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/** 插件面板入口 HTML 的绝对路径（protocol.ts 用） */
export function resolvePluginPanelEntry(pluginId: string, entry: string): string | null {
  const found = findPlugin(pluginId)
  if (!found || !found.manifest) return null
  const full = path.resolve(found.dir, entry)
  const root = path.resolve(found.dir)
  if (!full.startsWith(root)) return null // 防路径穿越
  return full
}

export async function readPluginPanelFile(fullPath: string): Promise<{ data: Buffer; mime: string } | null> {
  try {
    const data = await fsp.readFile(fullPath)
    return { data, mime: mimeForPath(fullPath) }
  } catch {
    return null
  }
}

function mimeForPath(p: string): string {
  const ext = path.extname(p).toLowerCase()
  const table: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }
  return table[ext] ?? 'application/octet-stream'
}
