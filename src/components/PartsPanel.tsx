import { useState } from 'react'
import { Boxes, ChevronDown, ChevronUp, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react'
import { getEngine } from '@/app/studio'
import { MATERIAL_PRESETS } from '@/core/engine/materials'
import type { MaterialPreset } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export function PartsPanel() {
  const parts = useAppStore((s) => s.parts)
  const selectedId = useAppStore((s) => s.selectedId)
  const [open, setOpen] = useState(true)

  if (parts.length === 0) return null
  const selected = parts.find((p) => p.id === selectedId)

  return (
    <div className="panel-glass absolute bottom-3 left-3 z-30 w-72">
      <button
        className="flex w-full items-center gap-2 px-3 py-2.5 text-sm font-medium"
        onClick={() => setOpen(!open)}
      >
        <Boxes className="size-4 text-primary" />
        Parts <span className="text-muted-foreground">({parts.length})</span>
        {open ? <ChevronDown className="ml-auto size-4" /> : <ChevronUp className="ml-auto size-4" />}
      </button>

      {open && (
        <div className="max-h-64 overflow-y-auto px-1.5 pb-1.5">
          {parts.map((part) => (
            <div
              key={part.id}
              className={cn(
                'group flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm',
                part.id === selectedId ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50',
              )}
            >
              <Button
                variant="ghost"
                size="iconSm"
                className="size-8"
                title={part.visible ? 'Hide' : 'Show'}
                onClick={() => getEngine().setPartVisible(part.id, !part.visible)}
              >
                {part.visible ? <Eye /> : <EyeOff className="text-muted-foreground/50" />}
              </Button>
              <button
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => getEngine().select(part.id === selectedId ? null : part.id)}
              >
                {part.name}
              </button>
              <Button
                variant="ghost"
                size="iconSm"
                className="size-8 opacity-0 group-hover:opacity-100"
                title="Rename"
                onClick={() => {
                  const name = prompt('Rename part', part.name)
                  if (name?.trim()) getEngine().renamePart(part.id, name.trim())
                }}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="iconSm"
                className="size-8 text-destructive/80 opacity-0 hover:text-destructive group-hover:opacity-100"
                title="Delete"
                onClick={() => getEngine().removePart(part.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}

          {selected && (
            <div className="mt-1 flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <div>
                <div className="readout">
                  {selected.bbox.x.toFixed(2)} × {selected.bbox.y.toFixed(2)} ×{' '}
                  {selected.bbox.z.toFixed(2)} mm
                </div>
                <div className="readout">{selected.triangles.toLocaleString()} triangles</div>
              </div>
              <label className="flex flex-col gap-1 text-[10px]">
                Material
                <Select
                  value={selected.material ?? ''}
                  onChange={(e) =>
                    getEngine().setPartMaterial(
                      selected.id,
                      (e.target.value || null) as MaterialPreset | null,
                    )
                  }
                >
                  <option value="">Auto (global)</option>
                  {MATERIAL_PRESETS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </label>
              <div className="flex items-center justify-between">
                <span id={`flat-shading-${selected.id}`} className="text-[10px]">
                  Flat shading (sharp facets)
                </span>
                <Switch
                  aria-labelledby={`flat-shading-${selected.id}`}
                  checked={selected.flatShading}
                  onCheckedChange={(v) => getEngine().setPartFlatShading(selected.id, v)}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
