import { describe, expect, it } from 'vitest'
import { makeCube } from '../geometry/testFixtures'
import { export3MF, exportOBJ, exportPLY, exportSTL, mergeMeshData, scaleMeshDataCopy } from './exporters'

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

/** Minimal binary-PLY reader: vertex/triangle counts, bbox, optional colours. */
function readPLY(bytes: Uint8Array) {
  const text = new TextDecoder('latin1').decode(bytes)
  const headerEnd = text.indexOf('end_header\n') + 'end_header\n'.length
  const header = text.slice(0, headerEnd)
  const vertexCount = Number(/element vertex (\d+)/.exec(header)![1])
  const faceCount = Number(/element face (\d+)/.exec(header)![1])
  const hasColor = /property uchar red/.test(header)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = headerEnd
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const colors: number[][] = []
  for (let v = 0; v < vertexCount; v++) {
    for (let k = 0; k < 3; k++) {
      const c = view.getFloat32(off, true)
      off += 4
      if (c < min[k]) min[k] = c
      if (c > max[k]) max[k] = c
    }
    if (hasColor) {
      colors.push([view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2)])
      off += 3
    }
  }
  let tris = 0
  for (let f = 0; f < faceCount; f++) {
    const n = view.getUint8(off)
    off += 1 + n * 4
    tris += n - 2
  }
  return { vertexCount, tris, min, max, colors, hasColor }
}

describe('binary PLY writer', () => {
  it('round-trips vertex/triangle counts and bounding box', () => {
    const cube = makeCube(10, [2, 3, 4])
    const ply = readPLY(exportPLY(cube))
    expect(ply.vertexCount).toBe(8)
    expect(ply.tris).toBe(12)
    expect(ply.min).toEqual([2, 3, 4])
    expect(ply.max).toEqual([12, 13, 14])
    expect(ply.hasColor).toBe(false)
  })

  it('preserves per-vertex colours', () => {
    const cube = makeCube(10)
    // 8 vertices × rgb in 0..1
    const colors = new Float32Array(8 * 3)
    for (let i = 0; i < 8; i++) {
      colors[i * 3] = i / 7 // red ramps 0→1 across the corners
      colors[i * 3 + 1] = 0.5
      colors[i * 3 + 2] = 1 - i / 7
    }
    const ply = readPLY(exportPLY(cube, colors))
    expect(ply.hasColor).toBe(true)
    expect(ply.colors).toHaveLength(8)
    expect(ply.colors[0]).toEqual([0, 128, 255]) // round(0*255), round(.5*255), round(1*255)
    expect(ply.colors[7]).toEqual([255, 128, 0])
  })
})

describe('3MF writer', () => {
  it('packages a valid stored zip with the model XML', () => {
    const cube = makeCube(10)
    const bytes = export3MF([{ name: 'cube', mesh: cube }])
    // ZIP local-file-header signature "PK\x03\x04"
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04])
    // STORE (uncompressed) → the XML is present verbatim and countable
    const text = new TextDecoder('latin1').decode(bytes)
    expect(text).toContain('3dmodel.model')
    expect((text.match(/<vertex /g) ?? []).length).toBe(cube.positions.length / 3)
    expect((text.match(/<triangle /g) ?? []).length).toBe(cube.indices.length / 3)
    expect(text).toContain('unit="millimeter"')
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
