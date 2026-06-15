import { describe, expect, it } from 'vitest'
import { defaultInsertionAxis, findBestAxis, surveyUndercut, undercutColor } from './undercut'
import { blockoutMesh } from './fitManifold'
import { makeBulgedStud } from './testFixtures'
import type { MeshData, Vec3 } from '../types'

const Z: Vec3 = [0, 0, 1]

/** Open-bottomed hemisphere dome (convex): fully draftable along +Z, undercut when tilted. */
function makeDome(R = 5, seg = 32, rings = 16): MeshData {
  const verts: number[] = []
  for (let i = 0; i < rings; i++) {
    const beta = (Math.PI / 2) * (1 - i / rings) // 90° (equator) → ~0 (near pole)
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
  const push = (a: number, b: number, c: number, rx: number, ry: number, rz: number) => {
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2]
    const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az
    const vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    if (nx * rx + ny * ry + nz * rz < 0) tris.push(a, c, b)
    else tris.push(a, b, c)
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const mc = Math.cos((2 * Math.PI * (j + 0.5)) / seg)
      const ms = Math.sin((2 * Math.PI * (j + 0.5)) / seg)
      push(ring(i, j), ring(i, j + 1), ring(i + 1, j + 1), mc, ms, 0.2)
      push(ring(i, j), ring(i + 1, j + 1), ring(i + 1, j), mc, ms, 0.2)
    }
  }
  for (let j = 0; j < seg; j++) push(ring(rings - 1, j), ring(rings - 1, j + 1), apexIdx, 0, 0, 1)
  return { positions, indices: new Uint32Array(tris) }
}

/** Signed volume of a closed mesh (divergence theorem). */
function volume(mesh: MeshData): number {
  const { positions: p, indices: ix } = mesh
  let v = 0
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3
    const cx = p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]
    const cy = p[b + 2] * p[c] - p[b] * p[c + 2]
    const cz = p[b] * p[c + 1] - p[b + 1] * p[c]
    v += p[a] * cx + p[a + 1] * cy + p[a + 2] * cz
  }
  return Math.abs(v) / 6
}

describe('defaultInsertionAxis', () => {
  it('returns the averaged outward normal (+Z) of the open-bottomed stud', () => {
    const axis = defaultInsertionAxis(makeBulgedStud())
    expect(axis[2]).toBeGreaterThan(0.95) // dominantly +Z
    expect(Math.hypot(axis[0], axis[1])).toBeLessThan(0.1)
  })
})

describe('surveyUndercut', () => {
  it('flags the sphere underside undercut, the top cap clear', async () => {
    const stud = makeBulgedStud() // R=5, rNeck=2.5, neckH=2 → equator z≈6.33, apex z≈11.33
    const field = await surveyUndercut(stud, Z, { yieldEvery: 0 })
    expect(field).not.toBeNull()
    expect(field!.area).toBeGreaterThan(0)

    let topVerts = 0
    let undersideUndercut = 0
    for (let v = 0; v < field!.values.length; v++) {
      const z = stud.positions[v * 3 + 2]
      if (z > 10.5) { // near the apex, facing the axis
        expect(field!.values[v]).toBe(0)
        topVerts++
      }
      if (z > 2.5 && z < 5.5 && field!.values[v] > 0) undersideUndercut++ // sub-equator band
    }
    expect(topVerts).toBeGreaterThan(0)
    expect(undersideUndercut).toBeGreaterThan(0)
  })

  it('returns an empty field for empty input', async () => {
    const empty: MeshData = { positions: new Float32Array([]), indices: new Uint32Array([]) }
    const field = await surveyUndercut(empty, Z, { yieldEvery: 0 })
    expect(field!.values.length).toBe(0)
    expect(field!.area).toBe(0)
  })
})

describe('findBestAxis', () => {
  it('recovers the clean +Z direction of a dome from a tilted seed', async () => {
    const dome = makeDome(5, 32, 16) // convex hemisphere — draftable along +Z, undercut when tilted
    const seed: Vec3 = [0.45, 0.3, 0.84] // tilted ~33° off the true +Z
    const before = await surveyUndercut(dome, seed, { yieldEvery: 0 })
    expect(before!.area).toBeGreaterThan(1) // the tilted seed sees real undercut

    const result = await findBestAxis(dome, seed)
    expect(result).not.toBeNull()
    expect(Math.abs(result!.axis[2])).toBeGreaterThan(0.9) // back near the Z axis
    expect(Math.hypot(result!.axis[0], result!.axis[1])).toBeLessThan(0.4)

    // and at that axis the undercut area is ~nil (an "obvious clean direction")
    const after = await surveyUndercut(dome, result!.axis, { yieldEvery: 0 })
    expect(after!.area).toBeLessThan(before!.area * 0.2)
  })
})

describe('blockoutMesh', () => {
  it('fills the undercuts so the upper surface draws cleanly along +Z', async () => {
    const stud = makeBulgedStud({ seg: 24, rings: 10 })
    const before = await surveyUndercut(stud, Z, { yieldEvery: 0 })
    // sanity: the original has undercut above the neck (the sphere bulge)
    let origUpperUndercut = 0
    for (let v = 0; v < before!.values.length; v++) {
      if (stud.positions[v * 3 + 2] > 2.5 && before!.values[v] > 0) origUpperUndercut++
    }
    expect(origUpperUndercut).toBeGreaterThan(0)

    const result = await blockoutMesh(stud, Z, 0, 16)
    expect(result).not.toBeNull()
    expect(volume(result!)).toBeGreaterThan(volume(stud)) // fill was added

    // re-survey the result: above the neck join everything should now be draftable
    // (the healed base cap + the swept skirt below the original rim are ignored)
    const after = await surveyUndercut(result!, Z, { yieldEvery: 0 })
    for (let v = 0; v < after!.values.length; v++) {
      if (result!.positions[v * 3 + 2] > 2.5) expect(after!.values[v]).toBe(0)
    }
  }, 30000)

  it('retention under-fills, leaving volume between the original and a clean seat', async () => {
    const stud = makeBulgedStud({ seg: 24, rings: 10 })
    const clean = await blockoutMesh(stud, Z, 0, 16)
    const retained = await blockoutMesh(stud, Z, 0.05, 16)
    expect(clean).not.toBeNull()
    expect(retained).not.toBeNull()
    const vOrig = volume(stud)
    expect(volume(retained!)).toBeGreaterThan(vOrig)
    expect(volume(retained!)).toBeLessThan(volume(clean!))
  }, 30000)
})

describe('undercutColor', () => {
  it('paints clear vertices neutral and undercuts amber→red', () => {
    const [nr, ng, nb] = undercutColor(0)
    expect(Math.abs(nr - ng)).toBeLessThan(0.15) // neutral-ish grey
    expect(Math.abs(ng - nb)).toBeLessThan(0.15)
    const shallow = undercutColor(0.2)
    const deep = undercutColor(1)
    expect(shallow[1]).toBeGreaterThan(deep[1]) // amber greener than red
    expect(deep[0]).toBeGreaterThan(deep[1]) // deep is red-dominant
  })
})
