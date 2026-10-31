import { CHAT_CENTER_VIEW } from '@shared/plugin-manifest'
import { useUIStore } from '@renderer/stores/ui-store'

/**
 * 把中央内容区从应用视图拉回对话。
 *
 * 「打开某个会话」是幂等意图：用户点了它，就要看见对话本身。但 switchSessionInPlace
 * 对"就是当前会话"会早退（保护流式投影），enterBlankSession 对"已经是空白会话"同样不产生
 * 状态变化 —— 停在应用视图里时，这类"再点一次"就表现为点了没反应。
 *
 * 所以导航入口统一先调这里：视图一定回到对话，会话内容由各自的既有逻辑决定是否重放。
 */
export function revealConversation(): void {
  const store = useUIStore.getState()
  if (store.centerView.kind !== 'chat') store.setCenterView(CHAT_CENTER_VIEW)
}
