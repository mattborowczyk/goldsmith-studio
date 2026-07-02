import { useEffect } from 'react'
import { Activity, ArrowDownToLine, Split, Undo2, Wrench } from 'lucide-react'
import {
  analyzeSelected,
  applyBaseCap,
  beginBaseCap,
  cancelBaseCap,
  healSelected,
  splitSelected,
  undoHeal,
  updateBaseCap,
} from '@/app/studio'
import type { AnalysisReport, HealMode, SectionAxis } from '@/core/types'
import { HEAL_PRESETS } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

function Stat({ label, value, bad }: { label: string; value: string | number; bad?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('readout text-xs', bad ? 'text-error font-semibold' : 'text-foreground')}>
        {value}
      </span>
    </div>
  )
}

function ReportStats({ report }: { report: AnalysisReport }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <Stat label="Triangles" value={report.triangles.toLocaleString()} />
      <Stat label="Vertices" value={report.vertices.toLocaleString()} />
      <Stat label="Shells" value={report.shells} />
      <Stat label="Boundary edges (holes)" value={report.boundaryEdges} bad={report.boundaryEdges > 0} />
      <Stat label="Hole loops" value={report.boundaryLoops} bad={report.boundaryLoops > 0} />
      <Stat label="Non-manifold edges" value={report.nonManifoldEdges} bad={report.nonManifoldEdges > 0} />
      <Stat label="Inverted shells" value={report.invertedShells} bad={report.invertedShells > 0} />
      <Stat label="Watertight" value={report.watertight ? 'yes' : 'NO'} bad={!report.watertight} />
      <Stat label="Volume" value={`${report.volume.toFixed(2)} mm³`} />
      <Stat label="Surface area" value={`${report.surfaceArea.toFixed(2)} mm²`} />
    </div>
  )
}

/** Close-open-base tool (issue #26): axis pick + cap-plane slider + apply. */
function BaseCapSection({ busy, hasTarget }: { busy: boolean; hasTarget: boolean }) {
  const repair = useAppStore((s) => s.repair)
  const cap = repair.baseCap

  // hide the placement plane when the Repair tab unmounts mid-tool
  useEffect(() => cancelBaseCap, [])

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
      <label className="text-xs font-medium text-muted-foreground">Close open base</label>
      <p className="text-xs text-muted-foreground">
        For scans that arrive as an open shell (the whole top missing): extrudes the open rim to a
        flat plane and caps it, making the mesh watertight for the Fit tools.
      </p>
      {!cap ? (
        <Button variant="secondary" disabled={busy || !hasTarget} onClick={() => void beginBaseCap()}>
          <ArrowDownToLine />
          {repair.busy === 'baseCap' ? 'Finding open rim…' : 'Close open base'}
        </Button>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">
          <div className="flex gap-1">
            {(['x', 'y', 'z'] as SectionAxis[]).map((axis) => (
              <Button
                key={axis}
                variant={cap.axis === axis ? 'default' : 'secondary'}
                size="sm"
                className="flex-1 uppercase"
                onClick={() => updateBaseCap({ axis })}
              >
                {axis}
              </Button>
            ))}
          </div>
          <label className="text-xs text-muted-foreground">
            Base plane{' '}
            <span className="readout text-foreground">{cap.position.toFixed(2)} mm</span>
            <Slider
              min={cap.min}
              max={cap.max}
              step={Math.max((cap.max - cap.min) / 200, 0.01)}
              value={[cap.position]}
              onValueChange={([position]) => updateBaseCap({ position })}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Open rim: {cap.info.loopEdges.toLocaleString()} edges
            {cap.info.loopCount > 1 ? ` (+${cap.info.loopCount - 1} smaller holes left to Heal)` : ''}
          </p>
          <div className="flex gap-2">
            <Button className="flex-1" disabled={busy} onClick={() => void applyBaseCap()}>
              {repair.busy === 'baseCap' ? 'Capping…' : 'Apply cap'}
            </Button>
            <Button variant="secondary" className="flex-1" disabled={busy} onClick={cancelBaseCap}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function RepairPanel() {
  const repair = useAppStore((s) => s.repair)
  const patchRepair = useAppStore((s) => s.patchRepair)
  const selectedId = useAppStore((s) => s.selectedId)
  const parts = useAppStore((s) => s.parts)
  const busy = repair.busy !== null
  const hasTarget = selectedId !== null || parts.length === 1

  const setMode = (mode: HealMode) => {
    if (mode === 'custom') patchRepair({ options: { ...repair.options, mode } })
    else patchRepair({ options: { mode, ...HEAL_PRESETS[mode] } })
  }

  return (
    <div className="flex flex-col gap-4">
      {!hasTarget && (
        <p className="text-xs text-muted-foreground">
          Tap a part in the viewport or parts list to choose what to analyze.
        </p>
      )}

      <Button disabled={busy || !hasTarget} onClick={() => void analyzeSelected()}>
        <Activity />
        {repair.busy === 'analyze' ? 'Analyzing…' : 'Analyze'}
      </Button>

      {repair.report && !repair.beforeAfter && (
        <>
          <ReportStats report={repair.report} />
          {(repair.report.boundaryEdges > 0 || repair.report.invertedShells > 0) && (
            <p className="text-xs text-muted-foreground">
              <span className="text-error">Red lines</span> = open hole edges ·{' '}
              <span className="text-[#4090ff]">blue dots</span> = flipped faces
            </p>
          )}
        </>
      )}

      <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
        <label className="text-xs font-medium text-muted-foreground">Heal mode</label>
        <Select value={repair.options.mode} onChange={(e) => setMode(e.target.value as HealMode)}>
          <option value="safe">Safe (clean models)</option>
          <option value="aggressive">Aggressive (dirty scans)</option>
          <option value="custom">Custom</option>
        </Select>

        {repair.options.mode === 'custom' && (
          <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">
            <label className="text-xs text-muted-foreground">
              Weld tolerance (mm)
              <input
                type="number"
                step="0.001"
                min="0"
                value={repair.options.tolerance}
                onChange={(e) =>
                  patchRepair({
                    options: { ...repair.options, tolerance: parseFloat(e.target.value) || 0 },
                  })
                }
                className="mt-1 h-10 w-full rounded-md border border-border bg-input/50 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Drop shells under (mm³)
              <input
                type="number"
                step="0.01"
                min="0"
                value={repair.options.minShellVolume}
                onChange={(e) =>
                  patchRepair({
                    options: { ...repair.options, minShellVolume: parseFloat(e.target.value) || 0 },
                  })
                }
                className="mt-1 h-10 w-full rounded-md border border-border bg-input/50 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Fill holes up to (edges)
              <input
                type="number"
                step="1"
                min="0"
                value={repair.options.fillHolesUpTo}
                onChange={(e) =>
                  patchRepair({
                    options: { ...repair.options, fillHolesUpTo: parseInt(e.target.value) || 0 },
                  })
                }
                className="mt-1 h-10 w-full rounded-md border border-border bg-input/50 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
        )}

        <Button disabled={busy || !hasTarget} onClick={() => void healSelected()}>
          <Wrench />
          {repair.busy === 'heal' ? 'Healing…' : 'Heal'}
        </Button>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            disabled={busy || !hasTarget}
            onClick={() => void splitSelected()}
          >
            <Split />
            {repair.busy === 'split' ? 'Splitting…' : 'Split shells'}
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            disabled={busy || !repair.canUndo}
            onClick={undoHeal}
          >
            <Undo2 />
            Undo heal
          </Button>
        </div>
      </div>

      <BaseCapSection busy={busy} hasTarget={hasTarget} />

      {repair.beforeAfter && (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
          <p className="text-xs font-medium text-muted-foreground">
            Before → after{' '}
            {repair.beforeAfter.unioned ? '(shells boolean-unioned)' : '(union skipped — still open)'}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <ReportStats report={repair.beforeAfter.before} />
            <ReportStats report={repair.beforeAfter.after} />
          </div>
        </div>
      )}

      {repair.error && (
        <p className="rounded-lg bg-destructive/15 px-3 py-2 text-xs text-destructive">
          {repair.error}
        </p>
      )}
    </div>
  )
}
