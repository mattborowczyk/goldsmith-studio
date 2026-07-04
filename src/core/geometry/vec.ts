import type { Vec3 } from '../types'

/** Normalize to unit length; a degenerate vector falls back to +Y (the default insertion axis). */
export function unit(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 1, 0]
}
