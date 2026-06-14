import type { MeshData } from '../types'

/**
 * Mesh exporters (plan §2.7). Pure TS over MeshData — no DOM, no Three — so the
 * same writers ship in the React Native shell. STL (binary) and OBJ are written
 * here; GLB/GLTF needs THREE objects and lives behind SceneManager.exportGLTF.
 * Mirrors the importers.ts conventions (positions in mm, indexed triangles).
 */

export type MeshFormat = 'stl' | 'obj' | 'glb' | 'ply' | '3mf'

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

/**
 * Binary little-endian PLY. Stores positions (float x/y/z) and, when `colors` is
 * supplied (rgb in 0..1, one triple per vertex), per-vertex `uchar` red/green/blue
 * — the channel intraoral scans carry (plan §3). Faces are a `uchar`-count list of
 * `uint` indices. PLY is the dental-scan interchange format; kept pure-TS to match
 * the STL/OBJ writers and keep core Three-free.
 */
export function exportPLY(mesh: MeshData, colors?: Float32Array): Uint8Array {
  const p = mesh.positions
  const idx = mesh.indices
  const vertexCount = p.length / 3
  const triCount = idx.length / 3
  const hasColor = !!colors && colors.length >= vertexCount * 3

  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    'comment GoldSmith Studio export (units: mm)\n' +
    `element vertex ${vertexCount}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    (hasColor ? 'property uchar red\nproperty uchar green\nproperty uchar blue\n' : '') +
    `element face ${triCount}\n` +
    'property list uchar uint vertex_indices\n' +
    'end_header\n'
  const headerBytes = new TextEncoder().encode(header)

  const vertexStride = hasColor ? 15 : 12 // 3 floats (+ 3 uchar)
  const faceStride = 1 + 3 * 4 // count byte + 3 uint32
  const body = new ArrayBuffer(vertexCount * vertexStride + triCount * faceStride)
  const view = new DataView(body)

  let off = 0
  for (let v = 0; v < vertexCount; v++) {
    view.setFloat32(off, p[v * 3], true)
    view.setFloat32(off + 4, p[v * 3 + 1], true)
    view.setFloat32(off + 8, p[v * 3 + 2], true)
    off += 12
    if (hasColor) {
      view.setUint8(off, to255(colors![v * 3]))
      view.setUint8(off + 1, to255(colors![v * 3 + 1]))
      view.setUint8(off + 2, to255(colors![v * 3 + 2]))
      off += 3
    }
  }
  for (let t = 0; t < idx.length; t += 3) {
    view.setUint8(off, 3)
    view.setUint32(off + 1, idx[t], true)
    view.setUint32(off + 5, idx[t + 1], true)
    view.setUint32(off + 9, idx[t + 2], true)
    off += faceStride
  }

  const out = new Uint8Array(headerBytes.length + body.byteLength)
  out.set(headerBytes, 0)
  out.set(new Uint8Array(body), headerBytes.length)
  return out
}

function to255(c: number): number {
  return Math.max(0, Math.min(255, Math.round(c * 255)))
}

/**
 * 3MF (3D Manufacturing Format) — a ZIP of XML. One `<object>` mesh per part with
 * a build item each; units in millimetres. A step beyond JewelCalc and the modern
 * slicer interchange format. Geometry only (no per-vertex colour, which 3MF models
 * via separate colour groups). Packaged as a STORE (uncompressed) zip — no deflate
 * dependency, and every 3MF reader accepts stored entries.
 */
export function export3MF(parts: NamedMesh[]): Uint8Array {
  const objects: string[] = []
  const items: string[] = []
  parts.forEach(({ mesh }, i) => {
    const id = i + 1
    objects.push(meshObjectXML(id, mesh))
    items.push(`    <item objectid="${id}" />`)
  })
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
    '  <resources>\n' +
    objects.join('\n') +
    '\n  </resources>\n' +
    '  <build>\n' +
    items.join('\n') +
    '\n  </build>\n' +
    '</model>\n'

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />\n' +
    '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />\n' +
    '</Types>\n'

  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '  <Relationship Target="/3D/3dmodel.model" Id="rel0" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />\n' +
    '</Relationships>\n'

  const enc = new TextEncoder()
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: '3D/3dmodel.model', data: enc.encode(model) },
  ])
}

function meshObjectXML(id: number, mesh: MeshData): string {
  const p = mesh.positions
  const idx = mesh.indices
  const verts: string[] = []
  for (let i = 0; i < p.length; i += 3) {
    verts.push(`        <vertex x="${fmt(p[i])}" y="${fmt(p[i + 1])}" z="${fmt(p[i + 2])}" />`)
  }
  const tris: string[] = []
  for (let t = 0; t < idx.length; t += 3) {
    tris.push(`        <triangle v1="${idx[t]}" v2="${idx[t + 1]}" v3="${idx[t + 2]}" />`)
  }
  return (
    `    <object id="${id}" type="model">\n` +
    '      <mesh>\n' +
    '        <vertices>\n' +
    verts.join('\n') +
    '\n        </vertices>\n' +
    '        <triangles>\n' +
    tris.join('\n') +
    '\n        </triangles>\n' +
    '      </mesh>\n' +
    '    </object>'
  )
}

interface ZipEntry {
  name: string
  data: Uint8Array
}

/**
 * Minimal STORE-only (no compression) ZIP writer: local file headers + a central
 * directory + end record, each entry CRC32-checked. Enough for an OPC package
 * like 3MF without pulling in a deflate library.
 */
function zipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = new Uint8Array(30 + nameBytes.length + size)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header signature
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // method: store
    lv.setUint16(10, 0, true) // mod time
    lv.setUint16(12, 0, true) // mod date
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true) // compressed size
    lv.setUint32(22, size, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // extra length
    local.set(nameBytes, 30)
    local.set(entry.data, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true) // central directory signature
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true) // method: store
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk number
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, offset, true) // local header offset
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true) // end of central directory signature
  ev.setUint16(8, entries.length, true) // entries on this disk
  ev.setUint16(10, entries.length, true) // total entries
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true) // central directory offset

  const total = offset + centralSize + end.length
  const out = new Uint8Array(total)
  let pos = 0
  for (const l of locals) { out.set(l, pos); pos += l.length }
  for (const c of centrals) { out.set(c, pos); pos += c.length }
  out.set(end, pos)
  return out
}

let crcTable: Uint32Array | null = null
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
