// Generates test STL files into public/test/ for manual + automated testing.
// broken-cube.stl: 10mm cube missing its top face, plus a 0.5mm debris cube —
// exercises weld, hole fill, small-shell filter and the analysis report.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public/test')
mkdirSync(outDir, { recursive: true })

function cubeTris(s, [ox, oy, oz], { skipTop = false } = {}) {
  const v = [
    [ox, oy, oz], [ox + s, oy, oz], [ox + s, oy + s, oz], [ox, oy + s, oz],
    [ox, oy, oz + s], [ox + s, oy, oz + s], [ox + s, oy + s, oz + s], [ox, oy + s, oz + s],
  ]
  const faces = [
    [0, 2, 1], [0, 3, 2], // bottom
    ...(skipTop ? [] : [[4, 5, 6], [4, 6, 7]]), // top
    [0, 1, 5], [0, 5, 4],
    [2, 3, 7], [2, 7, 6],
    [0, 4, 7], [0, 7, 3],
    [1, 2, 6], [1, 6, 5],
  ]
  return faces.map((f) => f.map((i) => v[i]))
}

function writeBinarySTL(path, tris) {
  const buf = Buffer.alloc(84 + tris.length * 50)
  buf.write('GoldSmith Studio test fixture', 0, 'ascii')
  buf.writeUInt32LE(tris.length, 80)
  let o = 84
  for (const [a, b, c] of tris) {
    // normal left zero — readers recompute
    o += 12
    for (const p of [a, b, c]) {
      buf.writeFloatLE(p[0], o)
      buf.writeFloatLE(p[1], o + 4)
      buf.writeFloatLE(p[2], o + 8)
      o += 12
    }
    o += 2 // attribute byte count
  }
  writeFileSync(path, buf)
  console.log(`${path}: ${tris.length} triangles`)
}

writeBinarySTL(join(outDir, 'broken-cube.stl'), [
  ...cubeTris(10, [0, 0, 0], { skipTop: true }),
  ...cubeTris(0.5, [20, 0, 0]),
])
writeBinarySTL(join(outDir, 'clean-cube.stl'), cubeTris(10, [0, 0, 0]))
