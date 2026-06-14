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
