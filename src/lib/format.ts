/**
 * Human-readable byte size using decimal (SI) units, e.g. 1_500_000_000 → "1.5 GB".
 * Storage quotas read in bytes; GB/MB is what a bench user thinks in. Returns "—"
 * for non-finite/negative input so a bad estimate never renders as "NaN".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000
    i++
  }
  const rounded = i === 0 ? Math.round(value) : parseFloat(value.toFixed(1))
  return `${rounded} ${units[i]}`
}
