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

  it('returns a dash for unusable input', () => {
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(NaN)).toBe('—')
    expect(formatBytes(Infinity)).toBe('—')
  })
})
