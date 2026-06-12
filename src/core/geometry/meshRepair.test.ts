import { describe, expect, it } from 'vitest'
import { analyzeMesh } from './meshAnalysis'
import {
  fillHoles,
  filterSmallShells,
  fixWinding,
  removeDegenerateTriangles,
  splitShells,
  weldVertices,
} from './meshRepair'
import { invert, makeCube, mergeMeshes, openCube } from './testFixtures'
import type { MeshData } from '../types'

/** Duplicate every vertex per triangle — STL-style triangle soup. */
function toSoup(mesh: MeshData): MeshData {
  const positions = new Float32Array(mesh.indices.length * 3)
  const indices = new Uint32Array(mesh.indices.length)
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i]
    positions[i * 3] = mesh.positions[v * 3]
    positions[i * 3 + 1] = mesh.positions[v * 3 + 1]
    positions[i * 3 + 2] = mesh.positions[v * 3 + 2]
    indices[i] = i
  }
  return { positions, indices }
}

describe('weldVertices', () => {
  it('rebuilds connectivity from triangle soup', () => {
    const soup = toSoup(makeCube(10))
    expect(analyzeMesh(soup).watertight).toBe(false)
    const welded = weldVertices(soup, 1e-4)
    const report = analyzeMesh(welded)
    expect(report.vertices).toBe(8)
    expect(report.watertight).toBe(true)
    expect(report.volume).toBeCloseTo(1000, 4)
  })
})

describe('fixWinding', () => {
  it('repairs an inside-out cube', () => {
    const fixed = fixWinding(invert(makeCube(10)))
    const report = analyzeMesh(fixed)
    expect(report.invertedShells).toBe(0)
    expect(report.volume).toBeCloseTo(1000, 5)
  })

  it('repairs a single flipped triangle', () => {
    const cube = makeCube(10)
    const indices = cube.indices.slice()
    // flip triangle 0
    const tmp = indices[1]
    indices[1] = indices[2]
    indices[2] = tmp
    const fixed = fixWinding({ positions: cube.positions, indices })
    expect(analyzeMesh(fixed).volume).toBeCloseTo(1000, 5)
    expect(analyzeMesh(fixed).invertedShells).toBe(0)
  })
})

describe('fillHoles', () => {
  it('closes the open cube and restores its volume', () => {
    const filled = fillHoles(openCube(10), 64)
    const report = analyzeMesh(filled)
    expect(report.watertight).toBe(true)
    expect(report.volume).toBeCloseTo(1000, 4)
    expect(report.invertedShells).toBe(0)
  })

  it('skips loops above the size limit', () => {
    const filled = fillHoles(openCube(10), 3)
    expect(analyzeMesh(filled).watertight).toBe(false)
  })
})

describe('filterSmallShells', () => {
  it('drops debris below the volume threshold', () => {
    const mesh = mergeMeshes(makeCube(10), makeCube(0.5, [30, 0, 0]))
    const filtered = filterSmallShells(mesh, 1)
    const report = analyzeMesh(filtered)
    expect(report.shells).toBe(1)
    expect(report.volume).toBeCloseTo(1000, 4)
  })
})

describe('splitShells', () => {
  it('separates disconnected shells into compact meshes', () => {
    const mesh = mergeMeshes(makeCube(10), makeCube(5, [30, 0, 0]))
    const parts = splitShells(mesh)
    expect(parts).toHaveLength(2)
    const vols = parts.map((p) => analyzeMesh(p).volume).sort((a, b) => a - b)
    expect(vols[0]).toBeCloseTo(125, 4)
    expect(vols[1]).toBeCloseTo(1000, 4)
    expect(parts[0].positions.length).toBe(8 * 3)
  })
})

describe('removeDegenerateTriangles', () => {
  it('strips zero-area and repeated-index triangles', () => {
    const cube = makeCube(10)
    const indices = new Uint32Array([...cube.indices, 0, 0, 1, 0, 1, 0])
    const cleaned = removeDegenerateTriangles({ positions: cube.positions, indices })
    expect(cleaned.indices.length).toBe(cube.indices.length)
  })
})
