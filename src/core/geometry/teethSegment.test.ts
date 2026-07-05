import { describe, expect, it } from 'vitest'
import type { MeshData, Vec3 } from '../types'
import { wandSelect, type WandParams } from './teethSegment'
import { makeTwoBumpBase } from './testFixtures'

const Z: Vec3 = [0, 0, 1]
const rad = (deg: number) => (deg * Math.PI) / 180

// two-bump fixture geometry (defaults): caps at x = ±8, foot radius √(R²−(R−h)²)
const R = 6
const H = 5.5
const SEP = 16
const FOOT = Math.sqrt(R * R - (R - H) * (R - H)) // ≈ 5.98

const mesh = makeTwoBumpBase()

function centroid(m: MeshData, t: number): Vec3 {
  const { positions, indices } = m
  const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3
  return [
    (positions[a] + positions[b] + positions[c]) / 3,
    (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3,
    (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3,
  ]
}

/** Radial distance of a point from a cap centre (x = cx, y = 0). */
const radial = (p: Vec3, cx: number) => Math.hypot(p[0] - cx, p[1])

/** Triangles safely inside one cap's foot circle and above the base plane. */
function capFaces(m: MeshData, cx: number): Set<number> {
  const out = new Set<number>()
  for (let t = 0; t < m.indices.length / 3; t++) {
    const c = centroid(m, t)
    if (radial(c, cx) < FOOT - 0.7 && c[2] > 0.05) out.add(t)
  }
  return out
}

function pick(m: MeshData, seed: Vec3, thresholdDeg: number, extra: Partial<WandParams> = {}) {
  return wandSelect(
    m,
    { seedPoint: seed, axis: Z, thresholdRad: rad(thresholdDeg), ...extra },
    { yieldEvery: 0 },
  )
}

const APEX_A: Vec3 = [-SEP / 2, 0, H]

describe('wandSelect', () => {
  it('clicking one bump selects ≈that bump and excludes the base and the other bump', async () => {
    const res = await pick(mesh, APEX_A, 45)
    expect(res).not.toBeNull()
    const region = new Set(res!.faces)
    expect(region.size).toBeGreaterThan(0)

    // covers essentially all of bump A…
    const capA = capFaces(mesh, -SEP / 2)
    let covered = 0
    for (const t of capA) if (region.has(t)) covered++
    expect(covered / capA.size).toBeGreaterThan(0.95)

    // …and never strays past A's foot crease (so no base, no bump B)
    for (const t of region) {
      const c = centroid(mesh, t)
      expect(radial(c, -SEP / 2)).toBeLessThan(FOOT + 1.0)
    }
    for (const t of capFaces(mesh, SEP / 2)) expect(region.has(t)).toBe(false)

    // the selection vertex set is what the overlay/shell clip consume
    expect(res!.vertices.length).toBeGreaterThan(0)
  })

  it('threshold widens/narrows the region monotonically and floods past the foot angle', async () => {
    // guard off: isolate the pure-curvature stop
    const noGuard = { guardFactor: 1 }
    const r25 = (await pick(mesh, APEX_A, 25, noGuard))!
    const r45 = (await pick(mesh, APEX_A, 45, noGuard))!
    const r120 = (await pick(mesh, APEX_A, 120, noGuard))!

    // a higher threshold blocks strictly fewer edges → supersets
    const s45 = new Set(r45.faces)
    for (const t of r25.faces) expect(s45.has(t)).toBe(true)
    expect(r45.faces.length).toBeGreaterThanOrEqual(r25.faces.length)

    // past every crease on the mesh, the grow floods the whole connected surface
    expect(r120.faces.length).toBe(mesh.indices.length / 3)
  })

  it('gum guard: a soft crease below the seed still stops the grow', async () => {
    // shallow caps sampled on the grid leave only a ~15–20° discrete crease —
    // pick a threshold that crease cannot block at full strength but does once
    // the guard tightens it below the seed
    const shallow = makeTwoBumpBase({ h: 2 })
    const seed: Vec3 = [-SEP / 2, 0, 2]
    const guard = { guardStartMm: 0.2, guardEndMm: 1.0, guardFactor: 0.5 }
    const thresholdDeg = 25

    const flooded = (await pick(shallow, seed, thresholdDeg, { guardFactor: 1 }))!
    const guarded = (await pick(shallow, seed, thresholdDeg, guard))!

    // (a handful of faces can hide behind stray creases — "flooded" ≈ the whole base)
    expect(flooded.faces.length).toBeGreaterThan((shallow.indices.length / 3) * 0.9)
    expect(guarded.faces.length).toBeLessThan(flooded.faces.length / 3)
    const footShallow = Math.sqrt(R * R - (R - 2) * (R - 2))
    for (const t of guarded.faces) {
      expect(radial(centroid(shallow, t), -SEP / 2)).toBeLessThan(footShallow + 1.0)
    }
  })

  it('emits a closed MarginCurve landing on the foot crease', async () => {
    const res = (await pick(mesh, APEX_A, 45))!
    expect(res.curves.length).toBe(1)
    const { points } = res.curves[0]
    expect(points.length).toBeGreaterThan(20)

    const region = new Set(res.faces)
    for (const p of points) {
      // the boundary hugs the foot ring, on the cap side of the crease
      const r = radial(p.position, -SEP / 2)
      expect(r).toBeGreaterThan(FOOT - 1.2)
      expect(r).toBeLessThan(FOOT + 0.7)
      expect(p.position[2]).toBeLessThan(1.5)
      // control points bind to their scan vertex and a region face
      expect(p.vertex).toBeDefined()
      expect(p.position[0]).toBeCloseTo(mesh.positions[p.vertex! * 3], 5)
      expect(p.position[1]).toBeCloseTo(mesh.positions[p.vertex! * 3 + 1], 5)
      expect(region.has(p.face!)).toBe(true)
    }
  })

  it('resolves null when cancelled mid-run', async () => {
    const res = await wandSelect(
      mesh,
      { seedPoint: APEX_A, axis: Z, thresholdRad: rad(45) },
      { yieldEvery: 1, shouldCancel: () => true },
    )
    expect(res).toBeNull()
  })

  it('returns an empty result for an empty mesh', async () => {
    const res = await wandSelect(
      { positions: new Float32Array(0), indices: new Uint32Array(0) },
      { seedPoint: [0, 0, 0], axis: Z, thresholdRad: rad(45) },
    )
    expect(res).toEqual({ faces: new Uint32Array(0), vertices: new Uint32Array(0), curves: [] })
  })
})
