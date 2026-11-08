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

/**
 * 这个 URL 是不是插件 UI 协议下的响应（`pi-plugin://…`）。
 *
 * 给生产环境的全局 CSP 注入用（src/main/index.ts 的 onHeadersReceived）：那里会给**所有**
 * 响应盖一份应用级 CSP（`script-src 'self'`），而插件文档要的是 protocol.ts 那份更贴身的
 * （`script-src pi-plugin:`）。盖上去的后果不是「更严格」而是「桥变跨源」——插件文档
 * origin 是 `pi-plugin://<插件>`，桥在 `pi-plugin://__host`，于是被 'self' 拒掉，每个面板
 * 都显示「插件桥未加载」（只在打包版复现，dev 不注入 CSP）。两份 CSP 并存也只是取交集，
 * 所以这类响应必须整份跳过。
 */
export function isPluginUiUrl(url: string): boolean {
  return String(url || '').startsWith(`${PLUGIN_UI_SCHEME}:`)
}
