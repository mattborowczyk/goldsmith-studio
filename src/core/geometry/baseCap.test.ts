import { describe, expect, it } from 'vitest'
import type { MeshData } from '../types'
import { closeOpenBase, earClipPolygon, findLargestOpenRim, summarizeOpenRim } from './baseCap'
import { analyzeMesh } from './meshAnalysis'
import { makeBulgedStud, makeCube, openCube } from './testFixtures'

/** Sum of signed 2D triangle areas for an ear-clip result. */
function clippedArea(pts: Array<[number, number]>, tris: number[]): number {
  let area = 0
  for (let t = 0; t < tris.length; t += 3) {
    const [ax, ay] = pts[tris[t]]
    const [bx, by] = pts[tris[t + 1]]
    const [cx, cy] = pts[tris[t + 2]]
    area += ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2
  }
  return area
}

/**
 * Open cylinder with a wavy (non-planar) bottom rim — the shape of an
 * intraoral scan's open side. Top is closed with an apex fan; only the
 * bottom boundary loop remains. Rim z ∈ [1, 3].
 */
function makeOpenWavyCylinder(r = 5, seg = 32, topZ = 10): MeshData {
  const verts: number[] = []
  for (let j = 0; j < seg; j++) {
    const a = (2 * Math.PI * j) / seg
    verts.push(r * Math.cos(a), r * Math.sin(a), 2 + Math.sin(2 * a))
  }
  for (let j = 0; j < seg; j++) {
    const a = (2 * Math.PI * j) / seg
    verts.push(r * Math.cos(a), r * Math.sin(a), topZ)
  }
  const apex = seg * 2
  verts.push(0, 0, topZ)
  const tris: number[] = []
  for (let j = 0; j < seg; j++) {
    const j1 = (j + 1) % seg
    tris.push(j, j1, seg + j1)
    tris.push(j, seg + j1, seg + j)
    tris.push(seg + j, seg + j1, apex)
  }
  return { positions: new Float32Array(verts), indices: new Uint32Array(tris) }
}

/** openCube with one extra bottom triangle removed — two boundary loops. */
function openCubeWithSmallHole(size = 10): MeshData {
  const open = openCube(size)
  return { positions: open.positions, indices: open.indices.slice(3) }
}

describe('earClipPolygon', () => {
  it('triangulates a convex square into 2 triangles covering its area', () => {
    const pts: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]]
    const tris = earClipPolygon(pts)
    expect(tris.length).toBe(6)
    expect(clippedArea(pts, tris)).toBeCloseTo(1, 9)
  })

  it('handles a concave L-shape with consistently oriented ears', () => {
    const pts: Array<[number, number]> = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]
    const tris = earClipPolygon(pts)
    expect(tris.length).toBe((pts.length - 2) * 3)
    expect(clippedArea(pts, tris)).toBeCloseTo(3, 9)
    for (let t = 0; t < tris.length; t += 3) {
      expect(clippedArea(pts, tris.slice(t, t + 3))).toBeGreaterThan(0)
    }
  })

  it('accepts clockwise input (orientation preserved in output)', () => {
    const pts: Array<[number, number]> = [[0, 0], [0, 1], [1, 1], [1, 0]]
    const tris = earClipPolygon(pts)
    expect(tris.length).toBe(6)
    expect(clippedArea(pts, tris)).toBeCloseTo(-1, 9)
  })
})

describe('findLargestOpenRim / summarizeOpenRim', () => {
  it('returns null for a watertight mesh', () => {
    expect(findLargestOpenRim(makeCube(10))).toBeNull()
    expect(summarizeOpenRim(makeCube(10))).toBeNull()
  })

  it('finds the open top of openCube and reports rim vs mesh bounds', () => {
    const summary = summarizeOpenRim(openCube(10))!
    expect(summary.loopEdges).toBe(4)
    expect(summary.loopCount).toBe(1)
    expect(summary.rimMin[2]).toBeCloseTo(10)
    expect(summary.rimMax[2]).toBeCloseTo(10)
    expect(summary.meshMin[2]).toBeCloseTo(0)
    // rim sits above the body centroid — the cap side the controller derives
    expect(summary.rimCentroid[2]).toBeGreaterThan(summary.meshCentroid[2])
  })

  it('picks the largest loop by perimeter when several are open', () => {
    const rim = findLargestOpenRim(openCubeWithSmallHole(10))!
    expect(rim.loopCount).toBe(2)
    expect(rim.loop.length).toBe(4) // the 40mm square rim, not the ~34mm triangle
  })
})

describe('closeOpenBase', () => {
  it('extends openCube to a watertight box with the expected volume', () => {
    const capped = closeOpenBase(openCube(10), { axis: 'z', position: 15 })
    const report = analyzeMesh(capped)
    expect(report.watertight).toBe(true)
    expect(report.manifold).toBe(true)
    expect(report.boundaryLoops).toBe(0)
    expect(report.volume).toBeCloseTo(10 * 10 * 15, 3)
  })

  it('closes the open-bottomed bulged stud (curved rim body)', () => {
    const capped = closeOpenBase(makeBulgedStud(), { axis: 'z', position: -2 })
    const report = analyzeMesh(capped)
    expect(report.watertight).toBe(true)
    expect(report.manifold).toBe(true)
    expect(report.invertedShells).toBe(0)
    expect(report.volume).toBeGreaterThan(0)
  })

  it('closes a non-planar wavy rim via the skirt', () => {
    const mesh = makeOpenWavyCylinder()
    const capped = closeOpenBase(mesh, { axis: 'z', position: 0 })
    const report = analyzeMesh(capped)
    expect(report.watertight).toBe(true)
    expect(report.manifold).toBe(true)
    // solid of revolution: between the full cylinder to rim-min and rim-max
    const r = 5
    expect(report.volume).toBeGreaterThan(Math.PI * r * r * 0.9 * (10 - 3))
    expect(report.volume).toBeLessThan(Math.PI * r * r * (10 - 0))
  })

  it('caps only the largest loop, leaving small holes to normal hole-fill', () => {
    const capped = closeOpenBase(openCubeWithSmallHole(10), { axis: 'z', position: 15 })
    const report = analyzeMesh(capped)
    expect(report.boundaryLoops).toBe(1)
    expect(report.boundaryEdges).toBe(3)
    expect(report.watertight).toBe(false)
  })

  it('throws a clear error when there is nothing to cap', () => {
    expect(() => closeOpenBase(makeCube(10), { axis: 'z', position: 20 })).toThrow(/no open rim/i)
  })
})
