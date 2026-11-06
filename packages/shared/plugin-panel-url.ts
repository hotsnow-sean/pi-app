/**
 * 插件 UI 的唯一定址规则。
 *
 * 为什么单独一个文件：这条规则同时被三处需要——main 的协议处理器（把 URL 还原成
 * 相对路径）、渲染端 iframe 的 src、以及任何要拼插件页面地址的地方。之前是
 * `plugin-manifest.ts` 里一份、`protocol.ts` 里一份、`plugin-panel-frame.tsx` 里再内联
 * 一份，其中两份还是**零调用者的死代码**，只有渲染端那份真正生效；三份的斜杠处理
 * 规则还不一样（`/^\/+/` vs `/^\//`）。
 *
 * 放在独立文件而不是 `plugin-manifest.ts`：后者依赖 zod，渲染端 import 会把整个
 * 清单校验器打进 bundle，而这里只需要一个字符串拼装。
 *
 * 注意本文件不允许有任何依赖：main / renderer / 测试三边都要能直接 import。
 */

export const PLUGIN_UI_SCHEME = 'pi-plugin'

/** 插件内默认入口（与 manifest 的 `entry` 默认值一致） */
export const DEFAULT_PLUGIN_UI_ENTRY = 'ui/index.html'

/**
 * 插件页面的绝对 URL：`pi-plugin://<pluginId>/<entry>`。
 * entry 允许带前导斜杠（插件里手写路径时常见），统一剥掉。
 */
export function pluginEntryUrl(pluginId: string, entry: string = DEFAULT_PLUGIN_UI_ENTRY): string {
  const rel = String(entry || DEFAULT_PLUGIN_UI_ENTRY).replace(/^\/+/, '')
  return `${PLUGIN_UI_SCHEME}://${pluginId}/${rel}`
}

/**
 * 协议处理器的逆向：`/ui/index.html` → `ui/index.html`，空路径回落到默认入口。
 * 与 `pluginEntryUrl` 的前缀规则保持同一处定义，改一边就是改两边。
 */
export function pluginEntryPath(pathname: string): string {
  return decodeURIComponent(String(pathname || '')).replace(/^\/+/, '') || DEFAULT_PLUGIN_UI_ENTRY
}
