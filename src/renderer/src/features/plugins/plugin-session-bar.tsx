import { PluginPanelFrame } from './plugin-panel-frame'
import { usePluginSessionBars } from './use-plugin-session-bars'

/**
 * 对话顶部的插件会话条。
 *
 * 宿主对它的全部理解就是「一条跟着当前会话走的 iframe」：显不显示、多高、画什么，
 * 都由插件自己决定（它更清楚哪些任务/成员属于当前会话）。宿主只做两件事——给一个
 * 位置，按插件上报的高度收放。所以这里不做归属反查，也不预判空态：插件报 0 就塌缩。
 *
 * 放在对话区顶部而不是右栏，是因为它回答的是「我这个会话后台在干什么」——这个问题
 * 必须在视线第一落点上，翻面板去确认就已经输了。
 *
 * ⚠️ 右上角安全区：宿主有一个浮在对话区右上角的「刷新会话」按钮
 * （MainColRightPanelToggle，绝对定位 right-3 top-2，28×28，垂直落在 44px 条内）。
 * 插件 UI 最右端的内容要自行避让约 48px，否则会被压在按钮下面。
 */
export function PluginSessionBar() {
  const bars = usePluginSessionBars()
  if (bars.length === 0) return null
  return (
    <>
      {bars.map((bar) => (
        <PluginPanelFrame
          key={`${bar.pluginId}:${bar.id}`}
          pluginId={bar.pluginId}
          panelId={`plugin:${bar.pluginId}:${bar.id}`}
          title={bar.title}
          entry={bar.entry}
          sizing="content"
          defaultHeight={bar.height}
        />
      ))}
    </>
  )
}
