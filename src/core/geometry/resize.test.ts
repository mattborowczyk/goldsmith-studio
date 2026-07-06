import { describe, expect, it } from 'vitest'
import {
  anglePointOnRing,
  detectHeadAngleDeg,
  planResize,
  pointAngleDeg,
  resizeRing,
  resizeStrainField,
  ringResizeWeight,
} from './resize'
import { analyzeRingFrame } from './measure'
import { analyzeMesh } from './meshAnalysis'
import { signedVolume } from '../generators/meshBuilder'
import { defaultRingParams, generateBandRing } from '../generators/bandRing'
import type { MeshData, RingFrame } from '../types'

const Z_FRAME: RingFrame = {
  axis: 2,
  center: [0, 0],
  axialCenter: 0,
  innerR: 8,
  outerR: 10,
}

/**
 * Sculpted solitaire fixture: a watertight band (torus-grid topology) with a
 * flat round bore, a bumpy sculpted outer surface, and a bulky head near 90°.
 * The bore being exactly circular makes roundness assertions exact.
 */
function makeSculptedRing(opts: { innerR?: number; segments?: number } = {}): MeshData {
  const rIn = opts.innerR ?? 8
  const N = opts.segments ?? 240
  const wall = 1.5
  const halfW = 1.5 // z half-width
  const bumpAmp = 0.35
  const bumpFreq = 24
  const headDeg = 90
  const positions = new Float32Array(N * 4 * 3)
  for (let s = 0; s < N; s++) {
    const theta = (s / N) * 2 * Math.PI
    const deg = (theta * 180) / Math.PI
    // sculpted outer surface + a gaussian head bulge at 90°
    const dHead = Math.abs(((deg - headDeg + 540) % 360) - 180)
    const head = 2.5 * Math.exp(-(dHead * dHead) / (2 * 15 * 15))
    const rOut = rIn + wall + bumpAmp * Math.sin(bumpFreq * theta) + head
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    const base = s * 12
    // v0 inner/z−, v1 outer/z−, v2 outer/z+, v3 inner/z+
    positions.set([rIn * cos, rIn * sin, -halfW], base)
    positions.set([rOut * cos, rOut * sin, -halfW], base + 3)
    positions.set([rOut * cos, rOut * sin, halfW], base + 6)
    positions.set([rIn * cos, rIn * sin, halfW], base + 9)
  }
  const indices: number[] = []
  const quad = (a: number, b: number, c: number, d: number) => {
    indices.push(a, b, c, a, c, d)
  }
  for (let s = 0; s < N; s++) {
    const i = s * 4
    const j = ((s + 1) % N) * 4
    quad(i + 0, j + 0, j + 1, i + 1) // bottom (−z out)
    quad(i + 1, j + 1, j + 2, i + 2) // outer wall (radial out)
    quad(i + 2, j + 2, j + 3, i + 3) // top (+z out)
    quad(i + 3, j + 3, j + 0, i + 0) // inner wall (radial in)
  }
  return { positions, indices: new Uint32Array(indices) }
}

/** Radial distance of vertex i from the frame centre, in the ring plane. */
function radialOf(p: Float32Array, i: number, frame: RingFrame): number {
  const u = (frame.axis + 1) % 3
  const v = (frame.axis + 2) % 3
  return Math.hypot(p[i + u] - frame.center[0], p[i + v] - frame.center[1])
}

function angleOf(p: Float32Array, i: number, frame: RingFrame): number {
  return pointAngleDeg([p[i], p[i + 1], p[i + 2]], frame)
}

function angleDist(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

describe('pointAngleDeg', () => {
  it('returns the angle of cardinal points around the axis', () => {
    expect(pointAngleDeg([1, 0, 0], Z_FRAME)).toBeCloseTo(0, 6)
    expect(pointAngleDeg([0, 1, 0], Z_FRAME)).toBeCloseTo(90, 6)
    expect(pointAngleDeg([-1, 0, 0], Z_FRAME)).toBeCloseTo(180, 6)
    expect(pointAngleDeg([0, -1, 0], Z_FRAME)).toBeCloseTo(270, 6)
  })

  it('is offset by the in-plane centre', () => {
    const frame: RingFrame = { ...Z_FRAME, center: [5, 5] }
    expect(pointAngleDeg([6, 5, 0], frame)).toBeCloseTo(0, 6)
    expect(pointAngleDeg([5, 6, 0], frame)).toBeCloseTo(90, 6)
  })
})

describe('anglePointOnRing', () => {
  it('round-trips with pointAngleDeg', () => {
    for (const deg of [0, 37, 90, 211, 359]) {
      const pt = anglePointOnRing(Z_FRAME, deg, 9)
      expect(pt[2]).toBeCloseTo(0, 6) // sits at axialCenter on the ring axis
      expect(pointAngleDeg(pt, Z_FRAME)).toBeCloseTo(deg, 4)
    }
  })
})

describe('ringResizeWeight', () => {
  it('is 0 inside the protected zone, 1 in the free shank, smooth between', () => {
    expect(ringResizeWeight(90, 90, 45, 40)).toBe(0)
    expect(ringResizeWeight(110, 90, 45, 40)).toBe(0) // 20° < 22.5° still rigid
    expect(ringResizeWeight(270, 90, 45, 40)).toBe(1) // opposite side, fully free
    const mid = ringResizeWeight(90 + 22.5 + 20, 90, 45, 40)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })

  it('wraps across 0/360', () => {
    expect(ringResizeWeight(350, 10, 45, 40)).toBe(0) // 20° apart across the wrap
  })
})

describe('resizeRing — uniform (wedding band)', () => {
  const mesh = generateBandRing({ ...defaultRingParams(), innerDiameter: 17, profile: 'flat' })
  const frame = analyzeRingFrame(mesh)!

  it('reaches the requested target inner diameter', () => {
    const target = 19
    const resized = resizeRing(mesh, { frame, mode: 'uniform', targetInnerDiameter: target })
    const after = analyzeRingFrame(resized)!
    expect(after.innerR * 2).toBeCloseTo(target, 3)
  })

  it('preserves wall thickness (radius moves by a constant Δ)', () => {
    const before = frame.outerR - frame.innerR
    const resized = resizeRing(mesh, { frame, mode: 'uniform', targetInnerDiameter: 14 })
    const after = analyzeRingFrame(resized)!
    expect(after.outerR - after.innerR).toBeCloseTo(before, 4)
  })

  it('keeps a smooth band a perfect annulus (remap is invisible without texture)', () => {
    const resized = resizeRing(mesh, { frame, mode: 'uniform', targetInnerDiameter: 20 })
    const after = analyzeRingFrame(resized)!
    const p = resized.positions
    let minR = Infinity
    let maxOfInner = 0
    for (let i = 0; i < p.length; i += 3) {
      const r = radialOf(p, i, after)
      if (r < minR) minR = r
      if (r < 10.1 && r > maxOfInner) maxOfInner = r // bore-surface verts
    }
    expect(minR).toBeGreaterThanOrEqual(10 - 1e-4)
    expect(maxOfInner).toBeLessThanOrEqual(10 + 1e-4)
  })

  it('stays a single watertight solid with positive volume', () => {
    const resized = resizeRing(mesh, { frame, mode: 'uniform', targetInnerDiameter: 20 })
    const report = analyzeMesh(resized)
    expect(report.watertight).toBe(true)
    expect(report.shells).toBe(1)
    expect(signedVolume(resized)).toBeGreaterThan(0)
  })
})

describe('resizeRing — input validation', () => {
  const mesh = generateBandRing({ ...defaultRingParams(), innerDiameter: 17, profile: 'flat' })
  const frame = analyzeRingFrame(mesh)!

  it('rejects non-finite or non-positive target diameters', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(() => resizeRing(mesh, { frame, mode: 'uniform', targetInnerDiameter: bad })).toThrow()
    }
  })
})

describe('resizeRing — protect-head (solitaire)', () => {
  const mesh = makeSculptedRing()
  const frame = analyzeRingFrame(mesh)!
  const headDeg = 90
  const protectedDeg = 45
  const smoothingDeg = 40
  const opts = {
    frame,
    mode: 'protect-head' as const,
    targetInnerDiameter: 19, // Ø16 → Ø19: a big upsize
    protectedCenterDeg: headDeg,
    protectedDeg,
    smoothingDeg,
  }
  const resized = resizeRing(mesh, opts)
  const plan = planResize(opts)

  it('detects the fixture frame as expected', () => {
    expect(frame.axis).toBe(2)
    expect(frame.innerR).toBeCloseTo(8, 3)
    expect(angleDist(detectHeadAngleDeg(mesh, frame), headDeg)).toBeLessThan(5)
  })

  it('keeps the bore perfectly round at the target radius outside the head', () => {
    const p = resized.positions
    const src = mesh.positions
    let checked = 0
    for (let i = 0; i < p.length; i += 3) {
      if (Math.abs(radialOf(src, i, frame) - frame.innerR) > 1e-6) continue // bore verts only
      const deg = angleOf(src, i, frame)
      if (angleDist(deg, headDeg) < protectedDeg / 2 + smoothingDeg + 1) continue
      expect(radialOf(p, i, frame)).toBeCloseTo(9.5, 4)
      checked++
    }
    expect(checked).toBeGreaterThan(100)
  })

  it('never lets any vertex protrude inside the target circle (gauge passes)', () => {
    const p = resized.positions
    let minR = Infinity
    for (let i = 0; i < p.length; i += 3) {
      const r = radialOf(p, i, frame)
      if (r < minR) minR = r
    }
    expect(minR).toBeGreaterThanOrEqual(9.5 - 1e-6)
  })

  it('moves the head rigidly: one shared translation, shape exactly preserved', () => {
    const src = mesh.positions
    const out = resized.positions
    const headIdx: number[] = []
    for (let i = 0; i < src.length; i += 3) {
      if (angleDist(angleOf(src, i, frame), headDeg) <= protectedDeg / 2 - 1) headIdx.push(i)
    }
    expect(headIdx.length).toBeGreaterThan(20)
    const dx = out[headIdx[0]] - src[headIdx[0]]
    const dy = out[headIdx[0] + 1] - src[headIdx[0] + 1]
    for (const i of headIdx) {
      expect(out[i] - src[i]).toBeCloseTo(dx, 6)
      expect(out[i + 1] - src[i + 1]).toBeCloseTo(dy, 6)
      expect(out[i + 2] - src[i + 2]).toBeCloseTo(0, 6)
    }
    // the slide is along the head direction (+Y at 90°) and outward for an upsize
    expect(Math.abs(dx)).toBeLessThan(1e-6)
    expect(dy).toBeGreaterThan(1)
  })

  it('preserves sculpted texture spacing in the arms (bent, not stretched)', () => {
    const src = mesh.positions
    const out = resized.positions
    // adjacent bore vertices in the arms: chord length must be preserved
    let checked = 0
    for (let s = 0; s < 240 - 1; s++) {
      const i = s * 12 // v0 of slice s (bore, z−)
      const j = (s + 1) * 12
      const degI = angleOf(src, i, frame)
      const degJ = angleOf(src, j, frame)
      const seamDist = Math.min(angleDist(degI, plan.seamCenterDeg), angleDist(degJ, plan.seamCenterDeg))
      const headDist = Math.min(angleDist(degI, headDeg), angleDist(degJ, headDeg))
      if (headDist < protectedDeg / 2 + smoothingDeg + 2) continue
      if (seamDist < plan.seamDeg / 2 + 2) continue
      const before = Math.hypot(src[j] - src[i], src[j + 1] - src[i + 1], src[j + 2] - src[i + 2])
      const after = Math.hypot(out[j] - out[i], out[j + 1] - out[i + 1], out[j + 2] - out[i + 2])
      expect(after / before).toBeCloseTo(1, 2)
      checked++
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('concentrates the stretch in the seam sector at the predicted rate', () => {
    const src = mesh.positions
    const out = resized.positions
    let checked = 0
    for (let s = 0; s < 240 - 1; s++) {
      const i = s * 12
      const j = (s + 1) * 12
      const degI = angleOf(src, i, frame)
      const degJ = angleOf(src, j, frame)
      // both endpoints inside the seam plateau (central half of the sector)
      if (angleDist(degI, plan.seamCenterDeg) > plan.seamDeg / 4 - 1) continue
      if (angleDist(degJ, plan.seamCenterDeg) > plan.seamDeg / 4 - 1) continue
      const before = Math.hypot(src[j] - src[i], src[j + 1] - src[i + 1], src[j + 2] - src[i + 2])
      const after = Math.hypot(out[j] - out[i], out[j + 1] - out[i + 1], out[j + 2] - out[i + 2])
      expect(after / before).toBeCloseTo(plan.seamBoreScale, 1)
      checked++
    }
    expect(checked).toBeGreaterThan(5)
  })

  it('remains watertight with positive volume', () => {
    const report = analyzeMesh(resized)
    expect(report.watertight).toBe(true)
    expect(report.shells).toBe(1)
    expect(signedVolume(resized)).toBeGreaterThan(0)
  })

  it('downsizing also keeps the bore round and the gauge exact', () => {
    const down = resizeRing(mesh, { ...opts, targetInnerDiameter: 14 })
    const p = down.positions
    let minR = Infinity
    for (let i = 0; i < p.length; i += 3) {
      const r = radialOf(p, i, frame)
      if (r < minR) minR = r
    }
    expect(minR).toBeGreaterThanOrEqual(7 - 1e-6)
    expect(minR).toBeLessThanOrEqual(7 + 1e-3)
    const after = analyzeRingFrame(down)!
    expect(after.innerR * 2).toBeCloseTo(14, 3)
  })

  it('is stable across repeated resizes (up then back down)', () => {
    const up = resizeRing(mesh, { ...opts, targetInnerDiameter: 19 })
    const upFrame = analyzeRingFrame(up)!
    const back = resizeRing(up, {
      ...opts,
      frame: upFrame,
      protectedCenterDeg: detectHeadAngleDeg(up, upFrame),
      targetInnerDiameter: 16,
    })
    const backFrame = analyzeRingFrame(back)!
    expect(backFrame.innerR * 2).toBeCloseTo(16, 3)
    expect(analyzeMesh(back).watertight).toBe(true)
  })
})

describe('planResize — seam closure and fold guard', () => {
  const frame: RingFrame = { ...Z_FRAME, innerR: 9.5, outerR: 11.5 }
  const base = {
    frame,
    mode: 'protect-head' as const,
    protectedCenterDeg: 90,
    protectedDeg: 45,
    smoothingDeg: 40,
    seamDeg: 60,
  }

  it('upsizing stretches the seam, arms stay texture-true', () => {
    const plan = planResize({ ...base, targetInnerDiameter: 22 })
    expect(plan.armSlope).toBeCloseTo(plan.k, 9)
    expect(plan.armBoreScale).toBeCloseTo(1, 9)
    expect(plan.seamBoreScale).toBeGreaterThan(1)
    expect(plan.seamWidened).toBe(false)
    expect(plan.preservationRelaxed).toBe(false)
  })

  it('auto-widens a too-narrow seam on a heavy downsize instead of folding', () => {
    const plan = planResize({ ...base, targetInnerDiameter: 16, seamDeg: 8 })
    expect(plan.seamWidened).toBe(true)
    expect(plan.seamDeg).toBeGreaterThan(8)
    expect(plan.seamSlope).toBeGreaterThanOrEqual(0.25 - 1e-9)
  })

  it('relaxes arm preservation when even the widest seam cannot absorb it', () => {
    const plan = planResize({ ...base, targetInnerDiameter: 12 })
    expect(plan.preservationRelaxed).toBe(true)
    expect(plan.armSlope).toBeGreaterThan(1) // still compressing…
    expect(plan.armSlope).toBeLessThan(plan.k) // …but less than full preservation
    expect(plan.seamSlope).toBeCloseTo(0.25, 6)
  })

  it('keeps the seam clear of the head and blend zones', () => {
    const plan = planResize({ ...base, targetInnerDiameter: 22, seamCenterDeg: 100 })
    const gap = angleDist(plan.seamCenterDeg, 90)
    expect(gap).toBeGreaterThanOrEqual(45 / 2 + 40 + plan.seamDeg / 2)
  })
})

describe('resizeStrainField', () => {
  const mesh = makeSculptedRing()
  const frame = analyzeRingFrame(mesh)!
  const opts = {
    frame,
    mode: 'protect-head' as const,
    targetInnerDiameter: 19,
    protectedCenterDeg: 90,
    protectedDeg: 45,
    smoothingDeg: 40,
  }
  const plan = planResize(opts)
  const strain = resizeStrainField(mesh, opts)

  it('reports zero strain on the rigid head and ~zero on arm bore vertices', () => {
    const p = mesh.positions
    for (let i = 0, vi = 0; i < p.length; i += 3, vi++) {
      const deg = angleOf(p, i, frame)
      if (angleDist(deg, 90) <= 45 / 2 - 1) expect(strain[vi]).toBe(0)
      const isBore = Math.abs(radialOf(p, i, frame) - frame.innerR) < 1e-6
      const inArm =
        angleDist(deg, 90) > 45 / 2 + 40 + 2 && angleDist(deg, plan.seamCenterDeg) > plan.seamDeg / 2 + 2
      if (isBore && inArm) expect(Math.abs(strain[vi])).toBeLessThan(1e-6)
    }
  })

  it('reports the predicted stretch on seam-plateau bore vertices', () => {
    const p = mesh.positions
    let checked = 0
    for (let i = 0, vi = 0; i < p.length; i += 3, vi++) {
      if (Math.abs(radialOf(p, i, frame) - frame.innerR) > 1e-6) continue
      if (angleDist(angleOf(p, i, frame), plan.seamCenterDeg) > plan.seamDeg / 4 - 1) continue
      expect(strain[vi]).toBeCloseTo(plan.seamBoreScale - 1, 6)
      checked++
    }
    expect(checked).toBeGreaterThan(5)
  })
})

describe('detectHeadAngleDeg', () => {
  it('finds the bulky top of a variable band near +90°', () => {
    const mesh = generateBandRing({
      ...defaultRingParams(),
      mode: 'variable',
      top: { width: 8, thickness: 4 },
      shoulder: { width: 5, thickness: 2 },
      bottom: { width: 3, thickness: 1.4 },
    })
    const frame = analyzeRingFrame(mesh)!
    const head = detectHeadAngleDeg(mesh, frame)
    expect(Math.abs(((head - 90 + 540) % 360) - 180)).toBeLessThan(15)
  })
})
