/**
 * 插件 → 宿主的界面请求（目前只有问卷）。
 *
 * 插件 main 侧调 `ctx.ui.ask(questions)` 时，宿主把它变成一次 extension-ui 对话框请求，
 * 复用现成的 QuestionnaireDialog（键盘导航、选项预览、草稿保留都是白拿的）。
 * 这里只放**结构**，渲染逻辑仍在 renderer/features/extension-ui。
 */

export type PluginUIQuestionOption = {
  label: string
  description?: string
}

export type PluginUIQuestion = {
  question: string
  /** 短标题（对话框顶部的小标签） */
  header?: string
  /** 允许多选 */
  multiSelect?: boolean
  options: PluginUIQuestionOption[]
}

export type PluginUIAnswer = {
  questionIndex: number
  question: string
  kind: 'option' | 'multi' | 'custom'
  answer: string | null
  selected?: string[]
}

export type PluginUIQuestionnaireResult = {
  cancelled: boolean
  answers: PluginUIAnswer[]
}

export const EMPTY_QUESTIONNAIRE: PluginUIQuestionnaireResult = { cancelled: true, answers: [] }

/** 插件 UI 请求的 id 前缀：宿主据此把回答路由回 main 侧的等待者，而不是转发给 worker */
export const PLUGIN_UI_ID_PREFIX = 'plugin-ui-'

export function isPluginUIRequestId(id: string): boolean {
  return id.startsWith(PLUGIN_UI_ID_PREFIX)
}

/** renderer → main 的回答（与 extension-ui 的 respondUI 同一通道，靠 id 前缀区分） */
export type PluginUIResponse = {
  id: string
  cancelled?: boolean
  result?: unknown
}
