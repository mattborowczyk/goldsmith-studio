import {
  FolderInput,
  Wrench,
  Ruler,
  Shapes,
  Scaling,
  Smile,
  Coins,
  FileText,
  LayoutGrid,
} from 'lucide-react'
import type { WorkflowTab } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import { cn } from '@/lib/utils'

const TABS: { id: WorkflowTab; label: string; icon: React.ElementType; enabled: boolean }[] = [
  { id: 'import', label: 'Import', icon: FolderInput, enabled: true },
  { id: 'repair', label: 'Repair', icon: Wrench, enabled: true },
  { id: 'measure', label: 'Measure', icon: Ruler, enabled: true },
  { id: 'build', label: 'Build', icon: Shapes, enabled: false },
  { id: 'resize', label: 'Resize', icon: Scaling, enabled: false },
  { id: 'fit', label: 'Fit', icon: Smile, enabled: false },
  { id: 'cost', label: 'Cost', icon: Coins, enabled: true },
  { id: 'deliver', label: 'Deliver', icon: FileText, enabled: false },
  { id: 'all', label: 'All', icon: LayoutGrid, enabled: false },
]

export function TabRail() {
  const tab = useAppStore((s) => s.tab)
  const setTab = useAppStore((s) => s.setTab)

  return (
    <nav className="panel-glass absolute left-3 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 p-1.5">
      {TABS.map(({ id, label, icon: Icon, enabled }) => (
        <button
          key={id}
          disabled={!enabled}
          onClick={() => setTab(id)}
          title={enabled ? label : `${label} — coming soon`}
          className={cn(
            'flex size-12 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium transition-colors',
            tab === id
              ? 'bg-primary text-primary-foreground'
              : enabled
                ? 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                : 'text-muted-foreground/30',
          )}
        >
          <Icon className="size-5" />
          {label}
        </button>
      ))}
    </nav>
  )
}
