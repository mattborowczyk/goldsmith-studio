import { useEffect } from 'react'
import { Circle, PenTool, Ruler, Trash2, Undo2 } from 'lucide-react'
import {
  clearAllMeasurements,
  detectInnerDiameter,
  draftingView,
  removeMeasurementById,
  setMeasureColor,
  setMeasurePicking,
  undoLastMeasurement,
  updateSection,
} from '@/app/studio'
import type { SectionAxis } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const DIM_COLORS = [
  { value: '#e8c260', label: 'Gold' },
  { value: '#f2efe9', label: 'White' },
  { value: '#4fc3f7', label: 'Blue' },
  { value: '#ef5350', label: 'Red' },
  { value: '#66bb6a', label: 'Green' },
]

function DimensionsSection() {
  const measure = useAppStore((s) => s.measure)
  const parts = useAppStore((s) => s.parts)

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={measure.picking ? 'default' : 'secondary'}
        disabled={parts.length === 0}
        onClick={() => setMeasurePicking(!measure.picking)}
      >
        <Ruler />
        {measure.picking ? 'Picking… tap two points' : 'Add dimension'}
      </Button>
      {measure.picking && (
        <p className="text-xs text-muted-foreground">
          {measure.pendingPoint
            ? 'First point set — tap the second point.'
            : 'Tap the model to place the first point (snaps to nearby vertices).'}
        </p>
      )}

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Color</span>
        <div className="flex gap-1">
          {DIM_COLORS.map((c) => (
            <button
              key={c.value}
              title={c.label}
              onClick={() => setMeasureColor(c.value)}
              className={cn(
                'size-7 rounded-full border-2 transition-transform active:scale-90',
                measure.color === c.value ? 'border-ring scale-110' : 'border-transparent',
              )}
              style={{ background: c.value }}
            />
          ))}
        </div>
      </div>

      {measure.measurements.length > 0 && (
        <>
          <div className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
            {measure.measurements.map((m, i) => (
              <div key={m.id} className="group flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-1">
                <Circle className="size-2.5 shrink-0" fill={m.color} stroke="none" />
                <span className="text-xs text-muted-foreground">D{i + 1}</span>
                <span className="readout flex-1 text-xs">{m.distance.toFixed(2)} mm</span>
                <Button
                  variant="ghost"
                  size="iconSm"
                  className="opacity-0 group-hover:opacity-100"
                  title="Delete"
                  onClick={() => removeMeasurementById(m.id)}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" className="flex-1" onClick={undoLastMeasurement}>
              <Undo2 /> Undo last
            </Button>
            <Button variant="secondary" size="sm" className="flex-1" onClick={clearAllMeasurements}>
              <Trash2 /> Clear all
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function InspectSection() {
  const parts = useAppStore((s) => s.parts)
  const selectedId = useAppStore((s) => s.selectedId)
  const innerDiameter = useAppStore((s) => s.measure.innerDiameter)
  const part = parts.find((p) => p.id === selectedId) ?? (parts.length === 1 ? parts[0] : null)

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <span className="text-xs font-medium text-muted-foreground">Inspect</span>
      {part ? (
        <p className="readout rounded-lg bg-muted/40 px-3 py-2 text-xs">
          {part.bbox.x.toFixed(2)} × {part.bbox.y.toFixed(2)} × {part.bbox.z.toFixed(2)} mm
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Select a part to see its bounding box.</p>
      )}
      <Button variant="secondary" size="sm" disabled={!part} onClick={detectInnerDiameter}>
        Detect ring inner Ø
      </Button>
      {innerDiameter === 'none' && (
        <p className="text-xs text-muted-foreground">No through-hole detected on this part.</p>
      )}
      {innerDiameter && innerDiameter !== 'none' && (
        <p className="readout rounded-lg bg-muted/40 px-3 py-2 text-xs">
          Inner Ø ≈ <span className="font-semibold text-primary">{innerDiameter.diameter.toFixed(2)} mm</span>{' '}
          <span className="text-muted-foreground">(axis {innerDiameter.axis})</span>
        </p>
      )}
    </div>
  )
}

function SectionControls() {
  const section = useAppStore((s) => s.measure.section)
  const parts = useAppStore((s) => s.parts)
  const span = section.range.max - section.range.min

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Section view</span>
        <Switch
          checked={section.enabled}
          disabled={parts.length === 0}
          onCheckedChange={(enabled) => updateSection({ enabled })}
        />
      </div>

      {section.enabled && (
        <>
          <div className="flex gap-1">
            {(['x', 'y', 'z'] as SectionAxis[]).map((axis) => (
              <Button
                key={axis}
                variant={section.axis === axis ? 'default' : 'secondary'}
                size="sm"
                className="flex-1 uppercase"
                onClick={() => updateSection({ axis })}
              >
                {axis}
              </Button>
            ))}
          </div>

          <label className="text-xs text-muted-foreground">
            Position{' '}
            <span className="readout text-foreground">{section.position.toFixed(2)} mm</span>
            <Slider
              min={section.range.min}
              max={section.range.max}
              step={Math.max(span / 500, 0.01)}
              value={[section.position]}
              onValueChange={([position]) => updateSection({ position })}
            />
          </label>

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Slice (thin slab)</span>
            <Switch checked={section.slice} onCheckedChange={(slice) => updateSection({ slice })} />
          </div>

          {section.slice ? (
            <label className="text-xs text-muted-foreground">
              Thickness{' '}
              <span className="readout text-foreground">{section.thickness.toFixed(2)} mm</span>
              <Slider
                min={0.1}
                max={Math.max(span / 4, 5)}
                step={0.1}
                value={[section.thickness]}
                onValueChange={([thickness]) => updateSection({ thickness })}
              />
            </label>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Flip side</span>
              <Switch checked={section.flip} onCheckedChange={(flip) => updateSection({ flip })} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function MeasurePanel() {
  const picking = useAppStore((s) => s.measure.picking)

  // disarm pick mode when the panel unmounts (tab switch)
  useEffect(() => {
    return () => {
      if (useAppStore.getState().measure.picking) setMeasurePicking(false)
    }
  }, [])
  void picking

  return (
    <div className="flex flex-col gap-3">
      <DimensionsSection />
      <InspectSection />
      <SectionControls />

      <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
        <Button variant="secondary" onClick={draftingView}>
          <PenTool /> Drafting view
        </Button>
        <p className="text-xs text-muted-foreground">
          Orthographic front view — add dimensions, then use the snapshot button for a drafting
          screenshot.
        </p>
      </div>
    </div>
  )
}
