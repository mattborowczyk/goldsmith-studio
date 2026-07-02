import type { MarginControlPoint, MarginCurve, MeshData, Vec3 } from '../types'
import { unit } from './vec'

/**
 * Margin-curve conversions (issue #47): the bridge between the brush/wand's
 * flat vertex `Set` and the editable closed curve the drag-handle UI and the
 * shell clip work with.
 *
 * - selection (vertex set) → boundary loops → `MarginCurve[]`
 * - `MarginCurve` → enclosed face set (point-in-projected-polygon)
 *
 * Pure TS — no three.js/DOM — so it runs in fit.worker and in vitest.
 */

/** Faces (flat vertex triples) whose three corners are all selected — the same
 * region rule the brush path uses in `buildSelectionPrism`. */
export function fullySelectedFaces(mesh: MeshData, selected: Set<number>): number[] {
  const { indices } = mesh
  const faces: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2]
    if (selected.has(i0) && selected.has(i1) && selected.has(i2)) faces.push(i0, i1, i2)
  }
  return faces
}

/**
 * Trace the boundary of the fully-selected face region into closed margin
 * curves, one per boundary loop (a selection spanning two teeth yields two),
 * largest first. Each control point is bound to its scan vertex and to the
 * selected face that touches the boundary there, so later edits can re-project.
 *
 * Loops are walked in the direction the selected faces traverse them, i.e.
 * counter-clockwise around the region as seen from outside the surface.
 */
export function marginCurvesFromSelection(scan: MeshData, selected: Set<number>): MarginCurve[] {
  const faces = fullySelectedFaces(scan, selected)
  if (faces.length === 0) return []
  const { positions } = scan
  const N = positions.length / 3

  // undirected edge use-count over the selected region
  const key = (u: number, w: number) => (u < w ? u * N + w : w * N + u)
  const counts = new Map<number, number>()
  for (let f = 0; f < faces.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      const u = faces[f + e]
      const w = faces[f + ((e + 1) % 3)]
      const k = key(u, w)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }

  // directed boundary edges (used by exactly one selected face) + their face.
  // A vertex can start SEVERAL boundary edges (a pinch — two regions or an
  // hourglass region sharing one vertex), so successors are lists and loops
  // are walked per directed edge, consuming each edge exactly once.
  const outEdges = new Map<number, { w: number; face: number; used: boolean }[]>()
  let edgeCount = 0
  for (let f = 0; f < faces.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      const u = faces[f + e]
      const w = faces[f + ((e + 1) % 3)]
      if (counts.get(key(u, w)) === 1) {
        let list = outEdges.get(u)
        if (!list) outEdges.set(u, (list = []))
        list.push({ w, face: f / 3, used: false })
        edgeCount++
      }
    }
  }

  const curves: MarginCurve[] = []
  for (const [start, list] of outEdges) {
    for (const first of list) {
      if (first.used) continue
      const loop: number[] = []
      const faceAlong: number[] = []
      let u = start
      let edge: { w: number; face: number; used: boolean } | undefined = first
      let guard = edgeCount + 1
      while (edge && !edge.used && guard-- > 0) {
        edge.used = true
        loop.push(u)
        faceAlong.push(edge.face)
        u = edge.w
        if (u === start) break // closed
        edge = outEdges.get(u)?.find((e) => !e.used)
      }
      if (u !== start || loop.length < 3) continue // open chain (non-manifold) — skip
      const points: MarginControlPoint[] = loop.map((vertex, i) => ({
        position: [
          positions[vertex * 3],
          positions[vertex * 3 + 1],
          positions[vertex * 3 + 2],
        ] as Vec3,
        vertex,
        face: faceAlong[i],
      }))
      curves.push({ points })
    }
  }
  return curves.sort((a, b) => b.points.length - a.points.length)
}

/**
 * Faces of `scan` enclosed by the margin curve: triangles that face the
 * insertion `axis` (normal·axis > 0 — the crown side the margin traces) and
 * whose centroid, projected along the axis, lands inside the projected curve
 * polygon. The inverse of `marginCurvesFromSelection`: on a clean patch,
 * feeding its boundary curve back returns the original face region.
 *
 * Returns triangle indices (into `indices`, per 3).
 */
export function enclosedFaceSet(scan: MeshData, curve: MarginCurve, axis: Vec3): Set<number> {
  const out = new Set<number>()
  const pts = curve.points
  if (pts.length < 3) return out
  const a = unit(axis)
  const [bu, bv] = planeBasis(a)

  // projected curve polygon + its bbox for a cheap reject
  const poly = new Float64Array(pts.length * 2)
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i].position
    const u = p[0] * bu[0] + p[1] * bu[1] + p[2] * bu[2]
    const v = p[0] * bv[0] + p[1] * bv[1] + p[2] * bv[2]
    poly[i * 2] = u
    poly[i * 2 + 1] = v
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }

  const { positions, indices } = scan
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t] * 3, i1 = indices[t + 1] * 3, i2 = indices[t + 2] * 3
    // face the axis: the margin encloses the crown surface, not the far side
    const e1x = positions[i1] - positions[i0]
    const e1y = positions[i1 + 1] - positions[i0 + 1]
    const e1z = positions[i1 + 2] - positions[i0 + 2]
    const e2x = positions[i2] - positions[i0]
    const e2y = positions[i2 + 1] - positions[i0 + 1]
    const e2z = positions[i2 + 2] - positions[i0 + 2]
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    if (nx * a[0] + ny * a[1] + nz * a[2] <= 0) continue

    const cx = (positions[i0] + positions[i1] + positions[i2]) / 3
    const cy = (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3
    const cz = (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3
    const cu = cx * bu[0] + cy * bu[1] + cz * bu[2]
    const cv = cx * bv[0] + cy * bv[1] + cz * bv[2]
    if (cu < minU || cu > maxU || cv < minV || cv > maxV) continue
    if (pointInPolygon(cu, cv, poly)) out.add(t / 3)
  }
  return out
}

/** Even-odd (ray-crossing) point-in-polygon; either winding, concave OK. */
function pointInPolygon(px: number, py: number, poly: Float64Array): boolean {
  const n = poly.length / 2
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1]
    const xj = poly[j * 2], yj = poly[j * 2 + 1]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Two unit vectors spanning the plane perpendicular to `a` (unit). */
function planeBasis(a: Vec3): [Vec3, Vec3] {
  const t: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = unit([
    a[1] * t[2] - a[2] * t[1],
    a[2] * t[0] - a[0] * t[2],
    a[0] * t[1] - a[1] * t[0],
  ])
  const v: Vec3 = [
    a[1] * u[2] - a[2] * u[1],
    a[2] * u[0] - a[0] * u[2],
    a[0] * u[1] - a[1] * u[0],
  ]
  return [u, v]
}
