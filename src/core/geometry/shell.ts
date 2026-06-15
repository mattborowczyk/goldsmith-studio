import type { MeshData, Vec3 } from '../types'
import { computeShells, shellVolumes } from './meshAnalysis'

/**
 * Brush-selection → closed "selection prism" (plan §3.3). The surface brush paints
 * a set of scan vertices; the shell generator restricts itself to that region by
 * intersecting the finished shell with the solid built here.
 *
 * The prism is the sub-patch of `scan` whose triangles are fully selected,
 * duplicated onto two planes perpendicular to the insertion `axis` — `cap` above
 * the highest selected point and `cap` below the scan's own base — with side walls
 * along the patch boundary. So its silhouette (looking down the axis) follows the
 * brushed teeth and it spans the full shell thickness; `shell ∩ prism` keeps the
 * shell over those teeth with a clean vertical cut at the selection edge.
 *
 * Pure TS / DOM-light so it runs in fit.worker; the result is heal-guarded
 * (toManifold) before the boolean, so the cap/wall winding need only be a closed
 * 2-manifold, not pre-oriented. Returns null when no triangle is fully selected.
 */
export function buildSelectionPrism(
  scan: MeshData, selected: Set<number>, axis: Vec3, cap: number,
): MeshData | null {
  const { positions, indices } = scan
  const a = unit(axis)
  const dot = (i: number) => positions[i] * a[0] + positions[i + 1] * a[1] + positions[i + 2] * a[2]

  // selected faces: all three vertices brushed (a tight region matching the paint)
  const faces: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2]
    if (selected.has(i0) && selected.has(i1) && selected.has(i2)) faces.push(i0, i1, i2)
  }
  if (faces.length === 0) return null

  // the two cap planes: above the highest selected point, below the scan's base
  let selHi = -Infinity
  for (let f = 0; f < faces.length; f++) {
    const d = dot(faces[f] * 3)
    if (d > selHi) selHi = d
  }
  let scanLo = Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const d = dot(i)
    if (d < scanLo) scanLo = d
  }
  const topPlane = selHi + cap
  const botPlane = scanLo - cap

  // compact the used vertices → local indices; emit a top copy then a bottom copy
  const local = new Map<number, number>()
  const order: number[] = []
  for (let f = 0; f < faces.length; f++) {
    const v = faces[f]
    if (!local.has(v)) { local.set(v, order.length); order.push(v) }
  }
  const n = order.length
  const verts = new Float32Array(n * 2 * 3)
  const project = (v: number, plane: number, base: number) => {
    const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2]
    const k = plane - (px * a[0] + py * a[1] + pz * a[2])
    verts[base] = px + a[0] * k
    verts[base + 1] = py + a[1] * k
    verts[base + 2] = pz + a[2] * k
  }
  for (let i = 0; i < n; i++) {
    project(order[i], topPlane, i * 3)
    project(order[i], botPlane, (n + i) * 3)
  }
  const top = (v: number) => local.get(v)!
  const bot = (v: number) => n + local.get(v)!

  const tris: number[] = []
  // top cap (patch winding) + bottom cap (reversed); heal re-orients either way
  for (let f = 0; f < faces.length; f += 3) {
    const a0 = faces[f], a1 = faces[f + 1], a2 = faces[f + 2]
    tris.push(top(a0), top(a1), top(a2))
    tris.push(bot(a0), bot(a2), bot(a1))
  }
  // side walls along boundary edges (those used by exactly one selected face)
  const N = positions.length / 3
  const edgeKey = (u: number, w: number) => (u < w ? u * N + w : w * N + u)
  const edges = new Map<number, { u: number; w: number; count: number }>()
  for (let f = 0; f < faces.length; f += 3) {
    const tri = [faces[f], faces[f + 1], faces[f + 2]]
    for (let e = 0; e < 3; e++) {
      const u = tri[e], w = tri[(e + 1) % 3]
      const k = edgeKey(u, w)
      const rec = edges.get(k)
      if (rec) rec.count++
      else edges.set(k, { u, w, count: 1 })
    }
  }
  for (const { u, w, count } of edges.values()) {
    if (count !== 1) continue
    tris.push(top(u), top(w), bot(w))
    tris.push(top(u), bot(w), bot(u))
  }
  return { positions: verts, indices: new Uint32Array(tris) }
}

function unit(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 1, 0]
}

/**
 * Per-tooth shell volumes (plan §3.3): split the shell into spatially-separated
 * pieces and net the wall volume of each, mm³, descending.
 *
 * A hollow shell is two disconnected surfaces (an outer + an inner cavity), so
 * connected components over-count; we group components whose axis-aligned bounds
 * overlap (the inner sits inside its outer) and sum their *signed* volumes per
 * group — the cavity's negative volume cancels into the wall. A joined arch is one
 * group → one figure; separate (e.g. brushed) teeth split out. Near-zero groups are
 * dropped. Used for the 6- vs 8-tooth pricing estimate.
 */
export function perToothVolumes(mesh: MeshData): number[] {
  const { positions, indices } = mesh
  const { shellOfTri, shellCount } = computeShells(mesh)
  if (shellCount === 0) return []
  const signed = shellVolumes(mesh, shellOfTri, shellCount)

  // per-component axis-aligned bounds
  const lo = new Array<Vec3>(shellCount)
  const hi = new Array<Vec3>(shellCount)
  for (let s = 0; s < shellCount; s++) {
    lo[s] = [Infinity, Infinity, Infinity]
    hi[s] = [-Infinity, -Infinity, -Infinity]
  }
  for (let t = 0; t < shellOfTri.length; t++) {
    const s = shellOfTri[t]
    for (let e = 0; e < 3; e++) {
      const v = indices[t * 3 + e] * 3
      for (let k = 0; k < 3; k++) {
        if (positions[v + k] < lo[s][k]) lo[s][k] = positions[v + k]
        if (positions[v + k] > hi[s][k]) hi[s][k] = positions[v + k]
      }
    }
  }

  // union components with overlapping bounds (an inner cavity nests in its outer)
  const parent = new Int32Array(shellCount)
  for (let s = 0; s < shellCount; s++) parent[s] = s
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  const overlap = (a: number, b: number) =>
    lo[a][0] <= hi[b][0] && hi[a][0] >= lo[b][0] &&
    lo[a][1] <= hi[b][1] && hi[a][1] >= lo[b][1] &&
    lo[a][2] <= hi[b][2] && hi[a][2] >= lo[b][2]
  for (let a = 0; a < shellCount; a++) {
    for (let b = a + 1; b < shellCount; b++) {
      if (overlap(a, b)) parent[find(a)] = find(b)
    }
  }

  const groups = new Map<number, number>()
  for (let s = 0; s < shellCount; s++) {
    const r = find(s)
    groups.set(r, (groups.get(r) ?? 0) + signed[s])
  }
  return [...groups.values()]
    .map(Math.abs)
    .filter((v) => v > 1e-6)
    .sort((x, y) => y - x)
}
