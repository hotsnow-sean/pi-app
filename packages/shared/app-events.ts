// AppEvent - Unified event model for Renderer/Main/Worker

import type { CompletionOutcome } from './completion-preview'
import type { AdapterWidgetProjection, AdapterWidgetProtocol } from './adapter-widget'
import type { PluginComposerBarState } from './plugin-composer-bar'
import type { PluginMessageOrigin } from './plugin-message'

export interface AppEventBase {
  seq: number
  workspaceId: string
  sessionId?: string
  /** pi session JSONL path — stable routing key across UI / Worker */
  sessionFile?: string
  runId?: string
  turnId?: string
  timestamp: number
}

export interface MessageEvent extends AppEventBase {
  type: 'message'
  role: 'user' | 'assistant' | 'system'
  phase: 'start' | 'delta' | 'end'
  text?: string
  /** assistant 流：正文 vs 思维链 */
  contentKind?: 'text' | 'thinking'
  /** pi JSONL entry id（跳转 /tree 用） */
  sessionEntryId?: string
  /** 插件投递的消息（sessions.send）：带来源，界面渲染成转述行而不是用户气泡 */
  pluginOrigin?: PluginMessageOrigin
}

export interface ToolEvent extends AppEventBase {
  type: 'tool'
  toolCallId: string
  toolName: string
  phase: 'start' | 'update' | 'end'
  input?: unknown
  output?: unknown
  details?: unknown
  isError?: boolean
}

export interface FileEvent extends AppEventBase {
  type: 'file'
  source: 'edit' | 'write' | 'bash-diff' | 'git'
  path: string
  changeType: 'added' | 'modified' | 'deleted' | 'renamed'
}

export interface RunEvent extends AppEventBase {
  type: 'run'
  phase: 'started' | 'running' | 'idle' | 'failed' | 'cancelled' | 'state'
  model?: string
  thinkingLevel?: string
  /** Thinking levels the session's current model supports (pi `getAvailableThinkingLevels`). */
  availableThinkingLevels?: string[]
  /** Internal lifecycle marker: emitted only from SDK agent_settled. */
  settled?: boolean
  /**
   * SDK could not restore the session's saved model (missing registry entry / auth)
   * and fell back to another model. Surface in UI — do not leave as worker-only log.
   */
  modelFallbackMessage?: string
  usage?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number
  }
  toolStats?: {
    total: number
    running: number
    failed: number
  }
}

export interface CompactionEvent extends AppEventBase {
  type: 'compaction'
  phase: 'start' | 'end'
  tokensBefore?: number
  tokensSaved?: number
  summary?: string
}

/** pi auto-retry of a failed model request (timeout, 5xx…): start of each wait, then end. */
export interface RetryEvent extends AppEventBase {
  type: 'retry'
  phase: 'start' | 'end'
  attempt?: number
  maxAttempts?: number
  delayMs?: number
  errorMessage?: string
}

// B-layer slash command dispatch (R0-1): observable slash execution
export interface SlashEvent extends AppEventBase {
  type: 'slash'
  command: string
  status: 'dispatched' | 'ok' | 'error' | 'info'
  text?: string
}

/** pi AgentSession queue_update：运行中已入队的 steer / follow-up（对齐 TUI 输入框上方淡色展示） */
export interface QueueEvent extends AppEventBase {
  type: 'queue'
  steering: string[]
  followUp: string[]
}

/** Agent 轮次失败 / 中止 / 重试耗尽（时间线 error 卡片） */
export interface AgentErrorEvent extends AppEventBase {
  type: 'agent_error'
  text: string
  kind?: 'error' | 'aborted' | 'retry'
  stopReason?: string
}

/** Worker-owned completion fact. Main is the only delivery-policy owner. */
export interface CompletionEvent extends AppEventBase {
  type: 'completion'
  outcome: CompletionOutcome
  settled: true
  promptPreview?: string
  responsePreview?: string
  durationMs?: number
}

export interface ExtensionWidgetEvent extends AppEventBase {
  type: 'extension_widget'
  phase: 'set' | 'clear'
  widgetKey: string
  adapterId: string
  protocol: AdapterWidgetProtocol
  state?: AdapterWidgetProjection
}

/**
 * 插件托盘：插件 main 主动推给某个会话的输入框上方摘要。
 *
 * 走 app event 而不是 iframe 轮询，是因为这条要「任务状态一变就变」，
 * 而 renderer 没有能力反过来知道 main 何时变了。`bar: null` 表示这个会话没有东西要显示。
 */
export interface PluginWidgetEvent extends AppEventBase {
  type: 'plugin_widget'
  pluginId: string
  bar: PluginComposerBarState | null
}

/**
 * 插件请求宿主打开一段会话（只读预览，不绑定 worker）。
 *
 * 为什么走 app event 而不是 invoke：这是 main → renderer 的单向指令，插件那边
 * 不需要知道结果（它自己的面板还在，切会话不影响它）。反过来让 renderer 轮询
 * 或让插件 iframe 直接调宿主导航，都要求插件理解宿主 UI 状态，越界了。
 *
 * `sessionFile` 是唯一入参：会话 id 由 renderer 侧的 `session.prepare` 换取，
 * main 不替它编一个——会话列表可能在别的窗口 / 别的设备上已经变了。
 */
export interface PluginRevealSessionEvent extends AppEventBase {
  type: 'plugin_reveal_session'
  pluginId: string
  /** 要预览的会话文件绝对路径 */
  sessionFile: string
}

/**
 * 插件请求宿主**切到**一段会话（`ctx.sessions.activate` 的落点）。
 *
 * 与 `plugin_reveal_session` 的区别：reveal 是「看一眼」（恒为只读预览），activate
 * 是「回去」——目标会话在当前工作区侧栏里就正常激活（可写、绑 worker），不在
 * （比如子代理的子会话、跨工作区）才退化为只读预览。插件面板的「返回主会话」
 * 就是它的第一个消费者。
 *
 * 校验与静默语义与 reveal 相同：路径不合规/文件不存在时 main 直接吞掉，renderer
 * 不该收到一次注定失败的导航。
 */
export interface PluginActivateSessionEvent extends AppEventBase {
  type: 'plugin_activate_session'
  pluginId: string
  /** 要切到的会话文件绝对路径 */
  sessionFile: string
}

// SDK 安装进度（设置页 UI 用，与会话无关，不继承 AppEventBase）
export interface SdkInstallProgressEvent {
  type: 'sdk-install-progress'
  version: string
  line?: string
  done?: boolean
  error?: string
}

/** Active SDK changed after a successful install/switch; invalidate SDK-owned projections. */
export interface SdkRuntimeChangedEvent {
  type: 'sdk-runtime-changed'
}

export interface AdapterCatalogChangedEvent {
  type: 'adapter-catalog-changed'
  workspaceId?: string
  revision?: string
}

/** A remote (phone) client changed a setting the renderer caches; reload it. */
export interface RemoteSettingsChangedEvent {
  type: 'remote-settings-changed'
  key: 'capabilities' | 'cacheWarming' | 'sessions' | 'rewound'
  sessionFile?: string
  /** For `sessions`: the workspace whose session list changed. */
  workspaceId?: string
}

export type AppEvent =
  | MessageEvent
  | ToolEvent
  | FileEvent
  | RunEvent
  | CompactionEvent
  | RetryEvent
  | SlashEvent
  | QueueEvent
  | AgentErrorEvent
  | CompletionEvent
  | ExtensionWidgetEvent
  | PluginWidgetEvent
  | PluginRevealSessionEvent
  | PluginActivateSessionEvent
  | SdkInstallProgressEvent
  | SdkRuntimeChangedEvent
  | AdapterCatalogChangedEvent
  | RemoteSettingsChangedEvent

export const APP_EVENT_CHANNEL = 'app:event'
