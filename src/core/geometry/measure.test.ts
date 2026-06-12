import { describe, expect, it } from 'vitest'
import { estimateInnerDiameter, volumeAndArea } from './measure'
import { makeCube } from './testFixtures'
import type { MeshData } from '../types'

describe('volumeAndArea', () => {
  it('10 mm cube → 1000 mm³, 600 mm²', () => {
    const { volume, area } = volumeAndArea(makeCube(10))
    expect(volume).toBeCloseTo(1000, 6)
    expect(area).toBeCloseTo(600, 6)
  })
})

/** Annulus tube vertices around the z axis (no faces — only vertices matter). */
function makeRing(innerR: number, outerR: number, height: number, segments = 64): MeshData {
  const positions: number[] = []
  for (let s = 0; s < segments; s++) {
    const a = (s / segments) * Math.PI * 2
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    for (const r of [innerR, outerR]) {
      positions.push(r * cos, r * sin, 0, r * cos, r * sin, height)
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(0) }
}

describe('estimateInnerDiameter', () => {
  it('detects the inner diameter of a band ring', () => {
    const est = estimateInnerDiameter(makeRing(8, 10, 4))
    expect(est).not.toBeNull()
    expect(est!.axis).toBe('z')
    expect(est!.diameter).toBeCloseTo(16, 6)
  })

  it('returns null for a solid object (no hole)', () => {
    expect(estimateInnerDiameter(makeCube(10))).toBeNull()
  })
})
