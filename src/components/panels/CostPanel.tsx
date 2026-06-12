import { useEffect, useState } from 'react'
import { Download, History, Plus, RefreshCw, RotateCcw, Save, Shrink, Trash2 } from 'lucide-react'
import {
  addCustomMaterial,
  applyShrinkage,
  clearHistoryLog,
  deleteMaterial,
  exportHistoryCSV,
  formatMoney,
  recomputeVolumes,
  refreshMarketPrices,
  removeHistoryEntry,
  resetMaterialLibrary,
  saveCalculationToHistory,
  setPartMaterial,
  updateCostSettings,
  updateMaterial,
} from '@/app/studio'
import { costOf, weightGrams, type Material } from '@/core/calc/materials'
import { CURRENCIES, type Currency } from '@/core/calc/spotPrices'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

function Swatch({ color }: { color: string }) {
  return <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: color }} />
}

/** Per-part row: material picker + volume/weight/cost readout. */
function PartRow({ partId, name }: { partId: string; name: string }) {
  const cost = useAppStore((s) => s.cost)
  const material = cost.materials.find((m) => m.id === cost.assignments[partId])
  const volume = cost.volumes[partId]
  const weight = material && volume !== undefined ? weightGrams(volume, material.density) : null

  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 p-2.5">
      <p className="truncate text-xs font-medium">{name}</p>
      <Select
        value={cost.assignments[partId] ?? ''}
        onChange={(e) => setPartMaterial(partId, e.target.value)}
      >
        <option value="">— no material —</option>
        {cost.materials.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </Select>
      <p className="readout text-xs text-muted-foreground">
        {volume === undefined ? 'computing…' : `${volume.toFixed(1)} mm³`}
        {weight !== null && (
          <>
            {' · '}
            <span className="text-foreground">{weight.toFixed(2)} g</span>
            {material!.pricePerGram > 0 && (
              <>
                {' · '}
                <span className="text-primary">
                  {formatMoney(
                    costOf(weight, material!.pricePerGram, cost.settings.lossFactorPct),
                    cost.settings.currency,
                  )}
                </span>
              </>
            )}
          </>
        )}
      </p>
    </div>
  )
}

function Totals() {
  const cost = useAppStore((s) => s.cost)
  const parts = useAppStore((s) => s.parts)

  const perMaterial = new Map<string, { material: Material; weight: number; cost: number }>()
  for (const part of parts) {
    const material = cost.materials.find((m) => m.id === cost.assignments[part.id])
    const volume = cost.volumes[part.id]
    if (!material || volume === undefined) continue
    const w = weightGrams(volume, material.density)
    const c = costOf(w, material.pricePerGram, cost.settings.lossFactorPct)
    const acc = perMaterial.get(material.id) ?? { material, weight: 0, cost: 0 }
    acc.weight += w
    acc.cost += c
    perMaterial.set(material.id, acc)
  }
  if (perMaterial.size === 0) return null
  const totals = [...perMaterial.values()]
  const grandW = totals.reduce((s, t) => s + t.weight, 0)
  const grandC = totals.reduce((s, t) => s + t.cost, 0)

  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      {totals.map((t) => (
        <div key={t.material.id} className="flex items-center justify-between gap-2 py-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Swatch color={t.material.color} />
            <span className="truncate">{t.material.name}</span>
          </span>
          <span className="readout shrink-0 text-xs">
            {t.weight.toFixed(2)} g
            {t.material.pricePerGram > 0 && ` · ${formatMoney(t.cost, cost.settings.currency)}`}
          </span>
        </div>
      ))}
      {totals.length > 1 && (
        <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/60 pt-1.5">
          <span className="text-xs font-medium">Total</span>
          <span className="readout text-xs font-semibold text-primary">
            {grandW.toFixed(2)} g · {formatMoney(grandC, cost.settings.currency)}
          </span>
        </div>
      )}
    </div>
  )
}

function MaterialLibrary() {
  const materials = useAppStore((s) => s.cost.materials)
  const currency = useAppStore((s) => s.cost.settings.currency)

  return (
    <details>
      <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
        Material library ({materials.length})
      </summary>
      <div className="mt-2 flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
        {materials.map((m) => (
          <div key={m.id} className="flex flex-col gap-1 rounded-lg bg-muted/40 p-2">
            <div className="flex items-center gap-1.5">
              <Swatch color={m.color} />
              {m.builtin ? (
                <span className="flex-1 truncate text-xs">{m.name}</span>
              ) : (
                <Input
                  className="h-8 flex-1 text-xs"
                  value={m.name}
                  onChange={(e) => updateMaterial(m.id, { name: e.target.value })}
                />
              )}
              {!m.builtin && (
                <Button variant="ghost" size="iconSm" title="Delete" onClick={() => deleteMaterial(m.id)}>
                  <Trash2 />
                </Button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <label className="text-[10px] text-muted-foreground">
                Density g/cm³
                <Input
                  className="mt-0.5 h-8 text-xs"
                  type="number"
                  step="0.01"
                  min="0"
                  value={m.density}
                  onChange={(e) => updateMaterial(m.id, { density: parseFloat(e.target.value) || 0 })}
                />
              </label>
              <label className="text-[10px] text-muted-foreground">
                {currency}/g
                <Input
                  className="mt-0.5 h-8 text-xs"
                  type="number"
                  step="0.01"
                  min="0"
                  value={m.pricePerGram}
                  onChange={(e) =>
                    updateMaterial(m.id, { pricePerGram: parseFloat(e.target.value) || 0 })
                  }
                />
              </label>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" size="sm" className="flex-1" onClick={addCustomMaterial}>
          <Plus /> Add custom
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="flex-1"
          title="Restore built-in names & densities (keeps custom materials)"
          onClick={resetMaterialLibrary}
        >
          <RotateCcw /> Reset defaults
        </Button>
      </div>
    </details>
  )
}

function HistorySection() {
  const history = useAppStore((s) => s.cost.history)
  if (history.length === 0) return null
  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <History className="size-3.5" /> History ({history.length})
        </span>
        <div className="flex gap-1">
          <Button variant="ghost" size="iconSm" title="Export CSV" onClick={exportHistoryCSV}>
            <Download />
          </Button>
          <Button variant="ghost" size="iconSm" title="Clear history" onClick={() => void clearHistoryLog()}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-1">
        {history.map((e) => (
          <div key={e.id} className="group flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs">{e.model}</p>
              <p className="readout text-[10px] text-muted-foreground">
                {e.date.slice(0, 10)} · {e.material} · {e.weightG.toFixed(2)} g
                {e.cost > 0 && ` · ${formatMoney(e.cost, e.currency as Currency)}`}
              </p>
            </div>
            <Button
              variant="ghost"
              size="iconSm"
              className="opacity-0 group-hover:opacity-100"
              title="Delete entry"
              onClick={() => void removeHistoryEntry(e.id)}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CostPanel() {
  const parts = useAppStore((s) => s.parts)
  const cost = useAppStore((s) => s.cost)
  const selectedId = useAppStore((s) => s.selectedId)
  const [shrinkPct, setShrinkPct] = useState(1.75)
  const hasAssignment = parts.some(
    (p) => cost.assignments[p.id] && cost.volumes[p.id] !== undefined,
  )

  useEffect(() => {
    recomputeVolumes()
  }, [parts])

  if (parts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Import a model first — then assign a material to each part to get weight and cost.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {parts.map((p) => (
        <PartRow key={p.id} partId={p.id} name={p.name} />
      ))}

      <Totals />

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-muted-foreground">
          Casting loss %
          <Input
            className="mt-1"
            type="number"
            step="0.5"
            min="0"
            value={cost.settings.lossFactorPct}
            onChange={(e) => updateCostSettings({ lossFactorPct: parseFloat(e.target.value) || 0 })}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Currency
          <Select
            className="mt-1"
            value={cost.settings.currency}
            onChange={(e) => updateCostSettings({ currency: e.target.value as Currency })}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <Button variant="secondary" disabled={cost.refreshing} onClick={() => void refreshMarketPrices()}>
        <RefreshCw className={cost.refreshing ? 'animate-spin' : ''} />
        {cost.refreshing ? 'Fetching…' : 'Refresh from market'}
      </Button>
      {cost.settings.pricesUpdatedAt && (
        <p className="readout -mt-1 text-[10px] text-muted-foreground">
          Spot prices: {cost.settings.pricesUpdatedAt.slice(0, 16).replace('T', ' ')}
        </p>
      )}
      {cost.error && (
        <p className="rounded-lg bg-destructive/15 px-3 py-2 text-xs text-destructive">{cost.error}</p>
      )}

      <MaterialLibrary />

      <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
        <label className="text-xs text-muted-foreground">
          Shrinkage % (casting / investment)
          <div className="mt-1 flex gap-2">
            <Input
              type="number"
              step="0.05"
              value={shrinkPct}
              onChange={(e) => setShrinkPct(parseFloat(e.target.value) || 0)}
            />
            <Button
              variant="secondary"
              disabled={!selectedId && parts.length !== 1}
              title="Scale the selected part up before export"
              onClick={() => applyShrinkage(shrinkPct)}
            >
              <Shrink /> Apply
            </Button>
          </div>
        </label>
      </div>

      <Button disabled={!hasAssignment} onClick={() => void saveCalculationToHistory()}>
        <Save /> Save calculation
      </Button>

      <HistorySection />
    </div>
  )
}
