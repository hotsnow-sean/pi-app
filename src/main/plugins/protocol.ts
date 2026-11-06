import { protocol } from 'electron'
import { PLUGIN_UI_SCHEME, pluginEntryPath } from '@shared/plugin-panel-url'
import { readPluginPanelFile, resolvePluginPanelEntry } from './plugin-host'

/**
 * pi-plugin:// 协议：把插件 ui/ 目录以只读静态站点暴露给 renderer 的 sandbox iframe。
 *
 * URL 形态：pi-plugin://<pluginId>/<path…>
 * 必须在 app ready 之前注册为 standard + secure + supportFetchAPI scheme。
 */

export function registerPluginProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_UI_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
    },
  ])
}

export function registerPluginProtocolHandler(): void {
  protocol.handle(PLUGIN_UI_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // standard scheme：host = pluginId，pathname = /path
      const pluginId = url.hostname
      if (!pluginId) return new Response('missing plugin id', { status: 400 })
      // 与 pluginEntryUrl 共用同一份前缀规则（见 @shared/plugin-panel-url）
      const rel = pluginEntryPath(url.pathname)
      const full = resolvePluginPanelEntry(pluginId, rel)
      if (!full) return new Response('not found', { status: 404 })
      const file = await readPluginPanelFile(full)
      if (!file) return new Response('not found', { status: 404 })
      return new Response(new Uint8Array(file.data), {
        headers: {
          'Content-Type': file.mime,
          // 插件文档的隔离 CSP：脚本/样式仅同源 + inline，禁止外联
          'Content-Security-Policy':
            "default-src 'none'; script-src pi-plugin: 'unsafe-inline'; style-src pi-plugin: 'unsafe-inline'; img-src pi-plugin: data:; font-src pi-plugin: data:",
          'Cache-Control': 'no-cache',
        },
      })
    } catch (error) {
      console.error('[plugin-protocol]', error)
      return new Response('internal error', { status: 500 })
    }
  })
}
