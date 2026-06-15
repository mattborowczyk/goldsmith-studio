import type { MeshData } from '../types'
import { buildBVH, closestPoint } from './bvh'

/**
 * Grillz/dental clearance map (plan §3.1, the v2 headline). For every vertex of
 * the grillz shell we find the nearest point on the tooth scan and measure the
 * signed gap: positive = clearance (shell sits off the tooth), negative = the
 * shell bites into the tooth (interference). The sign comes free from the nearest
 * triangle's outward normal — dot < 0 means the shell vertex is behind the scan
 * surface. The engine paints this field: red ≤ 0 (touch/interference) → green
 * (in the cement-gap band) → blue (too loose).
 *
 * Pure TS / DOM-light so it runs in fit.worker; the closest-surface query is
 * BVH-accelerated (bvh.ts), three-free per the core/geometry rule. Mirrors
 * thickness.ts' chunked yield + cancel so the worker stays interruptible.
 */

export interface ClearanceField {
  /** Per shell-vertex signed gap to the scan in mm (negative = interference). */
  values: Float32Array
  /** Smallest (most negative) measured gap. */
  min: number
  /** Largest measured gap. */
  max: number
}

export interface ClearanceProgress {
  onProgress?: (fraction: number) => void
  shouldCancel?: () => boolean
  /** Yield to the event loop every N vertices (0 = run straight through). */
  yieldEvery?: number
}

const CHUNK = 2048

/**
 * Signed distance from each `shell` vertex to the nearest `scan` surface.
 * Returns null if cancelled; an empty field for empty input. Both meshes must be
 * in the same (world) space — the caller passes world mesh data.
 */
export async function computeClearance(
  shell: MeshData,
  scan: MeshData,
  opts: ClearanceProgress = {},
): Promise<ClearanceField | null> {
  const verts = shell.positions
  const vertexCount = verts.length / 3
  const values = new Float32Array(vertexCount)
  if (vertexCount === 0 || scan.indices.length === 0) {
    return { values, min: 0, max: 0 }
  }

  const bvh = buildBVH(scan.positions, scan.indices)
  const sp = scan.positions
  const si = scan.indices
  const yieldEvery = opts.yieldEvery ?? CHUNK
  let min = Infinity
  let max = -Infinity

  for (let v = 0; v < vertexCount; v++) {
    const x = verts[v * 3]
    const y = verts[v * 3 + 1]
    const z = verts[v * 3 + 2]
    const hit = closestPoint(bvh, sp, si, x, y, z)
    let d = hit.dist
    if (hit.tri >= 0 && signOf(sp, si, hit.tri, x - hit.px, y - hit.py, z - hit.pz) < 0) {
      d = -d
    }
    values[v] = d
    if (d < min) min = d
    if (d > max) max = d

    if (yieldEvery > 0 && (v + 1) % yieldEvery === 0) {
      opts.onProgress?.((v + 1) / vertexCount)
      await new Promise((r) => setTimeout(r, 0))
      if (opts.shouldCancel?.()) return null
    }
  }

  if (!Number.isFinite(min)) min = 0
  if (!Number.isFinite(max)) max = 0
  opts.onProgress?.(1)
  return { values, min, max }
}

/** Sign of the gap: dot of (query − closestPoint) with the triangle's normal. */
function signOf(
  positions: Float32Array, indices: Uint32Array, tri: number,
  wx: number, wy: number, wz: number,
): number {
  const a = indices[tri * 3] * 3
  const b = indices[tri * 3 + 1] * 3
  const c = indices[tri * 3 + 2] * 3
  const e1x = positions[b] - positions[a]
  const e1y = positions[b + 1] - positions[a + 1]
  const e1z = positions[b + 2] - positions[a + 2]
  const e2x = positions[c] - positions[a]
  const e2y = positions[c + 1] - positions[a + 1]
  const e2z = positions[c + 2] - positions[a + 2]
  const nx = e1y * e2z - e1z * e2y
  const ny = e1z * e2x - e1x * e2z
  const nz = e1x * e2y - e1y * e2x
  return nx * wx + ny * wy + nz * wz
}

const RED: [number, number, number] = [0.9, 0.16, 0.16]
const GREEN: [number, number, number] = [0.2, 0.78, 0.32]
const BLUE: [number, number, number] = [0.2, 0.42, 0.92]

/**
 * Map a signed clearance to the diverging fit ramp around the green band
 * [lo, hi]: ≤ 0 hard red (interference), 0→lo red→green (too tight), in band
 * green, above hi green→blue (too loose, reaching full blue a band-width past
 * hi). Components 0..1.
 */
export function clearanceColor(
  value: number, lo: number, hi: number,
): [number, number, number] {
  if (value <= 0) return RED
  if (value < lo) return mix(RED, GREEN, lo > 0 ? value / lo : 1)
  if (value <= hi) return GREEN
  const span = Math.max(hi - lo, 1e-4)
  return mix(GREEN, BLUE, Math.min((value - hi) / span, 1))
}

function mix(
  a: [number, number, number], b: [number, number, number], t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
