import { app } from 'electron'
import { basename, dirname, join } from 'node:path'

/**
 * 产物路径统一入口。
 *
 * 主进程有多个 entry（index / worker / preview / preview-wsl），共享模块会被拆到
 * out/main/chunks/*.js，于是 **`__dirname` 可能指向 out/main/chunks**。
 * `join(__dirname, '../preload/index.cjs')` 在 chunk 里就变成 out/main/preload/index.cjs，
 * 表现为 preload 加载 ENOENT → 渲染端拿不到 window.piDesktop → 界面在但点哪都没反应。
 * 同类错误还会命中 out/renderer/index.html 与 build/icon.*（托盘「App icon is unavailable」）。
 *
 * 因此产物路径一律以 app root 为基准重新推导，不要再写 `join(__dirname, '..', ...)`。
 */

function readAppPath(): string | undefined {
  // 单测里 electron 常被整体 mock（没有 app），默认值只在真正调用时才求值。
  return app?.getAppPath?.() ?? process.cwd()
}

/** 应用根目录：开发态是仓库根，打包态是 asar 根。也接受已经被传进来的 out/main。 */
export function resolveAppRoot(appPath: string | undefined = readAppPath()): string {
  if (!appPath) return process.cwd()
  return basename(appPath) === 'main' && basename(dirname(appPath)) === 'out'
    ? dirname(dirname(appPath))
    : appPath
}

/** 主进程产物目录 out/main（utility entry 的同级）。 */
export function resolveMainOutDir(appPath?: string): string {
  return join(resolveAppRoot(appPath), 'out', 'main')
}

/** out/preload/<file>：主窗口与通知宿主窗口的 preload。 */
export function resolvePreloadFile(
  file: 'index.cjs' | 'notification.cjs',
  appPath?: string,
): string {
  return join(resolveAppRoot(appPath), 'out', 'preload', file)
}

/** out/renderer/index.html：非 dev 模式下的窗口入口。 */
export function resolveRendererHtml(appPath?: string): string {
  return join(resolveAppRoot(appPath), 'out', 'renderer', 'index.html')
}

/** 仓库根的静态资源（build/icon.ico、resources/icon.png 等）。 */
export function resolveAppAsset(...segments: string[]): string {
  return join(resolveAppRoot(), ...segments)
}
