/**
 * 插件 → 宿主会话的消息契约（main / worker / renderer 共用）。
 *
 * 插件给会话送话有两条路，语义不同，不要混用：
 * - `runAgentPrompt`：另起一个 headless 会话，用户看不见，历史不连续；
 * - `sessions.send`（本文件）：投进**用户自己的那个会话**，落盘是 custom_message，
 *   照样进模型上下文、驱动完整一轮，但界面上标明来源，不冒充用户输入。
 *
 * 后台任务的完成回报走第二条：它必须回到发起任务的那份对话里，接上原有上下文。
 */

/** 插件投递消息的 customType：宿主据此把「非人类来源的输入」与用户消息分开 */
export const PLUGIN_MESSAGE_CUSTOM_TYPE = 'plugin_host_message'

/**
 * 一轮输入的来源：这轮话是谁对会话说的。
 *
 * 为什么需要它：custom message 在会话里占的是「用户位」（模型视角），
 * 没有来源标注的话，用户在时间线上会看到一条自己没说过的话，误以为是自己打的。
 * 带上来源后界面可以渲染成转述行（`后台任务 → 会话 [回报] …`）。
 */
export type PluginMessageOrigin = {
  /** 哪个插件说的 */
  pluginId: string
  /** 界面上显示的名字，如「后台任务」 */
  label: string
  /** 插件自定的细分类型（report / notice / …），宿主不解释，只用于样式与筛选 */
  kind?: string
  /** 补充说明，如任务标签 */
  detail?: string
}
