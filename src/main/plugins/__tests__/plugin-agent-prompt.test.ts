import { describe, expect, it, vi } from 'vitest'
import { runPromptWithTimeout, type PromptSessionLike } from '../plugin-agent-prompt'

/**
 * 超时语义的回归。
 *
 * 关键事实：SDK 的 `abort()` **不抛错**，只让 `session.prompt()` 正常 resolve。
 * 宿主如果不自己记「被中止」，超时会被当成成功——定时任务的「超时记为失败」
 * 因此永远不成立，用户看到的是「成功 + 半截结果」。
 */

function sessionThatAborts(): PromptSessionLike {
  let release: (() => void) | null = null
  return {
    prompt: () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
    abort: () => {
      release?.()
    },
    getLastAssistantText: () => '半截结果',
  }
}

describe('runPromptWithTimeout', () => {
  it('abort 后 prompt 正常返回，也算超时失败', async () => {
    const result = await runPromptWithTimeout(sessionThatAborts(), '跑一个不会结束的任务', 50)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('timed out')
  })

  it('正常结束返回正文，不算超时', async () => {
    const session: PromptSessionLike = {
      prompt: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      },
      abort: () => {
        throw new Error('不该被调用')
      },
      getLastAssistantText: () => '一切正常',
    }
    await expect(runPromptWithTimeout(session, '很快就好', 5_000)).resolves.toEqual({
      ok: true,
      text: '一切正常',
    })
  })

  it('会话本身抛错时原样带回原因', async () => {
    const session: PromptSessionLike = {
      prompt: async () => {
        throw new Error('model unavailable')
      },
      abort: () => {},
      getLastAssistantText: () => '',
    }
    await expect(runPromptWithTimeout(session, '随便跑跑', 1_000)).resolves.toEqual({
      ok: false,
      error: 'model unavailable',
    })
  })

  it('abort 之后仍不返回时，兜底计时器兜住（不会永远挂着）', async () => {
    vi.useFakeTimers()
    try {
      const session: PromptSessionLike = {
        prompt: () => new Promise<void>(() => {}),
        abort: () => {},
        getLastAssistantText: () => '',
      }
      const pending = runPromptWithTimeout(session, '卡住的会话', 1_000)
      await vi.advanceTimersByTimeAsync(31_000)
      await expect(pending).resolves.toEqual({ ok: false, error: expect.stringContaining('timed out') })
    } finally {
      vi.useRealTimers()
    }
  })
})
