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
 *   ← { type: 'plugin-ready', panelId }                 宿主应答 hello
 *   ← { type: 'plugin-invoke-result', requestId, ok, result?, error? }
 *   ← { type: 'plugin-theme', vars: Record<string,string> }  主题 token（含自定义主题），切换/修改时重推
 *
 * 主题契约：vars 是 `--pi-*` 名到**可直接使用**的 CSS 值的映射，插件在 documentElement
 * 上落盘后引用即可。globals.css 并存两套取值体系（shadcn 族是裸 HSL 三元组、自研族是
 * hex），自定义主题还可能改写格式，所以这里按值实际能否作为颜色解析来判断，不假设格式。
 */
/** shadcn 族 token：裸三元组，需要补 hsl() */
const HSL_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
] as const
/** 直接值 token（十六进制 / 长度），透传 */
const RAW_TOKENS = [
  'surface-sidebar',
  'sidebar-row-hover',
  'sidebar-row-press',
  'sidebar-row-selected',
  'list-row-selected',
  'radius',
] as const

function collectThemeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const name of HSL_TOKENS) {
    const raw = cs.getPropertyValue(`--${name}`).trim()
    if (raw) vars[`--pi-${name}`] = resolveColor(raw)
  }
  for (const name of RAW_TOKENS) {
    const v = cs.getPropertyValue(`--${name}`).trim()
    if (v) vars[`--pi-${name}`] = v
  }
  return vars
}

/** 裸 HSL 三元组补 hsl()；已是完整颜色（hex / rgb() / hsl()）则原样返回 */
function resolveColor(raw: string): string {
  const supported = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', raw)
  return supported ? raw : `hsl(${raw})`
}
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
        frame.contentWindow?.postMessage({ type: 'plugin-theme', vars: collectThemeVars() }, '*')
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

  // 主题跟随：明暗切换（documentElement class）、自定义主题/背景层（head 内 <style> 变化、根 style）
  // 都会落到上述节点，统一观察后重推 token。防抖合并连续变更。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastSent = ''
    const push = () => {
      timer = null
      const frame = iframeRef.current
      if (!frame) return
      const vars = collectThemeVars()
      const signature = JSON.stringify(vars)
      if (signature === lastSent) return
      lastSent = signature
      frame.contentWindow?.postMessage({ type: 'plugin-theme', vars }, '*')
    }
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(push, 120)
    }
    const rootObserver = new MutationObserver(schedule)
    rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    const headObserver = new MutationObserver(schedule)
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
    return () => {
      rootObserver.disconnect()
      headObserver.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [])

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
