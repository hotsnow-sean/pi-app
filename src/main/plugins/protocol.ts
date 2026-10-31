import { app, net, protocol } from 'electron'
import path from 'node:path'
import { readPluginPanelFile, resolvePluginPanelEntry } from './plugin-host'

/**
 * pi-plugin:// 协议：把插件 ui/ 目录以只读静态站点暴露给 renderer 的 sandbox iframe。
 *
 * URL 形态：pi-plugin://<pluginId>/<path…>
 * 必须在 app ready 之前注册为 standard + secure + supportFetchAPI scheme。
 */

const SCHEME = 'pi-plugin'

export function registerPluginProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
    },
  ])
}

export function registerPluginProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      // standard scheme：host = pluginId，pathname = /path
      const pluginId = url.hostname
      if (!pluginId) return new Response('missing plugin id', { status: 400 })
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
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

export function pluginPanelUrl(pluginId: string, entry: string): string {
  const normalized = entry.replace(/^\//, '')
  return `${SCHEME}://${pluginId}/${normalized}`
}
