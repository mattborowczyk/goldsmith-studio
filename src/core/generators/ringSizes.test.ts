import { describe, expect, it } from 'vitest'
import {
  circumferenceToSize,
  diameterToSize,
  sizeToCircumference,
  sizeToDiameter,
  ukLabel,
} from './ringSizes'

describe('ring size conversions', () => {
  // ISO 8653 reference points (inner circumference in mm)
  it('matches known US ↔ diameter values', () => {
    // US 7 ≈ 17.35 mm inner diameter
    expect(sizeToDiameter('US', 7)).toBeCloseTo(17.35, 1)
    // US 10 ≈ 19.84 mm
    expect(sizeToDiameter('US', 10)).toBeCloseTo(19.8, 1)
  })

  it('EU size equals the circumference in mm', () => {
    const c = sizeToCircumference('US', 7)
    expect(sizeToCircumference('EU', c)).toBeCloseTo(c, 6)
    expect(circumferenceToSize('EU', c)).toBeCloseTo(c, 6)
  })

  it('round-trips every system', () => {
    for (const system of ['US', 'UK', 'EU', 'FR', 'DE', 'JP', 'CH'] as const) {
      for (const size of [3, 7, 11]) {
        const d = sizeToDiameter(system, size)
        expect(diameterToSize(system, d)).toBeCloseTo(size, 4)
      }
    }
  })

  it('UK letter index increases with size', () => {
    expect(sizeToCircumference('UK', 0)).toBeLessThan(sizeToCircumference('UK', 12))
    expect(sizeToCircumference('UK', 12)).toBeLessThan(sizeToCircumference('UK', 25))
  })

  // contract: UK extends past Z for the large US sizes the chart spans (1..15),
  // staying strictly increasing instead of silently collapsing to "Z"
  it('UK stays distinct and monotonic past Z for large US sizes', () => {
    const uk = [13, 14, 15].map((us) => diameterToSize('UK', sizeToDiameter('US', us)))
    expect(uk[0]).toBeGreaterThan(25) // beyond Z
    expect(uk[0]).toBeLessThan(uk[1])
    expect(uk[1]).toBeLessThan(uk[2])
  })

  it('UK labels past Z use Z+n notation', () => {
    expect(ukLabel(25)).toBe('Z')
    expect(ukLabel(25.5)).toBe('Z½')
    expect(ukLabel(26)).toBe('Z+1')
    expect(ukLabel(27.5)).toBe('Z+2½')
  })
})
