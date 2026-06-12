import { useRef, useState } from 'react'
import { FolderOpen, Scaling } from 'lucide-react'
import { getEngine, importFiles } from '@/app/studio'
import type { ImportUnit } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'

export function ImportPanel() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [unit, setUnit] = useState<ImportUnit>('mm')
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [scalePct, setScalePct] = useState('100')
  const importing = useAppStore((s) => s.importing)
  const importError = useAppStore((s) => s.importError)
  const selectedId = useAppStore((s) => s.selectedId)
  const parts = useAppStore((s) => s.parts)
  const selected = parts.find((p) => p.id === selectedId)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-muted-foreground">File units</label>
        <Select value={unit} onChange={(e) => setUnit(e.target.value as ImportUnit)}>
          <option value="mm">Millimetres (mm)</option>
          <option value="cm">Centimetres (cm)</option>
          <option value="m">Metres (m)</option>
          <option value="in">Inches (in)</option>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-muted-foreground">On import</label>
        <Select value={mode} onChange={(e) => setMode(e.target.value as 'append' | 'replace')}>
          <option value="append">Append to scene</option>
          <option value="replace">Replace scene</option>
        </Select>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".stl,.obj,.glb,.gltf"
        className="hidden"
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) await importFiles(files, { unit, mode })
        }}
      />
      <Button disabled={importing} onClick={() => fileInput.current?.click()}>
        <FolderOpen />
        {importing ? 'Importing…' : 'Choose files…'}
      </Button>
      <p className="text-xs text-muted-foreground">
        STL · OBJ · GLB/GLTF — or drag &amp; drop anywhere in the viewport.
      </p>

      {importError && (
        <p className="rounded-lg bg-destructive/15 px-3 py-2 text-xs text-destructive">
          {importError}
        </p>
      )}

      {selected && (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
          <label className="text-xs font-medium text-muted-foreground">
            Rescale “{selected.name}”
          </label>
          <div className="readout text-xs text-muted-foreground">
            {selected.bbox.x.toFixed(2)} × {selected.bbox.y.toFixed(2)} ×{' '}
            {selected.bbox.z.toFixed(2)} mm
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="number"
                inputMode="decimal"
                value={scalePct}
                min={1}
                onChange={(e) => setScalePct(e.target.value)}
                className="h-11 w-full rounded-md border border-border bg-input/50 pl-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                %
              </span>
            </div>
            <Button
              variant="secondary"
              onClick={() => {
                const pct = parseFloat(scalePct)
                if (Number.isFinite(pct) && pct > 0) {
                  getEngine().applyScale(selected.id, pct / 100)
                  setScalePct('100')
                }
              }}
            >
              <Scaling />
              Apply
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
