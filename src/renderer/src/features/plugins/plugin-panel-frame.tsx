import { useCallback, useEffect, useRef } from 'react'
import { ipcClient } from '@renderer/lib/ipc-client'

export type PluginPanelFrameProps = {
  pluginId: string
  /** 完整 panel id（plugin:<pluginId>:<panelId>），透传给插件 UI */
  panelId: string
  title?: string
}

/**
 * 插件面板容器：pi-plugin:// iframe（sandbox，无 same-origin）。
 *
 * 握手协议（iframe ↔ 宿主 renderer，window.postMessage）：
 *   → { type: 'plugin-hello', panelId }                 iframe 就绪
 *   → { type: 'plugin-invoke', requestId, method, params }
 *   ← { type: 'plugin-ready' }                          宿主应答 hello
 *   ← { type: 'plugin-invoke-result', requestId, ok, result?, error? }
 */
export function PluginPanelFrame({ pluginId, panelId, title }: PluginPanelFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const frame = iframeRef.current
      if (!frame || !event.source || event.source !== frame.contentWindow) return
      const data = event.data as Record<string, unknown>
      if (!data || typeof data !== 'object') return
      if (data.type === 'plugin-hello') {
        frame.contentWindow?.postMessage({ type: 'plugin-ready', panelId }, '*')
        return
      }
      if (data.type === 'plugin-invoke') {
        const requestId = Number(data.requestId)
        void ipcClient
          .invoke('plugin.invoke', {
            pluginId,
            method: String(data.method ?? ''),
            params: (data.params ?? {}) as Record<string, unknown>,
          })
          .then((raw) => {
            const r = raw as { ok: boolean; result?: unknown; error?: string }
            if (r?.ok) frame.contentWindow?.postMessage({ type: 'plugin-invoke-result', requestId, ok: true, result: r.result }, '*')
            else frame.contentWindow?.postMessage({ type: 'plugin-invoke-result', requestId, ok: false, error: r?.error ?? 'invoke failed' }, '*')
          })
          .catch((e: unknown) => {
            frame.contentWindow?.postMessage(
              { type: 'plugin-invoke-result', requestId, ok: false, error: e instanceof Error ? e.message : String(e) },
              '*',
            )
          })
        return
      }
    },
    [pluginId],
  )

  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <iframe
        ref={iframeRef}
        className="h-full w-full border-0 bg-transparent"
        title={title ?? `plugin:${pluginId}`}
        src={`pi-plugin://${pluginId}/ui/index.html`}
        sandbox="allow-scripts allow-forms allow-modals"
      />
    </div>
  )
}
