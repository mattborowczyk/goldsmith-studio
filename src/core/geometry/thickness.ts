import type { MeshData } from '../types'
import { buildBVH, raycastNearest } from './bvh'

/**
 * Wall-thickness sampling (plan §2.3, the beyond-parity headline). For every
 * surface vertex we cast a ray inward along the negated vertex normal and
 * measure the distance to the opposite wall — the local wall thickness. The
 * result is a per-vertex thickness field the engine paints onto the surface
 * (blue = thick → red = thin) with a minimum-thickness threshold.
 *
 * Pure TS / DOM-light so it runs in a worker (see thickness.worker.ts). Heavy
 * work is the raycast, accelerated by the in-house BVH (bvh.ts) — three-free, to
 * honour the core/geometry no-Three rule.
 */

export interface ThicknessField {
  /** Per source-vertex wall thickness in mm. Unreachable samples are `max`. */
  values: Float32Array
  /** Smallest measured thickness (mm). */
  min: number
  /** Largest finite measured thickness (mm) — caps the colour ramp. */
  max: number
}

export interface ThicknessProgress {
  /** Called periodically with completion in [0, 1]. */
  onProgress?: (fraction: number) => void
  /** Polled between chunks; return true to abort early (returns null). */
  shouldCancel?: () => boolean
  /** Yield to the event loop between chunks (lets the worker see cancel msgs). */
  yieldEvery?: number
}

/** Angle-weighted vertex normals (outward, assuming CCW winding). */
function computeVertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3
    const b = indices[t + 1] * 3
    const c = indices[t + 2] * 3
    const e1x = positions[b] - positions[a]
    const e1y = positions[b + 1] - positions[a + 1]
    const e1z = positions[b + 2] - positions[a + 2]
    const e2x = positions[c] - positions[a]
    const e2y = positions[c + 1] - positions[a + 1]
    const e2z = positions[c + 2] - positions[a + 2]
    // face normal (length ∝ 2× area, an area weighting for the accumulation)
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2])
    if (len > 0) {
      normals[i] /= len
      normals[i + 1] /= len
      normals[i + 2] /= len
    }
  }
  return normals
}

const CHUNK = 2048

/**
 * Compute the wall-thickness field. Returns null if cancelled. Throws nothing on
 * empty input — it yields an empty field. Distances are measured from the vertex
 * surface; samples whose inward ray escapes (open boundary) are filled with the
 * largest finite thickness so they read as "thick", never "thin".
 */
export async function computeThickness(
  mesh: MeshData,
  opts: ThicknessProgress = {},
): Promise<ThicknessField | null> {
  const { positions, indices } = mesh
  const vertexCount = positions.length / 3
  const values = new Float32Array(vertexCount)
  if (vertexCount === 0 || indices.length === 0) {
    return { values, min: 0, max: 0 }
  }

  const normals = computeVertexNormals(positions, indices)
  const bvh = buildBVH(positions, indices)

  // ray-start offset + self-hit guard, scaled to the model so it works at any size
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
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1
  const eps = diag * 1e-5
  const maxReach = diag * 1.001

  // 0 = run straight through (tests); otherwise yield + report every N samples
  const yieldEvery = opts.yieldEvery ?? CHUNK
  let min = Infinity
  let maxFinite = 0
  const reached = new Uint8Array(vertexCount)

  for (let v = 0; v < vertexCount; v++) {
    const p = v * 3
    // cast inward: away from the outward normal, into the material
    const dx = -normals[p]
    const dy = -normals[p + 1]
    const dz = -normals[p + 2]
    if (dx === 0 && dy === 0 && dz === 0) {
      values[v] = maxReach
      continue
    }
    // nudge the origin a hair inward so the ray clears the start face
    const ox = positions[p] + dx * eps
    const oy = positions[p + 1] + dy * eps
    const oz = positions[p + 2] + dz * eps
    const t = raycastNearest(bvh, positions, indices, ox, oy, oz, dx, dy, dz, eps)
    if (Number.isFinite(t) && t < maxReach) {
      const thickness = t + eps
      values[v] = thickness
      reached[v] = 1
      if (thickness < min) min = thickness
      if (thickness > maxFinite) maxFinite = thickness
    } else {
      values[v] = Infinity // resolved to maxFinite after the pass
    }

    if (yieldEvery > 0 && (v + 1) % yieldEvery === 0) {
      opts.onProgress?.((v + 1) / vertexCount)
      // a real macrotask, so a queued cancel message gets a turn to run
      await new Promise((r) => setTimeout(r, 0))
      if (opts.shouldCancel?.()) return null
    }
  }

  if (!Number.isFinite(min)) min = 0
  if (maxFinite <= 0) maxFinite = maxReach
  // Clip the ramp's top to a high percentile of the reached samples, not the
  // absolute max: a handful of deep through-rays (caps, sample points that see
  // clear across a cavity) would otherwise compress the whole wall gradient into
  // the red end. Per-vertex values keep their true thickness; the ramp clamps.
  const high = percentile(values, reached, 0.95, maxFinite)
  // unreachable samples read as the thickest value, never as a thin alarm
  for (let v = 0; v < vertexCount; v++) {
    if (!reached[v]) values[v] = high
  }
  opts.onProgress?.(1)
  return { values, min, max: high }
}

/** p-quantile (0..1) of the reached thickness samples, falling back to `fallback`. */
function percentile(values: Float32Array, reached: Uint8Array, p: number, fallback: number): number {
  let n = 0
  for (let v = 0; v < reached.length; v++) if (reached[v]) n++
  if (n === 0) return fallback
  const sample = new Float32Array(n)
  let j = 0
  for (let v = 0; v < reached.length; v++) if (reached[v]) sample[j++] = values[v]
  sample.sort()
  const idx = Math.min(n - 1, Math.max(0, Math.round((n - 1) * p)))
  return sample[idx] || fallback
}

/**
 * Map a thickness value to an RGB colour (components 0..1) for the heatmap ramp:
 * red (thin) → green → blue (thick), normalised across [low, high]. Anything at
 * or below `threshold` is painted hard red so under-spec walls jump out.
 */
export function thicknessColor(
  value: number, low: number, high: number, threshold: number,
): [number, number, number] {
  if (value <= threshold) return [0.92, 0.13, 0.13]
  const lo = Math.max(low, threshold)
  const span = high - lo
  const n = span > 1e-9 ? Math.min(Math.max((value - lo) / span, 0), 1) : 1
  return ramp(n)
}

/** 0 = red, 0.5 = green, 1 = blue. */
function ramp(n: number): [number, number, number] {
  if (n < 0.5) {
    const k = n / 0.5
    return [0.92 - 0.62 * k, 0.13 + 0.62 * k, 0.13 + 0.07 * k]
  }
  const k = (n - 0.5) / 0.5
  return [0.3 - 0.18 * k, 0.75 - 0.55 * k, 0.2 + 0.72 * k]
}
