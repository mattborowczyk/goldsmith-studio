import type { MeshData, Vec3 } from '../types'
import { loftLoops, normalizeLoop, restOnGround, type Loop2 } from './meshBuilder'

/**
 * Gemstone Generator (plan §2.5.1). Each cut is a girdle outline (in the XZ
 * plane, length along X, width along Z) lofted vertically: a pavilion down to
 * a culet point (brilliant cuts) or keel pad (step cuts), a girdle band, and a
 * crown up to a flat table. Table-up, culet at y = 0.
 */

export type GemCut =
  | 'round' | 'oval' | 'princess' | 'cushion' | 'cushion-rect'
  | 'emerald' | 'emerald-square' | 'asscher' | 'radiant' | 'radiant-square'
  | 'baguette' | 'octagon' | 'triangle' | 'trillion' | 'trillion-curved'
  | 'marquise' | 'pear' | 'heart' | 'calf' | 'half-moon'

export interface GemCutInfo {
  id: GemCut
  label: string
  /** Square cuts lock width = length in the UI. */
  square: boolean
  /** Default depth (height) as a fraction of width — industry-typical ratio. */
  depthRatio: number
  style: 'brilliant' | 'step'
}

export const GEM_CUTS: GemCutInfo[] = [
  { id: 'round', label: 'Round', square: true, depthRatio: 0.61, style: 'brilliant' },
  { id: 'oval', label: 'Oval', square: false, depthRatio: 0.6, style: 'brilliant' },
  { id: 'princess', label: 'Princess', square: true, depthRatio: 0.72, style: 'brilliant' },
  { id: 'cushion', label: 'Cushion (square)', square: true, depthRatio: 0.66, style: 'brilliant' },
  { id: 'cushion-rect', label: 'Cushion (standard)', square: false, depthRatio: 0.66, style: 'brilliant' },
  { id: 'emerald', label: 'Emerald', square: false, depthRatio: 0.65, style: 'step' },
  { id: 'emerald-square', label: 'Emerald (square)', square: true, depthRatio: 0.65, style: 'step' },
  { id: 'asscher', label: 'Asscher', square: true, depthRatio: 0.68, style: 'step' },
  { id: 'radiant', label: 'Radiant', square: false, depthRatio: 0.68, style: 'brilliant' },
  { id: 'radiant-square', label: 'Radiant (square)', square: true, depthRatio: 0.68, style: 'brilliant' },
  { id: 'baguette', label: 'Baguette', square: false, depthRatio: 0.48, style: 'step' },
  { id: 'octagon', label: 'Octagon', square: true, depthRatio: 0.62, style: 'step' },
  { id: 'triangle', label: 'Triangle', square: true, depthRatio: 0.42, style: 'brilliant' },
  { id: 'trillion', label: 'Trillion (straight)', square: true, depthRatio: 0.42, style: 'brilliant' },
  { id: 'trillion-curved', label: 'Trillion (curved)', square: true, depthRatio: 0.42, style: 'brilliant' },
  { id: 'marquise', label: 'Marquise', square: false, depthRatio: 0.58, style: 'brilliant' },
  { id: 'pear', label: 'Pear', square: false, depthRatio: 0.6, style: 'brilliant' },
  { id: 'heart', label: 'Heart', square: true, depthRatio: 0.58, style: 'brilliant' },
  { id: 'calf', label: 'Calf (bullet)', square: false, depthRatio: 0.5, style: 'step' },
  { id: 'half-moon', label: 'Half-moon', square: false, depthRatio: 0.5, style: 'brilliant' },
]

export interface GemParams {
  cut: GemCut
  /** mm along X. */
  length: number
  /** mm along Z (ignored for square cuts — width = length). */
  width: number
  /** Total height mm; null = auto from the cut's depth ratio. */
  height: number | null
}

export function gemCutInfo(cut: GemCut): GemCutInfo {
  return GEM_CUTS.find((c) => c.id === cut)!
}

export function gemDefaultHeight(cut: GemCut, length: number, width: number): number {
  return gemCutInfo(cut).depthRatio * Math.min(length, width)
}

// ---------- girdle outlines (unit shapes; normalized to L × W afterwards) ----------

function ellipse(n = 64): Loop2 {
  const pts: Loop2 = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    pts.push([Math.cos(a), Math.sin(a)])
  }
  return pts
}

function rect(): Loop2 {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]]
}

/** Rectangle with cut corners (emerald family) — f = corner cut fraction. */
function cutCornerRect(f: number): Loop2 {
  return [
    [-1 + f, -1], [1 - f, -1], [1, -1 + f], [1, 1 - f],
    [1 - f, 1], [-1 + f, 1], [-1, 1 - f], [-1, -1 + f],
  ]
}

/** Rounded rectangle (cushion family) — r = corner radius fraction. */
function roundedRect(r: number, per = 8): Loop2 {
  const pts: Loop2 = []
  const corners: [number, number, number][] = [
    [1 - r, 1 - r, 0], [-1 + r, 1 - r, Math.PI / 2],
    [-1 + r, -1 + r, Math.PI], [1 - r, -1 + r, (3 * Math.PI) / 2],
  ]
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= per; i++) {
      const a = start + ((Math.PI / 2) * i) / per
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  }
  return pts
}

/** Triangle with optional rounded tips and optional outward-bulged sides. */
function triangleOutline(tipRadius: number, bulge: number, per = 10): Loop2 {
  const corners: [number, number][] = [
    [0, 1], [-1, -1], [1, -1],
  ]
  const pts: Loop2 = []
  for (let k = 0; k < 3; k++) {
    const a = corners[k]
    const b = corners[(k + 1) % 3]
    for (let i = 0; i < per; i++) {
      const t = i / per
      let x = a[0] + (b[0] - a[0]) * t
      let y = a[1] + (b[1] - a[1]) * t
      if (bulge > 0) {
        // push the side outward along its normal, max at mid-edge
        const nx = b[1] - a[1]
        const ny = a[0] - b[0]
        const len = Math.hypot(nx, ny) || 1
        const s = Math.sin(Math.PI * t) * bulge
        x += (nx / len) * s
        y += (ny / len) * s
      }
      pts.push([x, y])
    }
  }
  if (tipRadius <= 0) return pts
  // soften tips by averaging each corner point with its neighbours
  return pts.map((p, i) => {
    const prev = pts[(i - 1 + pts.length) % pts.length]
    const next = pts[(i + 1) % pts.length]
    return [
      p[0] * (1 - tipRadius) + ((prev[0] + next[0]) / 2) * tipRadius,
      p[1] * (1 - tipRadius) + ((prev[1] + next[1]) / 2) * tipRadius,
    ]
  })
}

/** Lens of two circular arcs meeting in points at ±X (marquise). */
function marquiseOutline(n = 24): Loop2 {
  const pts: Loop2 = []
  // upper arc through (-1,0) (0,1) (1,0): radius & center from sagitta
  const R = (1 + 1) / (2 * 1) // (hl² + hw²) / (2·hw) with hl = hw = 1
  const cy = 1 - R
  const a0 = Math.atan2(0 - cy, -1)
  const a1 = Math.atan2(0 - cy, 1)
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    pts.push([R * Math.cos(a), cy + R * Math.sin(a)])
  }
  for (let i = 0; i < n; i++) {
    const a = a1 + ((a0 - a1) * i) / n
    pts.push([R * Math.cos(a), -(cy + R * Math.sin(a))])
  }
  return pts
}

/** Teardrop: round head at -X tapering to a point at +X (pear). */
function pearOutline(n = 40): Loop2 {
  const pts: Loop2 = []
  for (let i = 0; i <= n; i++) {
    const t = i / n // 0…1 over the half-outline, point → head → point
    const a = Math.PI * t
    // radius swells toward the head (cardioid-ish), pinches to the tip at a=0
    const r = Math.sin(a / 2)
    pts.push([1 - 2 * r * r, r * Math.sin(a)])
  }
  for (let i = 1; i < n; i++) {
    const [x, y] = pts[n - i]
    pts.push([x, -y])
  }
  return pts
}

/** Classic parametric heart, point toward +X (length axis). */
function heartOutline(n = 48): Loop2 {
  const pts: Loop2 = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    const x = 16 * Math.pow(Math.sin(t), 3)
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    // lobes at -X, point at +X; heart's vertical axis becomes the length
    pts.push([-y, x])
  }
  return pts
}

/** Bullet: square tail at -X, tapered rounded nose at +X (calf). */
function calfOutline(per = 10): Loop2 {
  const pts: Loop2 = [[-1, -1], [-1, 1], [0.1, 0.85]]
  for (let i = 0; i <= per; i++) {
    const a = Math.PI / 2 - (Math.PI * i) / per
    pts.push([0.55 + 0.45 * Math.cos(a), 0.85 * Math.sin(a)])
  }
  pts.push([0.1, -0.85])
  return pts
}

/** Half disc: flat edge along the length, dome toward +Z (half-moon). */
function halfMoonOutline(n = 32): Loop2 {
  const pts: Loop2 = [[-1, 0], [1, 0]]
  for (let i = 1; i < n; i++) {
    const a = (Math.PI * i) / n
    pts.push([Math.cos(a), Math.sin(a)])
  }
  return pts.reverse()
}

function outlineFor(cut: GemCut): Loop2 {
  switch (cut) {
    case 'round':
    case 'oval':
      return ellipse()
    case 'princess':
      return rect()
    case 'cushion':
    case 'cushion-rect':
      return roundedRect(0.55)
    case 'emerald':
    case 'emerald-square':
      return cutCornerRect(0.35)
    case 'asscher':
      return cutCornerRect(0.5)
    case 'radiant':
    case 'radiant-square':
      return cutCornerRect(0.25)
    case 'baguette':
      return rect()
    case 'octagon':
      return cutCornerRect(2 - Math.sqrt(2)) // regular octagon when square
    case 'triangle':
      return triangleOutline(0, 0)
    case 'trillion':
      return triangleOutline(0.35, 0)
    case 'trillion-curved':
      return triangleOutline(0.35, 0.18)
    case 'marquise':
      return marquiseOutline()
    case 'pear':
      return pearOutline()
    case 'heart':
      return heartOutline()
    case 'calf':
      return calfOutline()
    case 'half-moon':
      return halfMoonOutline()
  }
}

// ---------- vertical structure ----------

interface Tier {
  /** Outline scale factor at this height. */
  scale: number
  y: number
}

function gemTiers(style: 'brilliant' | 'step', H: number): { tiers: Tier[]; culetScale: number } {
  if (style === 'brilliant') {
    // pavilion 66%, girdle 6%, crown 28%; 55% table
    return {
      culetScale: 0,
      tiers: [
        { scale: 1, y: 0.66 * H },
        { scale: 1, y: 0.72 * H },
        { scale: 0.8, y: 0.89 * H },
        { scale: 0.55, y: H },
      ],
    }
  }
  // step cuts: terraced pavilion + crown; 62% table, keel pad instead of point
  return {
    culetScale: 0.18,
    tiers: [
      { scale: 0.55, y: 0.3 * H },
      { scale: 0.82, y: 0.58 * H },
      { scale: 1, y: 0.72 * H },
      { scale: 1, y: 0.78 * H },
      { scale: 0.86, y: 0.9 * H },
      { scale: 0.62, y: H },
    ],
  }
}

function layerFromOutline(outline: Loop2, scale: number, y: number): Vec3[] {
  return outline.map(([x, z]): Vec3 => [x * scale, y, z * scale])
}

export function generateGem(p: GemParams): MeshData {
  const info = gemCutInfo(p.cut)
  const W = info.square ? p.length : p.width
  const H = p.height ?? gemDefaultHeight(p.cut, p.length, W)
  const outline = normalizeLoop(outlineFor(p.cut), p.length, W)
  const { tiers, culetScale } = gemTiers(info.style, H)

  if (culetScale === 0) {
    const layers = tiers.map((t) => layerFromOutline(outline, t.scale, t.y))
    return restOnGround(loftLoops(layers, [0, 0, 0], 'fan'))
  }
  const layers = [
    layerFromOutline(outline, culetScale, 0),
    ...tiers.map((t) => layerFromOutline(outline, t.scale, t.y)),
  ]
  return restOnGround(loftLoops(layers, 'fan', 'fan'))
}

/**
 * Matching cutter mesh: the pavilion + girdle inflated by `clearance`, with a
 * straight prism extension above the girdle — boolean-subtract it from a host
 * model to cut a seat for the gem. Aligned with generateGem (culet at y ≈ 0).
 */
export function generateGemCutter(p: GemParams, clearance = 0.05): MeshData {
  const info = gemCutInfo(p.cut)
  const W = info.square ? p.length : p.width
  const H = p.height ?? gemDefaultHeight(p.cut, p.length, W)
  const outline = normalizeLoop(
    outlineFor(p.cut),
    p.length + 2 * clearance,
    W + 2 * clearance,
  )
  const { tiers, culetScale } = gemTiers(info.style, H)
  // pavilion + girdle tiers only (everything below the widest band's top)
  const girdleTop = tiers.filter((t) => t.scale === 1).at(-1)!
  const pavilion = tiers.filter((t) => t.y <= girdleTop.y)
  const extension = H // straight wall above the girdle, open the seat upward

  const layers = [
    ...(culetScale > 0 ? [layerFromOutline(outline, culetScale, -clearance)] : []),
    ...pavilion.map((t) => layerFromOutline(outline, t.scale, t.y)),
    layerFromOutline(outline, 1, girdleTop.y + extension),
  ]
  const bottom = culetScale > 0 ? 'fan' : ([0, -clearance, 0] as Vec3)
  return loftLoops(layers, bottom, 'fan')
}
