import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPluginUiUrl } from '@shared/plugin-panel-url'

/**
 * 生产环境 CSP 与插件文档 CSP 的边界。
 *
 * 背景（真实事故，v0.7.7-fork.5 安装版）：index.ts 在非 dev 时给**所有**响应盖一份应用级
 * CSP（`script-src 'self'`），把 protocol.ts 给插件文档准备的那份覆盖掉了。插件文档
 * origin 是 `pi-plugin://<插件>`，桥却在 `pi-plugin://__host` —— 跨 host 的脚本撞上
 * `'self'` 直接被拒，于是每个面板都是「插件桥未加载」。`npm run dev` 不注入 CSP，所以
 * 只在打包版复现。前两条守地址判定，第三条守调用点（纯函数对了，忘了用一样白搭）。
 */

const mainIndex = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')

describe('pi-plugin:// 响应不被应用级 CSP 覆盖', () => {
  it('认得插件协议下的所有 URL（含桥所在的保留 host）', () => {
    expect(isPluginUiUrl('pi-plugin://scheduler/index.html')).toBe(true)
    expect(isPluginUiUrl('pi-plugin://scheduler/app.js')).toBe(true)
    // 桥的 host 与插件不同 —— 正是它被 'self' 判成跨源的
    expect(isPluginUiUrl('pi-plugin://__host/bridge.js')).toBe(true)
  })

  it('别的协议照旧注入：renderer 生产环境走 file://，必须还在范围内', () => {
    expect(isPluginUiUrl('file:///app/out/renderer/index.html')).toBe(false)
    expect(isPluginUiUrl('https://api.github.com/releases')).toBe(false)
    expect(isPluginUiUrl('devtools://devtools/bundled/inspector.html')).toBe(false)
    // 只是前缀相像，不是同一个 scheme
    expect(isPluginUiUrl('pi-plugin-evil://scheduler/index.html')).toBe(false)
    expect(isPluginUiUrl('')).toBe(false)
  })

  it('onHeadersReceived 里必须先放行，再谈注入', () => {
    const guard = mainIndex.indexOf('isPluginUiUrl(details.url)')
    const override = mainIndex.indexOf("'Content-Security-Policy': [")
    expect(guard).toBeGreaterThan(-1)
    expect(override).toBeGreaterThan(guard)
  })
})
