import { ipcClient, onSessionTail } from '@renderer/lib/ipc-client'
import { sessionFilesEqual } from '@renderer/lib/session-file-key'
import { hydrateSessionView } from '@renderer/lib/session-shell'
import { clearSessionHistoryCache } from '@renderer/lib/session-history'
import { useUIStore } from '@renderer/stores/ui-store'

/**
 * 预览中的会话「自己长出来」。
 *
 * 预览态（`openSessionPreview`）不绑定 worker，所以没有任何事件流告诉我们对方又说了
 * 什么——内容只在磁盘上。这里让 main 盯文件（`session-tails.ts`），变了就通知，
 * 回来重读一遍磁盘尾巴。
 *
 * 为什么重读整段尾巴而不是增量追加：jsonl → 时间线的归一化（合并、投影、流式拼接）
 * 全在 `hydrateSessionView` 里，而它是幂等的、按 id 合并的。在这里再造一条增量解析
 * 路径，等于让两套逻辑对同一份磁盘数据给出两种结果。
 *
 * 只在预览态生效：绑定 worker 的会话由实时事件流驱动，再叠一份文件监听会和
 * 流式渲染抢同一个数组（也白费 IO）。
 */
let watchedFile: string | null = null
let unsubscribeEvents: (() => void) | null = null
/**
 * 订阅/退订必须串行。
 *
 * 快速连点两个会话时，两次 watch 的 `await invoke` 会交叉：第二次的 unsubscribe(旧)
 * 可能落在第一次的 subscribe(旧) 之后，把刚订上的又退掉（或者反过来退错文件）。
 * 一条 promise 链把这个顺序钉死——代价是所有订阅操作串行，而它们本来就是毫秒级。
 */
let queue: Promise<void> = Promise.resolve()

function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task, task)
  return queue
}

function handleTail(payload: { sessionFile: string; truncated: boolean }): void {
  const state = useUIStore.getState()
  // 用户已经切走了：事件是按窗口广播的，不看这一眼就会把别人的会话刷进当前视图
  if (!state.historySessionFile || !sessionFilesEqual(state.historySessionFile, payload.sessionFile)) return
  if (!state.currentSessionId) return
  // 磁盘已经变了，切片缓存立刻作废：预览这次走 bypass，但随后任何一次普通读取
  // （切回来、后台刷新）都会命中 2 分钟的 TTL，拿旧尾巴把新内容盖回去。
  clearSessionHistoryCache(payload.sessionFile)
  void hydrateSessionView(payload.sessionFile, state.currentSessionId, undefined, { bindWorker: false })
    .catch(() => {
      /* 预览是尽力而为：一次读盘失败（文件正在被重写）不该弹错误 */
    })
}

function attach(): void {
  if (unsubscribeEvents) return
  unsubscribeEvents = onSessionTail(handleTail)
}

/** 开始盯这段会话的文件（重复调用同一文件幂等）。 */
export function watchSessionTail(sessionFile: string): Promise<void> {
  const file = String(sessionFile || '').trim()
  if (!file) return Promise.resolve()
  return enqueue(async () => {
    if (watchedFile && sessionFilesEqual(watchedFile, file)) return
    attach()
    const previous = watchedFile
    watchedFile = file
    await ipcClient.invoke('session.tail.subscribe', { sessionFile: file }).catch(() => {})
    // 先订新的再退旧的：中间这一瞬旧会话的变化也不会漏（它已经不在屏幕上，影响为零），
    // 反过来则会出现「刚打开的头 200ms 静止不动」。
    if (previous && !sessionFilesEqual(previous, file)) {
      await ipcClient.invoke('session.tail.unsubscribe', { sessionFile: previous }).catch(() => {})
    }
  })
}

/** 停止盯（切到绑定 worker 的会话 / 关掉预览时调用）。 */
export function unwatchSessionTail(): Promise<void> {
  return enqueue(async () => {
    const file = watchedFile
    watchedFile = null
    unsubscribeEvents?.()
    unsubscribeEvents = null
    if (!file) return
    await ipcClient.invoke('session.tail.unsubscribe', { sessionFile: file }).catch(() => {})
  })
}

/** @internal 测试专用：当前盯着的文件 */
export function watchedSessionTailFile(): string | null {
  return watchedFile
}
