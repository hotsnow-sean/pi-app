import { basename } from 'path'
import type { AppEvent, CompletionEvent } from '@shared/app-events'
import type { PluginInboxItem } from '@shared/plugin-context'
import { getMainWindow } from './window'
import { getPendingWorkerSessionFile } from './session-bind-state'
import {
  bindCompletionNotificationEvents,
  currentVisibleSessionFile,
} from './completion-notification-events'
import {
  createCompletionNotificationController,
  type CompletionNotificationController,
} from './completion-notification-controller'
import { disposeCompletionDelivery, presentCompletionCard } from './completion-notification-delivery'
import { readCompletionNotificationSettings } from './completion-notification-settings'

let controller: CompletionNotificationController | null = null
let unbindEvents: (() => void) | null = null

function projectLabel(workspaceId: string): string {
  const name = basename(String(workspaceId || '').replace(/\\/g, '/'))
  return name || 'pi Desktop'
}

function windowState() {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return { focused: false, visible: false, minimized: true }
  return {
    focused: win.isFocused(),
    visible: win.isVisible(),
    minimized: win.isMinimized(),
  }
}

function getController(): CompletionNotificationController {
  if (!controller) {
    controller = createCompletionNotificationController({
      now: () => Date.now(),
      delayMs: 2000,
      getSettings: () => readCompletionNotificationSettings(),
      getWindowState: windowState,
      getVisibleSessionFile: () => currentVisibleSessionFile() ?? getPendingWorkerSessionFile(),
      projectLabel,
      deliver: (card) => {
        void presentCompletionCard(card, readCompletionNotificationSettings().delivery)
      },
    })
  }
  return controller
}

function handleAppEvent(event: AppEvent): void {
  const ctrl = getController()
  if (event.type === 'run' && (event.phase === 'started' || event.phase === 'running')) {
    ctrl.notifyRunStarted(event.sessionFile, event.runId)
    return
  }
  if (event.type === 'completion') {
    ctrl.handleCompletion(event as CompletionEvent)
  }
}

function handleWorkerExit(slot: {
  cwd: string
  sessionFile?: string | null
}): void {
  getController().handleWorkerExitFailure({
    workspaceId: slot.cwd,
    sessionFile: slot.sessionFile,
  })
}

export function initializeCompletionNotifications(): void {
  if (unbindEvents) return
  unbindEvents = bindCompletionNotificationEvents({
    observeAppEvent: handleAppEvent,
    observeWorkerExit: handleWorkerExit,
    visibleSessionChanged: (sessionFile) => controller?.notifyVisibleSessionChanged(sessionFile),
    foregroundChanged: () => controller?.notifyVisibleSessionChanged(currentVisibleSessionFile()),
  })
}

export function deliverTestCompletionNotification(): void {
  getController().deliverTest()
}

export function listCompletionInbox() {
  return getController().listInbox()
}

/**
 * 插件投递一条到同一个信箱（`ctx.ui.inbox` 的实现落点）。
 *
 * 刻意复用一个 inbox 而不是给插件另开一个：未读红点、标已读、Dock 徽章计数、
 * 4s 轮询都是现成的，用户也不需要记「哪个红点是谁的」。
 */
export function pushPluginInbox(pluginId: string, item: PluginInboxItem): void {
  getController().pushPluginInbox(pluginId, item)
}

export function markCompletionInboxUnread(notificationId: string, unread: boolean): void {
  getController().markInboxUnread(notificationId, unread)
}

export function markCompletionInboxRead(notificationId: string): void {
  getController().markInboxRead(notificationId)
}

export function disposeCompletionNotifications(): void {
  unbindEvents?.()
  unbindEvents = null
  controller?.dispose()
  controller = null
  disposeCompletionDelivery()
}
