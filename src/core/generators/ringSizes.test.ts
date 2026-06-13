import { describe, expect, it } from 'vitest'
import {
  circumferenceToSize,
  diameterToSize,
  sizeToCircumference,
  sizeToDiameter,
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
})
