import type { MeshData } from '../types'
import { analyzeTopology, computeShells, shellVolumes } from './meshAnalysis'

/**
 * Pure-TS repair primitives. The Repair Center composes these (in a worker),
 * then optionally runs the result through Manifold for boolean union.
 */

/** Weld vertices closer than `tolerance` using a spatial hash grid. */
export function weldVertices(mesh: MeshData, tolerance: number): MeshData {
  const { positions, indices } = mesh
  const n = positions.length / 3
  const inv = tolerance > 0 ? 1 / tolerance : 0
  const remap = new Uint32Array(n)
  const grid = new Map<string, number[]>()
  const outPos: number[] = []
  let next = 0

  for (let v = 0; v < n; v++) {
    const x = positions[v * 3]
    const y = positions[v * 3 + 1]
    const z = positions[v * 3 + 2]
    let found = -1
    if (tolerance > 0) {
      const cx = Math.round(x * inv)
      const cy = Math.round(y * inv)
      const cz = Math.round(z * inv)
      outer: for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const cell = grid.get(`${cx + dx},${cy + dy},${cz + dz}`)
            if (!cell) continue
            for (const u of cell) {
              const ux = outPos[u * 3] - x
              const uy = outPos[u * 3 + 1] - y
              const uz = outPos[u * 3 + 2] - z
              if (ux * ux + uy * uy + uz * uz <= tolerance * tolerance) {
                found = u
                break outer
              }
            }
          }
        }
      }
      if (found < 0) {
        const key = `${cx},${cy},${cz}`
        let cell = grid.get(key)
        if (!cell) grid.set(key, (cell = []))
        cell.push(next)
      }
    }
    if (found >= 0) {
      remap[v] = found
    } else {
      remap[v] = next
      outPos.push(x, y, z)
      next++
    }
  }

  const outIdx = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) outIdx[i] = remap[indices[i]]
  return { positions: new Float32Array(outPos), indices: outIdx }
}

/** Remove triangles with repeated indices or (near-)zero area. */
export function removeDegenerateTriangles(mesh: MeshData, areaEps = 1e-12): MeshData {
  const { positions, indices } = mesh
  const out: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2]
    if (a === b || b === c || a === c) continue
    const ax = positions[b * 3] - positions[a * 3]
    const ay = positions[b * 3 + 1] - positions[a * 3 + 1]
    const az = positions[b * 3 + 2] - positions[a * 3 + 2]
    const bx = positions[c * 3] - positions[a * 3]
    const by = positions[c * 3 + 1] - positions[a * 3 + 1]
    const bz = positions[c * 3 + 2] - positions[a * 3 + 2]
    const cx = ay * bz - az * by
    const cy = az * bx - ax * bz
    const cz = ax * by - ay * bx
    if (cx * cx + cy * cy + cz * cz <= areaEps) continue
    out.push(a, b, c)
  }
  return { positions, indices: new Uint32Array(out) }
}

/**
 * Make winding consistent per shell via BFS over edge-adjacent triangles, then
 * flip any shell with negative signed volume so normals point outward.
 */
export function fixWinding(mesh: MeshData): MeshData {
  const { positions } = mesh
  const indices = mesh.indices.slice()
  const n = positions.length / 3
  const triCount = indices.length / 3

  // adjacency: undirected edge -> triangles using it
  const edgeTris = new Map<number, number[]>()
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a)
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const k = key(indices[t * 3 + e], indices[t * 3 + ((e + 1) % 3)])
      let list = edgeTris.get(k)
      if (!list) edgeTris.set(k, (list = []))
      list.push(t)
    }
  }

  const hasDirectedEdge = (t: number, a: number, b: number): boolean => {
    for (let e = 0; e < 3; e++) {
      if (indices[t * 3 + e] === a && indices[t * 3 + ((e + 1) % 3)] === b) return true
    }
    return false
  }
  const flipTri = (t: number) => {
    const tmp = indices[t * 3 + 1]
    indices[t * 3 + 1] = indices[t * 3 + 2]
    indices[t * 3 + 2] = tmp
  }

  const visited = new Uint8Array(triCount)
  const stack: number[] = []
  for (let seed = 0; seed < triCount; seed++) {
    if (visited[seed]) continue
    visited[seed] = 1
    stack.push(seed)
    while (stack.length) {
      const t = stack.pop()!
      for (let e = 0; e < 3; e++) {
        const a = indices[t * 3 + e]
        const b = indices[t * 3 + ((e + 1) % 3)]
        const neighbors = edgeTris.get(key(a, b))!
        if (neighbors.length !== 2) continue // boundary or non-manifold: skip
        const other = neighbors[0] === t ? neighbors[1] : neighbors[0]
        if (visited[other]) continue
        // Coherent winding: neighbor must traverse the shared edge as (b,a)
        if (hasDirectedEdge(other, a, b)) flipTri(other)
        visited[other] = 1
        stack.push(other)
      }
    }
  }

  // Orient shells outward (positive signed volume)
  const result: MeshData = { positions, indices }
  const { shellOfTri, shellCount } = computeShells(result)
  const vols = shellVolumes(result, shellOfTri, shellCount)
  for (let t = 0; t < triCount; t++) {
    if (vols[shellOfTri[t]] < 0) flipTri(t)
  }
  return result
}

/** Fill boundary loops (up to maxLoopSize edges each) with a centroid fan. */
export function fillHoles(mesh: MeshData, maxLoopSize: number): MeshData {
  const topo = analyzeTopology(mesh)
  if (topo.boundaryNext.size === 0) return mesh

  const positions: number[] = Array.from(mesh.positions)
  const indices: number[] = Array.from(mesh.indices)
  const visited = new Set<number>()

  for (const start of topo.boundaryNext.keys()) {
    if (visited.has(start)) continue
    // walk the loop
    const loop: number[] = []
    let v: number | undefined = start
    let guard = topo.boundaryNext.size + 1
    while (v !== undefined && !visited.has(v) && guard-- > 0) {
      visited.add(v)
      loop.push(v)
      v = topo.boundaryNext.get(v)
    }
    if (v !== start || loop.length < 3 || loop.length > maxLoopSize) continue

    // centroid vertex
    let cx = 0, cy = 0, cz = 0
    for (const p of loop) {
      cx += mesh.positions[p * 3]
      cy += mesh.positions[p * 3 + 1]
      cz += mesh.positions[p * 3 + 2]
    }
    const ci = positions.length / 3
    positions.push(cx / loop.length, cy / loop.length, cz / loop.length)

    // Boundary directed edge (a→b) is only traversed once by existing faces,
    // so each fill triangle must traverse it as (b→a) to keep winding coherent.
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]
      const b = loop[(i + 1) % loop.length]
      indices.push(b, a, ci)
    }
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

/** Drop shells with |volume| below minVolume (mm³). */
export function filterSmallShells(mesh: MeshData, minVolume: number): MeshData {
  if (minVolume <= 0) return mesh
  const { shellOfTri, shellCount } = computeShells(mesh)
  const vols = shellVolumes(mesh, shellOfTri, shellCount)
  const keep = new Uint8Array(shellCount)
  for (let s = 0; s < shellCount; s++) keep[s] = Math.abs(vols[s]) >= minVolume ? 1 : 0
  const out: number[] = []
  for (let t = 0; t < shellOfTri.length; t++) {
    if (keep[shellOfTri[t]]) {
      out.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2])
    }
  }
  return compactVertices({ positions: mesh.positions, indices: new Uint32Array(out) })
}

/** Split a mesh into one MeshData per shell (each with compacted vertices). */
export function splitShells(mesh: MeshData): MeshData[] {
  const { shellOfTri, shellCount } = computeShells(mesh)
  const buckets: number[][] = Array.from({ length: shellCount }, () => [])
  for (let t = 0; t < shellOfTri.length; t++) {
    buckets[shellOfTri[t]].push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2])
  }
  return buckets.map((idx) =>
    compactVertices({ positions: mesh.positions, indices: new Uint32Array(idx) }),
  )
}

/** Drop unreferenced vertices and reindex. */
export function compactVertices(mesh: MeshData): MeshData {
  const { positions, indices } = mesh
  const remap = new Int32Array(positions.length / 3).fill(-1)
  const outPos: number[] = []
  const outIdx = new Uint32Array(indices.length)
  let next = 0
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]
    if (remap[v] < 0) {
      remap[v] = next++
      outPos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2])
    }
    outIdx[i] = remap[v]
  }
  return { positions: new Float32Array(outPos), indices: outIdx }
}
