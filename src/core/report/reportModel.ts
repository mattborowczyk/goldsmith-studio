import type { Vec3 } from '../types'
import type { Currency } from '../calc/spotPrices'
import { costOf, weightGrams } from '../calc/materials'

/**
 * Report model builder (plan §2.7). Pure TS — turns gathered scene/cost data
 * into a normalized model that both the clipboard text version and the pdf-lib
 * PDF render from, so the two never drift. No DOM, no Three.
 */

export type ReportTemplate = 'quote' | 'casting' | 'internal'

/** How modeling/labour time is rounded for billing. */
export type BillingIncrement = 'exact' | '15min' | '30min' | '1h'

export interface ReportBranding {
  businessName: string
  /** Free-text contact block (address / phone / email), newline-separated. */
  contact: string
  /** PNG/JPEG data-URL of the logo, or '' when none set. */
  logo: string
}

export interface ReportLabour {
  hours: number
  /** Currency per hour. */
  rate: number
  billing: BillingIncrement
}

/** One part's measured stats, gathered from the engine + cost store. */
export interface ReportPartInput {
  name: string
  materialName: string | null
  density: number | null
  /** Per-gram price of the assigned material (0 when unpriced). */
  pricePerGram: number
  volumeMm3: number
  areaMm2: number
  bbox: Vec3
}

/** A grouped gemstone line for the report. */
export interface GemListEntry {
  cut: string
  /** "6.0" or "6.0×4.0" mm. */
  sizeMm: string
  qty: number
}

export interface ReportInput {
  template: ReportTemplate
  branding: ReportBranding
  /** Project / client / job title for the header. */
  title: string
  /** ISO timestamp. */
  date: string
  currency: Currency
  lossFactorPct: number
  labour: ReportLabour
  /** Disclose per-gram metal prices used (client-quote nicety). */
  showMetalPrices: boolean
  notes: string
  parts: ReportPartInput[]
  gems: GemListEntry[]
  sceneBbox: Vec3 | null
}

export interface ReportPartRow {
  name: string
  materialName: string | null
  volumeMm3: number
  areaMm2: number
  weightG: number
  /** null when the part has no priced material. */
  cost: number | null
  bbox: Vec3
}

export interface MaterialTotal {
  name: string
  weightG: number
  cost: number
  pricePerGram: number
}

export interface ReportModel {
  template: ReportTemplate
  templateLabel: string
  title: string
  dateLabel: string
  branding: ReportBranding
  currency: Currency
  lossFactorPct: number
  /** Which sections this template renders. */
  show: {
    cost: boolean
    labour: boolean
    gems: boolean
    metalPrices: boolean
    notes: boolean
  }
  parts: ReportPartRow[]
  materialTotals: MaterialTotal[]
  grandWeightG: number
  grandMaterialCost: number
  labour: { hours: number; billedHours: number; rate: number; cost: number } | null
  /** Material cost + labour cost. */
  grandTotal: number
  gems: GemListEntry[]
  sceneBbox: Vec3 | null
  notes: string
}

const TEMPLATE_META: Record<ReportTemplate, { label: string; cost: boolean; labour: boolean }> = {
  quote: { label: 'Client Quote', cost: true, labour: true },
  casting: { label: 'Casting Specification', cost: false, labour: false },
  internal: { label: 'Internal Record', cost: true, labour: true },
}

/** Hours rounded UP to the chosen billing increment. */
const BILLING_STEP: Record<BillingIncrement, number> = {
  exact: 0,
  '15min': 0.25,
  '30min': 0.5,
  '1h': 1,
}

export function billHours(hours: number, billing: BillingIncrement): number {
  const step = BILLING_STEP[billing]
  if (step <= 0) return Math.max(hours, 0)
  return Math.ceil(Math.max(hours, 0) / step) * step
}

export function buildReportModel(input: ReportInput): ReportModel {
  const meta = TEMPLATE_META[input.template]

  const parts: ReportPartRow[] = input.parts.map((p) => {
    const weightG = p.density ? weightGrams(p.volumeMm3, p.density) : 0
    const cost =
      p.density && p.pricePerGram > 0
        ? costOf(weightG, p.pricePerGram, input.lossFactorPct)
        : null
    return {
      name: p.name,
      materialName: p.materialName,
      volumeMm3: p.volumeMm3,
      areaMm2: p.areaMm2,
      weightG,
      cost,
      bbox: p.bbox,
    }
  })

  // Group weight + cost by material name.
  const byMaterial = new Map<string, MaterialTotal>()
  for (const [i, row] of parts.entries()) {
    if (!row.materialName) continue
    const src = input.parts[i]
    const acc = byMaterial.get(row.materialName) ?? {
      name: row.materialName,
      weightG: 0,
      cost: 0,
      pricePerGram: src.pricePerGram,
    }
    acc.weightG += row.weightG
    acc.cost += row.cost ?? 0
    byMaterial.set(row.materialName, acc)
  }
  const materialTotals = [...byMaterial.values()]
  const grandWeightG = materialTotals.reduce((s, t) => s + t.weightG, 0)
  const grandMaterialCost = materialTotals.reduce((s, t) => s + t.cost, 0)

  let labour: ReportModel['labour'] = null
  if (meta.labour && input.labour.hours > 0 && input.labour.rate > 0) {
    const billedHours = billHours(input.labour.hours, input.labour.billing)
    labour = {
      hours: input.labour.hours,
      billedHours,
      rate: input.labour.rate,
      cost: billedHours * input.labour.rate,
    }
  }

  const grandTotal = (meta.cost ? grandMaterialCost : 0) + (labour?.cost ?? 0)

  return {
    template: input.template,
    templateLabel: meta.label,
    title: input.title.trim() || meta.label,
    dateLabel: formatDate(input.date),
    branding: input.branding,
    currency: input.currency,
    lossFactorPct: input.lossFactorPct,
    show: {
      cost: meta.cost,
      labour: labour !== null,
      gems: input.gems.length > 0,
      metalPrices: meta.cost && input.showMetalPrices && materialTotals.some((t) => t.pricePerGram > 0),
      notes: input.notes.trim().length > 0,
    },
    parts,
    materialTotals,
    grandWeightG,
    grandMaterialCost,
    labour,
    grandTotal,
    gems: input.gems,
    sceneBbox: input.sceneBbox,
    notes: input.notes.trim(),
  }
}

// ---------- plain-text version (clipboard) ----------

export function reportToText(model: ReportModel): string {
  const m = (v: number) => formatMoney(v, model.currency)
  const out: string[] = []
  if (model.branding.businessName) out.push(model.branding.businessName)
  out.push(`${model.templateLabel} — ${model.title}`)
  out.push(model.dateLabel)
  out.push('')

  if (model.sceneBbox) {
    const [x, y, z] = model.sceneBbox
    out.push(`Overall size: ${x.toFixed(2)} × ${y.toFixed(2)} × ${z.toFixed(2)} mm`)
    out.push('')
  }

  out.push('PARTS')
  for (const p of model.parts) {
    const bits = [
      p.name,
      p.materialName ?? 'no material',
      `${p.volumeMm3.toFixed(1)} mm³`,
      `${p.weightG.toFixed(2)} g`,
      `${p.areaMm2.toFixed(1)} mm²`,
    ]
    if (model.show.cost && p.cost !== null) bits.push(m(p.cost))
    out.push(`  • ${bits.join(' · ')}`)
  }
  out.push('')

  out.push('TOTALS')
  for (const t of model.materialTotals) {
    const bits = [t.name, `${t.weightG.toFixed(2)} g`]
    if (model.show.cost && t.cost > 0) bits.push(m(t.cost))
    out.push(`  ${bits.join(' · ')}`)
  }
  out.push(`  Total weight: ${model.grandWeightG.toFixed(2)} g`)
  if (model.lossFactorPct > 0) out.push(`  (incl. ${model.lossFactorPct}% casting loss)`)

  if (model.show.gems) {
    out.push('')
    out.push('GEMSTONES')
    for (const g of model.gems) out.push(`  ${g.qty}× ${g.cut} ${g.sizeMm} mm`)
  }

  if (model.show.metalPrices) {
    out.push('')
    out.push('METAL PRICES')
    for (const t of model.materialTotals) {
      if (t.pricePerGram > 0) out.push(`  ${t.name}: ${m(t.pricePerGram)}/g`)
    }
  }

  if (model.show.labour && model.labour) {
    out.push('')
    out.push('LABOUR')
    out.push(`  ${model.labour.billedHours.toFixed(2)} h × ${m(model.labour.rate)}/h = ${m(model.labour.cost)}`)
  }

  if (model.show.cost) {
    out.push('')
    out.push(`TOTAL: ${m(model.grandTotal)}`)
  }

  if (model.show.notes) {
    out.push('')
    out.push('NOTES')
    out.push(model.notes)
  }

  return out.join('\n')
}

// ---------- pure formatting helpers (shared by text + PDF) ----------

export function formatMoney(value: number, currency: Currency): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}
