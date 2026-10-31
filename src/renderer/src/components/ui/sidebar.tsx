import { cn } from '@renderer/lib/utils'
import { useUIStore } from '@renderer/stores/ui-store'
import { OverlayScrollHost } from '@renderer/components/ui/overlay-scrollbar'

interface SidebarProps {
  children: React.ReactNode
}

/** 宽度与收起动画由 MainLayoutShell 的 Grid 轨道负责 */
export function Sidebar({ children }: SidebarProps) {
  // 中央区被应用视图占用时，左栏只能有一个"实心选中项"（应用自己）：
  // 会话行退回"我会回到这里"的轻标记（样式见 globals.css 的 data-center 规则）。
  const centerKind = useUIStore((s) => s.centerView.kind)
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-center={centerKind}>
      {children}
    </div>
  )
}

export function SidebarHeader({ label }: { label: string }) {
  const collapsed = useUIStore((s) => s.sidebarCollapsed)
  if (collapsed) return null
  return (
    <div className="flex h-11 shrink-0 items-center border-b border-border/50 px-3">
      <span className="text-[13px] font-semibold tracking-wide text-foreground-secondary/90">{label}</span>
    </div>
  )
}

export function SidebarContent({ children }: { children: React.ReactNode }) {
  return (
    <OverlayScrollHost
      className="sidebar-scroll-host min-h-0 flex-1"
      scrollClassName="py-1"
      showRailOnHostHover
    >
      {children}
    </OverlayScrollHost>
  )
}

export function RightPanel({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
}

export function SidebarItem({ label, active, onClick, icon }: {
  label: string
  active?: boolean
  onClick?: () => void
  icon?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'nav-row sider-item-motion mx-1.5 flex w-[calc(100%-0.75rem)] cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] leading-[20px]',
        active ? 'nav-row-active font-medium text-foreground' : 'text-foreground-secondary/90 hover:text-foreground',
      )}
    >
      {icon}
      <span className="sidebar-label-fade">{label}</span>
    </button>
  )
}