import { describe, expect, it } from 'vitest'
import { formatBytes } from './format'

describe('formatBytes', () => {
  it('formats across decimal unit boundaries', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1000)).toBe('1 KB')
    expect(formatBytes(1_500_000)).toBe('1.5 MB')
    expect(formatBytes(4_000_000_000)).toBe('4 GB')
    expect(formatBytes(1_234_000_000)).toBe('1.2 GB')
  })

  it('promotes to the next unit when rounding tips over', () => {
    // 999.95 KB rounds to 1000.0 KB → should read as 1 MB, not "1000 KB"
    expect(formatBytes(999_950)).toBe('1 MB')
  })

  it('returns a dash for unusable input', () => {
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(NaN)).toBe('—')
    expect(formatBytes(Infinity)).toBe('—')
  })
})
