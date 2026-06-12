import type { MeshData } from '../types'

/**
 * Fast single-pass |volume| (mm³) + surface area (mm²). Lighter than
 * analyzeMesh (no topology maps) — used by the Cost tab on every part.
 */
export function volumeAndArea(mesh: MeshData): { volume: number; area: number } {
  const p = mesh.positions
  const idx = mesh.indices
  let vol6 = 0
  let area2 = 0
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t] * 3
    const i1 = idx[t + 1] * 3
    const i2 = idx[t + 2] * 3
    const ax = p[i0], ay = p[i0 + 1], az = p[i0 + 2]
    const bx = p[i1], by = p[i1 + 1], bz = p[i1 + 2]
    const cx = p[i2], cy = p[i2 + 1], cz = p[i2 + 2]
    // signed tetra volume ×6 (divergence theorem)
    vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
    // cross product of edges ×2
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    area2 += Math.sqrt(nx * nx + ny * ny + nz * nz)
  }
  return { volume: Math.abs(vol6) / 6, area: area2 / 2 }
}

export interface InnerDiameterEstimate {
  /** mm */
  diameter: number
  /** Bounding-box axis assumed to be the ring axis. */
  axis: 'x' | 'y' | 'z'
}

/**
 * Ring inner-diameter estimate: assume the ring axis is the smallest
 * bounding-box extent; the inner radius is then the smallest radial vertex
 * distance from that axis. Returns null when there is no detectable hole
 * (e.g. a solid signet top reaches the axis).
 */
export function estimateInnerDiameter(mesh: MeshData): InnerDiameterEstimate | null {
  const p = mesh.positions
  if (p.length < 9) return null

  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  let axis = 0
  if (ext[1] < ext[axis]) axis = 1
  if (ext[2] < ext[axis]) axis = 2
  const u = (axis + 1) % 3
  const v = (axis + 2) % 3
  const cu = (min[u] + max[u]) / 2
  const cv = (min[v] + max[v]) / 2

  // No through-hole if any triangle, projected along the axis, covers the axis
  // point (e.g. a cube's top face, a signet's solid table).
  const idx = mesh.indices
  for (let t = 0; t < idx.length; t += 3) {
    if (
      triCovers2D(
        p[idx[t] * 3 + u] - cu, p[idx[t] * 3 + v] - cv,
        p[idx[t + 1] * 3 + u] - cu, p[idx[t + 1] * 3 + v] - cv,
        p[idx[t + 2] * 3 + u] - cu, p[idx[t + 2] * 3 + v] - cv,
      )
    ) {
      return null
    }
  }

  let minR2 = Infinity
  for (let i = 0; i < p.length; i += 3) {
    const du = p[i + u] - cu
    const dv = p[i + v] - cv
    const r2 = du * du + dv * dv
    if (r2 < minR2) minR2 = r2
  }
  const innerR = Math.sqrt(minR2)
  const outerR = Math.max(ext[u], ext[v]) / 2
  if (outerR <= 0 || innerR < outerR * 0.05) return null
  return { diameter: innerR * 2, axis: (['x', 'y', 'z'] as const)[axis] }
}

/** Does the 2D triangle (a,b,c) contain the origin? (sign-consistency test) */
function triCovers2D(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = ax * by - ay * bx
  const d2 = bx * cy - by * cx
  const d3 = cx * ay - cy * ax
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}
