import { describe, expect, it } from 'vitest'
import { analyzeMesh } from '../geometry/meshAnalysis'
import { defaultRingParams, generateBandRing } from './bandRing'
import { GEM_CUTS, generateGem, generateGemCutter } from './gems'
import { makeCylinder, signedVolume } from './meshBuilder'

describe('band ring generator', () => {
  it('produces a watertight, manifold solid', () => {
    const report = analyzeMesh(generateBandRing(defaultRingParams()))
    expect(report.watertight).toBe(true)
    expect(report.manifold).toBe(true)
    expect(report.shells).toBe(1)
    expect(report.volume).toBeGreaterThan(0)
  })

  it('respects the requested inner diameter (hole present)', () => {
    const p = { ...defaultRingParams(), innerDiameter: 18, profile: 'flat' as const }
    const mesh = generateBandRing(p)
    const pos = mesh.positions
    // ring axis is Z; find the XY centre (restOnGround shifts the ring in Y)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let i = 0; i < pos.length; i += 3) {
      minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i])
      minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1])
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    // narrowest radial distance from the ring axis ≈ inner radius
    let minR = Infinity
    for (let i = 0; i < pos.length; i += 3) {
      minR = Math.min(minR, Math.hypot(pos[i] - cx, pos[i + 1] - cy))
    }
    expect(minR).toBeCloseTo(9, 1)
  })

  it('variable mode is also watertight', () => {
    const report = analyzeMesh(generateBandRing({ ...defaultRingParams(), mode: 'variable' }))
    expect(report.watertight).toBe(true)
    expect(report.shells).toBe(1)
  })
})

describe('gemstone generator', () => {
  it('every cut yields a single watertight shell with positive volume', () => {
    for (const cut of GEM_CUTS) {
      const mesh = generateGem({ cut: cut.id, length: 6, width: 4, height: null })
      const report = analyzeMesh(mesh)
      expect(report.shells, cut.id).toBe(1)
      expect(report.watertight, cut.id).toBe(true)
      expect(report.invertedShells, cut.id).toBe(0)
      // signed (not absolute) volume catches winding/inversion regressions
      expect(signedVolume(mesh), cut.id).toBeGreaterThan(0)
    }
  })

  it('the cutter is larger than the gem it seats', () => {
    const params = { cut: 'round' as const, length: 6, width: 6, height: null }
    const gem = signedVolume(generateGem(params))
    const cutter = signedVolume(generateGemCutter(params, 0.08))
    expect(gem).toBeGreaterThan(0)
    expect(cutter).toBeGreaterThan(0)
    expect(cutter).toBeGreaterThan(gem)
  })
})

describe('sizer cylinder', () => {
  it('is watertight with the expected radius', () => {
    const mesh = makeCylinder(5, 2)
    const report = analyzeMesh(mesh)
    expect(report.watertight).toBe(true)
    // volume of a 96-gon prism ≈ π r² h
    expect(report.volume).toBeCloseTo(Math.PI * 25 * 2, 0)
  })
})
