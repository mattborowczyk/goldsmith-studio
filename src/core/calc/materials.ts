/**
 * Material library + weight/cost math (plan §2.4). Pure TS — no DOM, no Three.
 * Densities in g/cm³, volumes in mm³, prices per gram in the user's currency.
 */

export type SpotMetal = 'gold' | 'silver' | 'platinum' | 'palladium'

export interface Material {
  id: string
  name: string
  /** g/cm³ */
  density: number
  /** Price per gram in the user's currency. 0 = unpriced. */
  pricePerGram: number
  /** Swatch color shown next to the material name. */
  color: string
  /** Precious-metal content for spot-price refresh; absent = manual price only. */
  spot?: { metal: SpotMetal; fineness: number }
  /** Built-ins can be edited and reset, but not deleted. */
  builtin: boolean
}

export interface HistoryEntry {
  id: string
  /** ISO date-time of the calculation. */
  date: string
  model: string
  material: string
  volumeMm3: number
  weightG: number
  cost: number
  currency: string
}

export function weightGrams(volumeMm3: number, density: number): number {
  return (volumeMm3 / 1000) * density
}

/** Cost = weight × price/g, inflated by the casting loss factor (sprues, buttons). */
export function costOf(weightG: number, pricePerGram: number, castingLossPct: number): number {
  return weightG * pricePerGram * (1 + castingLossPct / 100)
}

// ---------- default library ----------

const SWATCH = {
  yellow: '#e8c260',
  white: '#e6e3da',
  rose: '#e0a487',
  silver: '#c9ccd1',
  platinum: '#d8dde2',
  palladium: '#cdd2d6',
  brass: '#cfa84f',
  bronze: '#b9783f',
  resin: '#7fc8d6',
  wax: '#7ad17a',
}

interface GoldSpec {
  karat: string
  fineness: number
  /** yellow/white/rose densities; white/rose omitted for 24k. */
  densities: Partial<Record<'yellow' | 'white' | 'rose', number>>
}

const GOLD: GoldSpec[] = [
  { karat: '24k', fineness: 0.999, densities: { yellow: 19.32 } },
  { karat: '22k', fineness: 0.916, densities: { yellow: 17.8, white: 17.7, rose: 17.5 } },
  { karat: '18k', fineness: 0.75, densities: { yellow: 15.5, white: 14.7, rose: 15.0 } },
  { karat: '14k', fineness: 0.585, densities: { yellow: 13.05, white: 12.7, rose: 13.0 } },
  { karat: '10k', fineness: 0.417, densities: { yellow: 11.5, white: 11.1, rose: 11.4 } },
]

export function defaultMaterials(): Material[] {
  const out: Material[] = []
  for (const g of GOLD) {
    for (const tone of ['yellow', 'white', 'rose'] as const) {
      const density = g.densities[tone]
      if (density === undefined) continue
      out.push({
        id: `au-${g.karat}-${tone}`,
        name: g.karat === '24k' ? 'Gold 24k' : `Gold ${g.karat} ${tone}`,
        density,
        pricePerGram: 0,
        color: SWATCH[tone],
        spot: { metal: 'gold', fineness: g.fineness },
        builtin: true,
      })
    }
  }
  out.push(
    { id: 'ag-925', name: 'Silver 925', density: 10.36, pricePerGram: 0, color: SWATCH.silver, spot: { metal: 'silver', fineness: 0.925 }, builtin: true },
    { id: 'ag-999', name: 'Silver 999', density: 10.49, pricePerGram: 0, color: SWATCH.silver, spot: { metal: 'silver', fineness: 0.999 }, builtin: true },
    { id: 'pt-950', name: 'Platinum 950', density: 20.7, pricePerGram: 0, color: SWATCH.platinum, spot: { metal: 'platinum', fineness: 0.95 }, builtin: true },
    { id: 'pd-950', name: 'Palladium 950', density: 11.8, pricePerGram: 0, color: SWATCH.palladium, spot: { metal: 'palladium', fineness: 0.95 }, builtin: true },
    { id: 'brass', name: 'Brass', density: 8.5, pricePerGram: 0, color: SWATCH.brass, builtin: true },
    { id: 'bronze', name: 'Bronze', density: 8.8, pricePerGram: 0, color: SWATCH.bronze, builtin: true },
    { id: 'resin', name: 'Castable resin', density: 1.1, pricePerGram: 0, color: SWATCH.resin, builtin: true },
    { id: 'wax', name: 'Carving wax', density: 0.95, pricePerGram: 0, color: SWATCH.wax, builtin: true },
  )
  return out
}

/** Apply pure-metal spot prices (per gram) to a library, scaled by fineness. */
export function applySpotPrices(
  materials: Material[],
  perGram: Partial<Record<SpotMetal, number>>,
): Material[] {
  return materials.map((m) => {
    const spot = m.spot && perGram[m.spot.metal]
    return spot ? { ...m, pricePerGram: roundPrice(spot * m.spot!.fineness) } : m
  })
}

function roundPrice(v: number): number {
  return Math.round(v * 100) / 100
}

// ---------- history CSV ----------

export function historyToCSV(entries: HistoryEntry[]): string {
  const header = 'date,model,material,volume_mm3,weight_g,cost,currency'
  const rows = entries.map((e) =>
    [
      e.date,
      csvField(e.model),
      csvField(e.material),
      e.volumeMm3.toFixed(2),
      e.weightG.toFixed(3),
      e.cost.toFixed(2),
      e.currency,
    ].join(','),
  )
  return [header, ...rows].join('\n')
}

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}
