import fs from 'node:fs'
import { BrowserWindow, type WebContents } from 'electron'

/**
 * 会话文件的增量监听：预览一段正在跑的会话时，让新内容自己长出来。
 *
 * 为什么需要（而不是让 renderer 轮询）：预览的目标通常是**别的进程正在写**的会话
 * （子代理 / 另一个窗口），renderer 无从知道它何时写、写了几次。轮询文件大小能把
 * 延迟摊平，但代价是空转 IO；而 main 侧本来就有 fs 权限，watch 一下就只在该动的
 * 时候通知。
 *
 * 为什么只推「变了」而不推内容：jsonl → TimelineItem 的归一化只存在于 renderer 的
 * `hydrateSessionView` 链路里（merge / 投影 / 流式拼接一整套）。在这里再实现一遍
 * 解析等于开第二条真相，两边早晚不一致。这里只负责说「文件变了、现在是多大」，
 * renderer 决定要不要重读——它已经知道怎么读。
 *
 * 节流：一次工具调用的写入常伴随多次 append，逐次通知会让 renderer 反复重读。
 * 250ms 合并一次，肉眼仍是「实时」。
 */

/** 推给 renderer 的载荷（不含内容，只有「变了」这件事） */
export type SessionTailEvent = {
  sessionFile: string
  /** 变化后的文件大小 */
  size: number
  /**
   * 文件变小了：被重写 / 回退 / 换了分支。
   * renderer 收到后应当整段重读而不是当追加，否则会留下幽灵行。
   */
  truncated: boolean
}

const TAIL_CHANNEL = 'ipc:session-tail'
/** 兜底轮询间隔：Windows 上 fs.watch 偶有丢事件，只靠它会「卡住不动」 */
const DEFAULT_POLL_MS = 1200
/** 合并窗口：一次写入的多次 append 只推一次 */
const DEFAULT_DEBOUNCE_MS = 250

type Entry = {
  sessionFile: string
  subscribers: Set<number>
  watcher: fs.FSWatcher | null
  poller: NodeJS.Timeout | null
  flushTimer: NodeJS.Timeout | null
  lastSize: number
  /** watch 不可用（WSL/UNC）时只靠轮询，别在日志里反复喊 */
  watchFailed: boolean
}

const entries = new Map<string, Entry>()
let pollMs = DEFAULT_POLL_MS
let debounceMs = DEFAULT_DEBOUNCE_MS

function sizeOf(file: string): number | null {
  try {
    return fs.statSync(file).size
  } catch {
    return null
  }
}

function sendersOf(entry: Entry): WebContents[] {
  const out: WebContents[] = []
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const contents = win.webContents
    if (!contents.isDestroyed() && entry.subscribers.has(contents.id)) out.push(contents)
  }
  return out
}

function pruneDeadSubscribers(entry: Entry): void {
  const alive = new Set<number>()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const contents = win.webContents
    if (!contents.isDestroyed() && entry.subscribers.has(contents.id)) alive.add(contents.id)
  }
  entry.subscribers = alive
}

function emit(entry: Entry): void {
  pruneDeadSubscribers(entry)
  if (entry.subscribers.size === 0) {
    drop(entry.sessionFile)
    return
  }
  const size = sizeOf(entry.sessionFile)
  if (size == null) {
    // 文件被删：停止盯一个不存在的东西，但保留订阅关系——文件可能被原子写回来
    // （`.tmp` + rename 的窗口里 stat 会短暂失败）。
    entry.lastSize = 0
    return
  }
  const truncated = size < entry.lastSize
  if (size === entry.lastSize && entry.lastSize > 0) return
  entry.lastSize = size
  const payload: SessionTailEvent = { sessionFile: entry.sessionFile, size, truncated }
  for (const sender of sendersOf(entry)) sender.send(TAIL_CHANNEL, payload)
}

function scheduleFlush(entry: Entry): void {
  if (entry.flushTimer) return
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null
    emit(entry)
  }, debounceMs)
  // 定时器不该拖住进程退出
  entry.flushTimer.unref?.()
}

function ensureEntry(sessionFile: string): Entry {
  const existing = entries.get(sessionFile)
  if (existing) return existing
  const entry: Entry = {
    sessionFile,
    subscribers: new Set(),
    watcher: null,
    poller: null,
    flushTimer: null,
    lastSize: sizeOf(sessionFile) ?? 0,
    watchFailed: false,
  }
  try {
    entry.watcher = fs.watch(sessionFile, { persistent: false }, () => scheduleFlush(entry))
    // watch 的错误是异步的（文件被删 / 权限变化），静默降级到轮询
    entry.watcher.on('error', () => {
      entry.watchFailed = true
      try {
        entry.watcher?.close()
      } catch {
        /* 已经关了 */
      }
      entry.watcher = null
    })
  } catch {
    entry.watchFailed = true
  }
  entry.poller = setInterval(() => {
    // 轮询只看大小：watch 正常时它就是双保险，watch 挂了它就是唯一信号源
    const size = sizeOf(entry.sessionFile)
    if (size == null) return
    if (size !== entry.lastSize) scheduleFlush(entry)
  }, pollMs)
  entry.poller.unref?.()
  entries.set(sessionFile, entry)
  return entry
}

function drop(sessionFile: string): void {
  const entry = entries.get(sessionFile)
  if (!entry) return
  entries.delete(sessionFile)
  if (entry.flushTimer) clearTimeout(entry.flushTimer)
  if (entry.poller) clearInterval(entry.poller)
  try {
    entry.watcher?.close()
  } catch {
    /* 忽略：已经关了 */
  }
}

/** 订阅某段会话的变化。同一 webContents 重复订阅幂等。 */
export function subscribeSessionTail(sessionFile: string, sender: WebContents): void {
  const file = String(sessionFile || '').trim()
  if (!file || sender.isDestroyed()) return
  ensureEntry(file).subscribers.add(sender.id)
}

/** 退订。最后一个订阅者离开时释放句柄（否则 watch 会一直挂着，切走的会话仍在耗 IO）。 */
export function unsubscribeSessionTail(sessionFile: string, sender: WebContents): void {
  const file = String(sessionFile || '').trim()
  const entry = entries.get(file)
  if (!entry) return
  entry.subscribers.delete(sender.id)
  if (entry.subscribers.size === 0) drop(file)
}

/**
 * 窗口关闭 / reload：它的所有订阅都失效了。
 *
 * 传对象只适用于「sender 还活着」的场景（unsubscribe、手动清理）。`destroyed` 事件过后
 * WebContents 已经失效，连 `.id` 都会抛 "Object has been destroyed" —— 那种场合调用方
 * 必须在销毁前把 id 取好，改走 {@link releaseSessionTailsForSenderId}。
 */
export function releaseSessionTailsForSender(sender: WebContents): void {
  releaseSessionTailsForSenderId(sender.id)
}

/**
 * 按 webContents id 收回订阅。
 *
 * 存在的理由是一次真实事故：`webContents.on('destroyed', () => win.webContents)` 在
 * 退出时抛 `TypeError: Object has been destroyed`，撞上全局 uncaughtException 兜底弹了个
 * 错误框，而 `app.exit(0)` 紧接着就把进程收掉了 —— 用户只看到「退出时闪一下报错」，
 * 日志里也来不及留下什么。所以销毁后的回调只能碰 id，不能碰对象。
 */
export function releaseSessionTailsForSenderId(senderId: number): void {
  for (const [file, entry] of [...entries]) {
    entry.subscribers.delete(senderId)
    if (entry.subscribers.size === 0) drop(file)
  }
}

/** 应用退出前清理（测试也用它重置全局状态） */
export function shutdownSessionTails(): void {
  for (const file of [...entries.keys()]) drop(file)
}

/** @internal 测试专用：缩短节流与轮询，避免用例等真实的 1.2 秒 */
export function setSessionTailTimingForTests(opts: { pollMs?: number; debounceMs?: number }): void {
  pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
}

/** @internal 测试专用：当前活跃的监听数（断言句柄释放） */
export function activeSessionTailCount(): number {
  return entries.size
}
