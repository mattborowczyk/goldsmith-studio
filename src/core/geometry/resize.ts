import type { MeshData, RingFrame, ResizeMode, Vec3 } from '../types'

/**
 * Smart Ring Resizer math (plan §2.6). Pure and framework-agnostic: works in
 * cylindrical coordinates about a RingFrame (axis + in-plane centre). Triangle
 * indices are never touched, so watertightness is preserved.
 *
 * The mapping keeps the bore perfectly round and sculpted surfaces intact:
 *
 *  - head zone      rigid TRANSLATION along the head direction — the stone seat
 *                   is untouched. The slide distance is solved from the data
 *                   (bisection) so no head vertex ends up inside the target
 *                   circle: the gauge always passes.
 *  - shank arms     bent, not stretched: the angle remap runs at dθ'/dθ = r0/r1
 *                   so circumferential arc length at the bore is preserved —
 *                   sculpted texture keeps its spacing and only takes real-metal
 *                   bending strain. Radius moves by a constant Δ (wall thickness
 *                   and texture depth kept).
 *  - seam sector    absorbs ALL of the added/removed arc length (where a bench
 *                   jeweller would cut), with smoothstep-eased slope so the
 *                   density change is C1. On heavy downsizes the sector auto-
 *                   widens before it would fold; past that, arm preservation is
 *                   relaxed toward an even stretch (reported, never silent).
 *  - blend zones    smoothstep vector blend between the rigid-head displacement
 *                   and the remap, flanking the head.
 *
 * A final clamp pushes any vertex that still lands inside the target radius
 * back out to it, so `analyzeRingFrame`'s min-radius measurement reads exactly
 * the target after an apply.
 */

const DEG = 180 / Math.PI

/** Seam slope floor — below this the sector would visibly fold/self-overlap. */
const SEAM_SLOPE_MIN = 0.25
/** Narrowest useful seam sector (deg). */
const SEAM_MIN_DEG = 8
/** Keep this much clearance (deg) between the seam and the blend zones. */
const SEAM_MARGIN_DEG = 2

/** Smallest signed angular difference a − b, in degrees, wrapped to (−180, 180]. */
function angleDeltaDeg(a: number, b: number): number {
  let d = ((a - b) % 360 + 540) % 360 - 180
  if (d <= -180) d += 360
  return d
}

function smoothstep(x: number): number {
  const t = Math.min(Math.max(x, 0), 1)
  return t * t * (3 - 2 * t)
}

/** ∫₀ˣ smoothstep — for integrating a smoothstep-ramped slope in closed form. */
function smoothstepIntegral(x: number): number {
  const t = Math.min(Math.max(x, 0), 1)
  return t * t * t - (t * t * t * t) / 2
}

/**
 * Per-vertex blend weight at an angle: 0 inside the rigid protected zone,
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
  return smoothstep((d - half) / smoothingDeg)
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
  bins = Math.max(1, Math.floor(bins)) // public param: never construct a bad typed array
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
  /** Centre of the rigid zone (deg) — protect-head; anchor angle in uniform mode. */
  protectedCenterDeg?: number
  /** protect-head only — full width of the rigid zone (deg). */
  protectedDeg?: number
  /** protect-head only — width of each flanking blend zone (deg). */
  smoothingDeg?: number
  /** Centre of the seam (sacrificial stretch) sector (deg). Default: opposite the head. */
  seamCenterDeg?: number
  /** Full width of the seam sector (deg). Default 60. */
  seamDeg?: number
}

/**
 * Everything derived from the options that both the deformation and the UI
 * readout need: the resolved zone layout, slopes and strain figures, plus any
 * guard adjustments (seam auto-widened / preservation relaxed) — computed once
 * so the readout can never disagree with the applied geometry.
 */
export interface ResizePlan {
  /** Radial move applied to remapped vertices (mm). */
  delta: number
  /** Ideal texture-preserving arm slope r0/r1. */
  k: number
  /** Arm slope actually used (== k unless the fold guard relaxed it). */
  armSlope: number
  /** Seam plateau slope (angular density in the sector). */
  seamSlope: number
  /** Effective head/protected values (0 width in uniform mode). */
  headCenterDeg: number
  protectedDeg: number
  smoothingDeg: number
  /** Effective seam placement after clamping/widening (absolute deg). */
  seamCenterDeg: number
  seamDeg: number
  /** Tangential surface scale at the bore inside the seam plateau (1 = unchanged). */
  seamBoreScale: number
  /** Bend-only scale at the bore in the arms (exactly 1 when armSlope === k). */
  armBoreScale: number
  /** The seam had to widen past the requested width to avoid folding. */
  seamWidened: boolean
  /** Even at max width the seam couldn't absorb it all — arms partially stretch. */
  preservationRelaxed: boolean
}

/**
 * Resolve zone layout, closure slopes and guard fallbacks for a resize.
 * Shared by resizeRing, resizeStrainField and the panel readout.
 */
export function planResize(opts: ResizeOptions): ResizePlan {
  if (!Number.isFinite(opts.targetInnerDiameter) || opts.targetInnerDiameter <= 0) {
    throw new Error('planResize: targetInnerDiameter must be a finite positive number')
  }
  const r0 = opts.frame.innerR
  const r1 = opts.targetInnerDiameter / 2
  const delta = r1 - r0
  const k = r0 / r1

  const headCenterDeg = ((opts.protectedCenterDeg ?? 0) % 360 + 360) % 360
  const isHead = opts.mode === 'protect-head'
  const protectedDeg = isHead ? Math.min(Math.max(opts.protectedDeg ?? 0, 0), 176) : 0
  // clamp smoothing so head + both blends always leave room for a working seam
  // window — at extreme slider values the window would otherwise invert and the
  // angle remap's ascending-boundary layout would break down
  const minWindow = SEAM_MIN_DEG + 4
  const smoothingMax = Math.max((360 - protectedDeg - 2 * SEAM_MARGIN_DEG - minWindow) / 2, 0)
  const smoothingDeg = isHead ? Math.min(Math.max(opts.smoothingDeg ?? 0, 0), 120, smoothingMax) : 0

  // seam window in head-relative φ-space: must clear the head + blend zones
  const zoneEnd = protectedDeg / 2 + smoothingDeg + SEAM_MARGIN_DEG
  const windowLo = zoneEnd
  const windowHi = 360 - zoneEnd
  const windowSpan = windowHi - windowLo
  const maxSeamDeg = Math.max(Math.min(windowSpan, 160), SEAM_MIN_DEG)

  let seamDeg = Math.min(Math.max(opts.seamDeg ?? 60, SEAM_MIN_DEG), maxSeamDeg)
  const requestedSeamDeg = seamDeg
  const seamCenterRaw = opts.seamCenterDeg ?? headCenterDeg + 180
  let psi = ((seamCenterRaw - headCenterDeg) % 360 + 360) % 360
  const clampPsi = () => {
    psi = Math.min(Math.max(psi, windowLo + seamDeg / 2), windowHi - seamDeg / 2)
  }
  clampPsi()

  // closure: seamSlope = a + (4/3)·(360 − P − S)·(1 − a)/W  (a = arm slope)
  const closureC = 360 - protectedDeg - smoothingDeg
  const slopeFor = (a: number, w: number) => a + (4 / 3) * (closureC * (1 - a)) / w

  let armSlope = k
  let seamSlope = slopeFor(k, seamDeg)
  let seamWidened = false
  let preservationRelaxed = false
  if (seamSlope < SEAM_SLOPE_MIN) {
    // heavy downsize: widen the sector until it can absorb the compression
    const needed = (4 / 3) * (closureC * (k - 1)) / (k - SEAM_SLOPE_MIN)
    if (needed <= maxSeamDeg) {
      seamDeg = Math.max(seamDeg, needed)
      seamWidened = seamDeg > requestedSeamDeg
      seamSlope = slopeFor(k, seamDeg)
    } else {
      // even the widest seam can't take it — relax the arms toward even stretch
      seamDeg = maxSeamDeg
      seamWidened = true
      preservationRelaxed = true
      const b = (4 / 3) * closureC / seamDeg
      armSlope = (SEAM_SLOPE_MIN - b) / (1 - b)
      seamSlope = SEAM_SLOPE_MIN
    }
    clampPsi()
  }

  return {
    delta,
    k,
    armSlope,
    seamSlope,
    headCenterDeg,
    protectedDeg,
    smoothingDeg,
    seamCenterDeg: (headCenterDeg + psi) % 360,
    seamDeg,
    seamBoreScale: seamSlope * (r1 / r0),
    armBoreScale: armSlope * (r1 / r0),
    seamWidened,
    preservationRelaxed,
  }
}

/**
 * The angle remap g: head-relative source angle φ ∈ [0, 360) → target angle,
 * integrating the piecewise slope profile (head 1 · blend ramp · arm a · eased
 * seam · arm a · blend ramp · head 1). Closed-form per segment; g(0)=0 and the
 * closure slope guarantees g(360)=360.
 */
function buildAngleRemap(plan: ResizePlan): (phi: number) => number {
  const P2 = plan.protectedDeg / 2
  const S = plan.smoothingDeg
  const a = plan.armSlope
  const sc = plan.seamSlope
  const psi = ((plan.seamCenterDeg - plan.headCenterDeg) % 360 + 360) % 360
  const W = plan.seamDeg
  const q = W / 4 // seam quarter: ramp, plateau(2q), ramp

  // segment boundaries in φ (ascending)
  const b0 = P2 // head end
  const b1 = P2 + S // blend end → arm A
  const s0 = psi - W / 2 // seam start (ramp a→sc)
  const s1 = s0 + q // plateau start
  const s2 = s1 + 2 * q // plateau end (ramp sc→a)
  const s3 = s2 + q // seam end → arm B
  const b2 = 360 - P2 - S // blend start (a→1)
  const b3 = 360 - P2 // head start (far side)

  // g at each boundary, accumulated with per-segment closed-form integrals
  // (a full smoothstep ramp from s1→s2 over width L integrates to L·(s1+s2)/2)
  const g0 = b0 // slope 1 over [0, b0]
  const g1 = g0 + S * 1 + (a - 1) * S * smoothstepIntegral(1) // full ramp 1→a over S
  const g2 = g1 + (s0 - b1) * a
  const g3 = g2 + q * a + (sc - a) * q * smoothstepIntegral(1)
  const g4 = g3 + 2 * q * sc
  const g5 = g4 + q * sc + (a - sc) * q * smoothstepIntegral(1)
  const g6 = g5 + (b2 - s3) * a
  const g7 = g6 + S * a + (1 - a) * S * smoothstepIntegral(1)

  return (phi: number): number => {
    if (phi <= b0) return phi
    if (phi <= b1) {
      const x = (phi - b0) / S
      return g0 + (phi - b0) + (a - 1) * S * smoothstepIntegral(x)
    }
    if (phi <= s0) return g1 + (phi - b1) * a
    if (phi <= s1) {
      const x = (phi - s0) / q
      return g2 + (phi - s0) * a + (sc - a) * q * smoothstepIntegral(x)
    }
    if (phi <= s2) return g3 + (phi - s1) * sc
    if (phi <= s3) {
      const x = (phi - s2) / q
      return g4 + (phi - s2) * sc + (a - sc) * q * smoothstepIntegral(x)
    }
    if (phi <= b2) return g5 + (phi - s3) * a
    if (phi <= b3) {
      const x = (phi - b2) / S
      return g6 + (phi - b2) * a + (1 - a) * S * smoothstepIntegral(x)
    }
    return g7 + (phi - b3)
  }
}

/** Local slope of the angle remap at φ (the same piecewise profile as g). */
function angleRemapSlope(plan: ResizePlan, phi: number): number {
  const P2 = plan.protectedDeg / 2
  const S = plan.smoothingDeg
  const a = plan.armSlope
  const sc = plan.seamSlope
  const psi = ((plan.seamCenterDeg - plan.headCenterDeg) % 360 + 360) % 360
  const W = plan.seamDeg
  const q = W / 4
  const s0 = psi - W / 2
  if (phi <= P2 || phi >= 360 - P2) return 1
  if (phi <= P2 + S) return 1 + (a - 1) * smoothstep((phi - P2) / S)
  if (phi >= 360 - P2 - S) return a + (1 - a) * smoothstep((phi - (360 - P2 - S)) / S)
  if (phi <= s0) return a
  if (phi <= s0 + q) return a + (sc - a) * smoothstep((phi - s0) / q)
  if (phi <= s0 + 3 * q) return sc
  if (phi <= s0 + 4 * q) return sc + (a - sc) * smoothstep((phi - s0 - 3 * q) / q)
  return a
}

/**
 * Smallest head slide t along the head direction such that no rigid-zone vertex
 * ends up inside the target radius. f(t) = min head-vertex radius − r1 is
 * monotone in t (every head vertex has a positive component along the head
 * direction, the zone being < 180° wide), so bisection converges. Skipped when
 * the zone has no vertices (t = delta fallback).
 */
function solveHeadSlide(
  mesh: MeshData, frame: RingFrame, plan: ResizePlan, targetR: number,
): number {
  const p = mesh.positions
  const u = (frame.axis + 1) % 3
  const v = (frame.axis + 2) % 3
  const [cu, cv] = frame.center
  const half = plan.protectedDeg / 2
  const rad = plan.headCenterDeg / DEG
  const hx = Math.cos(rad)
  const hy = Math.sin(rad)

  // collect head-zone in-plane offsets once
  const du: number[] = []
  const dv: number[] = []
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i + u] - cu
    const y = p[i + v] - cv
    const deg = (Math.atan2(y, x) * DEG + 360) % 360
    if (Math.abs(angleDeltaDeg(deg, plan.headCenterDeg)) <= half) {
      du.push(x)
      dv.push(y)
    }
  }
  if (du.length === 0) return plan.delta

  const minRadiusAt = (t: number): number => {
    let min = Infinity
    for (let i = 0; i < du.length; i++) {
      const x = du[i] + t * hx
      const y = dv[i] + t * hy
      const r = Math.hypot(x, y)
      if (r < min) min = r
    }
    return min
  }

  // bracket the root of f(t) = minRadiusAt(t) − targetR
  let lo = plan.delta - frame.innerR
  let hi = plan.delta + frame.innerR
  // no bore vertices under the head (or a very wide zone the slide can't fix):
  // follow the shank's Δ and let the gauge clamp catch any stragglers
  if (minRadiusAt(lo) - targetR > 0) return plan.delta
  if (minRadiusAt(hi) - targetR < 0) return hi
  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2
    if (minRadiusAt(mid) - targetR < 0) lo = mid
    else hi = mid
  }
  return hi // the side guaranteed ≥ targetR
}

/**
 * Resize a ring to a target inner diameter. Returns fresh MeshData (indices
 * shared by reference — they never change). See the module doc for the mapping.
 */
export function resizeRing(mesh: MeshData, opts: ResizeOptions): MeshData {
  const plan = planResize(opts)
  const { frame } = opts
  const targetR = opts.targetInnerDiameter / 2
  const u = (frame.axis + 1) % 3
  const v = (frame.axis + 2) % 3
  const [cu, cv] = frame.center
  const H = plan.headCenterDeg
  const half = plan.protectedDeg / 2
  const S = plan.smoothingDeg
  const g = buildAngleRemap(plan)
  const headRad = H / DEG
  const slide = plan.protectedDeg > 0 ? solveHeadSlide(mesh, frame, plan, targetR) : 0
  const tx = slide * Math.cos(headRad)
  const ty = slide * Math.sin(headRad)

  const src = mesh.positions
  const positions = src.slice()
  for (let i = 0; i < positions.length; i += 3) {
    const du = positions[i + u] - cu
    const dv = positions[i + v] - cv
    const r = Math.hypot(du, dv)
    if (r < 1e-6) continue
    const deg = (Math.atan2(dv, du) * DEG + 360) % 360
    const d = Math.abs(angleDeltaDeg(deg, H))

    // remapped position (bent shank on the new bore)
    const phi = ((deg - H) % 360 + 360) % 360
    const thetaNew = (H + g(phi)) / DEG
    const rNew = r + plan.delta
    const remapU = rNew * Math.cos(thetaNew)
    const remapV = rNew * Math.sin(thetaNew)

    let nu: number
    let nv: number
    if (plan.protectedDeg > 0 && d <= half) {
      // rigid head: pure translation
      nu = du + tx
      nv = dv + ty
    } else if (plan.protectedDeg > 0 && S > 0 && d < half + S) {
      // blend zone: smoothstep between the rigid and remapped displacement
      const w = smoothstep((d - half) / S)
      nu = (1 - w) * (du + tx) + w * remapU
      nv = (1 - w) * (dv + ty) + w * remapV
    } else {
      nu = remapU
      nv = remapV
    }

    // gauge clamp: nothing may protrude inside the target circle
    const rFinal = Math.hypot(nu, nv)
    if (rFinal < targetR && rFinal > 1e-9) {
      const s = targetR / rFinal
      nu *= s
      nv *= s
    }

    positions[i + u] = cu + nu
    positions[i + v] = cv + nv
  }
  return { positions, indices: mesh.indices }
}

const STRAIN_NEUTRAL: Vec3 = [0.55, 0.54, 0.5]
const STRAIN_STRETCH: Vec3 = [0.9, 0.16, 0.16]
const STRAIN_COMPRESS: Vec3 = [0.23, 0.45, 0.9]

/**
 * Map a signed tangential strain to the preview ramp: neutral at 0, red as it
 * stretches toward `maxAbs`, blue as it compresses. `maxAbs` is the caller's
 * normalisation (the field's max magnitude, floored so noise stays neutral).
 */
export function strainColor(value: number, maxAbs: number): Vec3 {
  const t = Math.min(Math.abs(value) / Math.max(maxAbs, 1e-9), 1)
  const to = value >= 0 ? STRAIN_STRETCH : STRAIN_COMPRESS
  return [
    STRAIN_NEUTRAL[0] + (to[0] - STRAIN_NEUTRAL[0]) * t,
    STRAIN_NEUTRAL[1] + (to[1] - STRAIN_NEUTRAL[1]) * t,
    STRAIN_NEUTRAL[2] + (to[2] - STRAIN_NEUTRAL[2]) * t,
  ]
}

/**
 * Per-vertex tangential surface strain of the mapping (scale − 1, signed:
 * positive = stretched, negative = compressed, 0 = untouched/rigid). Drives the
 * strain heatmap so the user sees exactly which patch of sculpt pays for the
 * resize before applying. Blend zones interpolate toward the remap strain.
 */
export function resizeStrainField(mesh: MeshData, opts: ResizeOptions): Float32Array {
  const plan = planResize(opts)
  const { frame } = opts
  const u = (frame.axis + 1) % 3
  const v = (frame.axis + 2) % 3
  const [cu, cv] = frame.center
  const H = plan.headCenterDeg
  const half = plan.protectedDeg / 2
  const S = plan.smoothingDeg

  const p = mesh.positions
  const out = new Float32Array(p.length / 3)
  for (let i = 0, vi = 0; i < p.length; i += 3, vi++) {
    const du = p[i + u] - cu
    const dv = p[i + v] - cv
    const r = Math.hypot(du, dv)
    if (r < 1e-6) continue
    const deg = (Math.atan2(dv, du) * DEG + 360) % 360
    const d = Math.abs(angleDeltaDeg(deg, H))
    if (plan.protectedDeg > 0 && d <= half) continue // rigid: strain 0
    const phi = ((deg - H) % 360 + 360) % 360
    const scale = angleRemapSlope(plan, phi) * ((r + plan.delta) / r)
    let strain = scale - 1
    if (plan.protectedDeg > 0 && S > 0 && d < half + S) {
      strain *= smoothstep((d - half) / S) // fades to rigid at the head edge
    }
    out[vi] = strain
  }
  return out
}
