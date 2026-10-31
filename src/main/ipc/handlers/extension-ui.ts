import { registerHandler } from '../registry'
import { workerManager } from '../../worker-manager'
import { configStore } from '../../config-store'
import { cancelPluginUIRequest, resolvePluginUIResponse } from '../../plugins/plugin-ui'

export function registerExtensionUiHandlers(): void {
  registerHandler('ipc:extension.respondUI', async (req) => {
    // 插件发起的问卷回答：id 前缀 plugin-ui-，不属于任何 worker，直接唤醒 main 侧的等待者
    if (resolvePluginUIResponse(req)) return { ok: true }
    workerManager.respondExtensionUI(req)
    return { ok: true }
  })

  registerHandler('ipc:extension.cancelUI', async (req) => {
    if (req.id && cancelPluginUIRequest(String(req.id))) return { ok: true }
    workerManager.cancelExtensionUI(req.id, req.reason ?? 'renderer-cancel')
    return { ok: true }
  })

  registerHandler('ipc:extension.config.get', async (req) => {
    const workspaceId = req.workspaceId || workerManager.cwd || configStore.get('currentProject') || ''
    return { config: configStore.getExtensionConfig(workspaceId, req.extensionId) || {} }
  })

  registerHandler('ipc:extension.config.set', async (req) => {
    const workspaceId = req.workspaceId || workerManager.cwd || configStore.get('currentProject') || ''
    configStore.setExtensionConfig(workspaceId, req.extensionId, req.config || {})
    return { ok: true }
  })
}
