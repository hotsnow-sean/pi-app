import { errorMessage } from '@shared/error-message'
import type { PluginAgentPromptResult } from '@shared/plugin-context'

/**
 * 跑一次 prompt，带超时。**只依赖 session 的三个方法**，不碰 electron / pi SDK，
 * 这样超时语义可以被单测（宿主里那层只负责建会话与 dispose）。
 *
 * 为什么「超时」要自己记：SDK 的 `abort()` **不抛错**——它只是把内部循环断掉，
 * `session.prompt()` 仍然正常 resolve。于是「被中止」与「跑完了」在对调用方看来
 * 一模一样，拿到的还是半截文本。不记这个标志，定时任务的「超时记为失败」就永远
 * 不成立：用户设了 15 分钟上限，超时后记录里写的是「成功」。
 */
export interface PromptSessionLike {
  prompt(text: string): Promise<void>
  abort(): Promise<void> | void
  getLastAssistantText(): string | null | undefined
}

/** 中止后仍不返回时的兜底余量：abort 理应很快生效，30s 足够收尾 */
const ABORT_GRACE_MS = 30_000

export async function runPromptWithTimeout(
  session: PromptSessionLike,
  prompt: string,
  timeoutMs: number,
): Promise<PluginAgentPromptResult> {
  const label = `${Math.round(timeoutMs / 60_000)} min`
  let timedOut = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const abortTimer = setTimeout(() => {
    timedOut = true
    void session.abort()
  }, timeoutMs)
  try {
    await Promise.race([
      session.prompt(prompt),
      new Promise<never>((_, reject) => {
        graceTimer = setTimeout(() => reject(new Error(`prompt timed out after ${label}`)), timeoutMs + ABORT_GRACE_MS)
      }),
    ])
    // 中止后的正常返回 = 超时，不是成功
    if (timedOut) return { ok: false, error: `prompt timed out after ${label}` }
    return { ok: true, text: session.getLastAssistantText() ?? '' }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  } finally {
    clearTimeout(abortTimer)
    if (graceTimer) clearTimeout(graceTimer)
  }
}
