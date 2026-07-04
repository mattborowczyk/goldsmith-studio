import type { MarginCurve, MeshData, Vec3 } from '../types'
import { traceBoundaryLoops, type BoundaryEdge } from './marginCurve'

/**
 * Curvature region-grow "magic wand" tooth pick (issue #48; research §4.2 + §4.5).
 *
 * Click a point on the scan → flood-fill faces outward from the picked face,
 * stopping where the surface folds inward past a threshold. The inter-tooth
 * grooves and the gingival margin are exactly such lines of concave curvature,
 * so the grow selects "that tooth" and the gum/neighbouring teeth fall outside
 * for free — gum exclusion is not a separate detector. The region boundary is
 * traced into editable `MarginCurve` loops for the drag-handle nudge (#49).
 *
 * Curvature is the discrete per-edge kind: the signed dihedral angle between
 * the two faces sharing an edge (positive = concave fold), the classic
 * interactive dental-CAD method — no ML. The gingival crease is the weakest
 * one on real scans, so a height-along-insertion-axis cue (the "gum guard")
 * tightens the threshold below the picked point; see `WandParams`. Best-effort
 * by design: ~90% auto + a manual nudge, not pixel-perfect segmentation.
 * Degenerate faces never block, non-manifold edges always do, and open chains
 * in the boundary are dropped — noisy scans yield a usable partial result
 * rather than an error.
 *
 * Pure TS — no three.js/DOM — with undercut.ts' chunked yield + cancel so it
 * stays interruptible in fit.worker.
 */

export interface WandProgress {
  onProgress?: (fraction: number) => void
  shouldCancel?: () => boolean
  /** Yield to the event loop every N items (0 = run straight through). */
  yieldEvery?: number
}

export interface WandParams {
  /** Picked point on/near the scan surface (scan space, mm). */
  seedPoint: Vec3
  /** Insertion axis (occlusal "up") — the height reference for the gum guard. */
  axis: Vec3
  /** Concave dihedral angle (radians) that stops the grow — the UI slider. */
  thresholdRad: number
  /** Drop below the seed (mm, along the axis) where the guard starts tightening. */
  guardStartMm?: number
  /** Drop (mm) where the guard bottoms out at `guardFactor` × threshold. */
  guardEndMm?: number
  /** Threshold multiplier at/below `guardEndMm` (0..1; 1 disables the guard). */
  guardFactor?: number
}

export interface WandResult {
  /** Selected region as triangle ids (into `indices`, per 3). */
  faces: Uint32Array
  /** Distinct vertex ids of the region faces — the selection-overlay/shell-clip set. */
  vertices: Uint32Array
  /** Region boundary loops as margin curves, largest first. Control-point
   * `face` anchors are **global** triangle ids (members of `faces`). */
  curves: MarginCurve[]
}

const CHUNK = 4096
/** Gum guard defaults: teeth are ~8–12 mm tall, so a crease a few mm below the
 * click is heading for the gingival margin — require less concavity there. */
const GUARD_START_MM = 2
const GUARD_END_MM = 6
const GUARD_FACTOR = 0.6

/**
 * Grow the picked tooth region and trace its margin. Returns null if cancelled;
 * an empty result for an empty mesh.
 */
export async function wandSelect(
  scan: MeshData, params: WandParams, opts: WandProgress = {},
): Promise<WandResult | null> {
  const { positions, indices } = scan
  const triCount = indices.length / 3
  const vertexCount = positions.length / 3
  if (triCount === 0 || vertexCount === 0) {
    opts.onProgress?.(1)
    return { faces: new Uint32Array(0), vertices: new Uint32Array(0), curves: [] }
  }

  const yieldEvery = opts.yieldEvery ?? CHUNK
  // coarse overall progress: three triangle passes + the seed's vertex scan
  const total = triCount * 3 + vertexCount
  let work = 0
  const pause = async (): Promise<boolean> => {
    opts.onProgress?.(Math.min(work / total, 1))
    await new Promise((r) => setTimeout(r, 0))
    return opts.shouldCancel?.() ?? false
  }

  // ---- unit face normals ----
  const normals = new Float32Array(triCount * 3)
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3
    const e1x = positions[b] - positions[a]
    const e1y = positions[b + 1] - positions[a + 1]
    const e1z = positions[b + 2] - positions[a + 2]
    const e2x = positions[c] - positions[a]
    const e2y = positions[c + 1] - positions[a + 1]
    const e2z = positions[c + 2] - positions[a + 2]
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) {
      normals[t * 3] = nx / len
      normals[t * 3 + 1] = ny / len
      normals[t * 3 + 2] = nz / len
    } // degenerate faces keep a zero normal → their edges read as flat, never blocking
    if (yieldEvery > 0 && ++work % yieldEvery === 0 && (await pause())) return null
  }

  // ---- adjacency + per-half-edge concavity ----
  // neighbor[t*3+e] = the face across edge e of face t (-1 boundary/non-manifold);
  // concavity[t*3+e] = the signed fold there, radians, >0 concave (same both sides).
  const neighbor = new Int32Array(triCount * 3).fill(-1)
  const concavity = new Float32Array(triCount * 3)
  const pending = new Map<number, number>() // packed undirected edge → half-edge id
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const h = t * 3 + e
      const u = indices[h]
      const v = indices[t * 3 + ((e + 1) % 3)]
      const key = u < v ? u * vertexCount + v : v * vertexCount + u
      const other = pending.get(key)
      if (other === undefined) {
        pending.set(key, h)
        continue
      }
      // pair up; a 3rd use of the edge (non-manifold) re-opens it and any
      // extra halves stay boundary (-1) — the grow just stops there
      pending.delete(key)
      const ta = (other / 3) | 0
      neighbor[other] = t
      neighbor[h] = ta
      // signed dihedral about the edge as face `ta` directs it (u2→v2):
      // θ = atan2((nA×nB)·ê, nA·nB), θ>0 convex — concavity is −θ
      const u2 = indices[other] * 3
      const v2 = indices[ta * 3 + (((other % 3) + 1) % 3)] * 3
      let ex = positions[v2] - positions[u2]
      let ey = positions[v2 + 1] - positions[u2 + 1]
      let ez = positions[v2 + 2] - positions[u2 + 2]
      const elen = Math.hypot(ex, ey, ez)
      if (elen > 0) {
        ex /= elen; ey /= elen; ez /= elen
        const nax = normals[ta * 3], nay = normals[ta * 3 + 1], naz = normals[ta * 3 + 2]
        const nbx = normals[t * 3], nby = normals[t * 3 + 1], nbz = normals[t * 3 + 2]
        const cx = nay * nbz - naz * nby
        const cy = naz * nbx - nax * nbz
        const cz = nax * nby - nay * nbx
        const theta = Math.atan2(cx * ex + cy * ey + cz * ez, nax * nbx + nay * nby + naz * nbz)
        concavity[other] = -theta
        concavity[h] = -theta
      }
    }
    if (yieldEvery > 0 && ++work % yieldEvery === 0 && (await pause())) return null
  }

  // ---- seed face: nearest vertex to the pick, then its closest incident face ----
  const [sx, sy, sz] = params.seedPoint
  let seedVertex = 0
  let bestD = Infinity
  for (let v = 0; v < vertexCount; v++) {
    const dx = positions[v * 3] - sx
    const dy = positions[v * 3 + 1] - sy
    const dz = positions[v * 3 + 2] - sz
    const d = dx * dx + dy * dy + dz * dz
    if (d < bestD) { bestD = d; seedVertex = v }
    if (yieldEvery > 0 && ++work % yieldEvery === 0 && (await pause())) return null
  }
  let seedFace = -1
  bestD = Infinity
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2]
    if (i0 !== seedVertex && i1 !== seedVertex && i2 !== seedVertex) continue
    const cx = (positions[i0 * 3] + positions[i1 * 3] + positions[i2 * 3]) / 3 - sx
    const cy = (positions[i0 * 3 + 1] + positions[i1 * 3 + 1] + positions[i2 * 3 + 1]) / 3 - sy
    const cz = (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3 - sz
    const d = cx * cx + cy * cy + cz * cz
    if (d < bestD) { bestD = d; seedFace = t }
  }
  if (seedFace < 0) {
    // the nearest vertex is dangling (referenced by no face) — nothing to grow
    opts.onProgress?.(1)
    return { faces: new Uint32Array(0), vertices: new Uint32Array(0), curves: [] }
  }

  // ---- gum guard setup ----
  const alen = Math.hypot(params.axis[0], params.axis[1], params.axis[2])
  const ax = alen > 1e-9 ? params.axis[0] / alen : 0
  const ay = alen > 1e-9 ? params.axis[1] / alen : 1
  const az = alen > 1e-9 ? params.axis[2] / alen : 0
  const seedH = ax * sx + ay * sy + az * sz
  const gStart = params.guardStartMm ?? GUARD_START_MM
  const gEnd = Math.max(params.guardEndMm ?? GUARD_END_MM, gStart + 1e-6)
  const gFactor = Math.min(Math.max(params.guardFactor ?? GUARD_FACTOR, 0), 1)
  const threshold = params.thresholdRad

  /** Threshold at half-edge `h` of face `t`: full at/above the seed, easing down
   * to `gFactor`× below it, so the softer gingival crease still stops the grow. */
  const effThreshold = (t: number, h: number): number => {
    const u = indices[h] * 3
    const v = indices[t * 3 + (((h % 3) + 1) % 3)] * 3
    const hm =
      (ax * (positions[u] + positions[v]) +
        ay * (positions[u + 1] + positions[v + 1]) +
        az * (positions[u + 2] + positions[v + 2])) / 2
    const drop = seedH - hm
    if (drop <= gStart) return threshold
    if (drop >= gEnd) return threshold * gFactor
    return threshold * (1 + ((gFactor - 1) * (drop - gStart)) / (gEnd - gStart))
  }

  // ---- region grow: flood fill, stopping at concave creases ----
  const inRegion = new Uint8Array(triCount)
  const stack: number[] = [seedFace]
  inRegion[seedFace] = 1
  let regionCount = 1
  while (stack.length > 0) {
    const t = stack.pop()!
    for (let e = 0; e < 3; e++) {
      const h = t * 3 + e
      const nf = neighbor[h]
      if (nf < 0 || inRegion[nf]) continue
      if (concavity[h] >= effThreshold(t, h)) continue // crease — the margin lands here
      inRegion[nf] = 1
      regionCount++
      stack.push(nf)
    }
    if (yieldEvery > 0 && ++work % yieldEvery === 0 && (await pause())) return null
  }

  // ---- collect the region + trace its boundary loops ----
  const faces = new Uint32Array(regionCount)
  const vertexFlags = new Uint8Array(vertexCount)
  const edges: BoundaryEdge[] = []
  let fi = 0
  for (let t = 0; t < triCount; t++) {
    if (!inRegion[t]) continue
    faces[fi++] = t
    for (let e = 0; e < 3; e++) {
      const h = t * 3 + e
      vertexFlags[indices[h]] = 1
      const nf = neighbor[h]
      if (nf < 0 || !inRegion[nf]) {
        edges.push({ u: indices[h], v: indices[t * 3 + ((e + 1) % 3)], face: t })
      }
    }
  }
  let vertexTotal = 0
  for (let v = 0; v < vertexCount; v++) vertexTotal += vertexFlags[v]
  const vertices = new Uint32Array(vertexTotal)
  for (let v = 0, vi = 0; v < vertexCount; v++) {
    if (vertexFlags[v]) vertices[vi++] = v
  }

  const curves = traceBoundaryLoops(positions, edges)
  opts.onProgress?.(1)
  return { faces, vertices, curves }
}
