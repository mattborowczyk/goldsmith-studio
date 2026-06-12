import type { AnalysisReport, MeshData } from '../types'

/**
 * Pure-TS mesh topology analysis. Runs in a worker for big meshes but has no
 * environment dependencies, so it is unit-testable in Node.
 */

const MAX_HIGHLIGHT_POINTS = 60_000

interface EdgeTopology {
  /** count per undirected edge */
  boundaryEdges: number
  nonManifoldEdges: number
  /** flat [ax,ay,az,bx,by,bz, ...] for boundary edges (capped) */
  boundaryEdgePositions: Float32Array
  /** directed boundary edges as Map from start vertex -> end vertex (for loop walking) */
  boundaryNext: Map<number, number>
}

function edgeKey(a: number, b: number, n: number): number {
  return a < b ? a * n + b : b * n + a
}

export function analyzeTopology(mesh: MeshData): EdgeTopology {
  const { positions, indices } = mesh
  const n = positions.length / 3
  const counts = new Map<number, number>()
  // directed occurrence per undirected edge: +1 for a<b direction, -1 for b<a
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]
      const b = indices[t + ((e + 1) % 3)]
      const k = edgeKey(a, b, n)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }

  let boundaryEdges = 0
  let nonManifoldEdges = 0
  for (const c of counts.values()) {
    if (c === 1) boundaryEdges++
    else if (c > 2) nonManifoldEdges++
  }

  // Second pass for boundary edge geometry + directed loop map
  const boundaryNext = new Map<number, number>()
  const maxEdges = Math.min(boundaryEdges, MAX_HIGHLIGHT_POINTS / 2)
  const pos = new Float32Array(maxEdges * 6)
  let w = 0
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]
      const b = indices[t + ((e + 1) % 3)]
      if (counts.get(edgeKey(a, b, n)) === 1) {
        boundaryNext.set(a, b)
        if (w + 6 <= pos.length) {
          pos[w++] = positions[a * 3]
          pos[w++] = positions[a * 3 + 1]
          pos[w++] = positions[a * 3 + 2]
          pos[w++] = positions[b * 3]
          pos[w++] = positions[b * 3 + 1]
          pos[w++] = positions[b * 3 + 2]
        }
      }
    }
  }

  return {
    boundaryEdges,
    nonManifoldEdges,
    boundaryEdgePositions: pos.subarray(0, w).slice(),
    boundaryNext,
  }
}

export function countBoundaryLoops(boundaryNext: Map<number, number>): number {
  const visited = new Set<number>()
  let loops = 0
  for (const start of boundaryNext.keys()) {
    if (visited.has(start)) continue
    loops++
    let v: number | undefined = start
    let guard = boundaryNext.size + 1
    while (v !== undefined && !visited.has(v) && guard-- > 0) {
      visited.add(v)
      v = boundaryNext.get(v)
    }
  }
  return loops
}

/** Union-find over triangles connected via shared (undirected) edges. */
export function computeShells(mesh: MeshData): { shellOfTri: Int32Array; shellCount: number } {
  const { positions, indices } = mesh
  const n = positions.length / 3
  const triCount = indices.length / 3
  const parent = new Int32Array(triCount)
  for (let i = 0; i < triCount; i++) parent[i] = i
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== x) {
      const next = parent[x]
      parent[x] = r
      x = next
    }
    return r
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  const firstTriOfEdge = new Map<number, number>()
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e]
      const b = indices[t * 3 + ((e + 1) % 3)]
      const k = edgeKey(a, b, n)
      const other = firstTriOfEdge.get(k)
      if (other === undefined) firstTriOfEdge.set(k, t)
      else union(t, other)
    }
  }

  const shellOfTri = new Int32Array(triCount)
  const roots = new Map<number, number>()
  for (let t = 0; t < triCount; t++) {
    const r = find(t)
    let id = roots.get(r)
    if (id === undefined) {
      id = roots.size
      roots.set(r, id)
    }
    shellOfTri[t] = id
  }
  return { shellOfTri, shellCount: roots.size }
}

/** Signed volume (mm³) of one triangle, contribution via divergence theorem. */
function signedTriVolume(p: Float32Array, i0: number, i1: number, i2: number): number {
  const x0 = p[i0 * 3], y0 = p[i0 * 3 + 1], z0 = p[i0 * 3 + 2]
  const x1 = p[i1 * 3], y1 = p[i1 * 3 + 1], z1 = p[i1 * 3 + 2]
  const x2 = p[i2 * 3], y2 = p[i2 * 3 + 1], z2 = p[i2 * 3 + 2]
  return (
    (x0 * (y1 * z2 - y2 * z1) + x1 * (y2 * z0 - y0 * z2) + x2 * (y0 * z1 - y1 * z0)) / 6
  )
}

function triArea(p: Float32Array, i0: number, i1: number, i2: number): number {
  const ax = p[i1 * 3] - p[i0 * 3]
  const ay = p[i1 * 3 + 1] - p[i0 * 3 + 1]
  const az = p[i1 * 3 + 2] - p[i0 * 3 + 2]
  const bx = p[i2 * 3] - p[i0 * 3]
  const by = p[i2 * 3 + 1] - p[i0 * 3 + 1]
  const bz = p[i2 * 3 + 2] - p[i0 * 3 + 2]
  const cx = ay * bz - az * by
  const cy = az * bx - ax * bz
  const cz = ax * by - ay * bx
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2
}

export function shellVolumes(mesh: MeshData, shellOfTri: Int32Array, shellCount: number): Float64Array {
  const vols = new Float64Array(shellCount)
  const { positions, indices } = mesh
  for (let t = 0; t < shellOfTri.length; t++) {
    vols[shellOfTri[t]] += signedTriVolume(positions, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2])
  }
  return vols
}

export function analyzeMesh(mesh: MeshData): AnalysisReport {
  const { positions, indices } = mesh
  const topo = analyzeTopology(mesh)
  const { shellOfTri, shellCount } = computeShells(mesh)
  const vols = shellVolumes(mesh, shellOfTri, shellCount)

  let surfaceArea = 0
  for (let t = 0; t < indices.length; t += 3) {
    surfaceArea += triArea(positions, indices[t], indices[t + 1], indices[t + 2])
  }

  let invertedShells = 0
  let volume = 0
  const invertedShellSet = new Set<number>()
  for (let s = 0; s < shellCount; s++) {
    if (vols[s] < 0) {
      invertedShells++
      invertedShellSet.add(s)
    }
    volume += vols[s]
  }

  // Centroids of triangles in inverted shells, for viewport highlighting
  let flippedCount = 0
  for (let t = 0; t < shellOfTri.length; t++) {
    if (invertedShellSet.has(shellOfTri[t])) flippedCount++
  }
  const maxFlipped = Math.min(flippedCount, MAX_HIGHLIGHT_POINTS)
  const flipped = new Float32Array(maxFlipped * 3)
  let w = 0
  for (let t = 0; t < shellOfTri.length && w + 3 <= flipped.length; t++) {
    if (!invertedShellSet.has(shellOfTri[t])) continue
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2]
    flipped[w++] = (positions[i0 * 3] + positions[i1 * 3] + positions[i2 * 3]) / 3
    flipped[w++] = (positions[i0 * 3 + 1] + positions[i1 * 3 + 1] + positions[i2 * 3 + 1]) / 3
    flipped[w++] = (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3
  }

  const watertight = topo.boundaryEdges === 0
  return {
    triangles: indices.length / 3,
    vertices: positions.length / 3,
    shells: shellCount,
    boundaryEdges: topo.boundaryEdges,
    boundaryLoops: countBoundaryLoops(topo.boundaryNext),
    nonManifoldEdges: topo.nonManifoldEdges,
    invertedShells,
    watertight,
    manifold: watertight && topo.nonManifoldEdges === 0,
    volume: Math.abs(volume),
    surfaceArea,
    boundaryEdgePositions: topo.boundaryEdgePositions,
    flippedFacePositions: flipped,
  }
}
