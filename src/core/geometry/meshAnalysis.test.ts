import { describe, expect, it } from 'vitest'
import { analyzeMesh } from './meshAnalysis'
import { invert, makeCube, mergeMeshes, openCube } from './testFixtures'

describe('analyzeMesh', () => {
  it('reports a closed 10mm cube as watertight with exact volume and area', () => {
    const report = analyzeMesh(makeCube(10))
    expect(report.triangles).toBe(12)
    expect(report.vertices).toBe(8)
    expect(report.shells).toBe(1)
    expect(report.boundaryEdges).toBe(0)
    expect(report.nonManifoldEdges).toBe(0)
    expect(report.invertedShells).toBe(0)
    expect(report.watertight).toBe(true)
    expect(report.manifold).toBe(true)
    expect(report.volume).toBeCloseTo(1000, 5)
    expect(report.surfaceArea).toBeCloseTo(600, 5)
  })

  it('detects the hole in an open cube', () => {
    const report = analyzeMesh(openCube(10))
    expect(report.watertight).toBe(false)
    expect(report.boundaryEdges).toBe(4)
    expect(report.boundaryLoops).toBe(1)
    expect(report.boundaryEdgePositions.length).toBe(4 * 6)
  })

  it('counts separate shells', () => {
    const two = mergeMeshes(makeCube(10), makeCube(5, [30, 0, 0]))
    const report = analyzeMesh(two)
    expect(report.shells).toBe(2)
    expect(report.volume).toBeCloseTo(1000 + 125, 4)
  })

  it('flags inverted shells', () => {
    const report = analyzeMesh(invert(makeCube(10)))
    expect(report.invertedShells).toBe(1)
    expect(report.flippedFacePositions.length).toBe(12 * 3)
    // |volume| still reported
    expect(report.volume).toBeCloseTo(1000, 5)
  })
})
