/**
 * Ring size systems (plan §2.5.4). Canonical value is the inner circumference
 * in mm (ISO 8653 measures sizes this way); every system converts to/from it.
 */

export type SizeSystem = 'US' | 'UK' | 'EU' | 'FR' | 'DE' | 'JP' | 'CH'

export const SIZE_SYSTEMS: { id: SizeSystem; label: string }[] = [
  { id: 'US', label: 'US / CA' },
  { id: 'UK', label: 'UK / AU' },
  { id: 'EU', label: 'EU (ISO)' },
  { id: 'FR', label: 'FR' },
  { id: 'DE', label: 'DE' },
  { id: 'JP', label: 'JP' },
  { id: 'CH', label: 'CH' },
]

/**
 * UK/AU letter sizes — inner circumference (mm) for A…Z. The steps are not
 * perfectly uniform, so this is the standard table; half sizes interpolate.
 */
const UK_CIRC = [
  37.8, 39.1, 40.4, 41.7, 42.9, 44.2, 45.5, 46.8, 48.0, 48.7, 50.0, 51.2, 52.5,
  53.8, 55.1, 56.3, 57.6, 58.9, 60.2, 61.4, 62.7, 64.0, 65.3, 66.6, 67.8, 68.5,
]
const UK_LAST = UK_CIRC.length - 1
/** Average mm per letter — used to extrapolate beyond A…Z (UK sizes continue past Z). */
const UK_STEP = (UK_CIRC[UK_LAST] - UK_CIRC[0]) / UK_LAST

export function diameterToCircumference(d: number): number {
  return d * Math.PI
}

export function circumferenceToDiameter(c: number): number {
  return c / Math.PI
}

/**
 * System size → circumference mm. UK sizes are passed as a numeric letter
 * index (A = 0, A½ = 0.5 … Z = 25).
 */
export function sizeToCircumference(system: SizeSystem, size: number): number {
  switch (system) {
    case 'US':
      return 36.537 + 2.5535 * size
    case 'EU':
      return size
    case 'FR':
    case 'CH':
      return size + 40
    case 'DE':
      return size * Math.PI
    case 'JP':
      return (13 + (size - 1) / 3) * Math.PI
    case 'UK': {
      // extrapolate past either end so distinct sizes stay distinct (no clamp collapse)
      if (size <= 0) return UK_CIRC[0] + UK_STEP * size
      if (size >= UK_LAST) return UK_CIRC[UK_LAST] + UK_STEP * (size - UK_LAST)
      const lo = Math.floor(size)
      return UK_CIRC[lo] + (UK_CIRC[lo + 1] - UK_CIRC[lo]) * (size - lo)
    }
  }
}

/** Circumference mm → system size (UK as fractional letter index). */
export function circumferenceToSize(system: SizeSystem, c: number): number {
  switch (system) {
    case 'US':
      return (c - 36.537) / 2.5535
    case 'EU':
      return c
    case 'FR':
    case 'CH':
      return c - 40
    case 'DE':
      return c / Math.PI
    case 'JP':
      return 3 * (c / Math.PI - 13) + 1
    case 'UK': {
      // mirror sizeToCircumference: extrapolate past A and Z instead of clamping
      if (c <= UK_CIRC[0]) return (c - UK_CIRC[0]) / UK_STEP
      if (c >= UK_CIRC[UK_LAST]) return UK_LAST + (c - UK_CIRC[UK_LAST]) / UK_STEP
      let i = 0
      while (UK_CIRC[i + 1] < c) i++
      return i + (c - UK_CIRC[i]) / (UK_CIRC[i + 1] - UK_CIRC[i])
    }
  }
}

export function sizeToDiameter(system: SizeSystem, size: number): number {
  return circumferenceToDiameter(sizeToCircumference(system, size))
}

export function diameterToSize(system: SizeSystem, d: number): number {
  return circumferenceToSize(system, diameterToCircumference(d))
}

/** UK letter index → display label, rounded to the nearest half ("N½", or "Z+n" past Z). */
export function ukLabel(index: number): string {
  const snapped = Math.round(index * 2) / 2
  if (snapped <= 0) return 'A'
  const half = snapped % 1 === 0.5 ? '½' : ''
  if (snapped > UK_LAST) {
    const over = Math.floor(snapped) - UK_LAST
    return over === 0 ? `Z${half}` : `Z+${over}${half}`
  }
  return `${String.fromCharCode(65 + Math.floor(snapped))}${half}`
}

/** All UK half-step options (A, A½, … Z) for pickers. */
export function ukOptions(): { value: number; label: string }[] {
  const out: { value: number; label: string }[] = []
  for (let v = 0; v <= 25; v += 0.5) out.push({ value: v, label: ukLabel(v) })
  return out
}

export interface SizeChartRow {
  diameter: number
  circumference: number
  us: number
  uk: string
  eu: number
  fr: number
  de: number
  jp: number
  ch: number
}

/** Full conversion chart, US 1–15 in half sizes. */
export function buildSizeChart(): SizeChartRow[] {
  const rows: SizeChartRow[] = []
  for (let us = 1; us <= 15; us += 0.5) {
    const c = sizeToCircumference('US', us)
    rows.push({
      diameter: circumferenceToDiameter(c),
      circumference: c,
      us,
      uk: ukLabel(circumferenceToSize('UK', c)),
      eu: circumferenceToSize('EU', c),
      fr: circumferenceToSize('FR', c),
      de: circumferenceToSize('DE', c),
      jp: circumferenceToSize('JP', c),
      ch: circumferenceToSize('CH', c),
    })
  }
  return rows
}
