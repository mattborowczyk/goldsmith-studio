import type { MeshData, SectionAxis, Vec3 } from '../types'
import { analyzeTopology } from './meshAnalysis'
import { fixWinding, removeDegenerateTriangles, weldVertices } from './meshRepair'

/**
 * Planar base cap ("create model base") for open scans — issue #26.
 *
 * Good intraoral scans often arrive as an open shell: the whole occlusal side
 * is missing, leaving one huge non-planar boundary loop that the fan-based
 * hole-fill cannot close. This module closes that opening the way dental
 * slicers do: extrude the rim to a flat plane (a "skirt"), triangulate the
 * flat polygon via ear clipping, and weld/orient the result watertight.
 *
 * Pure TS — no three.js/DOM — so it runs in the repair worker and in vitest.
 */

export const AXIS_INDEX: Record<SectionAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 }

export interface BaseCapOptions {
  /** Cap-plane normal axis. */
  axis: SectionAxis
  /** Plane coordinate along that axis (mm, mesh space). Must sit past the rim. */
  position: number
}

/** Everything the UI needs to pick a default axis/side and a slider range. */
export interface RimSummary {
  /** Edge count of the largest open boundary loop. */
  loopEdges: number
  /** Total open boundary loops on the mesh (small ones are left to hole-fill). */
  loopCount: number
  rimMin: Vec3
  rimMax: Vec3
  rimCentroid: Vec3
  meshMin: Vec3
  meshMax: Vec3
  meshCentroid: Vec3
}

interface RimLoop {
  /** Ordered vertex indices, walked in the direction the faces traverse them. */
  loop: number[]
  loopCount: number
}

/** Walk all closed boundary loops and return the one with the longest perimeter. */
export function findLargestOpenRim(mesh: MeshData): RimLoop | null {
  const { boundaryNext } = analyzeTopology(mesh)
  if (boundaryNext.size === 0) return null

  const { positions } = mesh
  const visited = new Set<number>()
  let best: number[] | null = null
  let bestPerimeter = -1
  let loopCount = 0

  for (const start of boundaryNext.keys()) {
    if (visited.has(start)) continue
    const loop: number[] = []
    let v: number | undefined = start
    let guard = boundaryNext.size + 1
    while (v !== undefined && !visited.has(v) && guard-- > 0) {
      visited.add(v)
      loop.push(v)
      v = boundaryNext.get(v)
    }
    if (v !== start || loop.length < 3) continue // open chain / degenerate — skip
    loopCount++
    let perimeter = 0
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]
      const b = loop[(i + 1) % loop.length]
      const dx = positions[b * 3] - positions[a * 3]
      const dy = positions[b * 3 + 1] - positions[a * 3 + 1]
      const dz = positions[b * 3 + 2] - positions[a * 3 + 2]
      perimeter += Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
    if (perimeter > bestPerimeter) {
      bestPerimeter = perimeter
      best = loop
    }
  }
  return best ? { loop: best, loopCount } : null
}

/** Rim + mesh bounds/centroids for the largest open loop, or null when closed. */
export function summarizeOpenRim(mesh: MeshData): RimSummary | null {
  const rim = findLargestOpenRim(mesh)
  if (!rim) return null
  const { positions } = mesh

  const rimMin: Vec3 = [Infinity, Infinity, Infinity]
  const rimMax: Vec3 = [-Infinity, -Infinity, -Infinity]
  const rimCentroid: Vec3 = [0, 0, 0]
  for (const p of rim.loop) {
    for (let k = 0; k < 3; k++) {
      const c = positions[p * 3 + k]
      if (c < rimMin[k]) rimMin[k] = c
      if (c > rimMax[k]) rimMax[k] = c
      rimCentroid[k] += c / rim.loop.length
    }
  }

  const n = positions.length / 3
  const meshMin: Vec3 = [Infinity, Infinity, Infinity]
  const meshMax: Vec3 = [-Infinity, -Infinity, -Infinity]
  const meshCentroid: Vec3 = [0, 0, 0]
  for (let v = 0; v < n; v++) {
    for (let k = 0; k < 3; k++) {
      const c = positions[v * 3 + k]
      if (c < meshMin[k]) meshMin[k] = c
      if (c > meshMax[k]) meshMax[k] = c
      meshCentroid[k] += c / n
    }
  }

  return {
    loopEdges: rim.loop.length,
    loopCount: rim.loopCount,
    rimMin,
    rimMax,
    rimCentroid,
    meshMin,
    meshMax,
    meshCentroid,
  }
}

/**
 * Ear-clip a simple 2D polygon (any orientation). Returns index triples into
 * `pts`, each emitted as (prev, cur, next) in list order, so perimeter edges
 * are traversed in polygon order. Falls back to a fan on a degenerate
 * remainder so it always terminates with n−2 triangles.
 */
export function earClipPolygon(pts: Array<[number, number]>): number[] {
  const n = pts.length
  if (n < 3) return []

  let area2 = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % n]
    area2 += x0 * y1 - x1 * y0
    if (x0 < minX) minX = x0
    if (x0 > maxX) maxX = x0
    if (y0 < minY) minY = y0
    if (y0 > maxY) maxY = y0
  }
  const diag = Math.hypot(maxX - minX, maxY - minY)
  const sign = area2 >= 0 ? 1 : -1
  const epsArea = Math.max(diag * diag * 1e-12, 1e-30)

  const cross = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  // inside-or-on-boundary blocks an ear: a vertex sitting exactly on the ear's
  // diagonal would otherwise end up under an overlapping triangle
  const contains = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]) =>
    cross(a, b, p) * sign >= -epsArea &&
    cross(b, c, p) * sign >= -epsArea &&
    cross(c, a, p) * sign >= -epsArea

  const idx: number[] = Array.from({ length: n }, (_, i) => i)
  const out: number[] = []

  while (idx.length > 3) {
    let clipped = false
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length]
      const ib = idx[i]
      const ic = idx[(i + 1) % idx.length]
      if (cross(pts[ia], pts[ib], pts[ic]) * sign <= epsArea) continue // reflex/flat
      let blocked = false
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue
        if (contains(pts[j], pts[ia], pts[ib], pts[ic])) {
          blocked = true
          break
        }
      }
      if (blocked) continue
      out.push(ia, ib, ic)
      idx.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) {
      // self-intersecting or fully degenerate remainder — fan and finish
      for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1])
      return out
    }
  }
  out.push(idx[0], idx[1], idx[2])
  return out
}

/**
 * Close the largest open boundary loop with a flat base at `position` along
 * `axis`: extrude the rim to the plane (skirt), ear-clip the flat polygon,
 * then weld + fix winding. The plane should sit just past the open rim —
 * geometry between the rim and the plane becomes part of the solid base.
 *
 * Throws when the mesh has no closed boundary loop to cap.
 */
export function closeOpenBase(mesh: MeshData, opts: BaseCapOptions): MeshData {
  const rim = findLargestOpenRim(mesh)
  if (!rim) throw new Error('No open rim found — the mesh has no large boundary loop to cap.')
  const { loop } = rim
  const ai = AXIS_INDEX[opts.axis]
  const u = (ai + 1) % 3
  const v = (ai + 2) % 3

  const positions: number[] = Array.from(mesh.positions)
  const indices: number[] = Array.from(mesh.indices)

  // rim vertex → its projection on the cap plane (same u/v, axis coord = position)
  const proj = new Map<number, number>()
  for (const p of loop) {
    const ni = positions.length / 3
    const x = mesh.positions[p * 3]
    const y = mesh.positions[p * 3 + 1]
    const z = mesh.positions[p * 3 + 2]
    positions.push(ai === 0 ? opts.position : x, ai === 1 ? opts.position : y, ai === 2 ? opts.position : z)
    proj.set(p, ni)
  }

  // Skirt: each boundary edge a→b is traversed once by existing faces, so the
  // skirt quad must traverse it as b→a to keep winding coherent (same rule as
  // fillHoles). Bottom edge lands as a′→b′ in loop order.
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    const a2 = proj.get(a)!
    const b2 = proj.get(b)!
    indices.push(b, a, a2)
    indices.push(b, a2, b2)
  }

  // Flat cap: ear-clip the rim projected to the plane's 2D coords. Consecutive
  // rim vertices that project together (near-vertical rim segments) are deduped
  // so they can't produce zero-area ears.
  const capPts: Array<[number, number]> = []
  const capVerts: number[] = []
  let rimSpan = 0
  for (const p of loop) {
    const pu = mesh.positions[p * 3 + u]
    const pv = mesh.positions[p * 3 + v]
    rimSpan = Math.max(rimSpan, Math.abs(pu), Math.abs(pv))
  }
  const dedupeEps = Math.max(rimSpan * 1e-7, 1e-9)
  for (const p of loop) {
    const pu = mesh.positions[p * 3 + u]
    const pv = mesh.positions[p * 3 + v]
    const prev = capPts[capPts.length - 1]
    if (prev && Math.hypot(prev[0] - pu, prev[1] - pv) < dedupeEps) continue
    capPts.push([pu, pv])
    capVerts.push(proj.get(p)!)
  }
  while (
    capPts.length > 3 &&
    Math.hypot(capPts[0][0] - capPts[capPts.length - 1][0], capPts[0][1] - capPts[capPts.length - 1][1]) < dedupeEps
  ) {
    capPts.pop()
    capVerts.pop()
  }
  // Cap triangles must traverse the skirt's bottom edges opposite (b′→a′), so
  // flip each ear-clip triangle (which follows loop order on the perimeter).
  const tris = earClipPolygon(capPts)
  for (let t = 0; t < tris.length; t += 3) {
    indices.push(capVerts[tris[t]], capVerts[tris[t + 2]], capVerts[tris[t + 1]])
  }

  let out: MeshData = {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  }
  out = weldVertices(out, 1e-4)
  out = removeDegenerateTriangles(out)
  out = fixWinding(out)
  return out
}
