// Generates manual-test fixtures for the wall-thickness heatmap + PLY colour
// import (plan §2.3 / §3). Run: `node scripts/gen-test-fixtures.mjs`.
//
//  - public/test/tapered-tube.stl  hollow tube whose wall tapers from 2.0 mm
//    (bottom) to 0.4 mm (top), so the heatmap shows a blue→red gradient and the
//    threshold slider visibly flips the thin top to red.
//  - public/test/colored-cube.ply  ASCII PLY with per-vertex colours, to confirm
//    imported vertex colours render.
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'test')
mkdirSync(outDir, { recursive: true })

// ---------- tapered-wall tube (binary STL) ----------

function taperedTube({ innerR = 5, outerRBottom = 7, outerRTop = 5.4, height = 8, seg = 96, hSeg = 24 }) {
  // outer radius at parametric height t in [0,1]; inner radius is constant.
  // Height segments give interior wall vertices pure radial normals, so they
  // read the true (tapering) wall thickness — not an axial through-ray.
  const outerR = (t) => outerRBottom + (outerRTop - outerRBottom) * t
  const oPt = (i, t) => {
    const a = (2 * Math.PI * i) / seg
    const r = outerR(t)
    return [r * Math.cos(a), r * Math.sin(a), height * t]
  }
  const iPt = (i, t) => {
    const a = (2 * Math.PI * i) / seg
    return [innerR * Math.cos(a), innerR * Math.sin(a), height * t]
  }

  const tris = []
  const push = (a, b, c, refx, refy, refz) => {
    // force outward winding: flip if the face normal opposes the reference dir
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    if (nx * refx + ny * refy + nz * refz < 0) tris.push([a, c, b])
    else tris.push([a, b, c])
  }

  for (let i = 0; i < seg; i++) {
    const mc = Math.cos((2 * Math.PI * (i + 0.5)) / seg)
    const ms = Math.sin((2 * Math.PI * (i + 0.5)) / seg)
    for (let k = 0; k < hSeg; k++) {
      const t0 = k / hSeg, t1 = (k + 1) / hSeg
      // outer wall — outward = +radial
      push(oPt(i, t0), oPt(i + 1, t0), oPt(i + 1, t1), mc, ms, 0)
      push(oPt(i, t0), oPt(i + 1, t1), oPt(i, t1), mc, ms, 0)
      // inner wall — outward (into cavity) = −radial
      push(iPt(i, t0), iPt(i + 1, t0), iPt(i + 1, t1), -mc, -ms, 0)
      push(iPt(i, t0), iPt(i + 1, t1), iPt(i, t1), -mc, -ms, 0)
    }
    // bottom cap annulus — outward = −z; top cap annulus — outward = +z
    push(oPt(i, 0), iPt(i, 0), iPt(i + 1, 0), 0, 0, -1)
    push(oPt(i, 0), iPt(i + 1, 0), oPt(i + 1, 0), 0, 0, -1)
    push(oPt(i, 1), oPt(i + 1, 1), iPt(i + 1, 1), 0, 0, 1)
    push(oPt(i, 1), iPt(i + 1, 1), iPt(i, 1), 0, 0, 1)
  }
  return tris
}

function writeBinarySTL(tris, file) {
  const buf = Buffer.alloc(84 + tris.length * 50)
  buf.writeUInt32LE(tris.length, 80)
  let off = 84
  for (const [a, b, c] of tris) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len
    buf.writeFloatLE(nx, off); buf.writeFloatLE(ny, off + 4); buf.writeFloatLE(nz, off + 8)
    buf.writeFloatLE(a[0], off + 12); buf.writeFloatLE(a[1], off + 16); buf.writeFloatLE(a[2], off + 20)
    buf.writeFloatLE(b[0], off + 24); buf.writeFloatLE(b[1], off + 28); buf.writeFloatLE(b[2], off + 32)
    buf.writeFloatLE(c[0], off + 36); buf.writeFloatLE(c[1], off + 40); buf.writeFloatLE(c[2], off + 44)
    off += 50
  }
  writeFileSync(file, buf)
}

writeBinarySTL(taperedTube({}), join(outDir, 'tapered-tube.stl'))

// ---------- coloured cube (ASCII PLY) ----------

const cubeV = [
  [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
]
const cubeColor = [
  [220, 40, 40], [40, 220, 40], [40, 40, 220], [220, 220, 40],
  [220, 40, 220], [40, 220, 220], [240, 240, 240], [30, 30, 30],
]
const cubeF = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6],
  [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
]
let ply = 'ply\nformat ascii 1.0\ncomment GoldSmith Studio test fixture\n'
ply += `element vertex ${cubeV.length}\n`
ply += 'property float x\nproperty float y\nproperty float z\n'
ply += 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
ply += `element face ${cubeF.length}\n`
ply += 'property list uchar int vertex_indices\nend_header\n'
for (let i = 0; i < cubeV.length; i++) {
  ply += `${cubeV[i].join(' ')} ${cubeColor[i].join(' ')}\n`
}
for (const f of cubeF) ply += `3 ${f.join(' ')}\n`
writeFileSync(join(outDir, 'colored-cube.ply'), ply)

console.log('Wrote tapered-tube.stl + colored-cube.ply to public/test/')
