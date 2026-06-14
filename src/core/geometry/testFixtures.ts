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

/**
 * Watertight hollow tube (annular cylinder) with shared, indexed vertices and
 * outward-consistent winding — interior-ring side vertices therefore get purely
 * radial normals, so their inward ray crosses exactly `outerR − innerR`. With
 * ≥1 height segment that wall thickness is the mesh's minimum. `outerRTop` taper
 * gives a varying wall for threshold tests.
 */
export function makeTube(opts: {
  innerR?: number
  outerR?: number
  outerRTop?: number
  height?: number
  seg?: number
  hSeg?: number
} = {}): MeshData {
  const innerR = opts.innerR ?? 5
  const outerRBottom = opts.outerR ?? 7
  const outerRTop = opts.outerRTop ?? outerRBottom
  const height = opts.height ?? 8
  const seg = opts.seg ?? 48
  const hSeg = opts.hSeg ?? 4
  const outerR = (t: number) => outerRBottom + (outerRTop - outerRBottom) * t

  const verts: number[] = []
  const rings = hSeg + 1
  // outer ring vertices, then inner ring vertices
  for (let i = 0; i < rings; i++) {
    const t = i / hSeg
    const z = height * t
    const r = outerR(t)
    for (let j = 0; j < seg; j++) {
      const a = (2 * Math.PI * j) / seg
      verts.push(r * Math.cos(a), r * Math.sin(a), z)
    }
  }
  const innerBase = rings * seg
  for (let i = 0; i < rings; i++) {
    const z = height * (i / hSeg)
    for (let j = 0; j < seg; j++) {
      const a = (2 * Math.PI * j) / seg
      verts.push(innerR * Math.cos(a), innerR * Math.sin(a), z)
    }
  }
  const positions = new Float32Array(verts)
  const outer = (i: number, j: number) => i * seg + (j % seg)
  const inner = (i: number, j: number) => innerBase + i * seg + (j % seg)

  const tris: number[] = []
  const push = (a: number, b: number, c: number, rx: number, ry: number, rz: number) => {
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2]
    const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az
    const vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    if (nx * rx + ny * ry + nz * rz < 0) tris.push(a, c, b)
    else tris.push(a, b, c)
  }
  for (let i = 0; i < hSeg; i++) {
    for (let j = 0; j < seg; j++) {
      const mc = Math.cos((2 * Math.PI * (j + 0.5)) / seg)
      const ms = Math.sin((2 * Math.PI * (j + 0.5)) / seg)
      // outer wall — outward = +radial
      push(outer(i, j), outer(i, j + 1), outer(i + 1, j + 1), mc, ms, 0)
      push(outer(i, j), outer(i + 1, j + 1), outer(i + 1, j), mc, ms, 0)
      // inner wall — outward (into cavity) = −radial
      push(inner(i, j), inner(i, j + 1), inner(i + 1, j + 1), -mc, -ms, 0)
      push(inner(i, j), inner(i + 1, j + 1), inner(i + 1, j), -mc, -ms, 0)
    }
  }
  for (let j = 0; j < seg; j++) {
    // bottom cap (i=0) — outward = −z; top cap (i=hSeg) — outward = +z
    push(outer(0, j), inner(0, j), inner(0, j + 1), 0, 0, -1)
    push(outer(0, j), inner(0, j + 1), outer(0, j + 1), 0, 0, -1)
    push(outer(hSeg, j), outer(hSeg, j + 1), inner(hSeg, j + 1), 0, 0, 1)
    push(outer(hSeg, j), inner(hSeg, j + 1), inner(hSeg, j), 0, 0, 1)
  }
  return { positions, indices: new Uint32Array(tris) }
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
