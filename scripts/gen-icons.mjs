// Generate the PWA PNG icons from the GoldSmith mark (gold ring + diamond on a
// dark rounded square — matches public/favicon.svg). Zero external deps: we
// rasterize the few primitives with 4× supersampling and write PNGs by hand so
// the build needs no native image toolchain. Re-run after changing the mark:
//   node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const BG = [0x23, 0x22, 0x20] // #232220 — matches index.html theme-color
const GOLD = [0xe8, 0xb5, 0x4d] // #e8b54d

/** Mark drawn in a 32×32 design space (same geometry as favicon.svg). */
function markColorAt(x, y) {
  // gold diamond — M12 8 L16 3 L20 8 L16 11 Z
  if (inPolygon(x, y, [[12, 8], [16, 3], [20, 8], [16, 11]])) return GOLD
  // gold ring — circle cx16 cy18 r8, stroke 2.5 (annulus 6.75..9.25)
  const d = Math.hypot(x - 16, y - 18)
  if (d >= 8 - 1.25 && d <= 8 + 1.25) return GOLD
  return null
}

function inPolygon(x, y, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function roundedRectCovers(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false
  const cx = Math.min(Math.max(x, r), w - r)
  const cy = Math.min(Math.max(y, r), h - r)
  return Math.hypot(x - cx, y - cy) <= r
}

/**
 * Render one icon. `inset` shrinks the mark toward the centre (maskable needs
 * the artwork inside the ~80% safe zone); `rounded` draws the app-icon corner
 * radius (off for maskable, where the launcher applies its own mask).
 */
function render(size, { inset = 0, rounded = true } = {}) {
  const ss = 4 // supersample factor
  const px = new Uint8Array(size * size * 4)
  const radius = rounded ? size * (7 / 32) : 0
  const markScale = (size / 32) * (1 - inset)
  const markOffset = (size - 32 * markScale) / 2
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = pxi + (sx + 0.5) / ss
          const fy = py + (sy + 0.5) / ss
          let col = null
          let alpha = 0
          if (rounded ? roundedRectCovers(fx, fy, size, size, radius) : true) {
            col = BG
            alpha = 1
            const mark = markColorAt((fx - markOffset) / markScale, (fy - markOffset) / markScale)
            if (mark) col = mark
          }
          if (col) {
            r += col[0]; g += col[1]; b += col[2]; a += alpha * 255
          }
        }
      }
      const n = ss * ss
      const o = (py * size + pxi) * 4
      px[o] = Math.round(r / n)
      px[o + 1] = Math.round(g / n)
      px[o + 2] = Math.round(b / n)
      px[o + 3] = Math.round(a / n)
    }
  }
  return px
}

/** Minimal RGBA PNG encoder (filter 0, zlib via node:zlib). */
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter type 0 (none)
    rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((v, i) => {
      raw[y * (width * 4 + 1) + 1 + i] = v
    })
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]
  return Buffer.concat(chunks)
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length)
  return out
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}

const targets = [
  ['pwa-192.png', 192, {}],
  ['pwa-512.png', 512, {}],
  ['pwa-maskable-512.png', 512, { inset: 0.2, rounded: false }],
  ['apple-touch-icon.png', 180, {}],
]
for (const [name, size, opts] of targets) {
  writeFileSync(join(OUT, name), encodePNG(size, size, render(size, opts)))
  console.log('wrote', name, `${size}×${size}`)
}
