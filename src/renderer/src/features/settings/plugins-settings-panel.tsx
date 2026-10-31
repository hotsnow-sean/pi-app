import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ipcClient, onAppEvent } from '@renderer/lib/ipc-client'
import { cn } from '@renderer/lib/utils'
import { ChevronLeft, FolderOpen, Plus } from '@renderer/components/icons'
import { resolveAppIcon } from '@renderer/components/icons'
import { Switch } from '@renderer/components/ui/switch'
import { SettingsPageHeader } from '@renderer/features/settings/settings-shell'
import { SettingRow, SettingsSection } from '@renderer/features/settings/settings-page-shared'
import {
  btnDanger,
  btnOutline,
  inputCls,
  numberInputCls,
  selectCls,
  textareaCls,
} from '@renderer/features/settings/settings-controls'
import { ConfirmDialog } from '@renderer/features/settings/confirm-dialog'
import { resolvePluginIcon } from '@renderer/features/plugins/plugin-icon'
import type { PluginSettingField } from '@shared/plugin-manifest'

/**
 * 设置 → 插件：目录、启停、安装、卸载，以及**声明式设置项**的通用表单。
 *
 * 设置项值由宿主持久化（<userData>/plugin-data/<id>/settings.json），表单即时保存：
 * 插件设置多半是"开关/路径/阈值"，攒批点保存只会让人忘了点。改完 350ms 落盘，失败回滚并提示。
 */

type PluginRow = {
  id: string
  name: string
  version: string
  description?: string
  icon?: string
  enabled: boolean
  error?: string
  source: 'builtin' | 'user'
  dir: string
  views: { id: string; title: string; description?: string }[]
  panels: { id: string; title: string }[]
  settings: PluginSettingField[]
}

type SaveState = 'idle' | 'saving' | 'saved'

/** main 侧错误码 → 文案 key（其余原样展示） */
const ERROR_KEYS: Record<string, string> = {
  cancelled: 'settings:plugins.installCancelled',
  'no plugin.json found': 'settings:plugins.installNoManifest',
  already_installed: 'settings:plugins.overwriteTitle',
  builtin_not_removable: 'settings:plugins.builtinCannotRemove',
  'plugin_id_required': 'settings:plugins.genericError',
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: PluginSettingField
  value: unknown
  onChange: (next: unknown) => void
}) {
  if (field.type === 'boolean') {
    return <Switch checked={value === true} onCheckedChange={(next) => onChange(next)} />
  }
  if (field.type === 'number') {
    return (
      <input
        type="number"
        className={numberInputCls}
        value={typeof value === 'number' ? String(value) : ''}
        min={field.min}
        max={field.max}
        step={field.step}
        aria-label={field.label}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
      />
    )
  }
  if (field.type === 'select') {
    return (
      <select
        className={selectCls}
        value={typeof value === 'string' ? value : ''}
        aria-label={field.label}
        onChange={(event) => onChange(event.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }
  const text = typeof value === 'string' ? value : ''
  if (field.multiline) {
    return (
      <textarea
        className={textareaCls}
        value={text}
        rows={3}
        placeholder={field.placeholder}
        aria-label={field.label}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }
  return (
    <input
      className={inputCls}
      type={field.secret ? 'password' : 'text'}
      value={text}
      placeholder={field.placeholder}
      aria-label={field.label}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function PluginsSettings() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<PluginRow[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [pendingUninstall, setPendingUninstall] = useState<PluginRow | null>(null)
  const [pendingOverwrite, setPendingOverwrite] = useState<string[] | null>(null)
  /** 覆盖安装时沿用同一次选择的来源目录，确认后不再让用户重选 */
  const overwriteSource = useRef<string>('')

  const selected = rows?.find((row) => row.id === selectedId) ?? null
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId
  const patchRef = useRef<Record<string, unknown>>({})
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (): Promise<PluginRow[]> => {
    const res = (await ipcClient.invoke('plugins.catalog')) as { plugins?: PluginRow[] }
    const next = (res?.plugins ?? []).filter((row) => !!row?.id)
    setRows(next)
    return next
  }, [])

  useEffect(() => {
    void load().catch(() => setRows([]))
    // 目录在别处变化（安装/卸载/启停广播）时同步刷新，避免设置页显示过期状态
    return onAppEvent((event) => {
      if (event.type === 'adapter-catalog-changed') void load().catch(() => {})
    })
  }, [load])

  // 打开详情时拉一次设置值（目录里只有 schema，没有值）
  useEffect(() => {
    if (!selectedId) return
    let active = true
    void ipcClient
      .invoke('plugins.settings.get', { pluginId: selectedId })
      .then((res) => {
        if (active) setValues((res?.values ?? {}) as Record<string, unknown>)
      })
      .catch(() => {
        if (active) setValues({})
      })
    setSaveState('idle')
    return () => {
      active = false
    }
  }, [selectedId])

  const flush = useCallback(async () => {
    const pluginId = selectedRef.current
    const patch = patchRef.current
    patchRef.current = {}
    if (!pluginId || Object.keys(patch).length === 0) return
    setSaveState('saving')
    try {
      const res = await ipcClient.invoke('plugins.settings.set', { pluginId, values: patch })
      if (!res?.ok) {
        toast.error(t('settings:plugins.settingsSaveFailed'))
        setSaveState('idle')
        return
      }
      if (pluginId === selectedRef.current) setValues((res.values ?? {}) as Record<string, unknown>)
      setSaveState('saved')
    } catch {
      toast.error(t('settings:plugins.settingsSaveFailed'))
      setSaveState('idle')
    }
  }, [t])

  const changeField = useCallback(
    (key: string, value: unknown) => {
      setValues((prev) => ({ ...prev, [key]: value }))
      patchRef.current = { ...patchRef.current, [key]: value }
      setSaveState('saving')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => void flush(), 350)
    },
    [flush],
  )

  // 离开详情/卸载时把未落盘的改动冲掉，不丢设置
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void flush()
    }
  }, [flush])

  const toggleEnabled = async (row: PluginRow) => {
    setToggling(row.id)
    try {
      const res = await ipcClient.invoke('plugins.setEnabled', { pluginId: row.id, enabled: !row.enabled })
      if (!res?.ok) {
        toast.error(t('settings:plugins.toggleFailed', { error: res?.error ?? '' }))
        return
      }
      await load()
    } catch {
      toast.error(t('settings:plugins.toggleFailed', { error: '' }))
    } finally {
      setToggling(null)
    }
  }

  const install = async (force = false) => {
    setInstalling(true)
    try {
      const payload = force ? { force: true, sourceDir: overwriteSource.current } : {}
      const res = await ipcClient.invoke('plugins.install', payload)
      if (!res?.ok) {
        if (Array.isArray(res?.needConfirm) && res.needConfirm.length > 0) {
          overwriteSource.current = String(res?.sourceDir ?? '')
          setPendingOverwrite(res.needConfirm)
          return
        }
        if (res?.error === 'cancelled') return
        const key = ERROR_KEYS[String(res?.error ?? '')]
        toast.error(key ? t(key) : t('settings:plugins.installFailed', { error: String(res?.error ?? '') }))
        return
      }
      await load()
      toast.success(t('settings:plugins.installedToast', { names: (res.installed ?? []).join(', ') }))
    } catch (error) {
      toast.error(t('settings:plugins.installFailed', { error: error instanceof Error ? error.message : '' }))
    } finally {
      setInstalling(false)
    }
  }

  const uninstall = async (row: PluginRow) => {
    setPendingUninstall(null)
    try {
      const res = await ipcClient.invoke('plugins.uninstall', { pluginId: row.id })
      if (!res?.ok) {
        const key = ERROR_KEYS[String(res?.error ?? '')]
        toast.error(key ? t(key) : t('settings:plugins.uninstallFailed', { error: String(res?.error ?? '') }))
        return
      }
      if (selectedRef.current === row.id) setSelectedId(null)
      await load()
      toast.success(t('settings:plugins.uninstalledToast', { name: row.name }))
    } catch (error) {
      toast.error(t('settings:plugins.uninstallFailed', { error: error instanceof Error ? error.message : '' }))
    }
  }

  const resetSettings = async () => {
    if (!selected) return
    const res = await ipcClient.invoke('plugins.settings.reset', { pluginId: selected.id })
    if (!res?.ok) {
      toast.error(t('settings:plugins.settingsSaveFailed'))
      return
    }
    setValues((res.values ?? {}) as Record<string, unknown>)
    toast.success(t('settings:plugins.settingsReset'))
  }

  const header = (
    <SettingsPageHeader
      title={t('settings:plugins.title')}
      description={t('settings:plugins.description')}
      action={
        <button type="button" className={btnOutline} disabled={installing} onClick={() => void install()}>
          <Plus className="mr-1 inline h-3.5 w-3.5" strokeWidth={2} />
          {installing ? t('settings:plugins.installing') : t('settings:plugins.install')}
        </button>
      }
    />
  )

  if (rows === null) {
    return <div className="py-4 text-sm text-muted-foreground/70">{t('settings:plugins.loading')}</div>
  }

  // ---------- 详情 ----------
  if (selected) {
    const Icon = resolveAppIcon(resolvePluginIcon(selected.icon))
    return (
      <div className="w-full" data-plugin-detail={selected.id}>
        <button
          type="button"
          onClick={() => setSelectedId(null)}
          className="mb-4 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-foreground-secondary hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
          {t('settings:plugins.backToList')}
        </button>

        <div className="mb-7 flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
            <Icon className="h-4 w-4 text-foreground-secondary" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-[20px] font-semibold leading-7 tracking-tight text-foreground">{selected.name}</h2>
              {selected.version && <span className="font-mono text-2xs text-muted-foreground">v{selected.version}</span>}
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-2xs font-medium',
                  selected.source === 'user' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                )}
              >
                {selected.source === 'user' ? t('settings:plugins.sourceUser') : t('settings:plugins.sourceBuiltin')}
              </span>
            </div>
            {selected.description && (
              <p className="mt-1 max-w-2xl text-[13px] leading-[1.65] text-foreground-secondary">{selected.description}</p>
            )}
          </div>
          <div className="shrink-0 pt-1">
            <Switch
              checked={selected.enabled}
              disabled={toggling === selected.id}
              onCheckedChange={() => void toggleEnabled(selected)}
            />
          </div>
        </div>

        {selected.error && (
          <div className="mb-4 rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t('settings:plugins.invalidManifest')}: {selected.error}
          </div>
        )}

        <div className="space-y-6">
          <SettingsSection
            title={t('settings:plugins.settingsTitle')}
            description={
              selected.settings.length > 0
                ? t('settings:plugins.settingsDesc')
                : t('settings:plugins.noSettings')
            }
            action={
              selected.settings.length > 0 ? (
                <div className="flex items-center gap-3">
                  <span className="text-2xs text-muted-foreground" aria-live="polite">
                    {saveState === 'saving'
                      ? t('settings:plugins.saving')
                      : saveState === 'saved'
                        ? t('settings:plugins.saved')
                        : ''}
                  </span>
                  <button type="button" className={btnOutline} onClick={() => void resetSettings()}>
                    {t('settings:plugins.resetDefaults')}
                  </button>
                </div>
              ) : undefined
            }
          >
            {selected.settings.length === 0 ? (
              <div className="settings-row text-[12.5px] leading-[1.6] text-foreground-secondary">
                {t('settings:plugins.noSettingsHint')}
              </div>
            ) : (
              selected.settings.map((field) => (
                <SettingRow
                  key={field.key}
                  label={field.label}
                  description={field.description}
                  settingKey={field.key}
                >
                  <div
                    data-plugin-setting={field.key}
                    className={field.type === 'string' && !field.multiline ? 'w-[22rem] max-w-[46vw]' : undefined}
                  >
                    <FieldControl
                      field={field}
                      value={values[field.key]}
                      onChange={(next) => changeField(field.key, next)}
                    />
                  </div>
                </SettingRow>
              ))
            )}
          </SettingsSection>

          <SettingsSection title={t('settings:plugins.capabilities')} description={t('settings:plugins.capabilitiesDesc')}>
            {selected.views.length === 0 && selected.panels.length === 0 ? (
              <div className="settings-row text-[12.5px] text-foreground-secondary">{t('settings:plugins.noCapabilities')}</div>
            ) : (
              <div className="settings-row flex flex-wrap gap-1.5">
                {selected.views.map((view) => (
                  <span
                    key={`view-${view.id}`}
                    className="rounded bg-muted/60 px-1.5 py-0.5 text-2xs text-foreground-secondary"
                  >
                    {t('settings:plugins.capView')} · {view.title}
                  </span>
                ))}
                {selected.panels.map((panel) => (
                  <span
                    key={`panel-${panel.id}`}
                    className="rounded bg-muted/60 px-1.5 py-0.5 text-2xs text-foreground-secondary"
                  >
                    {t('settings:plugins.capPanel')} · {panel.title}
                  </span>
                ))}
              </div>
            )}
          </SettingsSection>

          <SettingsSection title={t('settings:plugins.about')}>
            <div className="settings-row flex flex-col gap-2 text-[12.5px] text-foreground-secondary">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-muted-foreground">{t('settings:plugins.path')}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-2xs" title={selected.dir}>
                  {selected.dir}
                </code>
                <button
                  type="button"
                  className={btnOutline}
                  onClick={() => void ipcClient.invoke('plugins.reveal', { pluginId: selected.id })}
                >
                  <FolderOpen className="mr-1 inline h-3.5 w-3.5" strokeWidth={1.8} />
                  {t('settings:plugins.reveal')}
                </button>
              </div>
              <p className="text-2xs leading-relaxed text-muted-foreground">{t('settings:plugins.dirHint')}</p>
            </div>
            <div className="settings-row flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13.5px] font-medium text-foreground">{t('settings:plugins.uninstall')}</div>
                <div className="mt-0.5 text-[12px] leading-[1.55] text-foreground-secondary">
                  {selected.source === 'user' ? t('settings:plugins.uninstallDesc') : t('settings:plugins.builtinCannotRemove')}
                </div>
              </div>
              <button
                type="button"
                className={btnDanger}
                disabled={selected.source !== 'user'}
                onClick={() => setPendingUninstall(selected)}
              >
                {t('settings:plugins.uninstall')}
              </button>
            </div>
          </SettingsSection>
        </div>

        <ConfirmDialog
          open={pendingUninstall !== null}
          destructive
          title={t('settings:plugins.uninstallConfirmTitle')}
          message={t('settings:plugins.uninstallConfirmMsg', { name: pendingUninstall?.name ?? '' })}
          confirmLabel={t('settings:plugins.uninstall')}
          onConfirm={() => pendingUninstall && void uninstall(pendingUninstall)}
          onCancel={() => setPendingUninstall(null)}
        />
      </div>
    )
  }

  // ---------- 列表 ----------
  return (
    <div className="w-full">
      {header}
      {rows.length === 0 ? (
        <div className="workbench-empty">
          <div className="text-sm text-foreground-secondary">{t('settings:plugins.empty')}</div>
          <div className="mt-1 max-w-md text-center text-xs leading-relaxed text-muted-foreground">
            {t('settings:plugins.emptyHint')}
          </div>
          <button type="button" className={cn(btnOutline, 'mt-3')} onClick={() => void install()}>
            {t('settings:plugins.install')}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const Icon = resolveAppIcon(resolvePluginIcon(row.icon))
            return (
              <div
                key={row.id}
                data-plugin-row={row.id}
                className="rounded-lg border border-border/60 bg-card/40 p-3 transition-colors hover:border-border"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
                    <Icon className="h-4 w-4 text-foreground-secondary" />
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    className="min-w-0 flex-1 text-left"
                    data-plugin-open={row.id}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[14px] font-medium text-foreground">{row.name}</span>
                      {row.version && <span className="font-mono text-2xs text-muted-foreground">v{row.version}</span>}
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-2xs font-medium',
                          row.source === 'user' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {row.source === 'user' ? t('settings:plugins.sourceUser') : t('settings:plugins.sourceBuiltin')}
                      </span>
                      {row.settings.length > 0 && (
                        <span className="rounded bg-muted/60 px-1.5 py-0.5 text-2xs text-muted-foreground">
                          {t('settings:plugins.settingsCount', { count: row.settings.length })}
                        </span>
                      )}
                      {row.error && (
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-2xs text-destructive">
                          {t('settings:plugins.invalidBadge')}
                        </span>
                      )}
                      {!row.enabled && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                          {t('settings:plugins.disabledBadge')}
                        </span>
                      )}
                    </div>
                    {row.description && (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground/70">{row.description}</div>
                    )}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {row.views.map((view) => (
                        <span key={`v-${view.id}`} className="rounded bg-muted/50 px-1.5 py-0.5 text-2xs text-muted-foreground">
                          {view.title}
                        </span>
                      ))}
                      {row.panels.map((panel) => (
                        <span key={`p-${panel.id}`} className="rounded bg-muted/50 px-1.5 py-0.5 text-2xs text-muted-foreground">
                          {panel.title}
                        </span>
                      ))}
                    </div>
                  </button>
                  <Switch
                    checked={row.enabled}
                    disabled={!!row.error || toggling === row.id}
                    onCheckedChange={() => void toggleEnabled(row)}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={pendingOverwrite !== null}
        destructive
        title={t('settings:plugins.overwriteTitle')}
        message={t('settings:plugins.overwriteMsg', { names: (pendingOverwrite ?? []).join(', ') })}
        confirmLabel={t('settings:plugins.overwriteConfirm')}
        onConfirm={() => {
          setPendingOverwrite(null)
          void install(true)
        }}
        onCancel={() => setPendingOverwrite(null)}
      />
    </div>
  )
}
