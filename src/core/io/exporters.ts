import type { MeshData } from '../types'

/**
 * Mesh exporters (plan §2.7). Pure TS over MeshData — no DOM, no Three — so the
 * same writers ship in the React Native shell. STL (binary) and OBJ are written
 * here; GLB/GLTF needs THREE objects and lives behind SceneManager.exportGLTF.
 * Mirrors the importers.ts conventions (positions in mm, indexed triangles).
 */

export type MeshFormat = 'stl' | 'obj' | 'glb'

export interface NamedMesh {
  name: string
  mesh: MeshData
}

/** A scaled copy of a mesh — never mutates the input (shrinkage goes on a copy). */
export function scaleMeshDataCopy(mesh: MeshData, factor: number): MeshData {
  const positions = new Float32Array(mesh.positions.length)
  for (let i = 0; i < mesh.positions.length; i++) positions[i] = mesh.positions[i] * factor
  return { positions, indices: mesh.indices.slice() }
}

/** Concatenate meshes into one, offsetting indices — used for merged export. */
export function mergeMeshData(meshes: MeshData[]): MeshData {
  let nPos = 0
  let nIdx = 0
  for (const m of meshes) {
    nPos += m.positions.length
    nIdx += m.indices.length
  }
  const positions = new Float32Array(nPos)
  const indices = new Uint32Array(nIdx)
  let posOff = 0
  let idxOff = 0
  for (const m of meshes) {
    positions.set(m.positions, posOff)
    const vertexOffset = posOff / 3
    for (let i = 0; i < m.indices.length; i++) indices[idxOff + i] = m.indices[i] + vertexOffset
    posOff += m.positions.length
    idxOff += m.indices.length
  }
  return { positions, indices }
}

/**
 * Binary STL. Layout: 80-byte header, uint32 triangle count, then per triangle
 * a face normal + three vertices (12 little-endian floats = 48 bytes) plus a
 * 2-byte attribute count. Total length is exactly 84 + 50 × triangles.
 */
export function exportSTL(mesh: MeshData): Uint8Array {
  const idx = mesh.indices
  const p = mesh.positions
  const tris = idx.length / 3
  const buffer = new ArrayBuffer(84 + tris * 50)
  const view = new DataView(buffer)
  // 80-byte header is left zeroed; some readers reject "solid " ASCII headers.
  view.setUint32(80, tris, true)

  let offset = 84
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t] * 3
    const i1 = idx[t + 1] * 3
    const i2 = idx[t + 2] * 3
    const ax = p[i0], ay = p[i0 + 1], az = p[i0 + 2]
    const bx = p[i1], by = p[i1 + 1], bz = p[i1 + 2]
    const cx = p[i2], cy = p[i2 + 1], cz = p[i2 + 2]
    // face normal = normalize((b-a) × (c-a))
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) {
      nx /= len
      ny /= len
      nz /= len
    }
    view.setFloat32(offset, nx, true)
    view.setFloat32(offset + 4, ny, true)
    view.setFloat32(offset + 8, nz, true)
    view.setFloat32(offset + 12, ax, true)
    view.setFloat32(offset + 16, ay, true)
    view.setFloat32(offset + 20, az, true)
    view.setFloat32(offset + 24, bx, true)
    view.setFloat32(offset + 28, by, true)
    view.setFloat32(offset + 32, bz, true)
    view.setFloat32(offset + 36, cx, true)
    view.setFloat32(offset + 40, cy, true)
    view.setFloat32(offset + 44, cz, true)
    view.setUint16(offset + 48, 0, true)
    offset += 50
  }
  return new Uint8Array(buffer)
}

/**
 * Wavefront OBJ. Each mesh becomes a named `o` group; vertex indices are 1-based
 * and offset across groups so several parts can share one file (merged export).
 */
export function exportOBJ(parts: NamedMesh[]): string {
  const lines: string[] = ['# GoldSmith Studio export', '# units: mm']
  let vertexBase = 0
  for (const { name, mesh } of parts) {
    lines.push(`o ${sanitizeName(name)}`)
    const p = mesh.positions
    for (let i = 0; i < p.length; i += 3) {
      lines.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`)
    }
    const idx = mesh.indices
    for (let t = 0; t < idx.length; t += 3) {
      lines.push(
        `f ${idx[t] + 1 + vertexBase} ${idx[t + 1] + 1 + vertexBase} ${idx[t + 2] + 1 + vertexBase}`,
      )
    }
    vertexBase += p.length / 3
  }
  return lines.join('\n') + '\n'
}

/** Trim trailing zeros, drop names of meaning to OBJ parsers (whitespace). */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : parseFloat(n.toFixed(6)).toString()
}

function sanitizeName(name: string): string {
  return name.replace(/\s+/g, '_') || 'part'
}
