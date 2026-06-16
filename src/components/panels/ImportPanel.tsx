import { useRef, useState } from 'react'
import { Download, FolderOpen, Loader2, Scaling, Share2, Upload } from 'lucide-react'
import { exportBackup, getEngine, importBackup, importFiles, setAccent } from '@/app/studio'
import { canShareFiles } from '@/app/files'
import { ACCENTS } from '@/app/theme'
import type { ImportUnit } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { StorageMeter } from '@/components/StorageMeter'
import { cn } from '@/lib/utils'

const SHARE_SUPPORTED = canShareFiles([
  new File(['{}'], 'goldsmith-backup.json', { type: 'application/json' }),
])

export function ImportPanel() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [unit, setUnit] = useState<ImportUnit>('mm')
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [scalePct, setScalePct] = useState('100')
  const [backupBusy, setBackupBusy] = useState<'export' | 'share' | 'restore' | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  const importing = useAppStore((s) => s.importing)
  const importError = useAppStore((s) => s.importError)
  const selectedId = useAppStore((s) => s.selectedId)
  const parts = useAppStore((s) => s.parts)
  const accent = useAppStore((s) => s.accent)
  const selected = parts.find((p) => p.id === selectedId)

  async function runBackup(kind: 'export' | 'share') {
    setBackupBusy(kind)
    setBackupError(null)
    try {
      await exportBackup({ share: kind === 'share' })
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : String(err))
    } finally {
      setBackupBusy(null)
    }
  }

  async function runRestore() {
    const ok = window.confirm(
      'Restore from a backup? This replaces all parts, materials, history and settings currently on this device.',
    )
    if (!ok) return
    setBackupBusy('restore')
    setBackupError(null)
    try {
      // on success the page reloads; only failures fall through to here
      await importBackup()
      setBackupBusy(null)
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : String(err))
      setBackupBusy(null)
    }
  }

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
        accept=".stl,.obj,.glb,.gltf,.ply,.3mf"
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
        STL · OBJ · GLB/GLTF · PLY · 3MF — or drag &amp; drop anywhere in the viewport. PLY vertex
        colours (intraoral scans) are shown.
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

      {/* Backup & restore — a single versioned JSON of everything on-device (§2.8) */}
      <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
        <label className="text-xs font-medium text-muted-foreground">Backup &amp; restore</label>
        <p className="text-xs text-muted-foreground">
          Save every part, material, calculation and setting to one file — your local insurance, no
          cloud.
        </p>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            disabled={backupBusy !== null}
            onClick={() => void runBackup('export')}
          >
            {backupBusy === 'export' ? <Loader2 className="animate-spin" /> : <Download />}
            Back up
          </Button>
          {SHARE_SUPPORTED && (
            <Button
              variant="secondary"
              size="icon"
              title="Share backup"
              aria-label="Share backup"
              disabled={backupBusy !== null}
              onClick={() => void runBackup('share')}
            >
              {backupBusy === 'share' ? <Loader2 className="animate-spin" /> : <Share2 />}
            </Button>
          )}
        </div>
        <Button
          variant="outline"
          disabled={backupBusy !== null}
          onClick={() => void runRestore()}
        >
          {backupBusy === 'restore' ? <Loader2 className="animate-spin" /> : <Upload />}
          Restore…
        </Button>
        {backupError && (
          <p className="rounded-lg bg-destructive/15 px-3 py-2 text-xs text-destructive">
            {backupError}
          </p>
        )}
      </div>

      {/* On-device storage usage / quota (issue #32) */}
      <StorageMeter />

      {/* Accent theming (§2.8): swap the warm-metal hue, dark studio stays default */}
      <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
        <label className="text-xs font-medium text-muted-foreground">Accent</label>
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              title={a.label}
              aria-label={a.label}
              aria-pressed={accent === a.id}
              onClick={() => setAccent(a.id)}
              className={cn(
                'size-8 rounded-full border transition-all',
                accent === a.id
                  ? 'border-foreground ring-2 ring-ring'
                  : 'border-border/60 hover:border-foreground/50',
              )}
              style={{ backgroundColor: `oklch(0.78 ${a.chroma} ${a.hue})` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
