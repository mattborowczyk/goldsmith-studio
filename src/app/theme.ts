/**
 * Accent-colour presets (plan §2.8 theming). Each swaps the hue/chroma of the
 * gold `--primary`/`--accent`/`--ring` oklch tokens defined in src/index.css.
 * The dark studio surfaces stay put; only the warm metal accent changes. The
 * choice is persisted in settings and re-applied on session restore.
 */

export interface AccentPreset {
  id: string
  label: string
  /** oklch chroma for --primary, and hue for the whole accent family. */
  chroma: number
  hue: number
}

export const ACCENTS: AccentPreset[] = [
  { id: 'gold', label: 'Gold', chroma: 0.13, hue: 85 },
  { id: 'rose', label: 'Rose gold', chroma: 0.11, hue: 40 },
  { id: 'ruby', label: 'Ruby', chroma: 0.16, hue: 22 },
  { id: 'emerald', label: 'Emerald', chroma: 0.13, hue: 155 },
  { id: 'sapphire', label: 'Sapphire', chroma: 0.13, hue: 255 },
  { id: 'platinum', label: 'Platinum', chroma: 0.02, hue: 250 },
]

export const DEFAULT_ACCENT = 'gold'

/** Write the accent's oklch tokens onto :root, mirroring index.css's defaults. */
export function applyAccent(id: string): void {
  const a = ACCENTS.find((p) => p.id === id) ?? ACCENTS[0]
  const root = document.documentElement.style
  root.setProperty('--primary', `oklch(0.78 ${a.chroma} ${a.hue})`)
  root.setProperty('--primary-foreground', `oklch(0.2 0.03 ${a.hue})`)
  root.setProperty('--accent', `oklch(0.32 0.03 ${a.hue})`)
  root.setProperty('--accent-foreground', `oklch(0.88 ${(a.chroma * 0.7).toFixed(3)} ${a.hue})`)
  root.setProperty('--ring', `oklch(0.78 ${a.chroma} ${a.hue} / 0.6)`)
}
