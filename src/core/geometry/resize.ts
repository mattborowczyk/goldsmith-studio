import type { MeshData, RingFrame, ResizeMode, Vec3 } from '../types'

/**
 * Smart Ring Resizer math (plan §2.6). Pure and framework-agnostic: works in
 * cylindrical coordinates about a RingFrame (axis + in-plane centre) and only
 * moves vertices radially, so triangle indices — and thus watertightness — are
 * preserved. Two modes:
 *   - uniform     every vertex moves radially by the same Δ (wall thickness kept)
 *   - protect-head a rigid angular zone stays put, a smoothing zone blends, the
 *                 rest of the shank takes the full Δ
 */

const DEG = 180 / Math.PI

/** Smallest signed angular difference a − b, in degrees, wrapped to (−180, 180]. */
function angleDeltaDeg(a: number, b: number): number {
  let d = ((a - b) % 360 + 540) % 360 - 180
  if (d <= -180) d += 360
  return d
}

/**
 * Per-vertex radial weight at an angle: 0 inside the rigid protected zone,
 * smoothstep-ramping across the flanking smoothing zone, 1 in the free shank.
 */
export function ringResizeWeight(
  deg: number,
  centerDeg: number,
  protectedDeg: number,
  smoothingDeg: number,
): number {
  const d = Math.abs(angleDeltaDeg(deg, centerDeg))
  const half = protectedDeg / 2
  if (d <= half) return 0
  if (smoothingDeg <= 0 || d >= half + smoothingDeg) return 1
  const x = (d - half) / smoothingDeg
  return x * x * (3 - 2 * x) // smoothstep — C1 at both ends
}

/** Angle (deg, [0,360)) of a world point around the ring axis. */
export function pointAngleDeg(point: Vec3, frame: RingFrame): number {
  const u = (frame.axis + 1) % 3
  const v = (frame.axis + 2) % 3
  const du = point[u] - frame.center[0]
  const dv = point[v] - frame.center[1]
  const deg = Math.atan2(dv, du) * DEG
  return (deg + 360) % 360
}

/** World point on the ring plane at a given angle and radius (for drag handles). */
export function anglePointOnRing(frame: RingFrame, deg: number, radius: number): Vec3 {
  const u = (frame.axis + 1) % 3
  const v = (frame.axis + 2) % 3
  const rad = deg / DEG
  const out: Vec3 = [0, 0, 0]
  out[frame.axis] = frame.axialCenter
  out[u] = frame.center[0] + radius * Math.cos(rad)
  out[v] = frame.center[1] + radius * Math.sin(rad)
  return out
}

/**
 * Auto-detect the head: the angular sector carrying the largest outer radius
 * (the bulkiest part — a stone setting). Bins vertices by angle and returns the
 * centre angle (deg) of the peak bin. Meaningless on a plain band (flat profile
 * of radii) but the user can always override.
 */
export function detectHeadAngleDeg(mesh: MeshData, frame: RingFrame, bins = 180): number {
  const p = mesh.positions
  const u = (frame.axis + 1) % 3
  const v = (frame.axis + 2) % 3
  const maxR = new Float64Array(bins)
  for (let i = 0; i < p.length; i += 3) {
    const du = p[i + u] - frame.center[0]
    const dv = p[i + v] - frame.center[1]
    const r2 = du * du + dv * dv
    let deg = Math.atan2(dv, du) * DEG
    deg = (deg + 360) % 360
    const b = Math.min(bins - 1, Math.floor((deg / 360) * bins))
    if (r2 > maxR[b]) maxR[b] = r2
  }
  let peak = 0
  for (let b = 1; b < bins; b++) if (maxR[b] > maxR[peak]) peak = b
  return ((peak + 0.5) / bins) * 360
}

export interface ResizeOptions {
  frame: RingFrame
  mode: ResizeMode
  /** Target inner diameter in mm. */
  targetInnerDiameter: number
  /** protect-head only — centre of the rigid zone (deg). */
  protectedCenterDeg?: number
  /** protect-head only — full width of the rigid zone (deg). */
  protectedDeg?: number
  /** protect-head only — width of each flanking blend zone (deg). */
  smoothingDeg?: number
}

/**
 * Resize a ring to a target inner diameter, moving vertices only radially.
 * Returns fresh MeshData (indices shared by reference — they never change).
 */
export function resizeRing(mesh: MeshData, opts: ResizeOptions): MeshData {
  const { frame, mode } = opts
  const targetInnerR = opts.targetInnerDiameter / 2
  const delta = targetInnerR - frame.innerR
  const u = (frame.axis + 1) % 3
  const v = (frame.axis + 2) % 3
  const [cu, cv] = frame.center
  const protectedCenterDeg = opts.protectedCenterDeg ?? 0
  const protectedDeg = opts.protectedDeg ?? 0
  const smoothingDeg = opts.smoothingDeg ?? 0

  const src = mesh.positions
  const positions = src.slice()
  for (let i = 0; i < positions.length; i += 3) {
    const du = positions[i + u] - cu
    const dv = positions[i + v] - cv
    const r = Math.hypot(du, dv)
    if (r < 1e-6) continue
    let add = delta
    if (mode === 'protect-head') {
      const deg = (Math.atan2(dv, du) * DEG + 360) % 360
      add = delta * ringResizeWeight(deg, protectedCenterDeg, protectedDeg, smoothingDeg)
    }
    if (add === 0) continue
    const factor = (r + add) / r
    positions[i + u] = cu + du * factor
    positions[i + v] = cv + dv * factor
  }
  return { positions, indices: mesh.indices }
}
