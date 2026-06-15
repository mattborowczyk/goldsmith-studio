/**
 * Compact bounding-volume hierarchy over a raw indexed triangle mesh, for fast
 * ray queries. Pure TS over typed arrays — NO Three.js — so it stays inside the
 * three-free core/geometry layer (the wall-thickness raycast runs in a worker;
 * three-mesh-bvh would drag a whole BufferGeometry/THREE dependency in).
 *
 * Layout follows the classic flat-node scheme: every node stores its AABB plus
 * either a child pointer (internal) or a span into `triOrder` (leaf). Built with
 * a midpoint split on the longest axis — cheap and good enough for the dense,
 * well-distributed meshes (rings, scans) this app handles.
 */

const MAX_LEAF_TRIS = 4

export interface BVH {
  /** Per node: min xyz then max xyz, 6 floats each. */
  nodeBounds: Float32Array
  /** Internal node → index of its left child (right is left+1); leaf → -1. */
  nodeLeft: Int32Array
  /** Leaf → first index into triOrder; internal → unused. */
  nodeFirst: Int32Array
  /** Leaf → triangle count; 0 marks an internal node. */
  nodeCount: Int32Array
  /** Triangle indices reordered so each leaf owns a contiguous span. */
  triOrder: Uint32Array
  nodeUsed: number
}

/** Build a BVH over `indices` (triangles) referencing `positions` (xyz triples). */
export function buildBVH(positions: Float32Array, indices: Uint32Array): BVH {
  const triCount = indices.length / 3
  const triOrder = new Uint32Array(triCount)
  for (let i = 0; i < triCount; i++) triOrder[i] = i

  // precompute triangle centroids for the split decision
  const cx = new Float32Array(triCount)
  const cy = new Float32Array(triCount)
  const cz = new Float32Array(triCount)
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3] * 3
    const i1 = indices[t * 3 + 1] * 3
    const i2 = indices[t * 3 + 2] * 3
    cx[t] = (positions[i0] + positions[i1] + positions[i2]) / 3
    cy[t] = (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3
    cz[t] = (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3
  }

  // a binary tree over N leaves needs at most 2N-1 nodes
  const maxNodes = Math.max(1, 2 * triCount - 1)
  const nodeBounds = new Float32Array(maxNodes * 6)
  const nodeLeft = new Int32Array(maxNodes)
  const nodeFirst = new Int32Array(maxNodes)
  const nodeCount = new Int32Array(maxNodes)

  const bvh: BVH = { nodeBounds, nodeLeft, nodeFirst, nodeCount, triOrder, nodeUsed: 0 }
  if (triCount === 0) {
    bvh.nodeUsed = 1
    nodeBounds.fill(0, 0, 6)
    nodeLeft[0] = -1
    nodeFirst[0] = 0
    nodeCount[0] = 0
    return bvh
  }

  const root = newNode(bvh)
  nodeFirst[root] = 0
  nodeCount[root] = triCount
  subdivide(bvh, root, positions, indices, cx, cy, cz)
  return bvh
}

function newNode(bvh: BVH): number {
  return bvh.nodeUsed++
}

function computeBounds(
  bvh: BVH, node: number, positions: Float32Array, indices: Uint32Array,
) {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  const first = bvh.nodeFirst[node]
  const count = bvh.nodeCount[node]
  for (let i = 0; i < count; i++) {
    const tri = bvh.triOrder[first + i]
    for (let k = 0; k < 3; k++) {
      const p = indices[tri * 3 + k] * 3
      const x = positions[p], y = positions[p + 1], z = positions[p + 2]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
  }
  const b = node * 6
  bvh.nodeBounds[b] = minX
  bvh.nodeBounds[b + 1] = minY
  bvh.nodeBounds[b + 2] = minZ
  bvh.nodeBounds[b + 3] = maxX
  bvh.nodeBounds[b + 4] = maxY
  bvh.nodeBounds[b + 5] = maxZ
}

function subdivide(
  bvh: BVH, node: number, positions: Float32Array, indices: Uint32Array,
  cx: Float32Array, cy: Float32Array, cz: Float32Array,
) {
  computeBounds(bvh, node, positions, indices)
  const count = bvh.nodeCount[node]
  if (count <= MAX_LEAF_TRIS) {
    bvh.nodeLeft[node] = -1
    return
  }

  // split on the longest centroid-bbox axis at its midpoint
  const b = node * 6
  const ex = bvh.nodeBounds[b + 3] - bvh.nodeBounds[b]
  const ey = bvh.nodeBounds[b + 4] - bvh.nodeBounds[b + 1]
  const ez = bvh.nodeBounds[b + 5] - bvh.nodeBounds[b + 2]
  let axis = 0
  let extent = ex
  if (ey > extent) { axis = 1; extent = ey }
  if (ez > extent) { axis = 2; extent = ez }
  const c = axis === 0 ? cx : axis === 1 ? cy : cz
  const splitPos = bvh.nodeBounds[b + axis] + extent * 0.5

  // in-place partition of this node's triangle span
  const first = bvh.nodeFirst[node]
  let i = first
  let j = first + count - 1
  while (i <= j) {
    if (c[bvh.triOrder[i]] < splitPos) {
      i++
    } else {
      const tmp = bvh.triOrder[i]
      bvh.triOrder[i] = bvh.triOrder[j]
      bvh.triOrder[j] = tmp
      j--
    }
  }

  const leftCount = i - first
  // degenerate split (all centroids on one side) → make a leaf
  if (leftCount === 0 || leftCount === count) {
    bvh.nodeLeft[node] = -1
    return
  }

  const left = newNode(bvh)
  const right = newNode(bvh)
  bvh.nodeLeft[node] = left
  bvh.nodeCount[node] = 0 // mark internal
  bvh.nodeFirst[left] = first
  bvh.nodeCount[left] = leftCount
  bvh.nodeFirst[right] = i
  bvh.nodeCount[right] = count - leftCount
  subdivide(bvh, left, positions, indices, cx, cy, cz)
  subdivide(bvh, right, positions, indices, cx, cy, cz)
}

/** Slab test: nearest ray entry distance to an AABB, or Infinity on a miss. */
function rayAabb(
  bvh: BVH, node: number,
  ox: number, oy: number, oz: number,
  idx: number, idy: number, idz: number,
  maxT: number,
): number {
  const b = node * 6
  let tmin = 0
  let tmax = maxT
  let t1 = (bvh.nodeBounds[b] - ox) * idx
  let t2 = (bvh.nodeBounds[b + 3] - ox) * idx
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t }
  if (t1 > tmin) tmin = t1
  if (t2 < tmax) tmax = t2
  t1 = (bvh.nodeBounds[b + 1] - oy) * idy
  t2 = (bvh.nodeBounds[b + 4] - oy) * idy
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t }
  if (t1 > tmin) tmin = t1
  if (t2 < tmax) tmax = t2
  t1 = (bvh.nodeBounds[b + 2] - oz) * idz
  t2 = (bvh.nodeBounds[b + 5] - oz) * idz
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t }
  if (t1 > tmin) tmin = t1
  if (t2 < tmax) tmax = t2
  return tmax >= tmin ? tmin : Infinity
}

const EPS = 1e-9
const stack = new Int32Array(64)

/**
 * Nearest ray-triangle hit distance along a unit direction, considering only
 * hits with t > minT (skips the surface the ray starts on). Returns Infinity
 * when the ray escapes. Double-sided (Möller–Trumbore without backface culling)
 * so a wall is measured regardless of which face the opposite side presents.
 */
export function raycastNearest(
  bvh: BVH, positions: Float32Array, indices: Uint32Array,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minT: number,
): number {
  if (bvh.nodeUsed === 0) return Infinity
  const idx = 1 / (dx || EPS)
  const idy = 1 / (dy || EPS)
  const idz = 1 / (dz || EPS)
  let closest = Infinity

  let sp = 0
  stack[sp++] = 0
  while (sp > 0) {
    const node = stack[--sp]
    if (rayAabb(bvh, node, ox, oy, oz, idx, idy, idz, closest) === Infinity) continue
    const count = bvh.nodeCount[node]
    if (count > 0) {
      const first = bvh.nodeFirst[node]
      for (let i = 0; i < count; i++) {
        const tri = bvh.triOrder[first + i]
        const t = rayTri(positions, indices, tri, ox, oy, oz, dx, dy, dz, minT)
        if (t < closest) closest = t
      }
    } else {
      const left = bvh.nodeLeft[node]
      if (left >= 0) {
        stack[sp++] = left
        stack[sp++] = left + 1
      }
    }
  }
  return closest
}

// ---------- nearest-surface (closest-point) query ----------

/** Result of a closest-point query: the shared scratch is reused per call. */
export interface ClosestHit {
  /** Unsigned distance from the query point to the nearest surface. */
  dist: number
  /** Index of the nearest triangle, or -1 when the mesh is empty. */
  tri: number
  /** The nearest point on that triangle. */
  px: number
  py: number
  pz: number
}

const cpStack = new Int32Array(64)
const cpHit: ClosestHit = { dist: Infinity, tri: -1, px: 0, py: 0, pz: 0 }
// scratch closest-point written by pointTri2, copied into cpHit on improvement
let sx = 0, sy = 0, sz = 0

/** Squared distance from a point to a node's AABB (0 when inside). */
function pointAabb2(
  bvh: BVH, node: number, x: number, y: number, z: number,
): number {
  const b = node * 6
  let dx = 0, dy = 0, dz = 0
  if (x < bvh.nodeBounds[b]) dx = bvh.nodeBounds[b] - x
  else if (x > bvh.nodeBounds[b + 3]) dx = x - bvh.nodeBounds[b + 3]
  if (y < bvh.nodeBounds[b + 1]) dy = bvh.nodeBounds[b + 1] - y
  else if (y > bvh.nodeBounds[b + 4]) dy = y - bvh.nodeBounds[b + 4]
  if (z < bvh.nodeBounds[b + 2]) dz = bvh.nodeBounds[b + 2] - z
  else if (z > bvh.nodeBounds[b + 5]) dz = z - bvh.nodeBounds[b + 5]
  return dx * dx + dy * dy + dz * dz
}

/**
 * Squared distance from a point to a triangle; writes the closest point on the
 * triangle to the sx/sy/sz scratch. Ericson, *Real-Time Collision Detection* —
 * the Voronoi-region method (vertices, edges, then the interior face).
 */
function pointTri2(
  positions: Float32Array, indices: Uint32Array, tri: number,
  x: number, y: number, z: number,
): number {
  const ia = indices[tri * 3] * 3
  const ib = indices[tri * 3 + 1] * 3
  const ic = indices[tri * 3 + 2] * 3
  const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2]
  const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2]
  const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2]

  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = x - ax, apy = y - ay, apz = z - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) { sx = ax; sy = ay; sz = az; return dist2(x, y, z, ax, ay, az) }

  const bpx = x - bx, bpy = y - by, bpz = z - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) { sx = bx; sy = by; sz = bz; return dist2(x, y, z, bx, by, bz) }

  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    sx = ax + v * abx; sy = ay + v * aby; sz = az + v * abz
    return dist2(x, y, z, sx, sy, sz)
  }

  const cpx = x - cx, cpy = y - cy, cpz = z - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) { sx = cx; sy = cy; sz = cz; return dist2(x, y, z, cx, cy, cz) }

  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    sx = ax + w * acx; sy = ay + w * acy; sz = az + w * acz
    return dist2(x, y, z, sx, sy, sz)
  }

  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    sx = bx + w * (cx - bx); sy = by + w * (cy - by); sz = bz + w * (cz - bz)
    return dist2(x, y, z, sx, sy, sz)
  }

  // interior face region
  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  sx = ax + abx * v + acx * w
  sy = ay + aby * v + acy * w
  sz = az + abz * v + acz * w
  return dist2(x, y, z, sx, sy, sz)
}

function dist2(x: number, y: number, z: number, ax: number, ay: number, az: number): number {
  const dx = x - ax, dy = y - ay, dz = z - az
  return dx * dx + dy * dy + dz * dz
}

/**
 * Nearest point on the mesh to (x,y,z): BVH-accelerated, pruning any node whose
 * AABB is already further than the best hit. Returns a shared mutable ClosestHit
 * (valid only until the next call) — for the grillz clearance map, which queries
 * one shell vertex against the tooth-scan surface at a time. Three-free.
 */
export function closestPoint(
  bvh: BVH, positions: Float32Array, indices: Uint32Array,
  x: number, y: number, z: number,
): ClosestHit {
  cpHit.dist = Infinity
  cpHit.tri = -1
  if (bvh.nodeUsed === 0) return cpHit
  let best2 = Infinity

  let sp = 0
  cpStack[sp++] = 0
  while (sp > 0) {
    const node = cpStack[--sp]
    if (pointAabb2(bvh, node, x, y, z) > best2) continue
    const count = bvh.nodeCount[node]
    if (count > 0) {
      const first = bvh.nodeFirst[node]
      for (let i = 0; i < count; i++) {
        const tri = bvh.triOrder[first + i]
        const d2 = pointTri2(positions, indices, tri, x, y, z)
        if (d2 < best2) {
          best2 = d2
          cpHit.tri = tri
          cpHit.px = sx; cpHit.py = sy; cpHit.pz = sz
        }
      }
    } else {
      const left = bvh.nodeLeft[node]
      if (left >= 0) {
        cpStack[sp++] = left
        cpStack[sp++] = left + 1
      }
    }
  }
  cpHit.dist = Math.sqrt(best2)
  return cpHit
}

/**
 * Unsigned distance from a point to the nearest mesh surface. Thin wrapper over
 * closestPoint — the documented scalar query the unit tests target.
 */
export function closestPointDistance(
  bvh: BVH, positions: Float32Array, indices: Uint32Array,
  x: number, y: number, z: number,
): number {
  return closestPoint(bvh, positions, indices, x, y, z).dist
}

/** Möller–Trumbore intersection; returns t (>minT) or Infinity. Double-sided. */
function rayTri(
  positions: Float32Array, indices: Uint32Array, tri: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minT: number,
): number {
  const a = indices[tri * 3] * 3
  const b = indices[tri * 3 + 1] * 3
  const c = indices[tri * 3 + 2] * 3
  const e1x = positions[b] - positions[a]
  const e1y = positions[b + 1] - positions[a + 1]
  const e1z = positions[b + 2] - positions[a + 2]
  const e2x = positions[c] - positions[a]
  const e2y = positions[c + 1] - positions[a + 1]
  const e2z = positions[c + 2] - positions[a + 2]
  const px = dy * e2z - dz * e2y
  const py = dz * e2x - dx * e2z
  const pz = dx * e2y - dy * e2x
  const det = e1x * px + e1y * py + e1z * pz
  if (det > -EPS && det < EPS) return Infinity
  const inv = 1 / det
  const tx = ox - positions[a]
  const ty = oy - positions[a + 1]
  const tz = oz - positions[a + 2]
  const u = (tx * px + ty * py + tz * pz) * inv
  if (u < 0 || u > 1) return Infinity
  const qx = ty * e1z - tz * e1y
  const qy = tz * e1x - tx * e1z
  const qz = tx * e1y - ty * e1x
  const v = (dx * qx + dy * qy + dz * qz) * inv
  if (v < 0 || u + v > 1) return Infinity
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv
  return t > minT ? t : Infinity
}
