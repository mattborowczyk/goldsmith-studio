import { Viewport } from '@/components/Viewport'
import { TopBar } from '@/components/TopBar'
import { TabRail } from '@/components/TabRail'
import { PartsPanel } from '@/components/PartsPanel'
import { ImportPanel } from '@/components/panels/ImportPanel'
import { RepairPanel } from '@/components/panels/RepairPanel'
import { MeasurePanel } from '@/components/panels/MeasurePanel'
import { BuildPanel } from '@/components/panels/BuildPanel'
import { ResizePanel } from '@/components/panels/ResizePanel'
import { FitPanel } from '@/components/panels/FitPanel'
import { CostPanel } from '@/components/panels/CostPanel'
import { DeliverPanel } from '@/components/panels/DeliverPanel'
import { PwaBanner } from '@/components/PwaBanner'
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

export default function App() {
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
        {tab === 'import' && <ImportPanel />}
        {tab === 'repair' && <RepairPanel />}
        {tab === 'measure' && <MeasurePanel />}
        {tab === 'build' && <BuildPanel />}
        {tab === 'resize' && <ResizePanel />}
        {tab === 'fit' && <FitPanel />}
        {tab === 'cost' && <CostPanel />}
        {tab === 'deliver' && <DeliverPanel />}
      </aside>

      <PwaBanner />
    </div>
  )
}
