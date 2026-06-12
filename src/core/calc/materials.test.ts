import { describe, expect, it } from 'vitest'
import {
  applySpotPrices,
  costOf,
  defaultMaterials,
  historyToCSV,
  weightGrams,
} from './materials'

describe('weight & cost math', () => {
  it('plan §8 cross-check: 10 mm cube of 14k yellow ≈ 13.05 g', () => {
    const au14 = defaultMaterials().find((m) => m.id === 'au-14k-yellow')!
    expect(weightGrams(1000, au14.density)).toBeCloseTo(13.05, 2)
  })

  it('10 mm cube of silver 925 ≈ 10.36 g', () => {
    const ag = defaultMaterials().find((m) => m.id === 'ag-925')!
    expect(weightGrams(1000, ag.density)).toBeCloseTo(10.36, 2)
  })

  it('cost applies the casting loss factor', () => {
    expect(costOf(10, 60, 0)).toBeCloseTo(600)
    expect(costOf(10, 60, 5)).toBeCloseTo(630)
  })
})

describe('spot price application', () => {
  it('scales pure-metal price by fineness, leaves non-spot materials alone', () => {
    const mats = defaultMaterials()
    const updated = applySpotPrices(mats, { gold: 100 })
    expect(updated.find((m) => m.id === 'au-14k-yellow')!.pricePerGram).toBeCloseTo(58.5, 2)
    expect(updated.find((m) => m.id === 'au-24k-yellow')!.pricePerGram).toBeCloseTo(99.9, 2)
    // silver spot not provided → untouched
    expect(updated.find((m) => m.id === 'ag-925')!.pricePerGram).toBe(0)
    expect(updated.find((m) => m.id === 'wax')!.pricePerGram).toBe(0)
  })
})

describe('history CSV', () => {
  it('formats rows and escapes fields', () => {
    const csv = historyToCSV([
      {
        id: '1',
        date: '2026-06-12T10:00:00.000Z',
        model: 'ring, "heavy"',
        material: 'Gold 14k yellow',
        volumeMm3: 1000,
        weightG: 13.05,
        cost: 763.43,
        currency: 'EUR',
      },
    ])
    const lines = csv.split('\n')
    expect(lines[0]).toBe('date,model,material,volume_mm3,weight_g,cost,currency')
    expect(lines[1]).toBe(
      '2026-06-12T10:00:00.000Z,"ring, ""heavy""",Gold 14k yellow,1000.00,13.050,763.43,EUR',
    )
  })
})
