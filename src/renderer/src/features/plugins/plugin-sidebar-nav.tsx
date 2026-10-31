import { useTranslation } from 'react-i18next'
import { useUIStore } from '@renderer/stores/ui-store'
import { normalizeLegacyIconName, resolveAppIcon, type AppIconName } from '@renderer/components/icons'
import { cn } from '@renderer/lib/utils'
import { CHAT_CENTER_VIEW, pluginViewGlobalId, type CenterView } from '@shared/plugin-manifest'
import { usePluginViews, type PluginViewEntry } from './use-plugin-views'

/**
 * 侧栏顶部「应用」区：插件中央视图的入口。
 *
 * 放在滚动容器之外（搜索框之上），所以永远可见——入口被项目列表滚走是上一个大坑。
 * 没有插件声明 views 时整块不渲染，宿主外观与未装插件时完全一致。
 * 再次点击已激活的入口 = 回到对话。
 */

/** 插件图标名 → 宿主图标：先按原名查表，再把 PascalCase 转成 kebab 重查（AlarmClock → alarm-clock） */
function resolvePluginIcon(raw: string | undefined): AppIconName {
  if (!raw) return 'panel-right'
  const direct = normalizeLegacyIconName(raw)
  if (direct) return direct
  const kebab = raw.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  return normalizeLegacyIconName(kebab) ?? 'panel-right'
}

function viewToCenterView(view: PluginViewEntry): CenterView {
  return { kind: 'plugin', pluginId: view.pluginId, viewId: view.id }
}

export function PluginSidebarNav() {
  const { t } = useTranslation()
  const collapsed = useUIStore((s) => s.sidebarCollapsed)
  const centerView = useUIStore((s) => s.centerView)
  const setCenterView = useUIStore((s) => s.setCenterView)
  const views = usePluginViews()

  if (collapsed || views.length === 0) return null

  const multiPlugin = new Set(views.map((v) => v.pluginId)).size > 1

  return (
    <div className="shrink-0 px-3 pb-2 pt-2" data-plugin-nav="">
      <div className="sidebar-section-head">
        <span className="sidebar-section-title flex-1 px-1">{t('common:sidebar.apps')}</span>
      </div>
      <div className="mt-0.5">
        {views.map((view) => {
          const active =
            centerView.kind === 'plugin' &&
            centerView.pluginId === view.pluginId &&
            centerView.viewId === view.id
          const Icon = resolveAppIcon(resolvePluginIcon(view.icon))
          const label = multiPlugin ? `${view.title}` : view.title
          return (
            <button
              key={pluginViewGlobalId(view.pluginId, view.id)}
              type="button"
              data-plugin-view={`${view.pluginId}:${view.id}`}
              aria-pressed={active}
              title={multiPlugin ? `${view.pluginName} · ${view.title}` : view.title}
              onClick={() => setCenterView(active ? CHAT_CENTER_VIEW : viewToCenterView(view))}
              className={cn(
                'nav-row sider-item-motion flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px] leading-[20px]',
                active
                  ? 'nav-row-active font-medium text-foreground'
                  : 'text-foreground-secondary/90 hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
