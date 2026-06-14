import { describe, expect, it } from 'vitest'
import { makeCube } from '../geometry/testFixtures'
import { exportOBJ, exportSTL, mergeMeshData, scaleMeshDataCopy } from './exporters'

/** Minimal binary-STL reader: triangle count + per-vertex bbox. */
function readSTL(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tris = view.getUint32(80, true)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let off = 84
  for (let t = 0; t < tris; t++) {
    off += 12 // skip the normal
    for (let v = 0; v < 3; v++) {
      for (let k = 0; k < 3; k++) {
        const c = view.getFloat32(off, true)
        off += 4
        if (c < min[k]) min[k] = c
        if (c > max[k]) max[k] = c
      }
    }
    off += 2 // attribute byte count
  }
  return { tris, min, max }
}

describe('binary STL writer', () => {
  it('produces the exact byte length 84 + 50 × triangles', () => {
    const cube = makeCube(10)
    const stl = exportSTL(cube)
    const tris = cube.indices.length / 3
    expect(tris).toBe(12)
    expect(stl.byteLength).toBe(84 + 50 * tris)
  })

  it('round-trips triangle count and bounding box', () => {
    const cube = makeCube(10, [2, 3, 4])
    const { tris, min, max } = readSTL(exportSTL(cube))
    expect(tris).toBe(12)
    expect(min).toEqual([2, 3, 4])
    expect(max).toEqual([12, 13, 14])
  })
})

describe('OBJ writer', () => {
  it('emits one v per vertex and one f per triangle', () => {
    const cube = makeCube(10)
    const obj = exportOBJ([{ name: 'cube', mesh: cube }])
    const vLines = obj.split('\n').filter((l) => l.startsWith('v '))
    const fLines = obj.split('\n').filter((l) => l.startsWith('f '))
    expect(vLines).toHaveLength(cube.positions.length / 3)
    expect(fLines).toHaveLength(cube.indices.length / 3)
  })

  it('uses 1-based indices and offsets across grouped meshes', () => {
    const cube = makeCube(10)
    const obj = exportOBJ([
      { name: 'a', mesh: cube },
      { name: 'b', mesh: cube },
    ])
    const fLines = obj.split('\n').filter((l) => l.startsWith('f '))
    // first group: 1-based, max index = 8 (8 verts)
    const first = fLines[0].slice(2).split(' ').map(Number)
    expect(Math.min(...first)).toBeGreaterThanOrEqual(1)
    // second group's faces reference verts 9..16
    const second = fLines[12].slice(2).split(' ').map(Number)
    expect(Math.min(...second)).toBeGreaterThan(8)
  })
})

describe('scaleMeshDataCopy', () => {
  it('scales a copy without mutating the input', () => {
    const cube = makeCube(10)
    const original = cube.positions.slice()
    const scaled = scaleMeshDataCopy(cube, 1.02)
    expect(cube.positions).toEqual(original) // input untouched
    expect(scaled.positions).not.toBe(cube.positions)
    expect(scaled.positions[3]).toBeCloseTo(original[3] * 1.02, 5)
    expect(scaled.indices).toEqual(cube.indices)
  })
})

describe('mergeMeshData', () => {
  it('sums triangles and offsets the second mesh indices', () => {
    const a = makeCube(10)
    const b = makeCube(10, [20, 0, 0])
    const merged = mergeMeshData([a, b])
    expect(merged.indices.length).toBe(a.indices.length + b.indices.length)
    expect(merged.positions.length).toBe(a.positions.length + b.positions.length)
    // second cube's first triangle indices are offset by a's vertex count (8)
    const off = a.positions.length / 3
    expect(merged.indices[a.indices.length]).toBe(a.indices[0] + off)
  })
})
