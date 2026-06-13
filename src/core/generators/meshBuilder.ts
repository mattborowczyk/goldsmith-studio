import type { MeshData, Vec3 } from '../types'

/**
 * Shared low-level mesh construction for the parametric generators. Everything
 * builds indexed MeshData directly (no Three.js dependency) so the meshes are
 * watertight by construction: closed grids share every edge exactly twice.
 */

/** Closed 2D loop (no repeated last point). */
export type Loop2 = [number, number][]

/** Signed volume in mm³ — positive when triangles wind outward (CCW). */
export function signedVolume(mesh: MeshData): number {
  const p = mesh.positions
  const idx = mesh.indices
  let vol6 = 0
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t] * 3
    const i1 = idx[t + 1] * 3
    const i2 = idx[t + 2] * 3
    vol6 +=
      p[i0] * (p[i1 + 1] * p[i2 + 2] - p[i1 + 2] * p[i2 + 1]) +
      p[i0 + 1] * (p[i1 + 2] * p[i2] - p[i1] * p[i2 + 2]) +
      p[i0 + 2] * (p[i1] * p[i2 + 1] - p[i1 + 1] * p[i2])
  }
  return vol6 / 6
}

/** Flip every triangle so a closed inward-winding mesh becomes outward. */
export function ensureOutward(mesh: MeshData): MeshData {
  if (signedVolume(mesh) >= 0) return mesh
  const idx = mesh.indices
  for (let t = 0; t < idx.length; t += 3) {
    const tmp = idx[t + 1]
    idx[t + 1] = idx[t + 2]
    idx[t + 2] = tmp
  }
  return mesh
}

/** Translate so the lowest point sits on the ground plane (y = 0). */
export function restOnGround(mesh: MeshData): MeshData {
  let minY = Infinity
  const p = mesh.positions
  for (let i = 1; i < p.length; i += 3) if (p[i] < minY) minY = p[i]
  if (minY !== Infinity && minY !== 0) {
    for (let i = 1; i < p.length; i += 3) p[i] -= minY
  }
  return mesh
}

/**
 * Grid closed in both directions (torus topology): rows[i][j] are vertices,
 * rows wrap to rows[0] and each row wraps to its first point.
 */
export function meshFromTorusGrid(rows: Vec3[][]): MeshData {
  const R = rows.length
  const M = rows[0]?.length ?? 0
  if (R < 3 || M < 3) throw new Error('meshFromTorusGrid needs ≥3 rows of ≥3 points')
  if (rows.some((row) => row.length !== M)) {
    throw new Error('meshFromTorusGrid needs all rows the same length')
  }
  const positions = new Float32Array(R * M * 3)
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < M; j++) {
      const v = rows[i][j]
      const o = (i * M + j) * 3
      positions[o] = v[0]
      positions[o + 1] = v[1]
      positions[o + 2] = v[2]
    }
  }
  const indices = new Uint32Array(R * M * 6)
  let k = 0
  for (let i = 0; i < R; i++) {
    const i2 = (i + 1) % R
    for (let j = 0; j < M; j++) {
      const j2 = (j + 1) % M
      const a = i * M + j
      const b = i2 * M + j
      const c = i2 * M + j2
      const d = i * M + j2
      indices[k++] = a
      indices[k++] = b
      indices[k++] = c
      indices[k++] = a
      indices[k++] = c
      indices[k++] = d
    }
  }
  return ensureOutward({ positions, indices })
}

/** End cap spec for a loft: an apex vertex, or a centroid fan over the loop. */
export type LoftCap = Vec3 | 'fan'

/**
 * Loft stacked closed loops (all the same length) into a solid: side quads
 * between consecutive layers, capped at both ends. Loops must be star-shaped
 * around their centroid for the fan caps to be valid.
 */
export function loftLoops(layers: Vec3[][], bottom: LoftCap, top: LoftCap): MeshData {
  const L = layers.length
  const M = layers[0]?.length ?? 0
  if (L < 2 || M < 3) throw new Error('loftLoops needs ≥2 layers of ≥3 points')
  if (layers.some((layer) => layer.length !== M)) {
    throw new Error('loftLoops needs all layers the same length')
  }
  const verts: number[] = []
  for (const layer of layers) {
    for (const v of layer) verts.push(v[0], v[1], v[2])
  }
  const indices: number[] = []
  for (let i = 0; i < L - 1; i++) {
    for (let j = 0; j < M; j++) {
      const j2 = (j + 1) % M
      const a = i * M + j
      const b = (i + 1) * M + j
      const c = (i + 1) * M + j2
      const d = i * M + j2
      indices.push(a, b, c, a, c, d)
    }
  }
  const capVertex = (cap: LoftCap, layer: Vec3[]): number => {
    const idx = verts.length / 3
    if (cap === 'fan') {
      let cx = 0, cy = 0, cz = 0
      for (const v of layer) {
        cx += v[0]
        cy += v[1]
        cz += v[2]
      }
      verts.push(cx / layer.length, cy / layer.length, cz / layer.length)
    } else {
      verts.push(cap[0], cap[1], cap[2])
    }
    return idx
  }
  // Layers wind CCW seen from above, matching the side quads. The bottom cap
  // must face down and the top cap up; both fans below are oriented to agree
  // with the walls so the whole solid has one consistent outward orientation.
  const bottomCenter = capVertex(bottom, layers[0])
  for (let j = 0; j < M; j++) {
    indices.push(bottomCenter, j, (j + 1) % M)
  }
  const topCenter = capVertex(top, layers[L - 1])
  const base = (L - 1) * M
  for (let j = 0; j < M; j++) {
    indices.push(topCenter, base + ((j + 1) % M), base + j)
  }
  return ensureOutward({
    positions: new Float32Array(verts),
    indices: new Uint32Array(indices),
  })
}

/** Solid cylinder along Y, base at y = 0 — used for ring sizer gauges. */
export function makeCylinder(radius: number, height: number, segments = 96): MeshData {
  if (!(radius > 0) || !(height > 0)) throw new Error('makeCylinder needs radius > 0 and height > 0')
  if (!Number.isInteger(segments) || segments < 3) throw new Error('makeCylinder needs ≥3 segments')
  const loopAt = (y: number): Vec3[] => {
    const pts: Vec3[] = []
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2
      pts.push([radius * Math.cos(a), y, radius * Math.sin(a)])
    }
    return pts
  }
  return loftLoops([loopAt(0), loopAt(height)], 'fan', 'fan')
}

/** Rescale a loop so its bounding box exactly fills [-L/2, L/2] × [-W/2, W/2]. */
export function normalizeLoop(loop: Loop2, length: number, width: number): Loop2 {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [x, y] of loop) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const sx = length / Math.max(maxX - minX, 1e-9)
  const sy = width / Math.max(maxY - minY, 1e-9)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return loop.map(([x, y]) => [(x - cx) * sx, (y - cy) * sy])
}
