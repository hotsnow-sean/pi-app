import { useCallback, useEffect, useRef, useState } from 'react'
import { ipcClient } from '@renderer/lib/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'
import { pluginEntryUrl } from '@shared/plugin-panel-url'

/**
 * 会话条（content 模式）上报高度的上限。会话条是对话流的租客，超过这个高度的
 * 内容应该做进右栏面板——宿主截断而不是把对话流顶开。契约见 plugin-host-api.md
 * 「plugin-content-height」一条；改这里必须同步改文档。
 */
const MAX_CONTENT_HEIGHT = 400

export type PluginPanelFrameProps = {
  pluginId: string
  /** 完整 panel/view id（plugin:<pluginId>:<id>），透传给插件 UI */
  panelId: string
  title?: string
  /** 入口文档，相对插件目录；右栏与中央视图共用同一份 UI 时留默认值 */
  entry?: string
  /**
   * 容器高度的归属：
   * - `fill`（默认）：撑满父容器——右栏面板、中央视图。
   * - `content`：高度由插件自己上报（`plugin-content-height`）——对话顶部的会话条
   *   是「有内容才存在」的东西，宿主无从预判它多高，也不该替它留白。
   */
  sizing?: 'fill' | 'content'
  /** content 模式下，插件上报高度前的占位（用 manifest 里声明的 height，避免加载后跳一下） */
  defaultHeight?: number
}

/**
 * 插件面板容器：pi-plugin:// iframe（sandbox，无 same-origin）。
 *
 * 握手协议（iframe ↔ 宿主 renderer，window.postMessage）：
 *   → { type: 'plugin-hello', panelId }                 iframe 就绪
 *   → { type: 'plugin-invoke', requestId, method, params }
 *   → { type: 'plugin-content-height', height }          content 模式下上报自身高度（0 = 收起）
 *   → { type: 'plugin-open-panel', panelId, requestId }  请求宿主切到某个右栏面板并展开
 *   ← { type: 'plugin-ready', panelId }                 宿主应答 hello
 *   ← { type: 'plugin-invoke-result', requestId, ok, result?, error? }
 *   ← { type: 'plugin-open-panel-result', requestId, ok }
 *   ← { type: 'plugin-theme', vars: Record<string,string> }  主题 token（含自定义主题），切换/修改时重推
 *   ← { type: 'plugin-settings', values: Record<string,unknown> }  声明式设置项的值，握手时下发一次
 *   ← { type: 'plugin-context', context: { workspacePath, sessionFile, sessionId } }  当前工作区/会话
 *
 * 主题不进握手依赖：iframe load 后无条件补推一次，插件 UI 忘了发 hello 也不会停在自带兜底色上。
 * 上下文同理——会话条要靠它判断「这个会话有没有我的东西」，等 hello 才开始推会有丢消息的窗口。
 *
 * 设置只读：写入口在设置页（宿主渲染表单）。插件 UI 拿到值后自行显示/生效即可。
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
  // 原生控件（时间/日期选择器的图标与弹层、select 下拉、滚动条）由浏览器绘制，
  // 只认 color-scheme，不认自定义变量 —— 必须显式传递，否则永远是亮色。
  const scheme = cs.colorScheme?.trim()
  vars['--pi-color-scheme'] = scheme && scheme !== 'normal' ? scheme : document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  return vars
}

/** 裸 HSL 三元组补 hsl()；已是完整颜色（hex / rgb() / hsl()）则原样返回 */
function resolveColor(raw: string): string {
  const supported = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', raw)
  return supported ? raw : `hsl(${raw})`
}
export function PluginPanelFrame({
  pluginId,
  panelId,
  title,
  entry,
  sizing = 'fill',
  defaultHeight = 44,
}: PluginPanelFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  /** content 模式下插件上报的高度；null = 还没报，先用默认值占位 */
  const [contentHeight, setContentHeight] = useState<number | null>(null)

  // 面板要看得到「用户正在哪儿」：会话条按当前会话过滤，右栏详情按当前工作区兜底
  const workspacePath = useUIStore((s) => s.currentWorkspace)
  const sessionFile = useUIStore((s) => s.historySessionFile)
  const sessionId = useUIStore((s) => s.currentSessionId)
  const contextRef = useRef({ workspacePath, sessionFile, sessionId })
  contextRef.current = { workspacePath, sessionFile, sessionId }

  /**
   * 推一次「面板需要知道的环境」：上下文 + 主题 + 设置。
   * 插件发 hello（正常路径）与 iframe load（兜底路径）都会调它。
   */
  const pushEnvironment = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    win.postMessage({ type: 'plugin-context', context: contextRef.current }, '*')
    win.postMessage({ type: 'plugin-theme', vars: collectThemeVars() }, '*')
    // 设置值按需拉一次（目录里只有 schema）；失败不阻塞面板，插件用默认值即可
    void ipcClient
      .invoke('plugins.settings.get', { pluginId })
      .then((res) => {
        win.postMessage(
          { type: 'plugin-settings', values: (res?.values ?? {}) as Record<string, unknown> },
          '*',
        )
      })
      .catch(() => {})
  }, [pluginId])

  // 切会话/切工作区时主动重推：插件据此换「这是哪个会话」的上下文
  useEffect(() => {
    pushEnvironment()
  }, [workspacePath, sessionFile, sessionId, pushEnvironment])

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const frame = iframeRef.current
      if (!frame || !event.source || event.source !== frame.contentWindow) return
      const data = event.data as Record<string, unknown>
      if (!data || typeof data !== 'object') return
      if (data.type === 'plugin-hello') {
        frame.contentWindow?.postMessage({ type: 'plugin-ready', panelId }, '*')
        pushEnvironment()
        return
      }
      if (data.type === 'plugin-content-height') {
        // content 模式：插件自己量高度后上报。0 表示「这里没我事」——
        // 容器塌缩成 0 但 iframe 不卸载，否则插件再也没机会把它撑开。
        const h = Number(data.height)
        setContentHeight(Number.isFinite(h) && h >= 0 ? Math.min(MAX_CONTENT_HEIGHT, Math.round(h)) : null)
        return
      }
      if (data.type === 'plugin-open-panel') {
        // 插件请求「把某个右栏面板亮出来」：例如会话条点任务 → 看详情。
        // 只在目录里真实存在时才动手，拼错的 id 不该把右栏清空。
        const requestId = Number(data.requestId)
        const target = String(data.panelId ?? '')
        const store = useUIStore.getState()
        const exists = !!target && store.rightPanelCatalog.some((c) => c.id === target)
        if (exists) {
          store.setActivePanel(target)
          store.revealRightPanel()
        }
        frame.contentWindow?.postMessage({ type: 'plugin-open-panel-result', requestId, ok: exists }, '*')
        return
      }
      if (data.type === 'plugin-key') {
        // iframe 内的键盘事件宿主收不到（焦点在子文档里），由插件主动转发。
        // 宿主 App 监听这个事件处理 Esc（回对话）与 mod+K（命令面板）。
        window.dispatchEvent(
          new CustomEvent('pi-desktop:plugin-key', {
            detail: { key: String(data.key ?? ''), mod: data.mod === true },
          }),
        )
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
    [pluginId, panelId, pushEnvironment],
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
    <div
      className={
        sizing === 'content'
          ? 'w-full shrink-0 overflow-hidden'
          : 'flex h-full min-w-0 flex-col overflow-hidden'
      }
      style={sizing === 'content' ? { height: contentHeight ?? defaultHeight } : undefined}
    >
      <iframe
        ref={iframeRef}
        className="h-full w-full border-0 bg-transparent"
        title={title ?? `plugin:${pluginId}`}
        src={pluginEntryUrl(pluginId, entry)}
        sandbox="allow-scripts allow-forms allow-modals"
        onLoad={() => {
          // 兜底：不依赖插件 UI 记得发 hello。load 晚于首屏脚本执行，
          // 监听器已就位，所以这里推一次主题能真正落地，避免界面停在插件自带兜底色上。
          pushEnvironment()
        }}
      />
    </div>
  )
}
