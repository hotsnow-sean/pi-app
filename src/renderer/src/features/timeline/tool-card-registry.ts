import type { AdapterJson, ToolCardTemplate } from '@extension-compat/adapter-schema'
import { currentAdapterCatalog, invalidateAdapterSnapshots, useAdapterCatalog } from '@renderer/lib/adapter-catalog'
import { pluginToolCard } from '@renderer/features/plugins/plugin-tool-cards'

export function invalidateToolCardCatalog(): void {
  invalidateAdapterSnapshots()
}

export function resolveAdapterForTool(toolName: string): AdapterJson | undefined {
  return currentAdapterCatalog().find((adapter) => adapter.match.tools?.includes(toolName))
}

export function resolveToolCardTemplate(toolName: string | undefined): ToolCardTemplate | undefined {
  return resolveToolCardDef(toolName)?.template
}

/**
 * 工具卡声明：插件工具（plugin.json 的 tools[].card）优先，其次 adapter 的 toolCard。
 * 插件在前是因为它描述的正是自己那个工具；adapter 描述的是别人家的扩展。
 */
export function resolveToolCardDef(toolName: string | undefined): AdapterJson['toolCard'] | undefined {
  if (!toolName) return undefined
  const fromPlugin = pluginToolCard(toolName)
  if (fromPlugin) return fromPlugin as AdapterJson['toolCard']
  return resolveAdapterForTool(toolName)?.toolCard
}

export function resolveAdapterToolCardTemplate(toolName: string | undefined): string | undefined {
  return resolveToolCardDef(toolName)?.template
}

export function useToolCardCatalogReady(): boolean {
  return !!useAdapterCatalog()
}
