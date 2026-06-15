import { describe, expect, it } from 'vitest'
import { buildBVH, closestPointDistance } from './bvh'
import { clearanceColor, computeClearance } from './fit'
import { offsetMesh, subtractMesh } from './fitManifold'
import { makeCube, makeTube } from './testFixtures'
import type { MeshData } from '../types'

function bbox(mesh: MeshData) {
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], mesh.positions[i + k])
      mx[k] = Math.max(mx[k], mesh.positions[i + k])
    }
  }
  return { mn, mx }
}

describe('closestPointDistance', () => {
  it('measures distance to the nearest face of a cube', () => {
    const cube = makeCube(10) // [0..10]^3
    const bvh = buildBVH(cube.positions, cube.indices)
    const d = (x: number, y: number, z: number) => closestPointDistance(bvh, cube.positions, cube.indices, x, y, z)
    // centre → 5 to every face, nearest 5
    expect(d(5, 5, 5)).toBeCloseTo(5, 5)
    // just inside the top face → small
    expect(d(5, 5, 9.7)).toBeCloseTo(0.3, 5)
    // outside above the top face → distance to the face
    expect(d(5, 5, 12)).toBeCloseTo(2, 5)
    // outside past a corner → distance to the corner vertex
    expect(d(13, 14, 10)).toBeCloseTo(Math.hypot(3, 4, 0), 5)
  })

  it('measures distance into a tube cavity', () => {
    const tube = makeTube({ innerR: 5, outerR: 7, height: 8, seg: 64, hSeg: 4 })
    const bvh = buildBVH(tube.positions, tube.indices)
    // a point on the axis at mid-height → nearest surface is the inner wall, r = 5
    const d = closestPointDistance(bvh, tube.positions, tube.indices, 0, 0, 4)
    expect(d).toBeCloseTo(5, 1)
  })
})

describe('computeClearance', () => {
  it('signs the gap: positive outside, negative inside (interference)', async () => {
    const scan = makeCube(10) // [0..10]^3
    // two probe vertices: one 2 mm above the top face, one 2 mm below it (inside)
    const shell: MeshData = {
      positions: new Float32Array([5, 5, 12, 5, 5, 8]),
      indices: new Uint32Array([]),
    }
    const field = await computeClearance(shell, scan, { yieldEvery: 0 })
    expect(field).not.toBeNull()
    expect(field!.values[0]).toBeCloseTo(2, 4) // outside → clearance
    expect(field!.values[1]).toBeCloseTo(-2, 4) // inside → interference
    expect(field!.min).toBeCloseTo(-2, 4)
    expect(field!.max).toBeCloseTo(2, 4)
  })

  it('returns an empty field for empty input', async () => {
    const empty: MeshData = { positions: new Float32Array([]), indices: new Uint32Array([]) }
    const field = await computeClearance(empty, makeCube(10), { yieldEvery: 0 })
    expect(field!.values.length).toBe(0)
  })
})

describe('clearanceColor', () => {
  const lo = 0.03
  const hi = 0.07
  it('flags interference red at/below zero', () => {
    expect(clearanceColor(-0.1, lo, hi)).toEqual(clearanceColor(0, lo, hi))
    const [r, g, b] = clearanceColor(-0.1, lo, hi)
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
  })
  it('paints in-band gaps green', () => {
    const [r, g, b] = clearanceColor(0.05, lo, hi)
    expect(g).toBeGreaterThan(r)
    expect(g).toBeGreaterThan(b)
  })
  it('trends red as the gap gets too tight', () => {
    const [r, g] = clearanceColor(0.005, lo, hi)
    expect(r).toBeGreaterThan(g)
  })
  it('trends blue as the gap gets too loose', () => {
    const [r, , b] = clearanceColor(0.5, lo, hi)
    expect(b).toBeGreaterThan(r)
  })
})

describe('offsetMesh (Minkowski)', () => {
  it('returns null when cancelled at a stage boundary', async () => {
    let cancelled = false
    const mesh = await offsetMesh(makeCube(10), 0.5, 16, {
      onStage: (_p, stage) => {
        if (stage === 'Building surface') cancelled = true
      },
      shouldCancel: () => cancelled,
    })
    expect(mesh).toBeNull()
  }, 20000)

  it('grows the bbox by ~clearance per side', async () => {
    const mesh = await offsetMesh(makeCube(10), 0.5, 16)
    expect(mesh).not.toBeNull()
    const { mn, mx } = bbox(mesh!)
    for (let k = 0; k < 3; k++) {
      expect(mn[k]).toBeCloseTo(-0.5, 2)
      expect(mx[k]).toBeCloseTo(10.5, 2)
    }
  }, 20000)
})

describe('subtractMesh', () => {
  it('carves a cavity with ~uniform clearance from the scan', async () => {
    const scan = makeCube(10) // [0..10]^3
    const shell = makeCube(14, [-2, -2, -2]) // [-2..12]^3 wall around the scan
    const clearance = 0.3
    const result = await subtractMesh(scan, shell, clearance, 24)
    expect(result).not.toBeNull()

    // every vertex on the carved cavity surface should sit ~clearance from the scan
    const bvh = buildBVH(scan.positions, scan.indices)
    let sampled = 0
    for (let i = 0; i < result!.positions.length; i += 3) {
      const d = closestPointDistance(
        bvh, scan.positions, scan.indices,
        result!.positions[i], result!.positions[i + 1], result!.positions[i + 2],
      )
      if (d < 1) {
        // a cavity-wall vertex (outer shell vertices are ~2 mm+ away)
        expect(d).toBeGreaterThan(clearance - 0.05)
        expect(d).toBeLessThan(clearance + 0.05)
        sampled++
      }
    }
    expect(sampled).toBeGreaterThan(0)
  }, 20000)
})
