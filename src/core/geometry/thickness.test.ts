import { describe, expect, it } from 'vitest'
import { makeTube } from './testFixtures'
import { computeThickness, thicknessColor } from './thickness'

// run straight through (no event-loop yielding) so the tests stay synchronous
const opts = { yieldEvery: 0 }

describe('computeThickness', () => {
  it('measures the wall thickness of a tube within tolerance', async () => {
    // outerR 7, innerR 5 → 2.0 mm wall
    const tube = makeTube({ innerR: 5, outerR: 7, height: 8, seg: 64, hSeg: 6 })
    const field = await computeThickness(tube, opts)
    expect(field).not.toBeNull()
    // interior side vertices read the radial wall thickness as the minimum
    expect(field!.min).toBeGreaterThan(1.9)
    expect(field!.min).toBeLessThan(2.1)
  })

  it('flags a thin wall below the threshold and clears a thick one', async () => {
    const thin = makeTube({ innerR: 5, outerR: 5.5, height: 8, seg: 64, hSeg: 6 }) // 0.5 mm
    const thinField = await computeThickness(thin, opts)
    expect(thinField!.min).toBeGreaterThan(0.4)
    expect(thinField!.min).toBeLessThan(0.6)
    const belowThreshold = countBelow(thinField!.values, 0.6)
    expect(belowThreshold).toBeGreaterThan(0)

    const thick = makeTube({ innerR: 5, outerR: 8, height: 8, seg: 64, hSeg: 6 }) // 3.0 mm
    const thickField = await computeThickness(thick, opts)
    // no side wall is under a 0.6 mm alarm (only thin cap rims, if any, could be)
    expect(thickField!.min).toBeGreaterThan(0.6)
  })

  it('returns an empty field for an empty mesh', async () => {
    const field = await computeThickness(
      { positions: new Float32Array(), indices: new Uint32Array() },
      opts,
    )
    expect(field).toEqual({ values: new Float32Array(), min: 0, max: 0 })
  })

  it('aborts when shouldCancel is set, returning null', async () => {
    const tube = makeTube({ seg: 64, hSeg: 8 })
    const field = await computeThickness(tube, { yieldEvery: 16, shouldCancel: () => true })
    expect(field).toBeNull()
  })
})

describe('thicknessColor ramp', () => {
  it('paints values at or under the threshold hard red', () => {
    expect(thicknessColor(0.3, 0, 2, 0.6)).toEqual([0.92, 0.13, 0.13])
    expect(thicknessColor(0.6, 0, 2, 0.6)).toEqual([0.92, 0.13, 0.13])
  })

  it('ramps thin→thick from red toward blue above the threshold', () => {
    const thinSide = thicknessColor(0.65, 0.5, 2, 0.6) // just above threshold → reddish
    const thickSide = thicknessColor(2, 0.5, 2, 0.6) // max → bluest
    expect(thinSide[0]).toBeGreaterThan(thinSide[2]) // more red than blue
    expect(thickSide[2]).toBeGreaterThan(thickSide[0]) // more blue than red
  })
})

function countBelow(values: Float32Array, threshold: number): number {
  let n = 0
  for (const v of values) if (v <= threshold) n++
  return n
}
