import { useEffect } from 'react'
import {
  Box, Brush, Compass, Gauge, Layers, Loader2, Radar, RotateCcw, Scissors, Shell, Trash2, Wand2, X,
} from 'lucide-react'
// Import directly from the model modules — not the feature barrel — to avoid the
// fit ↔ grillz ↔ FitPanel import cycle (the barrel re-exports this component).
import {
  cancelFit,
  clearFitMap,
  computeClearanceMap,
  generateOffsetPart,
  setFitBandHalf,
  setFitClearance,
  setFitScanPart,
  setFitShellPart,
  subtractFit,
  teardownFit,
} from '../model/fitController'
import {
  clearBrushSelection,
  generateShell,
  setBrushRadius,
  setBrushSelect,
  setOpenGingival,
  setShellThickness,
} from '../model/shellController'
import {
  findBestFitAxis,
  resetInsertionAxis,
  runBlockout,
  setInsertionAxis,
  setRetention,
  toggleSurvey,
} from '../model/undercutController'
import { setWandSelect, setWandThreshold } from '../model/wandController'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import type { Vec3 } from '@/core/types'

/** Cement-gap presets (mm) — typical grillz/dental clearance band. */
const CLEARANCE_PRESETS = [0.03, 0.05, 0.08, 0.12]

/** Shell wall-thickness presets (mm) — the grillz/dental range. */
const SHELL_PRESETS = [0.6, 0.8, 1.0, 1.2, 1.5]

/** The clearance ramp: red (touch) → green (in band) → blue (loose). */
const CLEARANCE_GRADIENT =
  'linear-gradient(to right, rgb(230,41,41), rgb(51,199,82), rgb(51,107,235))'

/** The survey ramp: amber (shallow undercut) → red (deep). */
const UNDERCUT_GRADIENT = 'linear-gradient(to right, rgb(245,168,33), rgb(230,41,41))'

/** World-axis snap presets for the insertion direction. */
const AXIS_SNAPS: { label: string; axis: Vec3 }[] = [
  { label: '+X', axis: [1, 0, 0] }, { label: '−X', axis: [-1, 0, 0] },
  { label: '+Y', axis: [0, 1, 0] }, { label: '−Y', axis: [0, -1, 0] },
  { label: '+Z', axis: [0, 0, 1] }, { label: '−Z', axis: [0, 0, -1] },
]

function OperandSection() {
  const fit = useAppStore((s) => s.fit)
  const parts = useAppStore((s) => s.parts)

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Tooth scan
        <Select
          value={fit.scanPartId ?? ''}
          onChange={(e) => setFitScanPart(e.target.value || null)}
        >
          <option value="">Auto (selection)</option>
          {parts.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Grillz shell
        <Select
          value={fit.shellPartId ?? ''}
          onChange={(e) => setFitShellPart(e.target.value || null)}
        >
          <option value="">Pick a part…</option>
          {parts.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </label>
    </div>
  )
}

function ClearanceSection() {
  const clearanceMm = useAppStore((s) => s.fit.clearanceMm)

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <span className="text-xs font-medium text-muted-foreground">Cement gap</span>
      <div className="flex gap-1">
        {CLEARANCE_PRESETS.map((mm) => (
          <Button
            key={mm}
            variant={Math.abs(clearanceMm - mm) < 1e-6 ? 'default' : 'secondary'}
            size="sm"
            className="flex-1 tabular-nums"
            onClick={() => setFitClearance(mm)}
          >
            {mm.toFixed(2)}
          </Button>
        ))}
      </div>
      <label className="text-xs text-muted-foreground">
        Clearance <span className="readout text-foreground">{clearanceMm.toFixed(3)} mm</span>
        <Slider
          min={0}
          max={0.3}
          step={0.005}
          value={[clearanceMm]}
          onValueChange={([mm]) => setFitClearance(mm)}
        />
      </label>
    </div>
  )
}

function ActionsSection() {
  const fit = useAppStore((s) => s.fit)
  const parts = useAppStore((s) => s.parts)

  if (fit.busy) {
    return (
      <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          <span className="flex-1">{fit.stage ?? 'Working'}… {Math.round(fit.progress * 100)}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${fit.progress * 100}%` }} />
        </div>
        <Button variant="secondary" size="sm" onClick={cancelFit}>
          <X /> Cancel
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <Button variant="secondary" disabled={parts.length === 0} onClick={() => void generateOffsetPart()}>
        <Layers /> Generate offset scan
      </Button>
      <Button variant="secondary" disabled={parts.length < 2} onClick={() => void subtractFit()}>
        <Scissors /> Subtract from shell
      </Button>
      <p className="text-[11px] text-muted-foreground">
        Offset adds a new part to sculpt over; subtract carves the chosen gap into the shell interior.
      </p>
    </div>
  )
}

function ClearanceMapSection() {
  const fit = useAppStore((s) => s.fit)
  const parts = useAppStore((s) => s.parts)

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <span className="text-xs font-medium text-muted-foreground">Clearance map</span>
      <p className="text-[11px] text-muted-foreground">
        Colours the shell by gap to the tooth scan — the at-a-glance fit check.
      </p>
      <div className="flex gap-2">
        <Button
          className="flex-1"
          variant={fit.mapEnabled ? 'default' : 'secondary'}
          disabled={parts.length < 2 || fit.busy}
          onClick={() => void computeClearanceMap()}
        >
          <Gauge />
          {fit.mapEnabled ? 'Recompute map' : 'Run clearance map'}
        </Button>
        {fit.mapEnabled && (
          <Button variant="ghost" size="icon" title="Clear map" onClick={clearFitMap}>
            <Trash2 />
          </Button>
        )}
      </div>

      {fit.mapEnabled && fit.mapRange && (
        <>
          <label className="text-xs text-muted-foreground">
            Tolerance band ± <span className="readout text-foreground">{fit.bandHalfMm.toFixed(3)} mm</span>
            <Slider
              min={0.005}
              max={0.05}
              step={0.005}
              value={[fit.bandHalfMm]}
              onValueChange={([mm]) => setFitBandHalf(mm)}
            />
          </label>
          <div className="h-2.5 w-full rounded-full" style={{ background: CLEARANCE_GRADIENT }} />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>≤ 0 · interference</span>
            <span>{fit.clearanceMm.toFixed(2)} mm · in band</span>
            <span>loose</span>
          </div>
          <p className="text-[10px] text-muted-foreground/70">
            Range {fit.mapRange.min.toFixed(3)} … {fit.mapRange.max.toFixed(3)} mm.
          </p>
        </>
      )}
    </div>
  )
}

function UndercutSection() {
  const fit = useAppStore((s) => s.fit)
  const parts = useAppStore((s) => s.parts)
  const axis = fit.insertionAxis

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <span className="text-xs font-medium text-muted-foreground">Undercut survey & blockout</span>
      <p className="text-[11px] text-muted-foreground">
        Colours the scan red/amber where it can’t draw off along the insertion axis. Drag the arrow to
        re-aim, then fill the undercuts to a clean seat.
      </p>
      <div className="flex gap-2">
        <Button
          className="flex-1"
          variant={fit.surveyEnabled ? 'default' : 'secondary'}
          disabled={parts.length === 0 || fit.busy}
          onClick={toggleSurvey}
        >
          <Radar />
          {fit.surveyEnabled ? 'Clear survey' : 'Run undercut survey'}
        </Button>
      </div>

      {fit.surveyEnabled && (
        <>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={fit.busy} onClick={resetInsertionAxis}>
              <RotateCcw /> Reset axis
            </Button>
            <span className="readout flex-1 text-right text-[11px] text-muted-foreground">
              {axis.map((n) => n.toFixed(2)).join(', ')}
            </span>
          </div>
          <div className="flex gap-1">
            {AXIS_SNAPS.map((s) => (
              <Button
                key={s.label}
                variant="secondary"
                size="sm"
                className="flex-1 tabular-nums"
                disabled={fit.busy}
                onClick={() => setInsertionAxis(s.axis)}
              >
                {s.label}
              </Button>
            ))}
          </div>
          <Button variant="secondary" disabled={fit.busy} onClick={() => void findBestFitAxis()}>
            <Compass /> Find best axis
          </Button>

          {fit.undercutArea !== null && (
            <>
              <div className="h-2.5 w-full rounded-full" style={{ background: UNDERCUT_GRADIENT }} />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>clear · neutral</span>
                <span>shallow</span>
                <span>deep undercut</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Undercut area <span className="readout text-foreground">{fit.undercutArea.toFixed(2)} mm²</span>
              </p>
            </>
          )}

          <label className="text-xs text-muted-foreground">
            Retention <span className="readout text-foreground">{fit.retentionMm.toFixed(3)} mm</span>
            <Slider
              min={0}
              max={0.05}
              step={0.005}
              value={[fit.retentionMm]}
              onValueChange={([mm]) => setRetention(mm)}
            />
          </label>
          <Button variant="secondary" disabled={fit.busy} onClick={() => void runBlockout()}>
            <Box /> Blockout undercuts
          </Button>
          <p className="text-[10px] text-muted-foreground/70">
            Blockout adds a new, draftable scan part. Retention leaves a little undercut for snap-fit grip.
          </p>
        </>
      )}
    </div>
  )
}

function ShellSection() {
  const fit = useAppStore((s) => s.fit)
  const parts = useAppStore((s) => s.parts)

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <span className="text-xs font-medium text-muted-foreground">Shell generator</span>
      <p className="text-[11px] text-muted-foreground">
        Builds a uniform-thickness shell that follows the offset tooth surface — a clean Nomad base.
        Pick teeth with the magic wand, brush to touch up, or generate over the whole scan.
      </p>

      <div className="flex gap-2">
        <Button
          className="flex-1"
          variant={fit.wandActive ? 'default' : 'secondary'}
          disabled={parts.length === 0 || fit.busy}
          onClick={() => setWandSelect(!fit.wandActive)}
        >
          <Wand2 />
          {fit.wandActive ? 'Picking teeth' : 'Pick tooth'}
        </Button>
        <Button
          className="flex-1"
          variant={fit.brushActive ? 'default' : 'secondary'}
          disabled={parts.length === 0 || fit.busy}
          onClick={() => setBrushSelect(!fit.brushActive)}
        >
          <Brush />
          {fit.brushActive ? 'Brushing region' : 'Brush region'}
        </Button>
        {(fit.brushActive || fit.wandActive || fit.brushCount > 0) && (
          <Button variant="ghost" size="icon" title="Clear selection" onClick={clearBrushSelection}>
            <Trash2 />
          </Button>
        )}
      </div>

      {fit.wandActive && (
        <>
          <label className="text-xs text-muted-foreground">
            Crease threshold{' '}
            <span className="readout text-foreground">{fit.wandThresholdDeg.toFixed(0)}°</span>
            <Slider
              min={10}
              max={80}
              step={1}
              value={[fit.wandThresholdDeg]}
              onValueChange={([deg]) => setWandThreshold(deg)}
            />
          </label>
          <p className="text-[10px] text-muted-foreground/70">
            Tap a tooth to auto-select it up to the surrounding creases; drag the slider to widen or
            narrow the last pick. {fit.brushCount} vertices selected.
          </p>
        </>
      )}

      {fit.brushActive && (
        <>
          <label className="text-xs text-muted-foreground">
            Brush radius <span className="readout text-foreground">{fit.brushRadiusMm.toFixed(1)} mm</span>
            <Slider
              min={0.5}
              max={5}
              step={0.5}
              value={[fit.brushRadiusMm]}
              onValueChange={([mm]) => setBrushRadius(mm)}
            />
          </label>
          <p className="text-[10px] text-muted-foreground/70">
            Drag over the scan to paint; hold Alt to erase. {fit.brushCount} vertices selected.
          </p>
        </>
      )}

      <div className="flex gap-1">
        {SHELL_PRESETS.map((mm) => (
          <Button
            key={mm}
            variant={Math.abs(fit.shellThicknessMm - mm) < 1e-6 ? 'default' : 'secondary'}
            size="sm"
            className="flex-1 tabular-nums"
            onClick={() => setShellThickness(mm)}
          >
            {mm.toFixed(1)}
          </Button>
        ))}
      </div>
      <label className="text-xs text-muted-foreground">
        Wall thickness <span className="readout text-foreground">{fit.shellThicknessMm.toFixed(2)} mm</span>
        <Slider
          min={0.6}
          max={1.5}
          step={0.1}
          value={[fit.shellThicknessMm]}
          onValueChange={([mm]) => setShellThickness(mm)}
        />
      </label>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={fit.openGingival}
          onChange={(e) => setOpenGingival(e.target.checked)}
        />
        Open gingival margin (slide-on)
      </label>

      <Button variant="secondary" disabled={parts.length === 0 || fit.busy} onClick={() => void generateShell()}>
        <Shell /> Generate shell
      </Button>

      {fit.toothWeights && fit.toothWeights.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-lg bg-muted/40 p-2 text-[11px] text-muted-foreground">
          {fit.toothWeights.length > 1 && (
            <div className="flex flex-col gap-0.5">
              {fit.toothWeights.map((g, i) => (
                <div key={i} className="flex justify-between">
                  <span>Tooth {i + 1}</span>
                  <span className="readout text-foreground">{g.toFixed(2)} g</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-between border-t border-border/60 pt-0.5 font-medium">
            <span>Total ({fit.toothWeights.length})</span>
            <span className="readout text-foreground">
              {fit.toothWeights.reduce((a, b) => a + b, 0).toFixed(2)} g
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export function FitPanel() {
  // tear the clearance map + any in-flight job down on tab switch
  useEffect(() => {
    return () => teardownFit()
  }, [])

  const error = useAppStore((s) => s.fit.error)

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        Grillz cement-gap prep: offset the tooth scan by a clearance, then carve it into your sculpted
        shell or check the fit. Cosmetic-jewellery use. Open scan (whole top missing)? Make it
        watertight first with Repair → Close open base.
      </p>
      <OperandSection />
      <ClearanceSection />
      <ActionsSection />
      <ClearanceMapSection />
      <UndercutSection />
      <ShellSection />
      {error && (
        <p className="rounded-lg bg-destructive/15 px-3 py-2 text-xs text-destructive">{error}</p>
      )}
    </div>
  )
}
