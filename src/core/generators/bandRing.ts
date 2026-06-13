import type { MeshData, Vec3 } from '../types'
import { meshFromTorusGrid, restOnGround } from './meshBuilder'

/**
 * Band Ring Builder (plan §2.5.2). The ring axis is Z (the band stands
 * upright in the XY plane, top of the shank at +Y). Cross-section profiles
 * are 2D loops in (u = axial mm, v = radial mm from the inner surface).
 */

export type RingProfile =
  | 'flat'
  | 'comfort-flat'
  | 'd-shape'
  | 'half-round'
  | 'court'
  | 'knife-edge'
  | 'bevel'
  | 'concave'
  | 'square'

export const RING_PROFILES: { id: RingProfile; label: string }[] = [
  { id: 'flat', label: 'Flat' },
  { id: 'comfort-flat', label: 'Flat comfort-fit' },
  { id: 'd-shape', label: 'D-shape' },
  { id: 'half-round', label: 'Half-round' },
  { id: 'court', label: 'Court (comfort both)' },
  { id: 'knife-edge', label: 'Knife-edge' },
  { id: 'bevel', label: 'Bevelled' },
  { id: 'concave', label: 'Concave' },
  { id: 'square', label: 'Square (chamfered)' },
]

export interface RingSectionValues {
  /** Band width along the finger, mm. */
  width: number
  /** Radial wall thickness, mm. */
  thickness: number
}

export interface BandRingParams {
  /** Inner (finger) diameter in mm. */
  innerDiameter: number
  profile: RingProfile
  mode: 'uniform' | 'variable'
  /** Uniform-mode section. */
  width: number
  thickness: number
  /** Variable-mode sections at the three control angles. */
  top: RingSectionValues
  shoulder: RingSectionValues
  bottom: RingSectionValues
  /** Shoulder control position, degrees from the top (0–180). */
  shoulderDeg: number
  /** Smooth = eased spline through controls; classic = straight blend. */
  interpolation: 'smooth' | 'classic'
  /** Segments around the band. */
  segments: number
}

export function defaultRingParams(): BandRingParams {
  return {
    innerDiameter: 17.35, // US 7
    profile: 'court',
    mode: 'uniform',
    width: 4,
    thickness: 1.6,
    top: { width: 6, thickness: 2.2 },
    shoulder: { width: 4.5, thickness: 1.8 },
    bottom: { width: 3, thickness: 1.4 },
    shoulderDeg: 55,
    interpolation: 'smooth',
    segments: 220,
  }
}

/** Sample an arc from a1 to a2 around (cx, cy), excluding the end point. */
function arc(
  cx: number, cy: number, rx: number, ry: number,
  a1: number, a2: number, steps: number,
): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i < steps; i++) {
    const a = a1 + ((a2 - a1) * i) / steps
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  }
  return pts
}

/**
 * Closed CCW section loop for a profile at a given width/thickness. The point
 * count depends only on the profile id, so every angular step of one ring has
 * matching loops.
 */
export function profileLoop(profile: RingProfile, w: number, t: number): [number, number][] {
  const hw = w / 2
  switch (profile) {
    case 'flat':
      return [[-hw, 0], [hw, 0], [hw, t], [-hw, t]]
    case 'square': {
      const c = Math.min(w, t) * 0.15
      return [
        [-hw + c, 0], [hw - c, 0], [hw, c], [hw, t - c],
        [hw - c, t], [-hw + c, t], [-hw, t - c], [-hw, c],
      ]
    }
    case 'comfort-flat': {
      // inner surface domed: relief e at the edges, touching v=0 mid-width
      const e = Math.min(t * 0.35, 0.8)
      return [
        ...arc(0, e, hw, e, Math.PI, Math.PI * 2, 14),
        [hw, e], [hw, t], [-hw, t],
      ]
    }
    case 'd-shape':
      // flat inside, full elliptical dome outside
      return [[-hw, 0], [hw, 0], ...arc(0, 0, hw, t, 0, Math.PI, 18).slice(1)]
    case 'half-round': {
      // shallow vertical wall, then a round arch
      const wall = t * 0.3
      return [
        [-hw, 0], [hw, 0], [hw, wall],
        ...arc(0, wall, hw, t - wall, 0, Math.PI, 16).slice(1),
        [-hw, wall],
      ]
    }
    case 'court':
      // fully domed inside and outside (ellipse section)
      return arc(0, t / 2, hw, t / 2, 0, Math.PI * 2, 26)
    case 'knife-edge': {
      const wall = t * 0.25
      return [[-hw, 0], [hw, 0], [hw, wall], [0, t], [-hw, wall]]
    }
    case 'bevel': {
      const cu = w * 0.28
      const cv = t * 0.3
      return [
        [-hw + cu, 0], [hw - cu, 0], [hw, cv], [hw, t - cv],
        [hw - cu, t], [-hw + cu, t], [-hw, t - cv], [-hw, cv],
      ]
    }
    case 'concave': {
      // flat inside, dished outer surface (negative ry bends the arc inward)
      const dip = t * 0.45
      return [
        [-hw, 0], [hw, 0], [hw, t],
        ...arc(0, t, hw, -dip, 0, Math.PI, 14).slice(1),
        [-hw, t],
      ]
    }
  }
}

/** Blend a section value across the band: top (α=0) → shoulder → bottom (α=180). */
function blendValue(
  alphaDeg: number, shoulderDeg: number,
  top: number, shoulder: number, mid: number,
  smooth: boolean,
): number {
  // Keep the shoulder strictly between top (α=0) and bottom (α=180) so both end
  // sections stay reachable even when shoulderDeg is set to an extreme (0 or 180).
  const s = Math.min(Math.max(shoulderDeg, 1e-6), 180 - 1e-6)
  const ease = (x: number) => (smooth ? x * x * (3 - 2 * x) : x)
  if (alphaDeg < s) {
    const x = ease(alphaDeg / s)
    return top + (shoulder - top) * x
  }
  const x = ease((alphaDeg - s) / (180 - s))
  return shoulder + (mid - shoulder) * x
}

export function generateBandRing(p: BandRingParams): MeshData {
  const innerR = p.innerDiameter / 2
  const segments = Math.max(Math.round(p.segments), 32)
  const rows: Vec3[][] = []
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2
    let w = p.width
    let t = p.thickness
    if (p.mode === 'variable') {
      // angular distance from the top of the shank (θ = +90°), 0…180°
      const alpha =
        (Math.abs(
          ((theta - Math.PI / 2 + Math.PI) % (Math.PI * 2)) - Math.PI,
        ) * 180) / Math.PI
      const smooth = p.interpolation === 'smooth'
      w = blendValue(alpha, p.shoulderDeg, p.top.width, p.shoulder.width, p.bottom.width, smooth)
      t = blendValue(
        alpha, p.shoulderDeg,
        p.top.thickness, p.shoulder.thickness, p.bottom.thickness, smooth,
      )
    }
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    rows.push(
      profileLoop(p.profile, w, t).map(([u, v]): Vec3 => {
        const r = innerR + v
        return [r * cos, r * sin, u]
      }),
    )
  }
  return restOnGround(meshFromTorusGrid(rows))
}
