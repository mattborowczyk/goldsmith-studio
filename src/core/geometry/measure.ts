import type { MeshData, RingFrame } from '../types'

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

/**
 * Recover the full cylindrical frame the resizer deforms about: ring axis
 * (smallest bbox extent), the in-plane bbox centre, and inner/outer radii.
 * Mirrors estimateInnerDiameter's axis/hole logic but also returns the centre,
 * axial midpoint and outer radius. Returns null when there is no through-hole.
 */
export function analyzeRingFrame(mesh: MeshData): RingFrame | null {
  const p = mesh.positions
  if (p.length < 9) return null

  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const val = p[i + k]
      if (val < min[k]) min[k] = val
      if (val > max[k]) max[k] = val
    }
  }
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  let axis = 0
  if (ext[1] < ext[axis]) axis = 1
  if (ext[2] < ext[axis]) axis = 2
  const u = (axis + 1) % 3
  const v = (axis + 2) % 3
  let cu = (min[u] + max[u]) / 2
  let cv = (min[v] + max[v]) / 2

  const idx = mesh.indices

  // Refine the in-plane centre to the centre of the finger hole. The bbox
  // centre is skewed when the ring is radially asymmetric (a solitaire head, a
  // variable band): sample the inner rim (per-angle nearest vertex) and fit a
  // circle to it, which recovers the true axis the head auto-detect and the
  // deformation both need.
  const BINS = 120
  for (let iter = 0; iter < 4; iter++) {
    const minR2 = new Float64Array(BINS).fill(Infinity)
    const rimU = new Float64Array(BINS)
    const rimV = new Float64Array(BINS)
    for (let i = 0; i < p.length; i += 3) {
      const du = p[i + u] - cu
      const dv = p[i + v] - cv
      const r2 = du * du + dv * dv
      let b = Math.floor(((Math.atan2(dv, du) + Math.PI) / (2 * Math.PI)) * BINS)
      if (b >= BINS) b = BINS - 1
      if (r2 < minR2[b]) {
        minR2[b] = r2
        rimU[b] = p[i + u]
        rimV[b] = p[i + v]
      }
    }
    const rim: [number, number][] = []
    for (let b = 0; b < BINS; b++) if (minR2[b] !== Infinity) rim.push([rimU[b], rimV[b]])
    const fit = fitCircleCenter(rim)
    if (!fit) break
    const moved = Math.hypot(fit[0] - cu, fit[1] - cv)
    cu = fit[0]
    cv = fit[1]
    if (moved < 1e-5) break
  }

  // reject solid parts (a triangle covering the refined centre means no hole).
  // Run after the fit so a skewed bbox centre on an asymmetric ring — a chunky
  // solitaire head — can't land in solid material and false-reject a real ring.
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
  let maxR2 = 0
  for (let i = 0; i < p.length; i += 3) {
    const du = p[i + u] - cu
    const dv = p[i + v] - cv
    const r2 = du * du + dv * dv
    if (r2 < minR2) minR2 = r2
    if (r2 > maxR2) maxR2 = r2
  }
  const innerR = Math.sqrt(minR2)
  const outerR = Math.sqrt(maxR2)
  if (outerR <= 0 || innerR < outerR * 0.05) return null
  return {
    axis: axis as 0 | 1 | 2,
    center: [cu, cv],
    axialCenter: (min[axis] + max[axis]) / 2,
    innerR,
    outerR,
  }
}

/**
 * Kåsa algebraic circle fit — returns the best-fit centre [x, y] of 2D points,
 * or null when degenerate. Bias-free with respect to angular sampling (unlike a
 * plain centroid), so it recovers the true axis from a subsampled inner rim.
 */
function fitCircleCenter(pts: [number, number][]): [number, number] | null {
  const n = pts.length
  if (n < 3) return null
  let mx = 0, my = 0
  for (const [x, y] of pts) { mx += x; my += y }
  mx /= n
  my /= n
  let Suu = 0, Suv = 0, Svv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0
  for (const [x, y] of pts) {
    const u = x - mx
    const v = y - my
    Suu += u * u
    Suv += u * v
    Svv += v * v
    Suuu += u * u * u
    Svvv += v * v * v
    Suvv += u * v * v
    Svuu += v * u * u
  }
  const det = Suu * Svv - Suv * Suv
  if (Math.abs(det) < 1e-12) return null
  const bx = 0.5 * (Suuu + Suvv)
  const by = 0.5 * (Svvv + Svuu)
  const uc = (bx * Svv - by * Suv) / det
  const vc = (by * Suu - bx * Suv) / det
  return [uc + mx, vc + my]
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
