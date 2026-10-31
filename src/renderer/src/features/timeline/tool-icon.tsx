import { memo } from 'react'
import {
  FileCode2,
  FileEdit,
  FileText,
  FolderTree,
  PencilLine,
  Plug,
  Search,
  Terminal,
  Wrench,
  normalizeLegacyIconName,
  resolveAppIcon,
  type AppIconComponent,
  type AppIconName,
} from '@renderer/components/icons'
import { cn } from '@renderer/lib/utils'
import { resolveToolCardDef } from './tool-card-registry'
import { isMcpToolName } from './mcp-tool'

const BUILTIN_ICON: Record<string, AppIconComponent> = {
  read: FileText,
  edit: PencilLine,
  write: FileEdit,
  insert: FileEdit,
  bash: Terminal,
  codemode: FileCode2,
  ls: FolderTree,
  find: Search,
  fffind: Search,
  grep: Search,
  ffgrep: Search,
}

export function resolveToolIconName(name: string): AppIconName {
  const declared = resolveToolCardDef(name)?.icon
  return normalizeLegacyIconName(declared) ?? 'wrench'
}

function ToolIconImpl({ name, className }: { name: string; className?: string }) {
  const cls = className || 'h-3.5 w-3.5 timeline-text-quiet'
  const Builtin = BUILTIN_ICON[name]
  const declaredIcon = resolveToolCardDef(name)?.icon
  const Icon =
    Builtin ?? (!declaredIcon && isMcpToolName(name) ? Plug : resolveAppIcon(resolveToolIconName(name))) ?? Wrench
  return <Icon className={cn(cls, 'text-current')} />
}

export const ToolIcon = memo(ToolIconImpl)
