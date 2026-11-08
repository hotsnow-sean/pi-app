import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 退出瞬间的窗口清理。
 *
 * 真实事故（v0.7.7-fork.6 安装版）：`webContents.on('destroyed', () => …win.webContents…)`
 * 在 WebContents 已经销毁之后才被调用，读 getter 直接抛
 * `TypeError: Object has been destroyed`；全局 uncaughtException 兜底弹了个错误框，
 * 而 `app.exit(0)` 紧接着把进程收掉，于是用户看到「点退出时闪一下报错」。
 *
 * 这两条守的是「就算以后有人把代码写回去」也要红：销毁后的回调只能碰事先取好的 id，
 * 退出过程中的异常只记日志、不弹框。
 */

const mainIndex = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')

describe('窗口销毁清理', () => {
  it('destroyed 回调只碰事先取好的 id，不读已失效的 webContents', () => {
    const start = mainIndex.indexOf('function attachSessionTailCleanup')
    expect(start).toBeGreaterThan(-1)
    const rest = mainIndex.slice(start)
    const body = rest.slice(0, rest.indexOf('\n}'))

    const destroyedLine = body.split('\n').find((line) => line.includes("'destroyed'")) ?? ''
    expect(destroyedLine).toContain('releaseSessionTailsForSenderId')
    // 销毁后 win.webContents 与 webContents.id 都会抛，不能出现在这一行
    expect(destroyedLine).not.toContain('win.webContents')
    // 整个函数体都不该再走「传对象」的旧入口
    expect(body).not.toMatch(/releaseSessionTailsForSender\(/)
  })

  it('退出流程开始后不再弹框（否则用户只看到闪一下）', () => {
    const handler = mainIndex.indexOf("process.on('uncaughtException'")
    expect(handler).toBeGreaterThan(-1)
    const guard = mainIndex.indexOf('if (appQuitting) return', handler)
    const firstDialog = mainIndex.indexOf('showMessageBox', handler)
    expect(guard).toBeGreaterThan(handler)
    expect(firstDialog).toBeGreaterThan(guard)
  })
})
