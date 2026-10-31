import { useTranslation } from 'react-i18next'
import { useUIStore } from '@renderer/stores/ui-store'
import { CHAT_CENTER_VIEW, pluginViewGlobalId } from '@shared/plugin-manifest'
import { PluginPanelFrame } from './plugin-panel-frame'
import { usePluginViews } from './use-plugin-views'

/**
 * 中央内容区的插件视图：整块工作区交给插件（sandbox iframe）。
 *
 * 与右栏面板共用同一个容器组件（PluginPanelFrame），差别只有落点和宽度：
 * 插件用同一份 ui/index.html，按自身宽度自适应即可。
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

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-plugin-center={pluginId}>
      <PluginPanelFrame
        pluginId={pluginId}
        panelId={pluginViewGlobalId(pluginId, viewId)}
        title={view.title}
        entry={view.entry}
      />
    </div>
  )
}
