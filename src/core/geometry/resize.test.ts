import { describe, expect, it } from 'vitest'
import {
  anglePointOnRing,
  detectHeadAngleDeg,
  pointAngleDeg,
  resizeRing,
  ringResizeWeight,
} from './resize'
import { analyzeRingFrame } from './measure'
import { analyzeMesh } from './meshAnalysis'
import { signedVolume } from '../generators/meshBuilder'
import { defaultRingParams, generateBandRing } from '../generators/bandRing'
import type { RingFrame } from '../types'

const Z_FRAME: RingFrame = {
  axis: 2,
  center: [0, 0],
  axialCenter: 0,
  innerR: 8,
  outerR: 10,
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
    // protected ±22.5°, smoothing 40° → free past 62.5° from centre
    expect(ringResizeWeight(90, 90, 45, 40)).toBe(0)
    expect(ringResizeWeight(110, 90, 45, 40)).toBe(0) // 20° < 22.5° still rigid
    expect(ringResizeWeight(270, 90, 45, 40)).toBe(1) // opposite side, fully free
    const mid = ringResizeWeight(90 + 22.5 + 20, 90, 45, 40)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })

  it('wraps across 0/360', () => {
    expect(ringResizeWeight(350, 10, 45, 40)).toBe(0) // 20° apart across the seam
  })
})

describe('resizeRing — uniform (wedding band)', () => {
  const mesh = generateBandRing({ ...defaultRingParams(), innerDiameter: 17, profile: 'flat' })
  const frame = analyzeRingFrame(mesh)!

  it('reaches the requested target inner diameter', () => {
    const target = 19
    const resized = resizeRing(mesh, { frame, mode: 'uniform', targetInnerDiameter: target })
    const after = analyzeRingFrame(resized)!
    expect(after.innerR * 2).toBeCloseTo(target, 1)
  })

  it('preserves wall thickness (the whole band shifts radially by Δ)', () => {
    const before = frame.outerR - frame.innerR
    const resized = resizeRing(mesh, { frame, mode: 'uniform', targetInnerDiameter: 14 })
    const after = analyzeRingFrame(resized)!
    expect(after.outerR - after.innerR).toBeCloseTo(before, 4)
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
  const mesh = generateBandRing({ ...defaultRingParams(), innerDiameter: 17, profile: 'flat' })
  const frame = analyzeRingFrame(mesh)!
  const centerDeg = 90
  const protectedDeg = 45
  const resized = resizeRing(mesh, {
    frame,
    mode: 'protect-head',
    targetInnerDiameter: 20,
    protectedCenterDeg: centerDeg,
    protectedDeg,
    smoothingDeg: 40,
  })

  it('leaves protected-zone vertices exactly in place and moves the shank', () => {
    const src = mesh.positions
    const out = resized.positions
    let protectedChecked = 0
    let shankMoved = 0
    for (let i = 0; i < src.length; i += 3) {
      const deg = pointAngleDeg([out[i], out[i + 1], out[i + 2]], frame)
      const d = Math.abs(((deg - centerDeg + 540) % 360) - 180)
      const moved =
        Math.abs(out[i] - src[i]) + Math.abs(out[i + 1] - src[i + 1]) + Math.abs(out[i + 2] - src[i + 2])
      if (d <= protectedDeg / 2 - 1) {
        expect(moved).toBeCloseTo(0, 6)
        protectedChecked++
      }
      if (d >= 150) {
        expect(moved).toBeGreaterThan(0.1)
        shankMoved++
      }
    }
    expect(protectedChecked).toBeGreaterThan(0)
    expect(shankMoved).toBeGreaterThan(0)
  })

  it('remains watertight after the protected deformation', () => {
    const report = analyzeMesh(resized)
    expect(report.watertight).toBe(true)
    expect(report.shells).toBe(1)
    expect(signedVolume(resized)).toBeGreaterThan(0)
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
    // top of the shank is +Y; with axis Z that is 90°
    expect(Math.abs(((head - 90 + 540) % 360) - 180)).toBeLessThan(15)
  })
})
