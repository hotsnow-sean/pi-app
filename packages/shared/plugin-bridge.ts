/**
 * 插件面板桥（iframe ↔ 宿主 renderer）的定址与协议版本。
 *
 * 桥脚本由**宿主**下发，插件 UI 只写业务——这是 VS Code webview（`acquireVsCodeApi`）、
 * Figma 插件（注入 `figma` 对象）、inSCADA（注入 `InscadaApi`）共同的做法。之前的形态是
 * 每个插件各抄一份客户端，已经分叉出三种行为（scheduler 10s 超时 / ask 无超时 /
 * background-tasks 既无超时也不握手），宿主一次不回包按钮就永远转圈。
 *
 * 定址用保留 hostname `__host`：`PLUGIN_ID_PATTERN` 要求首字符是字母，插件 id 永远
 * 不可能等于它，所以不会和真实插件目录撞车。
 *
 * 与 `plugin-panel-url.ts` 一样，本文件不允许有依赖：main / renderer / 测试三边都要能
 * 直接 import。
 */
import { PLUGIN_UI_SCHEME } from './plugin-panel-url'

/**
 * 桥协议版本。`plugin-ready` 里下发，桥脚本比对自己那一份，不一致只 warn 不失败。
 *
 * 加版本号的理由不是洁癖：宿主以后改消息形状时，用户的旧插件 UI 不会跟着重装，
 * 静默错位比起一行 warn 难查得多。桥脚本里的 `var PROTOCOL = <n>` 必须与这里一致，
 * 由 `plugin-bridge.test.ts` 守着（两份都在构建期定死，没有运行时同步手段）。
 */
export const PLUGIN_BRIDGE_PROTOCOL = 1

/** 保留 hostname：不是插件 id，走 bridge 分支而不是插件目录 */
export const PLUGIN_BRIDGE_HOST = '__host'

export const PLUGIN_BRIDGE_PATH = 'bridge.js'

/** `pi-plugin://__host/bridge.js`，插件 HTML 里以 `<script src>` 引用 */
export function pluginBridgeUrl(): string {
  return `${PLUGIN_UI_SCHEME}://${PLUGIN_BRIDGE_HOST}/${PLUGIN_BRIDGE_PATH}`
}

/** 协议处理器用：这个请求是不是要桥脚本（hostname 判定，不看路径大小写） */
export function isPluginBridgeRequest(hostname: string): boolean {
  return String(hostname || '').toLowerCase() === PLUGIN_BRIDGE_HOST
}
