import { normalizeLegacyIconName, type AppIconName } from '@renderer/components/icons'

/** 插件图标名 → 宿主图标：先按原名查表，再把 PascalCase 转成 kebab 重查（AlarmClock → alarm-clock） */
export function resolvePluginIcon(raw: string | undefined): AppIconName {
  if (!raw) return 'panel-right'
  const direct = normalizeLegacyIconName(raw)
  if (direct) return direct
  const kebab = raw.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  return normalizeLegacyIconName(kebab) ?? 'panel-right'
}
