/**
 * 插件 main 侧上下文（`ctx`）的权威契约。
 *
 * 为什么这个文件必须存在：插件的 `main.mjs` 是**无类型 ESM**，ctx 的形状此前只活在
 * `doc/dev/plugin-host-api.md` 的表格和 `buildContext()` 返回的对象字面量里。宿主没有任何
 * 能被编译器读取的声明，于是「宿主能提供什么」只能靠人记——本仓库两次契约事故
 * （工具 schema 漏参数、冷启动会话缺插件工具）根因都在这里。
 *
 * 现在的关系是单向的：
 *   - 宿主：`buildContext(...): PluginContext`，少一个成员、多一个成员都是编译错误；
 *   - 插件：`plugins/plugin-sdk.d.ts` 原样转出这份声明，JS 里 JSDoc 就能拿到补全；
 *   - 文档：`plugin-host-api.md` 的 ctx 表必须与这里逐项对应（有契约测试守着）。
 *
 * 增删成员时的规矩：**先改这里，再改实现，最后改文档**。顺序反了就会留下
 * 「文档承诺了、运行时没有」的窟窿，而这类窟窿只有在用户实测时才会暴露。
 */

import type { RunEvent } from './app-events'
import type { PluginComposerBarState } from './plugin-composer-bar'
import type { PluginMessageOrigin } from './plugin-message'
import type { PluginUIQuestion, PluginUIQuestionnaireResult } from './plugin-ui'

/** 按插件隔离的 JSON 小状态（`plugin-data/<id>/data.json`）。大文件走 ctx.dataDir */
export interface PluginStorage {
  get(): Record<string, unknown>
  set(data: Record<string, unknown>): void
}

/**
 * manifest `settings[]` 的只读视图。
 *
 * 写入只发生在宿主侧（设置页表单 / 重置），插件不直接改——否则界面上的开关与插件
 * 内部状态会各说各话。
 */
export interface PluginSettingsView {
  get(): Record<string, unknown>
  /**
   * 设置变更回调。返回解除函数；即使插件丢掉它，宿主也会在停用时统一回收，
   * 所以热更不会累积闭包。
   */
  onChange(callback: (values: Record<string, unknown>) => void): () => void
}

/**
 * 会话运行阶段。直接取宿主 run 事件的 phase，**别在插件里另造一套词**——
 * 宿主只发这六个值（注意 `state` 也在内，它表示只同步了状态而非一轮开始/结束）。
 */
export type PluginSessionRunPhase = RunEvent['phase']

/** `ctx.sessions.onRunEvent` 的回调载荷 */
export interface PluginSessionRunEvent {
  /** 事件所属会话的绝对路径（宿主已归一化） */
  sessionFile: string
  phase: PluginSessionRunPhase
  /** 该会话 worker 的当前工作目录，不一定等于 workspace 根（切过 worktree 会变） */
  cwd: string
}

/**
 * 投递方式：
 * - `steer`：插话。会话正在跑就在下一个工具调用边界插入，空闲就立即开一轮；
 * - `followUp`：排队，等这一轮结束后再开；
 * - `nextTurn`：更晚，宿主自行决定时机。
 */
export type PluginDeliverAs = 'steer' | 'followUp' | 'nextTurn'

/** `ctx.sessions.send` 的参数 */
export interface PluginSendSpec {
  /** 目标会话的绝对路径。工具调用里拿到的 sessionFile 可直接用 */
  sessionFile: string
  content: string
  /**
   * 界面上的来源标注。不给就等于「用户自己说的话」，几乎总是应该给——
   * 时间线上会渲染成转述行而不是用户气泡。
   */
  origin?: PluginMessageOrigin
  deliverAs?: PluginDeliverAs
}

/**
 * 向**用户自己的宿主会话**投递消息并驱动一轮。
 *
 * 与 `runAgentPrompt` 的区别是「落在哪」：那个另起一个 inMemory 会话，用户看不见、
 * 历史不连续；这个接上用户正在用的上下文。结果必须回到对话里时走这条。
 */
export interface PluginSessions {
  /**
   * 投递一条消息。
   *
   * 宿主保证：目标会话没有活 worker 时按会话 cwd 冷启动；投递前补发插件工具目录
   * （否则模型调不到本插件的工具）；空闲首轮补齐 system。投递是「定向到会话」而不是
   * 「定向到前台」，用户切到别的会话不影响。
   */
  send(spec: PluginSendSpec): Promise<void>
  /**
   * 订阅会话运行事件。用途是**决定投递语义**（忙时排队、闲时插话），不是判断
   * 「要不要投递」——`send` 自己处理忙闲。返回解除函数，停用时宿主也会兜底回收。
   */
  onRunEvent(handler: (payload: PluginSessionRunEvent) => void): () => void
}

/** `ctx.ui.ask` 的选项 */
export interface PluginAskOptions {
  /** 超时后按「取消」返回，不抛错 */
  timeoutMs?: number
  /** 外部中止（插件停用 / 工具调用被 Esc） */
  signal?: AbortSignal
}

/** 插件 → 宿主的界面能力 */
export interface PluginUI {
  /**
   * 弹宿主问卷并等用户作答（复用 QuestionnaireDialog：键盘导航、选项预览都是白拿的）。
   * 用户取消时返回 `{ cancelled: true, answers: [] }`，不抛错。
   */
  ask(questions: PluginUIQuestion[], opts?: PluginAskOptions): Promise<PluginUIQuestionnaireResult>
  /**
   * 往输入框上方那条托盘推摘要；`null` = 本插件在这个会话没话说（托盘随之消失，不留空壳）。
   *
   * 宿主原生渲染，没有 iframe。插件只说「说什么」，宿主决定「长什么样」——所以
   * 状态词是观感（active/ok/error/idle/warn）而不是业务状态。详情放右栏面板。
   */
  setComposerBar(sessionFile: string, bar: PluginComposerBarState | null): void
}

/** `ctx.runAgentPrompt` 的参数 */
export interface PluginAgentPromptSpec {
  /** 会话工作目录。传任务自己的 cwd，别传应用目录 */
  cwd: string
  prompt: string
  /** 默认 10 分钟；超时通过 abort 中止，返回 `{ ok: false }` 而不是抛错 */
  timeoutMs?: number
}

export type PluginAgentPromptResult = { ok: true; text: string } | { ok: false; error: string }

/**
 * 插件 main 侧能拿到的全部能力。
 *
 * 设计原则：**窄**。ctx 每多一个成员，就是宿主多背一份向后兼容的责任。这里只放
 * 「插件自己做不到、必须宿主代劳」的事——能靠 `node:fs` 做的（读文件、起进程）
 * 一律不给 API，插件直接用 Node。
 */
export interface PluginContext {
  /** manifest 里的 id。不要自己写死字符串常量，插件改名时会漏 */
  readonly pluginId: string
  /**
   * 插件的私有可写目录（`<userData>/plugin-data/<id>`，激活时已创建）。
   *
   * 日志、缓存、下载这类体积内容必须落这里：安装目录可能只读（内置插件），
   * 会话工作区是用户的、不该被插件弄脏。
   */
  readonly dataDir: string
  readonly storage: PluginStorage
  readonly settings: PluginSettingsView
  readonly ui: PluginUI
  readonly sessions: PluginSessions
  /** 系统通知（点击聚焦应用）。不支持通知的平台上静默忽略 */
  notify(title: string, body?: string): void
  /**
   * 起一个**独立 inMemory 会话**跑一次 prompt，阻塞到结束。用户看不见、历史不连续。
   * 适合「定时跑一段无关的活」；结果要回到对话里就用 `sessions.send`。
   */
  runAgentPrompt(spec: PluginAgentPromptSpec): Promise<PluginAgentPromptResult>
  /** 带 `[plugin:<id>]` 前缀的日志。插件里的 console.log 很难认领，用这个 */
  log(...args: unknown[]): void
}

/**
 * `invoke(method, params)` 的处理函数。
 *
 * 插件常见写法是 `invoke: async (method, params) => { switch (method) { ... } }`；
 * 返回同步值也可以，宿主会 await。
 */
export type PluginInvokeHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>

/** `activate()` 的返回值：把 invoke 交给宿主，面板/工具才能调到插件 */
export interface PluginInstanceApi {
  invoke?: PluginInvokeHandler
}

/** 插件 main.mjs 的模块形状（ESM） */
export interface PluginModule {
  activate?(ctx: PluginContext): PluginInstanceApi | void | Promise<PluginInstanceApi | void>
  deactivate?(): unknown
}

/**
 * `invoke('tool.execute', params)` 的参数。
 *
 * `sessionFile` / `cwd` 是**发起这次工具调用的会话**透传下来的——插件在 main 侧
 * 本来拿不到，需要「把结果送回发起它的会话」时全靠这两个字段。
 */
export interface PluginToolExecuteParams {
  /** manifest `tools[]` 里的工具名 */
  name: string
  /** 模型给的参数。**只有 manifest schema 里声明过的键才会到** */
  args: Record<string, unknown>
  sessionFile?: string
  /** worker 当前工作目录，不保证等于会话 workspace 根 */
  cwd?: string
  /** 用户 Esc 或 20 分钟超时会触发；长任务应监听它尽早收尾 */
  signal?: AbortSignal
}
