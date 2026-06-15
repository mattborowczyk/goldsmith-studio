import { describe, expect, it } from 'vitest'
import { shellMesh } from './fitManifold'
import { buildSelectionPrism, perToothVolumes } from './shell'
import { computeThickness } from './thickness'
import { analyzeMesh } from './meshAnalysis'
import { invert, makeCube, mergeMeshes } from './testFixtures'
import type { MeshData, Vec3 } from '../types'

const Y: Vec3 = [0, 1, 0]
const Z: Vec3 = [0, 0, 1]

/** Axis-aligned bounds of a mesh. */
function bounds(mesh: MeshData): { min: Vec3; max: Vec3 } {
  const p = mesh.positions
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k]
      if (p[i + k] > max[k]) max[k] = p[i + k]
    }
  }
  return { min, max }
}

/** Open-bottomed convex dome (single-valued along +Z) — a clean patch for the prism test. */
function makeDome(R = 5, seg = 24, rings = 12): MeshData {
  const verts: number[] = []
  for (let i = 0; i < rings; i++) {
    const beta = (Math.PI / 2) * (1 - i / rings)
    const r = R * Math.sin(beta), z = R * Math.cos(beta)
    for (let j = 0; j < seg; j++) {
      const a = (2 * Math.PI * j) / seg
      verts.push(r * Math.cos(a), r * Math.sin(a), z)
    }
  }
  const apexIdx = rings * seg
  verts.push(0, 0, R)
  const positions = new Float32Array(verts)
  const ring = (i: number, j: number) => i * seg + (j % seg)
  const tris: number[] = []
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < seg; j++) {
      tris.push(ring(i, j), ring(i, j + 1), ring(i + 1, j + 1))
      tris.push(ring(i, j), ring(i + 1, j + 1), ring(i + 1, j))
    }
  }
  for (let j = 0; j < seg; j++) tris.push(ring(rings - 1, j), ring(rings - 1, j + 1), apexIdx)
  return { positions, indices: new Uint32Array(tris) }
}

describe('shellMesh', () => {
  it('builds a watertight shell of ≈ the requested wall thickness', async () => {
    const thickness = 0.8
    const result = await shellMesh(makeCube(10), null, Y, 0, thickness, false, 16)
    expect(result).not.toBeNull()

    const report = analyzeMesh(result!.mesh)
    expect(report.watertight).toBe(true)
    expect(report.manifold).toBe(true)

    // step-9 thickness heatmap as a cross-check: the thinnest wall ≈ the requested value
    const field = await computeThickness(result!.mesh, { yieldEvery: 0 })
    expect(field!.min).toBeGreaterThan(thickness * 0.8)
    expect(field!.min).toBeLessThan(thickness * 1.3)
  }, 30000)

  it('grows the bounds by ≈ thickness on the outer side', async () => {
    const thickness = 0.8
    const result = await shellMesh(makeCube(10), null, Y, 0, thickness, false, 16)
    const { min, max } = bounds(result!.mesh)
    // the cube spans [0,10] on every axis; the outer offset reaches ±thickness past it
    for (let k = 0; k < 3; k++) {
      expect(min[k]).toBeCloseTo(-thickness, 1)
      expect(max[k]).toBeCloseTo(10 + thickness, 1)
    }
  }, 30000)

  it('splits a two-region scan into per-tooth volumes summing to the whole', async () => {
    const two = mergeMeshes(makeCube(10), makeCube(10, [20, 0, 0]))
    const result = await shellMesh(two, null, Y, 0, 0.8, false, 16)
    expect(result!.toothVolumes.length).toBe(2)
    const [a, b] = result!.toothVolumes
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
    expect(a).toBeCloseTo(b, 0) // the two identical cubes shell to equal volumes

    // summed per-tooth volume ≈ the whole shell's volume
    const whole = Math.abs(analyzeMesh(result!.mesh).volume)
    expect(a + b).toBeCloseTo(whole, 0)
  }, 30000)

  it('clips the shell to a brushed region', async () => {
    const two = mergeMeshes(makeCube(10), makeCube(10, [20, 0, 0]))
    const firstCube = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]) // only the cube at x∈[0,10]
    const result = await shellMesh(two, firstCube, Y, 0, 0.8, false, 16)
    expect(result).not.toBeNull()
    const { max } = bounds(result!.mesh)
    expect(max[0]).toBeLessThan(15) // the second cube's shell (x≈20–30) is gone
  }, 30000)
})

describe('perToothVolumes', () => {
  // A hollow box is two disconnected surfaces (outer shell + inner cavity) whose bounds
  // nest — they must group into one tooth, not count as two. This guards the
  // containment grouping against a regression to plain AABB overlap.
  it('groups a cavity with its enclosing outer into one tooth', () => {
    const hollow = mergeMeshes(makeCube(10), invert(makeCube(6, [2, 2, 2])))
    const vols = perToothVolumes(hollow)
    expect(vols.length).toBe(1)
    expect(vols[0]).toBeCloseTo(10 ** 3 - 6 ** 3, 5) // wall volume = outer − cavity
  })

  // Two such hollow boxes, far apart, stay two teeth — neither's bounds contain the other.
  it('keeps two separated hollow boxes as two teeth', () => {
    const a = mergeMeshes(makeCube(10), invert(makeCube(6, [2, 2, 2])))
    const b = mergeMeshes(makeCube(10, [40, 0, 0]), invert(makeCube(6, [42, 2, 2])))
    expect(perToothVolumes(mergeMeshes(a, b)).length).toBe(2)
  })
})

describe('buildSelectionPrism', () => {
  it('extrudes a selected patch into a watertight prism spanning the cap range', () => {
    const dome = makeDome()
    const all = new Set<number>()
    for (let v = 0; v < dome.positions.length / 3; v++) all.add(v)
    const prism = buildSelectionPrism(dome, all, Z, 1)
    expect(prism).not.toBeNull()

    const report = analyzeMesh(prism!)
    expect(report.boundaryEdges).toBe(0) // closed
    expect(report.shells).toBe(1)

    const { min, max } = bounds(prism!)
    expect(max[2]).toBeCloseTo(5 + 1, 5) // apex (z=5) + cap
    expect(min[2]).toBeCloseTo(0 - 1, 5) // base (z=0) − cap
  })

  it('returns null when no triangle is fully selected', () => {
    expect(buildSelectionPrism(makeDome(), new Set([0]), Z, 1)).toBeNull()
  })
})
