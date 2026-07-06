import { useEffect } from 'react'
import { Crosshair, Maximize, RotateCcw, Scaling, Thermometer, Undo2 } from 'lucide-react'
import {
  applyResize,
  detectResizeFrame,
  setResizeAutoHead,
  setResizeAutoSeam,
  setResizeMode,
  setResizePicking,
  setResizeProtectedCenter,
  setResizeProtectedWidth,
  setResizeReheal,
  setResizeSeamWidth,
  setResizeSmoothing,
  setResizeStrainMap,
  setResizeTargetDiameter,
  setResizeTargetSize,
  setResizeTargetSystem,
  teardownResize,
  undoResize,
} from '@/app/studio'
import { SIZE_SYSTEMS, ukOptions, type SizeSystem } from '@/core/generators/ringSizes'
import { planResize, type ResizePlan } from '@/core/geometry/resize'
import type { ResizeMode } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'

const MODES: { id: ResizeMode; label: string; hint: string }[] = [
  { id: 'uniform', label: 'Wedding band', hint: 'Whole band resizes evenly (wall thickness kept).' },
  { id: 'protect-head', label: 'Solitaire', hint: 'Head/setting stays rigid; only the shank deforms.' },
]

function DetectSection() {
  const resize = useAppStore((s) => s.resize)
  const parts = useAppStore((s) => s.parts)

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" size="sm" disabled={parts.length === 0} onClick={detectResizeFrame}>
        <Maximize /> Auto-detect current size
      </Button>
      {resize.detected === 'none' && (
        <p className="text-xs text-muted-foreground">No through-hole detected — is this a ring?</p>
      )}
      {resize.detected === true && resize.currentDiameter !== null && (
        <p className="readout rounded-lg bg-muted/40 px-3 py-2 text-xs">
          Current Ø ≈{' '}
          <span className="font-semibold text-primary">{resize.currentDiameter.toFixed(2)} mm</span>
        </p>
      )}
    </div>
  )
}

function ModeSection() {
  const mode = useAppStore((s) => s.resize.mode)
  const hint = MODES.find((m) => m.id === mode)!.hint

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <span className="text-xs font-medium text-muted-foreground">Mode</span>
      <div className="flex gap-1">
        {MODES.map((m) => (
          <Button
            key={m.id}
            variant={mode === m.id ? 'default' : 'secondary'}
            size="sm"
            className="flex-1"
            onClick={() => setResizeMode(m.id)}
          >
            {m.label}
          </Button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  )
}

function TargetSection() {
  const resize = useAppStore((s) => s.resize)

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <span className="text-xs font-medium text-muted-foreground">Target size</span>
      <div className="flex gap-2">
        <label className="flex-1 text-[10px] text-muted-foreground">
          System
          <Select
            className="mt-0.5"
            value={resize.targetSystem}
            onChange={(e) => setResizeTargetSystem(e.target.value as SizeSystem)}
          >
            {SIZE_SYSTEMS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex-1 text-[10px] text-muted-foreground">
          Size
          {resize.targetSystem === 'UK' ? (
            <Select
              className="mt-0.5"
              value={resize.targetSize}
              onChange={(e) => setResizeTargetSize(parseFloat(e.target.value))}
            >
              {ukOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              className="mt-0.5 h-8 text-xs"
              type="number"
              step={0.5}
              value={resize.targetSize}
              onChange={(e) => setResizeTargetSize(parseFloat(e.target.value) || 0)}
            />
          )}
        </label>
        <label className="flex-1 text-[10px] text-muted-foreground">
          Inner Ø mm
          <Input
            className="mt-0.5 h-8 text-xs"
            type="number"
            step={0.05}
            value={resize.targetDiameter.toFixed(2)}
            onChange={(e) => setResizeTargetDiameter(parseFloat(e.target.value) || 0)}
          />
        </label>
      </div>
    </div>
  )
}

function ProtectHeadSection() {
  const resize = useAppStore((s) => s.resize)

  return (
    <div className="flex flex-col gap-2.5 border-t border-border/60 pt-3">
      <span className="text-xs font-medium text-muted-foreground">Protected head</span>

      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Auto-detect head</span>
        <Switch checked={resize.autoHead} onCheckedChange={setResizeAutoHead} />
      </div>

      <label className="text-[10px] text-muted-foreground">
        Centre angle{' '}
        <span className="readout text-foreground">{resize.protectedCenterDeg.toFixed(0)}°</span>
        <Slider
          min={0}
          max={360}
          step={1}
          value={[resize.protectedCenterDeg]}
          onValueChange={([deg]) => setResizeProtectedCenter(deg)}
        />
      </label>
      <Button
        variant={resize.picking === 'head' ? 'default' : 'secondary'}
        size="sm"
        disabled={resize.detected !== true}
        onClick={() => setResizePicking(resize.picking === 'head' ? false : 'head')}
      >
        <Crosshair /> {resize.picking === 'head' ? 'Tap the head in the viewport…' : 'Pick head in viewport'}
      </Button>

      <label className="text-[10px] text-muted-foreground">
        Protected width{' '}
        <span className="readout text-foreground">{resize.protectedDeg.toFixed(0)}°</span>{' '}
        <span className="text-muted-foreground/70">(or drag the 3D handles)</span>
        <Slider
          min={4}
          max={176}
          step={1}
          value={[resize.protectedDeg]}
          onValueChange={([deg]) => setResizeProtectedWidth(deg)}
        />
      </label>

      <label className="text-[10px] text-muted-foreground">
        Smoothing width{' '}
        <span className="readout text-foreground">{resize.smoothingDeg.toFixed(0)}°</span>
        <Slider
          min={0}
          max={120}
          step={1}
          value={[resize.smoothingDeg]}
          onValueChange={([deg]) => setResizeSmoothing(deg)}
        />
      </label>
    </div>
  )
}

/** The plan for the pending resize, or null while nothing is detected/valid. */
function usePendingPlan(): ResizePlan | null {
  const resize = useAppStore((s) => s.resize)
  if (resize.detected !== true || !resize.frame || !(resize.targetDiameter > 0)) return null
  try {
    return planResize({
      frame: resize.frame,
      mode: resize.mode,
      targetInnerDiameter: resize.targetDiameter,
      protectedCenterDeg: resize.protectedCenterDeg,
      protectedDeg: resize.protectedDeg,
      smoothingDeg: resize.smoothingDeg,
      seamCenterDeg: resize.autoSeam ? undefined : resize.seamCenterDeg,
      seamDeg: resize.seamDeg,
    })
  } catch {
    return null
  }
}

function SeamSection() {
  const resize = useAppStore((s) => s.resize)
  const plan = usePendingPlan()
  const seamPct = plan ? (plan.seamBoreScale - 1) * 100 : null
  const hot = plan !== null && (Math.abs(seamPct!) > 30 || plan.preservationRelaxed)

  return (
    <div className="flex flex-col gap-2.5 border-t border-border/60 pt-3">
      <span className="text-xs font-medium text-muted-foreground">Seam sector</span>
      <p className="text-[11px] text-muted-foreground">
        Sculpted texture is bent to the new curve, never stretched — all added or removed
        length is absorbed here (where a jeweller would cut).
      </p>

      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Auto (opposite the head)</span>
        <Switch checked={resize.autoSeam} onCheckedChange={setResizeAutoSeam} />
      </div>

      <Button
        variant={resize.picking === 'seam' ? 'default' : 'secondary'}
        size="sm"
        disabled={resize.detected !== true}
        onClick={() => setResizePicking(resize.picking === 'seam' ? false : 'seam')}
      >
        <Crosshair /> {resize.picking === 'seam' ? 'Tap the seam spot in the viewport…' : 'Pick seam in viewport'}
      </Button>

      <label className="text-[10px] text-muted-foreground">
        Seam width{' '}
        <span className="readout text-foreground">{resize.seamDeg.toFixed(0)}°</span>
        {plan && plan.seamWidened && (
          <span className="text-amber-400"> → widened to {plan.seamDeg.toFixed(0)}°</span>
        )}
        <Slider
          min={8}
          max={160}
          step={1}
          value={[resize.seamDeg]}
          onValueChange={([deg]) => setResizeSeamWidth(deg)}
        />
      </label>

      {plan && seamPct !== null && (
        <p className={`readout rounded-lg bg-muted/40 px-3 py-2 text-[11px] ${hot ? 'text-amber-400' : ''}`}>
          Texture: {plan.preservationRelaxed ? 'partially stretched (seam maxed out)' : 'bent only'} ·
          seam {seamPct >= 0 ? 'stretch' : 'compression'}{' '}
          <span className="font-semibold">{Math.abs(seamPct).toFixed(0)}%</span>
        </p>
      )}

      <Button
        variant={resize.strainMapEnabled ? 'default' : 'secondary'}
        size="sm"
        disabled={resize.detected !== true}
        onClick={() => setResizeStrainMap(!resize.strainMapEnabled)}
      >
        <Thermometer /> {resize.strainMapEnabled ? 'Hide strain preview' : 'Preview surface strain'}
      </Button>
      {resize.strainMapEnabled && (
        <p className="text-[10px] text-muted-foreground/70">
          Red = stretched, blue = compressed, neutral = untouched or bent only.
        </p>
      )}
    </div>
  )
}

export function ResizePanel() {
  const mode = useAppStore((s) => s.resize.mode)
  const reheal = useAppStore((s) => s.resize.reheal)
  const busy = useAppStore((s) => s.resize.busy)
  const canUndo = useAppStore((s) => s.resize.canUndo)
  const error = useAppStore((s) => s.resize.error)
  const detected = useAppStore((s) => s.resize.detected)
  const parts = useAppStore((s) => s.parts)

  // auto-detect on entry; disarm picking + clear the overlay on tab switch
  useEffect(() => {
    if (parts.length > 0) detectResizeFrame()
    return () => teardownResize()
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        Resize a ring to a new finger size. Solitaire mode keeps the stone setting rigid.
      </p>

      <DetectSection />
      <ModeSection />
      <TargetSection />
      {mode === 'protect-head' && <ProtectHeadSection />}
      <SeamSection />

      <div className="flex items-center justify-between border-t border-border/60 pt-3">
        <span className="text-xs text-muted-foreground">Re-heal after resize</span>
        <Switch checked={reheal} onCheckedChange={setResizeReheal} />
      </div>

      <Button disabled={busy || detected !== true} onClick={() => void applyResize()}>
        {busy ? (
          <>
            <RotateCcw className="animate-spin" /> Resizing…
          </>
        ) : (
          <>
            <Scaling /> Apply resize
          </>
        )}
      </Button>
      {canUndo && (
        <Button variant="secondary" size="sm" onClick={undoResize}>
          <Undo2 /> Undo resize
        </Button>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
