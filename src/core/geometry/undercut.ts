import type { MeshData, Vec3 } from '../types'
import { buildBVH, raycastNearest, type BVH } from './bvh'

/**
 * Grillz/dental undercut survey (plan §3.2, the slice-2 headline). For a chosen
 * insertion (path-of-withdrawal) axis we ask, per scan vertex: travelling along
 * the axis, does the model block the point? A ray cast from the vertex along the
 * +axis that re-hits the surface means there's material overhanging it — the
 * point is occluded, i.e. undercut, and the appliance can't draw off there. This
 * is the classic dental "survey": colour the surface red/amber below the
 * height-of-contour, neutral above it.
 *
 * Pure TS / DOM-light so it runs in fit.worker; the ray query reuses the in-house
 * BVH (bvh.ts), three-free per the core/geometry rule. Mirrors thickness.ts'
 * inward-ray machinery (just a global direction here) and its chunked yield +
 * cancel so the worker stays interruptible.
 */

export interface SurveyField {
  /** Per source-vertex undercut value: 0 = clear, 0<v≤1 = undercut severity. */
  values: Float32Array
  /** Total undercut surface area (mm²) — the survey metric (plan §3.2 / Q7). */
  area: number
}

export interface SurveyProgress {
  onProgress?: (fraction: number) => void
  shouldCancel?: () => boolean
  /** Yield to the event loop every N vertices (0 = run straight through). */
  yieldEvery?: number
}

export interface BestAxisProgress {
  onProgress?: (fraction: number) => void
  shouldCancel?: () => boolean
}

export interface BestAxisResult {
  /** Insertion axis minimising undercut area, normalised. */
  axis: Vec3
}

const CHUNK = 2048
/** Occluded vertices paint at least this much amber, so the height-of-contour reads. */
const AMBER_FLOOR = 0.2
/** Best-axis search: candidates in a cone around the seed, then a local refine. */
const CONE_DEG = 45
const CONE_N = 64
const REFINE_DEG = 10
const REFINE_N = 16
/** Cap the origin points scored per candidate axis — the metric is subsampled. */
const SAMPLE_TARGET = 4096
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/** Area-weighted vertex normals (outward, assuming CCW winding). */
function vertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const e1x = positions[b] - positions[a]
    const e1y = positions[b + 1] - positions[a + 1]
    const e1z = positions[b + 2] - positions[a + 2]
    const e2x = positions[c] - positions[a]
    const e2y = positions[c + 1] - positions[a + 1]
    const e2z = positions[c + 2] - positions[a + 2]
    // face normal, length ∝ 2× area → an area weighting for the accumulation
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2])
    if (len > 0) { normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len }
  }
  return normals
}

/** Per-vertex surface area: ⅓ of each incident triangle's area (mm²). */
function vertexAreas(positions: Float32Array, indices: Uint32Array): Float32Array {
  const areas = new Float32Array(positions.length / 3)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2]
    const e1x = positions[b * 3] - positions[a * 3]
    const e1y = positions[b * 3 + 1] - positions[a * 3 + 1]
    const e1z = positions[b * 3 + 2] - positions[a * 3 + 2]
    const e2x = positions[c * 3] - positions[a * 3]
    const e2y = positions[c * 3 + 1] - positions[a * 3 + 1]
    const e2z = positions[c * 3 + 2] - positions[a * 3 + 2]
    const cx = e1y * e2z - e1z * e2y
    const cy = e1z * e2x - e1x * e2z
    const cz = e1x * e2y - e1y * e2x
    const third = Math.hypot(cx, cy, cz) / 6 // |cross| = 2·area, /2 then /3
    areas[a] += third; areas[b] += third; areas[c] += third
  }
  return areas
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 1, 0]
}

/** Bounding-box diagonal — scales the self-hit epsilon to any model size. */
function diagonal(positions: Float32Array): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i]
    if (positions[i + 1] < minY) minY = positions[i + 1]
    if (positions[i + 2] < minZ) minZ = positions[i + 2]
    if (positions[i] > maxX) maxX = positions[i]
    if (positions[i + 1] > maxY) maxY = positions[i + 1]
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2]
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1
}

/**
 * Default insertion axis: the area-weighted average of the scan's outward face
 * normals (plan §3.2 / Q3) — the dominant "occlusal" direction. Tessellation-
 * independent because each face is weighted by its own area. Falls back to +Y.
 */
export function defaultInsertionAxis(scan: MeshData): Vec3 {
  const { positions, indices } = scan
  let nx = 0, ny = 0, nz = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const e1x = positions[b] - positions[a]
    const e1y = positions[b + 1] - positions[a + 1]
    const e1z = positions[b + 2] - positions[a + 2]
    const e2x = positions[c] - positions[a]
    const e2y = positions[c + 1] - positions[a + 1]
    const e2z = positions[c + 2] - positions[a + 2]
    nx += e1y * e2z - e1z * e2y
    ny += e1z * e2x - e1x * e2z
    nz += e1x * e2y - e1y * e2x
  }
  return normalize([nx, ny, nz])
}

/** True when a ray from `(px,py,pz)` along `+axis` re-hits the model (occluded). */
function occluded(
  bvh: BVH, positions: Float32Array, indices: Uint32Array,
  px: number, py: number, pz: number, ax: number, ay: number, az: number, eps: number,
): boolean {
  // nudge the origin a hair along the axis so the ray clears the start face
  const t = raycastNearest(
    bvh, positions, indices,
    px + ax * eps, py + ay * eps, pz + az * eps, ax, ay, az, eps,
  )
  return Number.isFinite(t)
}

/**
 * Survey every scan vertex against the insertion `axis`. A vertex is undercut
 * when a ray along +axis re-hits the model; its value blends the back-draft
 * severity (−normal·axis) with a floor so any undercut still paints amber, deeper
 * undercuts redder. `area` sums the per-vertex area weights of undercut vertices.
 * Returns null if cancelled; an empty field for empty input.
 */
export async function surveyUndercut(
  scan: MeshData, axis: Vec3, opts: SurveyProgress = {},
): Promise<SurveyField | null> {
  const { positions, indices } = scan
  const vertexCount = positions.length / 3
  const values = new Float32Array(vertexCount)
  if (vertexCount === 0 || indices.length === 0) return { values, area: 0 }

  const [ax, ay, az] = normalize(axis)
  const normals = vertexNormals(positions, indices)
  const areas = vertexAreas(positions, indices)
  const bvh = buildBVH(positions, indices)
  const eps = diagonal(positions) * 1e-5
  const yieldEvery = opts.yieldEvery ?? CHUNK
  let area = 0

  for (let v = 0; v < vertexCount; v++) {
    const p = v * 3
    if (occluded(bvh, positions, indices, positions[p], positions[p + 1], positions[p + 2], ax, ay, az, eps)) {
      const draft = -(normals[p] * ax + normals[p + 1] * ay + normals[p + 2] * az)
      const sev = Math.min(Math.max(draft, 0), 1)
      values[v] = Math.max(sev, AMBER_FLOOR)
      area += areas[v]
    }

    if (yieldEvery > 0 && (v + 1) % yieldEvery === 0) {
      opts.onProgress?.((v + 1) / vertexCount)
      await new Promise((r) => setTimeout(r, 0))
      if (opts.shouldCancel?.()) return null
    }
  }
  opts.onProgress?.(1)
  return { values, area }
}

/** Strided, area-weighted subsample of vertex indices for the best-axis metric. */
function subsample(vertexCount: number): Int32Array {
  if (vertexCount <= SAMPLE_TARGET) {
    const all = new Int32Array(vertexCount)
    for (let i = 0; i < vertexCount; i++) all[i] = i
    return all
  }
  const stride = Math.ceil(vertexCount / SAMPLE_TARGET)
  const out = new Int32Array(Math.ceil(vertexCount / stride))
  for (let i = 0, j = 0; i < vertexCount; i += stride) out[j++] = i
  return out
}

/** Sum of area weights of sampled vertices occluded along `axis` (relative metric). */
function sampledUndercutArea(
  bvh: BVH, positions: Float32Array, indices: Uint32Array,
  sample: Int32Array, areas: Float32Array, axis: Vec3, eps: number,
): number {
  const [ax, ay, az] = axis
  let area = 0
  for (let i = 0; i < sample.length; i++) {
    const v = sample[i]
    const p = v * 3
    if (occluded(bvh, positions, indices, positions[p], positions[p + 1], positions[p + 2], ax, ay, az, eps)) {
      area += areas[v]
    }
  }
  return area
}

/**
 * An orthonormal basis whose +z is `axis` — used to splay cone candidates around
 * the axis. Picks a reference not parallel to the axis to avoid a degenerate cross.
 */
function basisFromAxis(axis: Vec3): { u: Vec3; v: Vec3 } {
  const ref: Vec3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let ux = ref[1] * axis[2] - ref[2] * axis[1]
  let uy = ref[2] * axis[0] - ref[0] * axis[2]
  let uz = ref[0] * axis[1] - ref[1] * axis[0]
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul; uy /= ul; uz /= ul
  const vx = axis[1] * uz - axis[2] * uy
  const vy = axis[2] * ux - axis[0] * uz
  const vz = axis[0] * uy - axis[1] * ux
  return { u: [ux, uy, uz], v: [vx, vy, vz] }
}

/** `n` Fibonacci-distributed directions within a cone of `halfDeg` around `axis`. */
function fibonacciCone(axis: Vec3, halfDeg: number, n: number): Vec3[] {
  const { u, v } = basisFromAxis(axis)
  const cosHalf = Math.cos((halfDeg * Math.PI) / 180)
  const out: Vec3[] = []
  for (let i = 0; i < n; i++) {
    const z = 1 - (1 - cosHalf) * ((i + 0.5) / n) // cosθ from ~1 down to cosHalf
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    const phi = i * GOLDEN_ANGLE
    const c = Math.cos(phi) * r
    const s = Math.sin(phi) * r
    out.push(normalize([
      u[0] * c + v[0] * s + axis[0] * z,
      u[1] * c + v[1] * s + axis[1] * z,
      u[2] * c + v[2] * s + axis[2] * z,
    ]))
  }
  return out
}

/**
 * Find the insertion axis minimising undercut area (plan §3.2 / Q6): a Fibonacci
 * cone of candidates around the seed (the seed itself always included), scored on
 * an area-weighted subsample, then a small local refine around the best. The full
 * survey is rerun on the winner by the caller, so only the axis is returned.
 */
export async function findBestAxis(
  scan: MeshData, seedAxis: Vec3, opts: BestAxisProgress = {},
): Promise<BestAxisResult | null> {
  const { positions, indices } = scan
  const seed = normalize(seedAxis)
  if (positions.length === 0 || indices.length === 0) return { axis: seed }

  const areas = vertexAreas(positions, indices)
  const bvh = buildBVH(positions, indices)
  const eps = diagonal(positions) * 1e-5
  const sample = subsample(positions.length / 3)

  const coarse = [seed, ...fibonacciCone(seed, CONE_DEG, CONE_N)]
  const total = coarse.length + REFINE_N

  let best = seed
  let bestArea = Infinity
  let done = 0

  const evalCandidate = async (axis: Vec3): Promise<boolean> => {
    const a = sampledUndercutArea(bvh, positions, indices, sample, areas, axis, eps)
    if (a < bestArea) { bestArea = a; best = axis }
    done++
    opts.onProgress?.(done / total)
    await new Promise((r) => setTimeout(r, 0))
    return opts.shouldCancel?.() ?? false
  }

  for (const axis of coarse) {
    if (await evalCandidate(axis)) return null
  }
  // a local refine pass tightens the result around the best coarse hit
  for (const axis of fibonacciCone(best, REFINE_DEG, REFINE_N)) {
    if (await evalCandidate(axis)) return null
  }
  opts.onProgress?.(1)
  return { axis: best }
}

const NEUTRAL: Vec3 = [0.55, 0.54, 0.5]
const AMBER: Vec3 = [0.96, 0.66, 0.13]
const RED: Vec3 = [0.9, 0.16, 0.16]

/**
 * Map a survey value to the overlay ramp: 0 → neutral (clear, above the height-
 * of-contour), then amber (shallow undercut) → red (deep) for values in (0, 1].
 */
export function undercutColor(value: number): Vec3 {
  if (value <= 0) return NEUTRAL
  const t = Math.min(value, 1)
  return [
    AMBER[0] + (RED[0] - AMBER[0]) * t,
    AMBER[1] + (RED[1] - AMBER[1]) * t,
    AMBER[2] + (RED[2] - AMBER[2]) * t,
  ]
}
