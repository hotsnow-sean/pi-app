import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  EMPTY_QUESTIONNAIRE,
  PLUGIN_UI_ID_PREFIX,
  type PluginUIQuestion,
  type PluginUIQuestionnaireResult,
  type PluginUIResponse,
} from '@shared/plugin-ui'
import { getMainWindow } from '../window'

/**
 * 插件 → 宿主的界面请求（main 侧）。
 *
 * 复用 extension-ui 那条现成链路：main 往窗口发 `ipc:extension-ui-request`，renderer 的
 * ExtensionUIHost 渲染 QuestionnaireDialog，回答走 `ipc:extension.respondUI` 回到这里。
 * 唯一的新东西是 id 前缀——带 `plugin-ui-` 的回答不进 worker，直接唤醒本模块的等待者。
 *
 * 为什么放 main 而不是 worker：插件工具的执行体在 main（插件是应用级代码），它需要
 * "问用户"这条交互能力，才能覆盖 ask / 审批这一类会话内场景。
 */

type Waiter = {
  pluginId: string
  resolve: (result: PluginUIQuestionnaireResult) => void
}

const waiters = new Map<string, Waiter>()

/**
 * 问卷只能由**主窗口**的渲染端承载：`ipc:extension-ui-request` 的监听器只装在主窗口
 * （通知卡窗口用的是另一个 preload，收到也画不出来）。
 *
 * 旧实现是「有焦点就用焦点窗口，否则用 getAllWindows()[0]」，两条都错：
 * ① 焦点可能落在别的窗口上；② `getAllWindows()` 的顺序不保证是创建顺序——实测新建窗口
 * 会排到 0 号位，于是只要通知卡窗口存在过（它 hide 但不销毁），请求就被发进那个隐藏窗口，
 * 没有监听者、没有回答，ask_user 一直挂到超时。用户看到的「应用不在前台提问必卡」即此。
 */
function hostWindow(): BrowserWindow | null {
  return getMainWindow()
}

/** 让问卷真正能被看见：从最小化/托盘恢复，但不抢焦点，只用任务栏闪烁提示 */
function presentHostWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  if (!win.isFocused()) win.flashFrame(true)
}

/** 弹一次问卷，等用户作答。没有窗口 / 被取消 / 超时都返回 cancelled 结果，绝不抛 */
export function askInHost(
  pluginId: string,
  questions: PluginUIQuestion[],
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<PluginUIQuestionnaireResult> {
  if (!Array.isArray(questions) || questions.length === 0) return Promise.resolve(EMPTY_QUESTIONNAIRE)
  if (opts?.signal?.aborted) return Promise.resolve(EMPTY_QUESTIONNAIRE)
  const win = hostWindow()
  if (!win) return Promise.resolve(EMPTY_QUESTIONNAIRE)

  const id = `${PLUGIN_UI_ID_PREFIX}${randomUUID()}`
  return new Promise<PluginUIQuestionnaireResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: PluginUIQuestionnaireResult): void => {
      if (timer) clearTimeout(timer)
      opts?.signal?.removeEventListener('abort', onAbort)
      waiters.delete(id)
      resolve(result)
    }
    const dismissInRenderer = (reason: 'abort' | 'timeout'): void => {
      if (win.isDestroyed()) return
      win.webContents.send('ipc:extension-ui-dismiss', { type: 'extension-ui-dismiss', id, reason })
    }
    const onAbort = (): void => {
      dismissInRenderer('abort')
      finish(EMPTY_QUESTIONNAIRE)
    }
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        dismissInRenderer('timeout')
        finish(EMPTY_QUESTIONNAIRE)
      }, opts.timeoutMs)
    }
    opts?.signal?.addEventListener('abort', onAbort, { once: true })
    waiters.set(id, { pluginId, resolve: finish })
    presentHostWindow(win)
    win.webContents.send('ipc:extension-ui-request', {
      id,
      method: 'custom',
      kind: 'ask_user_question',
      questions,
      // 让 renderer 知道是谁在问（目前只用于日志/排障，不影响渲染）
      source: `plugin:${pluginId}`,
    })
  })
}

/** renderer 的回答：命中插件请求则消费掉并返回 true（调用方不再转发给 worker） */
export function resolvePluginUIResponse(response: PluginUIResponse): boolean {
  const waiter = waiters.get(response.id)
  if (!waiter) return false
  if (response.cancelled) {
    waiter.resolve(EMPTY_QUESTIONNAIRE)
    return true
  }
  const result = response.result as PluginUIQuestionnaireResult | undefined
  if (!result || typeof result !== 'object' || !Array.isArray(result.answers)) {
    waiter.resolve(EMPTY_QUESTIONNAIRE)
    return true
  }
  waiter.resolve(result)
  return true
}

/** renderer 侧明确放弃（X / Esc 的「取消」分支） */
export function cancelPluginUIRequest(id: string): boolean {
  const waiter = waiters.get(id)
  if (!waiter) return false
  waiter.resolve(EMPTY_QUESTIONNAIRE)
  return true
}

/** 插件停用 / 应用退出时，别让挂着的对话框把 promise 卡死 */
export function cancelPluginUIRequests(pluginId?: string): void {
  const win = hostWindow()
  for (const [id, waiter] of [...waiters]) {
    if (pluginId !== undefined && waiter.pluginId !== pluginId) continue
    if (win) win.webContents.send('ipc:extension-ui-dismiss', { type: 'extension-ui-dismiss', id, reason: 'cancelled' })
    waiter.resolve(EMPTY_QUESTIONNAIRE)
  }
}
