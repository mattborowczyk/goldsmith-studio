import { describe, expect, it } from 'vitest'
import { makeCube } from '../geometry/testFixtures'
import { exportPLY } from './exporters'
import { importFile, isSupportedFile, scaleMeshData } from './importers'
import type { MeshData } from '../types'

describe('isSupportedFile', () => {
  it('accepts the v1.5 formats and rejects others', () => {
    for (const ok of ['ring.stl', 'a.obj', 'b.glb', 'c.gltf', 'scan.ply', 'part.3mf', 'UP.PLY']) {
      expect(isSupportedFile(ok)).toBe(true)
    }
    expect(isSupportedFile('notes.txt')).toBe(false)
    expect(isSupportedFile('noext')).toBe(false)
  })
})

describe('PLY import', () => {
  it('parses a binary PLY into the right triangle count and surfaces colours', async () => {
    const cube = makeCube(10)
    const colors = new Float32Array(8 * 3)
    for (let i = 0; i < 8; i++) {
      colors[i * 3] = i / 7 // red ramps across the corners
      colors[i * 3 + 1] = 0.5
      colors[i * 3 + 2] = 1 - i / 7
    }
    const bytes = exportPLY(cube, colors)
    const file = new File([bytes as unknown as BlobPart], 'colored-cube.ply', {
      type: 'application/octet-stream',
    })

    const parts = await importFile(file)
    expect(parts).toHaveLength(1)
    const part = parts[0]
    expect(part.data.indices.length / 3).toBe(12)
    expect(part.colors).toBeDefined()
    expect(part.colors!.length).toBe(part.data.positions.length)
    // colour channel survives the round trip: red rises from first to last vertex
    const n = part.data.positions.length / 3
    expect(part.colors![0]).toBeLessThan(part.colors![(n - 1) * 3])
  })
})

describe('triangle-soup welding', () => {
  it('welds shared corners across faces despite per-face normals (OBJ soup)', async () => {
    // a 2-triangle-per-side "tent" whose faces fold — per-face normals differ
    // at the shared ridge, which must not stop the weld (the wand #48 needs
    // real adjacency out of soup formats)
    const obj = [
      'v -1 0 0', 'v 0 0 1', 'v 0 1 1', 'v -1 1 0', 'v 1 0 0', 'v 1 1 0',
      'f 1 2 3', 'f 1 3 4', 'f 2 5 6', 'f 2 6 3',
    ].join('\n')
    const parts = await importFile(new File([obj], 'tent.obj'))
    expect(parts).toHaveLength(1)
    expect(parts[0].data.indices.length / 3).toBe(4)
    // 6 distinct corners — unwelded soup would have kept 12
    expect(parts[0].data.positions.length / 3).toBe(6)
  })
})

describe('scaleMeshData', () => {
  const sample = (): MeshData => ({
    positions: new Float32Array([1, 2, 3, 4, 5, 6]),
    indices: new Uint32Array([0, 1, 2]),
  })

  it('scales positions by the factor', () => {
    const out = scaleMeshData(sample(), 10)
    expect(Array.from(out.positions)).toEqual([10, 20, 30, 40, 50, 60])
  })

  it('does not mutate the input (pure transform)', () => {
    const input = sample()
    const out = scaleMeshData(input, 25.4)
    expect(Array.from(input.positions)).toEqual([1, 2, 3, 4, 5, 6])
    expect(out.positions).not.toBe(input.positions)
    expect(out.indices).not.toBe(input.indices)
  })

  it('returns a fresh copy even when factor is 1', () => {
    const input = sample()
    const out = scaleMeshData(input, 1)
    expect(Array.from(out.positions)).toEqual([1, 2, 3, 4, 5, 6])
    expect(out.positions).not.toBe(input.positions)
    expect(Array.from(out.indices)).toEqual([0, 1, 2])
    expect(out.indices).not.toBe(input.indices)
  })
})
