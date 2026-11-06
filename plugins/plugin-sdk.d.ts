/**
 * 插件开发用的类型入口 —— 给 `main.mjs` 的 JSDoc 用，**不参与宿主构建**。
 *
 * 用法：在 `main.mjs` 里用 JSDoc 引用这里的类型。下面这行是给 `ctx` 参数标注的
 * 写法（把 `@type` 后面的表达式换成 `import('./plugin-sdk').PluginContext`）：
 *
 * ```js
 * /// <reference path="./plugin-sdk.d.ts" />
 *
 * export async function activate(ctx) { … }   // ctx 标成 PluginContext
 * ```
 *
 * 更细的形状也能单独取：`import('./plugin-sdk').PluginToolExecuteParams`、
 * `.PluginSendSpec`、`.PluginSessionRunEvent`、`.PluginToolResult`。
 *
 * 定义只有一份，在 `packages/shared/plugin-context.ts`——宿主的 `buildContext()`
 * 也标注它。这里刻意只做转出：复制一份结构会漂移，而漂移的契约比没有契约更危险。
 *
 * 想要编辑器真的报错（而不只是补全）：在文件第一行加 `// @ts-check`。
 * 那是逐文件开关，加了就得自己维持零错误——新插件建议从第一天就加。
 */

export * from '../packages/shared/plugin-context'

/**
 * ctx 签名上用到、但在 plugin-context.ts 里是 `import type` 进来的形状——
 * 不跟着 `export *` 出来，单独转出（复审 P2-6）。
 */
export type {
  PluginMessageOrigin,
  PluginUIQuestion,
  PluginUIQuestionnaireResult,
} from '../packages/shared/plugin-context'

/**
 * 托盘的数据形状：`ctx.ui.setComposerBar` 的第二个参数就是它。
 * ctx 里是 `import type` 用的，不会跟着 `export *` 出来，所以这里显式转出。
 */
export type {
  PluginComposerBarActionIcon,
  PluginComposerBarRow,
  PluginComposerBarRowAction,
  PluginComposerBarRowState,
  PluginComposerBarState,
  PluginComposerBarTone,
} from '../packages/shared/plugin-composer-bar'

/** 工具结果形状（`invoke('tool.execute')` 的返回）在 manifest 契约里 */
export type { PluginToolResult } from '../packages/shared/plugin-manifest'
