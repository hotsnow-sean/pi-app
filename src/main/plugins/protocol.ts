import { protocol } from 'electron'
import { PLUGIN_UI_SCHEME, pluginEntryPath } from '@shared/plugin-panel-url'
import { isPluginBridgeRequest } from '@shared/plugin-bridge'
import { readPluginPanelFile, resolvePluginPanelEntry } from './plugin-host'
// 构建期内联成字符串：运行时不读磁盘，也就没有 asar / chunk 化后的路径问题
import bridgeSource from './bridge/bridge.js?raw'

/**
 * pi-plugin:// 协议：把插件 ui/ 目录以只读静态站点暴露给 renderer 的 sandbox iframe。
 *
 * URL 形态：pi-plugin://<pluginId>/<path…>
 *           pi-plugin://__host/bridge.js        （宿主下发的面板桥，不是插件资源）
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

      // 保留 hostname：桥脚本由宿主提供，插件目录里没有这个文件。
      // 「桥归宿主」是刻意的（见 @shared/plugin-bridge）——插件只写业务，
      // 请求/响应、超时、销毁这些协议细节只有一份实现。
      if (isPluginBridgeRequest(pluginId)) {
        return new Response(bridgeSource, {
          headers: {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        })
      }

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
