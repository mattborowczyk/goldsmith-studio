import { describe, expect, it } from 'vitest'
import { billHours, buildReportModel, reportToText, type ReportInput } from './reportModel'

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    template: 'quote',
    branding: { businessName: 'Acme Jewellers', contact: '', logo: '' },
    title: 'Solitaire for J. Smith',
    date: '2026-06-13T10:00:00.000Z',
    currency: 'USD',
    lossFactorPct: 0,
    labour: { hours: 1.1, rate: 50, billing: '30min' },
    showMetalPrices: true,
    notes: 'Polish to high shine.',
    parts: [
      {
        name: 'Band',
        materialName: 'Gold 14k yellow',
        density: 13.05,
        pricePerGram: 60,
        volumeMm3: 1000,
        areaMm2: 500,
        bbox: [10, 10, 2],
      },
    ],
    gems: [{ cut: 'Round', sizeMm: '6.0', qty: 2 }],
    sceneBbox: [20, 20, 5],
    ...overrides,
  }
}

describe('billing increments', () => {
  it('exact returns the raw hours', () => {
    expect(billHours(1.1, 'exact')).toBeCloseTo(1.1)
  })
  it('rounds up to the chosen increment', () => {
    expect(billHours(0.3, '15min')).toBeCloseTo(0.5)
    expect(billHours(1.1, '30min')).toBeCloseTo(1.5)
    expect(billHours(2.1, '1h')).toBeCloseTo(3)
  })
})

describe('buildReportModel', () => {
  it('computes weight, cost and totals for a known scene', () => {
    const model = buildReportModel(baseInput())
    expect(model.parts[0].weightG).toBeCloseTo(13.05, 2)
    expect(model.parts[0].cost).toBeCloseTo(783, 0)
    expect(model.grandWeightG).toBeCloseTo(13.05, 2)
    expect(model.grandMaterialCost).toBeCloseTo(783, 0)
    // 1.1 h billed at 30 min → 1.5 h × 50 = 75
    expect(model.labour?.billedHours).toBeCloseTo(1.5)
    expect(model.labour?.cost).toBeCloseTo(75)
    expect(model.grandTotal).toBeCloseTo(858, 0)
  })

  it('groups gems straight through and flags sections for the quote template', () => {
    const model = buildReportModel(baseInput())
    expect(model.show).toMatchObject({
      cost: true,
      labour: true,
      gems: true,
      metalPrices: true,
      notes: true,
    })
    expect(model.gems).toHaveLength(1)
    expect(model.materialTotals[0].name).toBe('Gold 14k yellow')
  })

  it('casting spec hides cost and labour', () => {
    const model = buildReportModel(baseInput({ template: 'casting' }))
    expect(model.show.cost).toBe(false)
    expect(model.show.labour).toBe(false)
    expect(model.labour).toBeNull()
    expect(model.grandTotal).toBe(0)
    // weight is still reported for the caster
    expect(model.grandWeightG).toBeCloseTo(13.05, 2)
  })

  it('applies the casting loss factor to part cost', () => {
    const model = buildReportModel(baseInput({ lossFactorPct: 10 }))
    expect(model.parts[0].cost).toBeCloseTo(783 * 1.1, 0)
  })
})

describe('reportToText', () => {
  it('renders the key sections', () => {
    const text = reportToText(buildReportModel(baseInput()))
    expect(text).toContain('Acme Jewellers')
    expect(text).toContain('Client Quote — Solitaire for J. Smith')
    expect(text).toContain('GEMSTONES')
    expect(text).toContain('2× Round 6.0 mm')
    expect(text).toContain('LABOUR')
    expect(text).toContain('TOTAL:')
    expect(text).toContain('NOTES')
  })
})
