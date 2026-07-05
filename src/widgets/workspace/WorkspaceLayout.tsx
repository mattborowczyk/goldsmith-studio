import { Viewport } from '@/widgets/viewport'
import { TopBar } from '@/widgets/top-bar'
import { TabRail } from '@/widgets/tab-rail'
import { PartsPanel } from '@/widgets/parts-panel'
import { ImportPanel } from '@/features/import'
import { RepairPanel } from '@/features/repair'
import { MeasurePanel } from '@/features/measure'
import { BuildPanel } from '@/features/generators'
import { ResizePanel } from '@/features/resize'
import { FitPanel } from '@/features/fit'
import { CostPanel } from '@/features/cost'
import { DeliverPanel } from '@/features/deliver'
import { PwaBanner } from '@/features/pwa'
import { StorageBanner } from '@/features/storage'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useAppStore } from '@/store/appStore'

const TAB_TITLES: Record<string, string> = {
  import: 'Import',
  repair: 'Repair Center',
  measure: 'Measure & Sections',
  build: 'Generators',
  resize: 'Smart Resizer',
  fit: 'Grillz Fit',
  cost: 'Weight & Cost',
  deliver: 'Export & Reports',
}

export function WorkspaceLayout() {
  const tab = useAppStore((s) => s.tab)

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Viewport />
      <TopBar />
      <TabRail />
      <PartsPanel />

      <aside className="panel-glass absolute bottom-3 right-3 top-28 z-30 w-80 overflow-y-auto p-4 lg:top-16">
        <h2 className="mb-4 text-sm font-semibold tracking-wide text-primary">
          {TAB_TITLES[tab] ?? tab}
        </h2>
        {/* A panel crash is isolated here: the Viewport and chrome stay alive and
            the fallback offers a re-mount. Keyed by tab so each tab gets its own
            boundary and switching tabs clears a stale error. */}
        <ErrorBoundary key={tab} label="panel">
          {tab === 'import' && <ImportPanel />}
          {tab === 'repair' && <RepairPanel />}
          {tab === 'measure' && <MeasurePanel />}
          {tab === 'build' && <BuildPanel />}
          {tab === 'resize' && <ResizePanel />}
          {tab === 'fit' && <FitPanel />}
          {tab === 'cost' && <CostPanel />}
          {tab === 'deliver' && <DeliverPanel />}
        </ErrorBoundary>
      </aside>

      <StorageBanner />
      <PwaBanner />
    </div>
  )
}
