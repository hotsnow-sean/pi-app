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
  /**
   * 把一段会话**只读预览**到主区域（`openSessionPreview` 语义）。
   *
   * 用途是「我在这条记录上看到有个子会话，想看看它到底在干什么」。刻意只做预览：
   * 不绑定 worker、不能对它发提示词——那等于让插件获得指挥用户会话的能力，
   * 超出观测层的定位。用户想接手，自己从侧栏切过去。
   *
   * 传绝对路径（插件一般从工具 details 或事件载荷里拿到）。文件不存在/已过期时
   * 静默不动，不抛错：这类会话多来自一次性 run，过期是常态，插件不该为此报错。
   *
   * @returns 路径看起来可用（已发起导航）为 true；路径非法/文件已不存在为 false。
   * 只校验「这段会话还在不在」，不保证用户真的看到了——导航是异步的，用户可能
   * 立刻切走。插件拿它来决定是否提示「会话已过期」，别拿它判断 UI 状态。
   */
  reveal(sessionFile: string): Promise<boolean>

  /**
   * **切到**一段会话（「回去」，与 reveal 的「看一眼」相对）。
   *
   * 目标会话在当前工作区侧栏里 → 正常激活（可写、绑 worker，和用户自己点侧栏
   * 一样）；不在（子代理的子会话、跨工作区）→ 退化为只读预览——那段会话本来
   * 就没法作为普通会话打开。
   *
   * 典型用途：面板从「主会话点进了子会话预览」回来时，用 activate 回主会话，
   * 用户拿到的是可写的对话，而不是又一个预览。
   *
   * 校验与静默语义同 reveal：路径不合规/文件不存在返回 false，不抛错。
   */
  activate(sessionFile: string): Promise<boolean>
}

/** `ctx.ui.ask` 的选项 */
export interface PluginAskOptions {
  /** 超时后按「取消」返回，不抛错 */
  timeoutMs?: number
  /** 外部中止（插件停用 / 工具调用被 Esc） */
  signal?: AbortSignal
}

/**
 * 信箱条目的观感。宿主只拿它挑图标与颜色，**不解释业务语义**——和托盘那套
 * （`PluginComposerBarState.state`）是同一个原则：插件说观感，宿主决定长什么样。
 */
export type PluginInboxTone = 'info' | 'success' | 'warn' | 'error'

/**
 * 点信箱条目跳到哪。
 *
 * 两个落点二选一，语义不同：
 * - `viewId`：占满中间列的插件视图（manifest `views[].id`）。适合「需要宽度」的详情。
 * - `panelId`：右栏页签（manifest `panels[].id`，写**插件自己的** id，不用拼 `plugin:` 前缀）。
 *   适合「顺手看一眼」——用户当前在对话里，不该被一整页顶掉。两者都传时以 `panelId`
 *   为准：右栏更轻，而右栏里通常就带着通往中央视图的入口。
 *
 * 注意右栏面板是**会话的附属物**（内容通常跟着当前会话变）。所以想让用户看到「某会话的
 * 子代理」，正确做法是给条目挂 `PluginInboxItem.sessionFile` 先回到那段对话，右栏自然
 * 跟着到那个会话；单独 `panelId` 只适合与具体会话无关的全局面板。
 *
 * 与 `sessionFile` 同时给时的优先级：**会话 → 右栏面板**。`viewId` 会被忽略（否则
 * 插件页立刻顶掉刚打开的会话），`panelId` 照常叠加。
 */
export interface PluginInboxTarget {
  pluginId: string
  viewId?: string
  panelId?: string
}

/**
 * 投进宿主信箱的一条。
 *
 * 定位是「值得你知道的一次事件」，不是归档：宿主信箱是 main 侧的内存数组
 * （重启即空，上限 200 条），完整历史必须留在插件自己的存储里，条目点开只是
 * 回去看现场（那段会话 / 那个插件页）。所以标题一行、正文一两句，别把结果全文塞进来。
 */
export interface PluginInboxItem {
  /** 一行标题。宿主会截断，别放长句 */
  title: string
  /** 摘要（一两句）。详情归插件视图 */
  body?: string
  /** 观感；缺省按 info */
  tone?: PluginInboxTone
  /**
   * 这条记录属于哪段会话（绝对路径）。
   *
   * 两个作用，都很实在：
   * - **未读判定**：用户正看着这段会话时，条目直接算已读（和宿主的完成卡同一套规则）；
   * - **点击落点**：点开先回到这段对话，再看 `target` 决定要不要顺手亮右栏面板。
   *
   * 子代理、定时任务这类「由会话产生的事件」都应该带它。不携带的条目是纯插件级
   * 通知（比如「插件需要重新配置」），点开只会到插件页。
   *
   * 文件已不存在时点击会提示「会话已不存在」（不抛错，条目本身照常保留）。
   */
  sessionFile?: string
  /**
   * 点击后跳到哪。**不传也能用**——条目照常进信箱、照常标已读，
   * 只是点不动（未读红点仍然会提醒）。
   */
  target?: PluginInboxTarget
  /**
   * 同一个 key 只保留最新一条。不传 = 每次都新增一条。
   *
   * 定时任务按任务 id 去重：每分钟跑一次的监控任务不该把 200 格信箱刷满。
   */
  dedupeKey?: string
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
  /**
   * 投一条到顶栏信箱（与「一轮跑完」的完成卡同一个信箱、同一个未读红点）。
   *
   * 用途是**跨会话、跨时间**的提醒：定时任务、监控类插件跑完时用户可能正在
   * 干别的事，弹系统通知会被忽略，信箱留一条「值得你知道」的记录更可靠。
   * 条目不落盘（重启即空），所以别把它当历史——历史留在插件自己的存储里。
   *
   * 不抛错：参数不合法（缺 title）时只打日志。宿主信箱满了自然淘汰最旧的。
   */
  inbox(item: PluginInboxItem): void
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
