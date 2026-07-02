import { describe, expect, it } from 'vitest'
import type { MeshData, Vec3 } from '../types'
import { enclosedFaceSet, fullySelectedFaces, marginCurvesFromSelection } from './marginCurve'
import { makeCube, makeDome, mergeMeshes } from './testFixtures'

const Z: Vec3 = [0, 0, 1]

/** Vertices of the dome's cap: rings `fromRing`.. plus the apex. */
function domeCapSelection(seg: number, rings: number, fromRing: number): Set<number> {
  const sel = new Set<number>()
  for (let i = fromRing; i < rings; i++) {
    for (let j = 0; j < seg; j++) sel.add(i * seg + j)
  }
  sel.add(rings * seg) // apex
  return sel
}

/** Triangle indices (t/3) of the fully-selected faces, for comparisons. */
function selectedTriSet(mesh: MeshData, selected: Set<number>): Set<number> {
  const out = new Set<number>()
  const { indices } = mesh
  for (let t = 0; t < indices.length; t += 3) {
    if (selected.has(indices[t]) && selected.has(indices[t + 1]) && selected.has(indices[t + 2])) {
      out.add(t / 3)
    }
  }
  return out
}

describe('marginCurvesFromSelection', () => {
  it('traces a dome-cap selection into one closed loop of bound control points', () => {
    const seg = 24, rings = 12
    const dome = makeDome(5, seg, rings)
    const sel = domeCapSelection(seg, rings, 6)

    const curves = marginCurvesFromSelection(dome, sel)
    expect(curves.length).toBe(1)
    const { points } = curves[0]
    // the boundary is exactly the innermost selected ring
    expect(points.length).toBe(seg)
    for (const p of points) {
      expect(p.vertex).toBeGreaterThanOrEqual(6 * seg)
      expect(p.vertex).toBeLessThan(7 * seg)
      expect(p.face).toBeDefined()
      // bound position matches the scan vertex it came from
      expect(p.position[0]).toBeCloseTo(dome.positions[p.vertex! * 3], 6)
      expect(p.position[2]).toBeCloseTo(dome.positions[p.vertex! * 3 + 2], 6)
    }
  })

  it('yields one curve per selected region (two teeth → two loops)', () => {
    const two = mergeMeshes(makeCube(10), makeCube(10, [20, 0, 0]))
    const sel = new Set<number>([4, 5, 6, 7, 12, 13, 14, 15]) // both top faces
    const curves = marginCurvesFromSelection(two, sel)
    expect(curves.length).toBe(2)
    expect(curves[0].points.length).toBe(4)
    expect(curves[1].points.length).toBe(4)
  })

  it('returns [] when nothing encloses a face', () => {
    expect(marginCurvesFromSelection(makeDome(), new Set([0]))).toEqual([])
    expect(fullySelectedFaces(makeDome(), new Set([0]))).toEqual([])
  })
})

describe('enclosedFaceSet (round-trip)', () => {
  it('recovers the original dome-cap region from its margin curve', () => {
    const seg = 24, rings = 12
    const dome = makeDome(5, seg, rings)
    const sel = domeCapSelection(seg, rings, 6)
    const original = selectedTriSet(dome, sel)
    const [curve] = marginCurvesFromSelection(dome, sel)

    const enclosed = enclosedFaceSet(dome, curve, Z)
    expect(enclosed.size).toBe(original.size)
    for (const t of original) expect(enclosed.has(t)).toBe(true)
  })

  it('recovers a cube-top selection without leaking to the bottom or sides', () => {
    const cube = makeCube(10)
    const sel = new Set<number>([4, 5, 6, 7]) // top face corners
    const original = selectedTriSet(cube, sel)
    expect(original.size).toBe(2)
    const [curve] = marginCurvesFromSelection(cube, sel)

    const enclosed = enclosedFaceSet(cube, curve, Z)
    expect(enclosed).toEqual(original)
  })

  it('scopes to the curve: one tooth of a two-tooth selection', () => {
    const two = mergeMeshes(makeCube(10), makeCube(10, [20, 0, 0]))
    const sel = new Set<number>([4, 5, 6, 7, 12, 13, 14, 15])
    const curves = marginCurvesFromSelection(two, sel)

    const enclosedA = enclosedFaceSet(two, curves[0], Z)
    const enclosedB = enclosedFaceSet(two, curves[1], Z)
    expect(enclosedA.size).toBe(2)
    expect(enclosedB.size).toBe(2)
    // disjoint regions
    for (const t of enclosedA) expect(enclosedB.has(t)).toBe(false)
  })

  it('returns an empty set for a degenerate curve', () => {
    const dome = makeDome()
    expect(enclosedFaceSet(dome, { points: [] }, Z).size).toBe(0)
  })
})
