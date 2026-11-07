import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Notification, app } from 'electron'
import { discoverPlugins, findPlugin, setPluginEnabled } from './plugin-manager'
import { getPluginSettings, onPluginSettingsChanged } from './plugin-settings'
import { askInHost, cancelPluginUIRequests } from './plugin-ui'
import { clearPluginComposerBars, publishPluginComposerBar } from './plugin-composer-bar'
import { publishPluginActivateSession, publishPluginRevealSession } from './plugin-reveal-session'
import type { PluginComposerBarState } from '@shared/plugin-composer-bar'
import type {
  PluginAgentPromptResult,
  PluginAgentPromptSpec,
  PluginAskOptions,
  PluginContext,
  PluginInboxItem,
  PluginInstanceApi,
  PluginModule,
  PluginSessionRunEvent,
} from '@shared/plugin-context'
import { cancelPluginToolCallsFor, pluginToolDescriptors } from './plugin-tools'
import { workerManager } from '../worker-manager'
import { PLUGIN_MESSAGE_CUSTOM_TYPE, type PluginMessageOrigin } from '@shared/plugin-message'
import type { PluginManifest } from '@shared/plugin-manifest'
import type { PluginUIQuestion, PluginUIQuestionnaireResult } from '@shared/plugin-ui'
import { errorMessage } from '@shared/error-message'
import { pushPluginInbox } from '../completion-notification'
import { runPromptWithTimeout } from './plugin-agent-prompt'

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
  instance: PluginInstanceApi
  deactivate?: () => unknown
  /**
   * 插件通过 ctx 注册的订阅（设置变更 / 会话运行事件）的解除函数。
   *
   * 为什么必须由宿主登记：插件丢掉了返回值（`ctx.settings.onChange(cb)` 是最自然的写法），
   * 于是每「停用→启用」一次就多一个闭包攥着上一个模块实例——开发期热更十次就是十个，
   * 旧模块永远不会被 GC，旧回调还会继续被调用。宿主统一回收是唯一可靠的兜底。
   */
  disposers: Array<() => void>
}

const active = new Map<string, PluginInstance>()

// 规避 bundler 对动态路径 import() 的静态分析
const dynamicImport = new Function('url', 'return import(url)') as (url: string) => Promise<Record<string, unknown>>

function pluginDataDir(pluginId: string): string {
  return path.join(app.getPath('userData'), 'plugin-data', pluginId)
}

/**
 * 读插件自己的 data.json。
 *
 * 解析失败时**先把坏文件改名留证**再返回空：宿主是 fail-open（读不出来就当空表），
 * 而插件下一次 `storage.set()` 会整份覆盖——不留备份的话，一次半截写盘就能把用户的
 * 任务表永久抹掉，连「原本长什么样」都查不到。
 */
function readStorage(pluginId: string): Record<string, unknown> {
  const file = path.join(pluginDataDir(pluginId), 'data.json')
  try {
    if (!fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (error) {
    console.warn(`[plugin:${pluginId}] data.json unreadable:`, error)
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* 改名也失败就算了，至少别在这里抛 */
    }
    return {}
  }
}

/** 原子写：先落 .tmp 再 rename，避免半个 JSON 留在正式文件名上 */
function writeStorage(pluginId: string, data: Record<string, unknown>): void {
  const dir = pluginDataDir(pluginId)
  const file = path.join(dir, 'data.json')
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

async function runAgentPrompt(opts: PluginAgentPromptSpec): Promise<PluginAgentPromptResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  let session: import('@earendil-works/pi-coding-agent').AgentSession | null = null
  try {
    const pi = await import('@earendil-works/pi-coding-agent')
    const created = await pi.createAgentSession({
      cwd: opts.cwd,
      sessionManager: pi.SessionManager.inMemory(),
    })
    session = created.session
    // 超时语义（含「abort 不抛错」这个坑）在 plugin-agent-prompt.ts，那里有单测
    return await runPromptWithTimeout(session, opts.prompt, timeoutMs)
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

/**
 * 造一份插件 ctx。
 *
 * 返回类型标成 `PluginContext`（`packages/shared/plugin-context.ts`）不是为了好看：
 * 对象字面量的返回位置有 **多余属性检查**，于是「类型里有的成员没实现」和
 * 「实现了类型里没有的成员」都会是编译错误。ctx 是宿主对插件唯一的公开承诺，
 * 让编译器守着它，比让文档守着它可靠。
 *
 * `disposers` 由调用方（activatePlugin）持有并在停用时统一执行：ctx 上任何
 * **注册型**能力都必须把解除函数塞进去，插件侧丢不丢返回值都不影响回收。
 */
function buildContext(pluginId: string, disposers: Array<() => void>): PluginContext {
  /** 登记一个订阅：插件主动解除时同时从登记表里摘掉，避免重复解 */
  const track = (off: () => void): (() => void) => {
    disposers.push(off)
    return () => {
      const index = disposers.indexOf(off)
      if (index >= 0) disposers.splice(index, 1)
      off()
    }
  }
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
        track(
          onPluginSettingsChanged((changedId, values) => {
            if (changedId === pluginId) callback(values)
          }),
        ),
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
        opts?: PluginAskOptions,
      ): Promise<PluginUIQuestionnaireResult> => askInHost(pluginId, questions, opts),
      /**
       * 输入框上方那条托盘。插件推什么、宿主画什么样；bar 传 null 表示这个会话没有东西可显示。
       *
       * 这是插件第一次能主动改 UI（此前只能被 iframe 反向 invoke）。刻意做得很窄：
       * 只有摘要 + 若干行 + 一个右栏面板 id，宿主不解释业务语义，插件也别指望在这里做大版面——
       * 详情仍然归右栏面板。
       */
      setComposerBar: (sessionFile: string, bar: PluginComposerBarState | null): void => {
        const file = String(sessionFile || '').trim()
        if (!file) {
          console.warn(`[plugin:${pluginId}] setComposerBar without sessionFile ignored`)
          return
        }
        publishPluginComposerBar(pluginId, file, bar)
      },
      /**
       * 投一条到顶栏信箱。用于「跑完时用户不在跟前」的提醒（定时任务、监控类）——
       * 系统通知会被忽略，信箱留一条可回看的记录。
       *
       * 不抛错：插件侧（尤其定时任务的后台执行）不该因为一次信箱写入失败而中断。
       */
      inbox: (item: PluginInboxItem): void => {
        const title = String(item?.title ?? '').trim()
        if (!title) {
          console.warn(`[plugin:${pluginId}] ui.inbox ignored: title required`)
          return
        }
        try {
          pushPluginInbox(pluginId, { ...item, title })
        } catch (error) {
          console.warn(`[plugin:${pluginId}] ui.inbox failed:`, error)
        }
      },
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
        handler: (payload: PluginSessionRunEvent) => void,
      ): (() => void) => {
        if (typeof handler !== 'function') throw new Error('sessions.onRunEvent: handler required')
        return track(workerManager.onSessionRunEvent(handler))
      },
      /**
       * 只读预览一段会话到主区域。
       *
       * 失败静默（不抛错）：会话文件多来自一次性 run，过期是常态，插件在轮询里
       * 顺手 reveal 时不该因为目标已删而中断整轮。返回值只表达「路径可用」，
       * 供插件决定要不要提示「会话已过期」。
       */
      reveal: async (sessionFile: string): Promise<boolean> => {
        return publishPluginRevealSession(pluginId, sessionFile)
      },
      /**
       * 切到一段会话：在当前工作区侧栏就正常激活（可写、绑 worker），不在
       * （子会话、跨工作区）才退化为只读预览。
       *
       * 与 reveal 的分工：reveal 是「看一眼」，activate 是「回去」——插件面板的
       * 「返回主会话」用它。校验与静默语义同 reveal。
       */
      activate: async (sessionFile: string): Promise<boolean> => {
        return publishPluginActivateSession(pluginId, sessionFile)
      },
    },
    log: (...args: unknown[]): void => console.log(`[plugin:${pluginId}]`, ...args),
  }
}

/**
 * 插件目录里所有文件的最新 mtime。
 *
 * Node 的 ESM 缓存以 URL 为键，热重载靠把版本号编进 import query 实现。版本必须
 * 取**整个插件目录**的最大 mtime 而不只是入口文件：插件的 main 会把相对导入解析成
 * 不带 query 的子模块 URL，只按入口 bust 时，「改了 lib、没改 main」的热更会拿到
 * 旧子模块——新旧两代模块同进程并存，是比完全旧更难查的错。插件侧的约定是入口
 * 把自己的 `?v=` 透传给每个动态导入（见 background-tasks 的 main.mjs 顶部注释），
 * 这里给入口一个目录级版本，透传下去就等于整个目录都被 bust 了。
 */
function pluginDirVersion(dir: string): number {
  let latest = 0
  const walk = (current: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of entries) {
      if (item.name === 'node_modules' || item.name === '.git') continue
      const full = path.join(current, item.name)
      if (item.isDirectory()) {
        walk(full)
        continue
      }
      try {
        latest = Math.max(latest, fs.statSync(full).mtimeMs)
      } catch {
        /* 刚好被删掉的文件不参与定版 */
      }
    }
  }
  walk(dir)
  return latest
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
  const disposers: Array<() => void> = []
  try {
    // 版本取目录最大 mtime（见 pluginDirVersion），入口把自己的 ?v= 透传给
    // 子模块后，「停用 → 启用」就能让整个插件目录都拿到新模块，不必重启应用。
    const version = pluginDirVersion(found.dir)
    // 用 pathToFileURL 而不是手拼 `file://` + 分隔符替换：插件目录来自用户
    // userData（可能是 `C:\Users\张三\...`），路径里出现 `#`/`?` 时手拼的串会被
    // URL 解析成 fragment/query，import 直接找不到文件。pathToFileURL 负责转义。
    const url = `${pathToFileURL(entryPath).href}?v=${version}`
    const mod = (await dynamicImport(url)) as PluginModule
    const ctx = buildContext(pluginId, disposers)
    // 插件可以只做副作用（定时器、订阅）而不返回 invoke，所以 `?? {}` 是正当的
    const instance = (await mod.activate?.(ctx)) ?? {}
    active.set(pluginId, {
      manifest,
      dir: found.dir,
      instance,
      deactivate: () => mod.deactivate?.(),
      disposers,
    })
    return { ok: true }
  } catch (error) {
    // 激活失败：ctx 可能已经登记过订阅，别把孤儿闭包留在宿主里
    disposeAll(disposers)
    console.error(`[plugin-host] activate ${pluginId} failed:`, error)
    return { ok: false, error: errorMessage(error) }
  }
}

function disposeAll(disposers: Array<() => void>): void {
  for (const dispose of disposers.splice(0)) {
    try {
      dispose()
    } catch (error) {
      console.warn('[plugin-host] dispose failed:', error)
    }
  }
}

export async function deactivatePlugin(pluginId: string): Promise<void> {
  const instance = active.get(pluginId)
  if (!instance) return
  active.delete(pluginId)
  // 先让插件自己收尾再回收订阅：插件的 deactivate 里可能还要读设置、停子进程。
  // 必须 await——开发期「停用→启用」用的就是这条路径，异步清理没跑完就 re-activate
  // 会和它抢同一份磁盘状态。
  try {
    await instance.deactivate?.()
  } catch (error) {
    console.warn(`[plugin-host] deactivate ${pluginId} failed:`, error)
  }
  // 插件自己解不解订阅都无所谓，这里统一收：漏一个就是一次模块实例泄漏
  disposeAll(instance.disposers)
  // 停用即收回它伸出去的手：挂着的对话框与会话里的工具调用都该结束，别把用户卡在弹窗里
  cancelPluginUIRequests(pluginId)
  cancelPluginToolCallsFor(pluginId)
  // 它推着的托盘也一样：插件都没了，输入框上方不该留一条没人再更新的摘要
  clearPluginComposerBars(pluginId)
}

/** 启停：更新持久化状态并 activate / deactivate */
export async function applyPluginEnabled(pluginId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  setPluginEnabled(pluginId, enabled)
  if (enabled) return activatePlugin(pluginId)
  await deactivatePlugin(pluginId)
  return { ok: true }
}

/** 启动时激活所有 enabled 插件（逐个隔离失败） */
export async function activateEnabledPlugins(): Promise<void> {
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
  const root = path.resolve(found.dir)
  const full = path.resolve(root, entry)
  // 防路径穿越：不能用 startsWith 比前缀——`../bg-evil/x` 解析后是 `<父目录>/bg-evil/x`，
  // 仍然以 `/plugins/bg` 开头。relative 出来以 .. 开头才是真的出界（Windows 上大小写
  // 不同也不会误判，因为两边都由 path.resolve 归一化了）。
  const rel = path.relative(root, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
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
