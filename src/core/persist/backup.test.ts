import { describe, expect, it } from 'vitest'
import { makeCube } from '../geometry/testFixtures'
import type { Material, HistoryEntry } from '../calc/materials'
import type { DatabaseDump, SavedPart, SavedSettings } from './db'
import { BACKUP_FORMAT, parseBackup, serializeBackup } from './backup'

function sampleDump(): DatabaseDump {
  const cube = makeCube(10, [2, 3, 4])
  const part: SavedPart = {
    id: 'part-1',
    name: 'Ring',
    visible: true,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    positions: cube.positions,
    indices: cube.indices,
    order: 0,
    material: 'gold',
    flatShading: false,
  }
  const settings: SavedSettings = {
    displayMode: 'gold',
    background: 'studio',
    gridVisible: true,
    accent: 'rose',
  }
  const material: Material = {
    id: 'au14',
    name: '14k Yellow',
    density: 13.05,
    pricePerGram: 42,
    color: '#e8c260',
    builtin: true,
  }
  const history: HistoryEntry = {
    id: 'h-1',
    date: '2026-06-14T00:00:00.000Z',
    model: 'Ring',
    material: '14k Yellow',
    volumeMm3: 1000,
    weightG: 13.05,
    cost: 548.1,
    currency: 'USD',
  }
  return {
    parts: [part],
    settings: [{ key: 'app', value: settings }],
    materials: [material],
    history: [history],
    kv: [
      { key: 'costSettings', value: { lossFactorPct: 5, currency: 'USD' } },
      { key: 'measureColor', value: '#e8c260' },
    ],
  }
}

describe('backup round-trip', () => {
  it('reproduces every store through serialize → JSON → parse', () => {
    const dump = sampleDump()
    const restored = parseBackup(serializeBackup(dump))

    expect(restored.settings).toEqual(dump.settings)
    expect(restored.materials).toEqual(dump.materials)
    expect(restored.history).toEqual(dump.history)
    expect(restored.kv).toEqual(dump.kv)
  })

  it('preserves part typed arrays, triangle count and bounding box', () => {
    const dump = sampleDump()
    const [orig] = dump.parts
    const [part] = parseBackup(serializeBackup(dump)).parts

    expect(part.positions).toBeInstanceOf(Float32Array)
    expect(part.indices).toBeInstanceOf(Uint32Array)
    // exact contents survive the base64 round-trip
    expect(Array.from(part.positions)).toEqual(Array.from(orig.positions))
    expect(Array.from(part.indices)).toEqual(Array.from(orig.indices))
    // triangle count
    expect(part.indices.length / 3).toBe(orig.indices.length / 3)
    // bounding box (cube of 10 offset by [2,3,4])
    const xs = part.positions.filter((_, i) => i % 3 === 0)
    expect(Math.min(...xs)).toBe(2)
    expect(Math.max(...xs)).toBe(12)
    // metadata carried alongside the geometry
    expect(part.id).toBe(orig.id)
    expect(part.matrix).toEqual(orig.matrix)
    expect(part.material).toBe('gold')
  })

  it('produces JSON tagged with the format and version', () => {
    const file = JSON.parse(serializeBackup(sampleDump()))
    expect(file.format).toBe(BACKUP_FORMAT)
    expect(file.version).toBe(1)
    expect(typeof file.createdAt).toBe('string')
  })
})

describe('backup validation', () => {
  it('rejects non-JSON input', () => {
    expect(() => parseBackup('not json {')).toThrow(/JSON/i)
  })

  it('rejects a foreign file (wrong format tag)', () => {
    expect(() => parseBackup(JSON.stringify({ format: 'something-else', version: 1, data: {} }))).toThrow(
      /not a GoldSmith Studio backup/i,
    )
  })

  it('rejects an unsupported version', () => {
    const file = JSON.parse(serializeBackup(sampleDump()))
    file.version = 999
    expect(() => parseBackup(JSON.stringify(file))).toThrow(/version/i)
  })

  it('rejects a payload with a missing store', () => {
    const file = JSON.parse(serializeBackup(sampleDump()))
    delete file.data.materials
    expect(() => parseBackup(JSON.stringify(file))).toThrow(/materials/i)
  })

  it('rejects a part with missing geometry', () => {
    const file = JSON.parse(serializeBackup(sampleDump()))
    delete file.data.parts[0].positions
    expect(() => parseBackup(JSON.stringify(file))).toThrow(/geometry/i)
  })

  it('rejects a part with corrupt base64 geometry', () => {
    const file = JSON.parse(serializeBackup(sampleDump()))
    file.data.parts[0].positions = '@@@ not base64 @@@'
    expect(() => parseBackup(JSON.stringify(file))).toThrow(/corrupt/i)
  })

  it('rejects an identified-store entry missing its id', () => {
    const file = JSON.parse(serializeBackup(sampleDump()))
    delete file.data.materials[0].id
    expect(() => parseBackup(JSON.stringify(file))).toThrow(/materials/i)
  })

  it('rejects a keyed-store entry missing its key', () => {
    const file = JSON.parse(serializeBackup(sampleDump()))
    file.data.kv[0] = { value: 'orphaned' } // no key
    expect(() => parseBackup(JSON.stringify(file))).toThrow(/kv/i)
  })
})
