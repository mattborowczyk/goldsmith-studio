import { useRef } from 'react'
import { Box, Check, Copy, Download, FileText, Loader2, Share2, Trash2, Upload } from 'lucide-react'
import {
  copyReportText,
  exportMesh,
  generateReportPDF,
  patchDeliver,
  setBranding,
  setLogoFromFile,
} from '@/app/studio'
import { canShareFiles } from '@/app/files'
import type { MeshFormat } from '@/core/io/exporters'
import type { BillingIncrement, ReportTemplate } from '@/core/report/reportModel'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const FORMATS: { id: MeshFormat; label: string }[] = [
  { id: 'stl', label: 'STL' },
  { id: 'obj', label: 'OBJ' },
  { id: 'glb', label: 'GLB' },
]

const TEMPLATES: { id: ReportTemplate; label: string; hint: string }[] = [
  { id: 'quote', label: 'Client quote', hint: 'Costs, labour and total for the customer.' },
  { id: 'casting', label: 'Casting spec', hint: 'Material, weight and dimensions for the caster.' },
  { id: 'internal', label: 'Internal record', hint: 'Everything, for your own files.' },
]

const BILLING: { id: BillingIncrement; label: string }[] = [
  { id: 'exact', label: 'Exact' },
  { id: '15min', label: '15 min' },
  { id: '30min', label: '30 min' },
  { id: '1h', label: '1 hour' },
]

const textareaClass =
  'w-full rounded-md border border-border bg-input/50 px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring'

// Web Share (§2.8): send an exported STL/PDF straight to Mail/AirDrop on iPad.
const SHARE_SUPPORTED = canShareFiles([new File([''], 'export.stl', { type: 'model/stl' })])

function ExportSection() {
  const d = useAppStore((s) => s.deliver)
  const parts = useAppStore((s) => s.parts)

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">Mesh export</span>
      <div className="flex gap-1">
        {FORMATS.map((f) => (
          <Button
            key={f.id}
            variant={d.exportFormat === f.id ? 'default' : 'secondary'}
            size="sm"
            className="flex-1"
            onClick={() => patchDeliver({ exportFormat: f.id })}
          >
            {f.label}
          </Button>
        ))}
      </div>
      <div className="flex gap-1">
        {(['merged', 'per-part'] as const).map((scope) => (
          <Button
            key={scope}
            variant={d.exportScope === scope ? 'default' : 'secondary'}
            size="sm"
            className="flex-1"
            onClick={() => patchDeliver({ exportScope: scope })}
          >
            {scope === 'merged' ? 'Merged' : 'Per part'}
          </Button>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Apply shrinkage scale</span>
        <Switch
          aria-label="Apply shrinkage scale"
          checked={d.applyShrinkage}
          onCheckedChange={(v) => patchDeliver({ applyShrinkage: v })}
        />
      </div>
      {d.applyShrinkage && (
        <label className="text-[10px] text-muted-foreground">
          Shrinkage % (scales a copy — the scene is untouched)
          <Input
            className="mt-0.5 h-8 text-xs"
            type="number"
            step="0.05"
            value={d.shrinkagePct}
            onChange={(e) => patchDeliver({ shrinkagePct: parseFloat(e.target.value) || 0 })}
          />
        </label>
      )}

      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={d.exporting || parts.length === 0}
          onClick={() => void exportMesh()}
        >
          {d.exporting ? <Loader2 className="animate-spin" /> : <Box />}
          Export {d.exportFormat.toUpperCase()}
        </Button>
        {SHARE_SUPPORTED && (
          <Button
            variant="secondary"
            size="icon"
            title="Share export"
            disabled={d.exporting || parts.length === 0}
            onClick={() => void exportMesh({ share: true })}
          >
            <Share2 />
          </Button>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground/70">
        PLY &amp; 3MF arrive in a later release.
      </p>
    </div>
  )
}

function BrandingSection() {
  const branding = useAppStore((s) => s.deliver.branding)
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <details className="border-t border-border/60 pt-3">
      <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
        Branding
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <label className="text-[10px] text-muted-foreground">
          Business name
          <Input
            className="mt-0.5 h-8 text-xs"
            value={branding.businessName}
            onChange={(e) => setBranding({ businessName: e.target.value })}
          />
        </label>
        <label className="text-[10px] text-muted-foreground">
          Contact (address, phone, email)
          <textarea
            className={cn(textareaClass, 'mt-0.5 h-16 resize-none text-xs')}
            value={branding.contact}
            onChange={(e) => setBranding({ contact: e.target.value })}
          />
        </label>
        <div className="flex items-center gap-2">
          {branding.logo ? (
            <img
              src={branding.logo}
              alt="Logo"
              className="h-10 w-10 rounded-md object-contain ring-1 ring-border"
            />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted/40 text-muted-foreground">
              <Upload className="size-4" />
            </div>
          )}
          <Button variant="secondary" size="sm" className="flex-1" onClick={() => fileRef.current?.click()}>
            <Upload /> {branding.logo ? 'Replace logo' : 'Upload logo'}
          </Button>
          {branding.logo && (
            <Button variant="ghost" size="iconSm" title="Remove logo" onClick={() => setBranding({ logo: '' })}>
              <Trash2 />
            </Button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) setLogoFromFile(file)
              e.target.value = ''
            }}
          />
        </div>
      </div>
    </details>
  )
}

function ReportSection() {
  const d = useAppStore((s) => s.deliver)
  const parts = useAppStore((s) => s.parts)
  const hint = TEMPLATES.find((t) => t.id === d.template)!.hint

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <span className="text-xs font-medium text-muted-foreground">PDF report</span>

      <div className="flex gap-1">
        {TEMPLATES.map((t) => (
          <Button
            key={t.id}
            variant={d.template === t.id ? 'default' : 'secondary'}
            size="sm"
            className="flex-1 px-1 text-[10px]"
            onClick={() => patchDeliver({ template: t.id })}
          >
            {t.label}
          </Button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{hint}</p>

      <label className="text-[10px] text-muted-foreground">
        Title / client / job
        <Input
          className="mt-0.5 h-8 text-xs"
          placeholder="e.g. Solitaire for J. Smith"
          value={d.title}
          onChange={(e) => patchDeliver({ title: e.target.value })}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px] text-muted-foreground">
          Labour hours
          <Input
            className="mt-0.5 h-8 text-xs"
            type="number"
            step="0.25"
            min="0"
            value={d.labourHours}
            onChange={(e) => patchDeliver({ labourHours: parseFloat(e.target.value) || 0 })}
          />
        </label>
        <label className="text-[10px] text-muted-foreground">
          Rate / hour
          <Input
            className="mt-0.5 h-8 text-xs"
            type="number"
            step="1"
            min="0"
            value={d.labourRate}
            onChange={(e) => patchDeliver({ labourRate: parseFloat(e.target.value) || 0 })}
          />
        </label>
      </div>
      <label className="text-[10px] text-muted-foreground">
        Billing increment
        <Select
          className="mt-0.5"
          value={d.billing}
          onChange={(e) => patchDeliver({ billing: e.target.value as BillingIncrement })}
        >
          {BILLING.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </Select>
      </label>

      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Disclose metal prices</span>
        <Switch
          aria-label="Disclose metal prices"
          checked={d.showMetalPrices}
          onCheckedChange={(v) => patchDeliver({ showMetalPrices: v })}
        />
      </div>

      <label className="text-[10px] text-muted-foreground">
        Notes
        <textarea
          className={cn(textareaClass, 'mt-0.5 h-16 resize-none text-xs')}
          value={d.notes}
          onChange={(e) => patchDeliver({ notes: e.target.value })}
        />
      </label>

      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={d.generating || parts.length === 0}
          onClick={() => void generateReportPDF()}
        >
          {d.generating ? <Loader2 className="animate-spin" /> : <FileText />}
          Generate PDF
        </Button>
        {SHARE_SUPPORTED && (
          <Button
            variant="secondary"
            size="icon"
            title="Share PDF"
            disabled={d.generating || parts.length === 0}
            onClick={() => void generateReportPDF({ share: true })}
          >
            <Share2 />
          </Button>
        )}
      </div>
      <Button
        variant="secondary"
        size="sm"
        disabled={parts.length === 0}
        onClick={() => void copyReportText()}
      >
        {d.copied ? <Check /> : <Copy />}
        {d.copied ? 'Copied!' : 'Copy results as text'}
      </Button>
    </div>
  )
}

export function DeliverPanel() {
  const parts = useAppStore((s) => s.parts)
  const error = useAppStore((s) => s.deliver.error)

  if (parts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Import or generate a model first, assign materials in Cost, then export files and branded
        reports here.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <ExportSection />
      <ReportSection />
      <BrandingSection />
      {error && (
        <p className="rounded-lg bg-destructive/15 px-3 py-2 text-xs text-destructive">{error}</p>
      )}
      <p className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
        <Download className="size-3" /> Files download to your device — nothing leaves the browser.
      </p>
    </div>
  )
}
