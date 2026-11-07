import type { WebContents } from 'electron'
import {
  releaseSessionTailsForSender,
  subscribeSessionTail,
  unsubscribeSessionTail,
} from '../../session-tails'
import { registerHandler } from '../registry'

/**
 * 会话文件实时预览的两个入口（订阅 / 退订）。
 *
 * 这里的 `sender` 是必需的：监听句柄按窗口记账，窗口 reload / 关闭时必须能整批收回，
 * 否则每次预览都在 main 侧留一个永远不退订的 watch。
 */
export function registerSessionTailHandlers(): void {
  registerHandler('ipc:session.tail.subscribe', async (req, sender) => {
    const sessionFile = typeof req?.sessionFile === 'string' ? req.sessionFile : ''
    if (!sessionFile.trim()) return { ok: false, error: 'sessionFile required' }
    if (!sender) return { ok: false, error: 'no sender' }
    subscribeSessionTail(sessionFile, sender as WebContents)
    return { ok: true }
  })

  registerHandler('ipc:session.tail.unsubscribe', async (req, sender) => {
    const sessionFile = typeof req?.sessionFile === 'string' ? req.sessionFile : ''
    if (!sender) return { ok: false }
    // 允许不带 sessionFile：那就是「这个窗口退掉全部订阅」（预览卸载 / 切会话）
    if (!sessionFile.trim()) {
      releaseSessionTailsForSender(sender as WebContents)
      return { ok: true }
    }
    unsubscribeSessionTail(sessionFile, sender as WebContents)
    return { ok: true }
  })
}
