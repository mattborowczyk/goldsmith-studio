import type { MeshData } from '../types'

/** Axis-aligned cube with outward-facing windings, for tests. */
export function makeCube(size = 10, offset: [number, number, number] = [0, 0, 0]): MeshData {
  const [ox, oy, oz] = offset
  const s = size
  // prettier-ignore
  const positions = new Float32Array([
    ox, oy, oz,         ox + s, oy, oz,         ox + s, oy + s, oz,         ox, oy + s, oz,
    ox, oy, oz + s,     ox + s, oy, oz + s,     ox + s, oy + s, oz + s,     ox, oy + s, oz + s,
  ])
  // prettier-ignore
  const indices = new Uint32Array([
    0, 2, 1,  0, 3, 2, // bottom (-z)
    4, 5, 6,  4, 6, 7, // top (+z)
    0, 1, 5,  0, 5, 4, // front (-y)
    2, 3, 7,  2, 7, 6, // back (+y)
    0, 4, 7,  0, 7, 3, // left (-x)
    1, 2, 6,  1, 6, 5, // right (+x)
  ])
  return { positions, indices }
}

export function mergeMeshes(a: MeshData, b: MeshData): MeshData {
  const positions = new Float32Array(a.positions.length + b.positions.length)
  positions.set(a.positions)
  positions.set(b.positions, a.positions.length)
  const offset = a.positions.length / 3
  const indices = new Uint32Array(a.indices.length + b.indices.length)
  indices.set(a.indices)
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + offset
  return { positions, indices }
}

/** Remove the two triangles of the +z face, leaving a square hole. */
export function openCube(size = 10): MeshData {
  const cube = makeCube(size)
  return { positions: cube.positions, indices: removeTris(cube.indices, 2, 4) }
}

function removeTris(indices: Uint32Array, startTri: number, endTri: number): Uint32Array {
  const out = new Uint32Array(indices.length - (endTri - startTri) * 3)
  out.set(indices.subarray(0, startTri * 3))
  out.set(indices.subarray(endTri * 3), startTri * 3)
  return out
}

/** Flip the winding of every triangle (inside-out cube). */
export function invert(mesh: MeshData): MeshData {
  const indices = mesh.indices.slice()
  for (let t = 0; t < indices.length; t += 3) {
    const tmp = indices[t + 1]
    indices[t + 1] = indices[t + 2]
    indices[t + 2] = tmp
  }
  return { positions: mesh.positions, indices }
}
