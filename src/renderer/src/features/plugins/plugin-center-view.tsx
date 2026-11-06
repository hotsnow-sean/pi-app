import { useTranslation } from 'react-i18next'
import { useUIStore } from '@renderer/stores/ui-store'
import { resolveAppIcon, ArrowLeft } from '@renderer/components/icons'
import { CHAT_CENTER_VIEW, pluginViewGlobalId } from '@shared/plugin-manifest'
import { PluginPanelFrame } from './plugin-panel-frame'
import { resolvePluginIcon } from './plugin-icon'
import { usePluginViews } from './use-plugin-views'

/**
 * 中央内容区的插件视图：整块工作区交给插件（sandbox iframe）。
 *
 * 与右栏面板共用同一个容器组件（PluginPanelFrame），差别只有落点和宽度：
 * 插件用同一份 ui/index.html，按自身宽度自适应即可。
 *
 * 顶部一条宿主工具条是刻意留给宿主的：左栏里"当前会话"和"当前应用"会同时高亮，
 * 用户需要一眼看出中间正在看的是应用，并且有一个不依赖左栏的明确出口。
 */
export function PluginCenterView({ pluginId, viewId }: { pluginId: string; viewId: string }) {
  const { t } = useTranslation()
  const setCenterView = useUIStore((s) => s.setCenterView)
  const views = usePluginViews()
  const view = views.find((v) => v.pluginId === pluginId && v.id === viewId)

  if (!view) {
    // 目录为空 = 首帧还没拉到；非空却找不到 = 插件被停用或卸载
    const known = views.length > 0
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-foreground-secondary">
        <span>{known ? t('common:plugins.viewUnavailable') : t('common:loading')}</span>
        {known && (
          <button type="button" className="workbench-button" onClick={() => setCenterView(CHAT_CENTER_VIEW)}>
            {t('common:plugins.backToChat')}
          </button>
        )}
      </div>
    )
  }

  const Icon = resolveAppIcon(resolvePluginIcon(view.icon))
  const showPluginName = view.pluginName && view.pluginName !== view.title

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-plugin-center={pluginId}>
      <div
        className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 pl-1.5 pr-3"
        data-plugin-center-bar={pluginViewGlobalId(pluginId, viewId)}
      >
        <button
          type="button"
          onClick={() => setCenterView(CHAT_CENTER_VIEW)}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-foreground-secondary transition-colors hover:bg-[var(--sidebar-row-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
          title={t('common:plugins.backToChat')}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('common:plugins.backToChat')}
        </button>
        <span className="h-3.5 w-px shrink-0 bg-border/70" aria-hidden="true" />
        <Icon className="ml-1 h-3.5 w-3.5 shrink-0 text-foreground-secondary" />
        <span className="truncate text-[12.5px] font-medium text-foreground-secondary">{view.title}</span>
        {showPluginName && (
          <span className="truncate text-[11px] text-foreground-secondary/60">{view.pluginName}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <PluginPanelFrame
          pluginId={pluginId}
          panelId={pluginViewGlobalId(pluginId, viewId)}
          placement="center"
          title={view.title}
          entry={view.entry}
        />
      </div>
    </div>
  )
}
