import { Font } from 'three/examples/jsm/loaders/FontLoader.js'
import { TTFLoader } from 'three/examples/jsm/loaders/TTFLoader.js'
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { BufferAttribute } from 'three'
import helvetikerRegular from 'three/examples/fonts/helvetiker_regular.typeface.json'
import helvetikerBold from 'three/examples/fonts/helvetiker_bold.typeface.json'
import optimerRegular from 'three/examples/fonts/optimer_regular.typeface.json'
import optimerBold from 'three/examples/fonts/optimer_bold.typeface.json'
import gentilisRegular from 'three/examples/fonts/gentilis_regular.typeface.json'
import gentilisBold from 'three/examples/fonts/gentilis_bold.typeface.json'
import type { MeshData } from '../types'
import { restOnGround } from './meshBuilder'

/**
 * 3D Text Generator (plan §2.5.3): solid extruded text, flat or bent along a
 * curve (ring outside/inside, coin arcs). Bundled typeface fonts plus
 * user-uploaded TTF/OTF (parsed client-side, kept in memory for the session).
 */

type FontJson = ConstructorParameters<typeof Font>[0]

const BUNDLED: { id: string; label: string; json: unknown }[] = [
  { id: 'helvetiker', label: 'Helvetiker', json: helvetikerRegular },
  { id: 'helvetiker-bold', label: 'Helvetiker Bold', json: helvetikerBold },
  { id: 'optimer', label: 'Optimer', json: optimerRegular },
  { id: 'optimer-bold', label: 'Optimer Bold', json: optimerBold },
  { id: 'gentilis', label: 'Gentilis', json: gentilisRegular },
  { id: 'gentilis-bold', label: 'Gentilis Bold', json: gentilisBold },
]

const fontCache = new Map<string, Font>()
const uploaded = new Map<string, { label: string; font: Font }>()

export function listFonts(): { id: string; label: string }[] {
  return [
    ...BUNDLED.map(({ id, label }) => ({ id, label })),
    ...[...uploaded.entries()].map(([id, f]) => ({ id, label: f.label })),
  ]
}

/** Parse an uploaded TTF/OTF file and register it; returns its font id. */
export function registerFontFile(name: string, buffer: ArrayBuffer): string {
  const json = new TTFLoader().parse(buffer)
  const id = `user-${name.replace(/\.[^.]+$/, '')}`
  uploaded.set(id, {
    label: name.replace(/\.[^.]+$/, ''),
    font: new Font(json as FontJson),
  })
  return id
}

function getFont(id: string): Font {
  const user = uploaded.get(id)
  if (user) return user.font
  let font = fontCache.get(id)
  if (!font) {
    const bundled = BUNDLED.find((b) => b.id === id) ?? BUNDLED[0]
    font = new Font(bundled.json as FontJson)
    fontCache.set(bundled.id, font)
  }
  return font
}

export type TextPlacement = 'flat' | 'ring-outside' | 'ring-inside' | 'arc-up' | 'arc-down'

export const TEXT_PLACEMENTS: { id: TextPlacement; label: string }[] = [
  { id: 'flat', label: 'Flat (on plane)' },
  { id: 'ring-outside', label: 'Around ring — outside' },
  { id: 'ring-inside', label: 'Around ring — inside' },
  { id: 'arc-up', label: 'Arc — coin top' },
  { id: 'arc-down', label: 'Arc — coin bottom' },
]

export interface Text3DParams {
  text: string
  fontId: string
  /** Letter height (font size) in mm. */
  sizeMm: number
  /** Extrusion depth in mm. */
  depthMm: number
  /** Curve smoothness (segments per glyph curve). */
  curveSegments: number
  placement: TextPlacement
  /** Reference diameter mm for the curved placements (ring/coin). */
  diameter: number
  /**
   * Cutter mode: for inside-ring text, extrude into the band material
   * (engraving) instead of protruding inward (embossing).
   */
  cutter: boolean
}

export function defaultTextParams(): Text3DParams {
  return {
    text: 'GOLD',
    fontId: 'helvetiker',
    sizeMm: 5,
    depthMm: 1,
    curveSegments: 6,
    placement: 'flat',
    diameter: 20,
    cutter: false,
  }
}

export function generateText3D(p: Text3DParams): MeshData {
  if (!p.text.trim()) throw new Error('Enter some text first.')
  const geometry = new TextGeometry(p.text, {
    font: getFont(p.fontId),
    size: p.sizeMm,
    depth: p.depthMm,
    curveSegments: Math.max(2, Math.round(p.curveSegments)),
    bevelEnabled: false,
  })
  // mergeVertices welds across every attribute, so the differing normals/uvs
  // on shared corners would block it — drop them (the engine recomputes
  // creased normals on display anyway) so positions weld into clean topology.
  geometry.deleteAttribute('normal')
  geometry.deleteAttribute('uv')
  const welded = mergeVertices(geometry, 1e-4)
  geometry.dispose()
  welded.computeBoundingBox()
  const bb = welded.boundingBox!
  // center horizontally, keep the baseline at y = 0
  welded.translate(-(bb.min.x + bb.max.x) / 2, 0, 0)

  const pos = welded.getAttribute('position') as BufferAttribute
  const positions = new Float32Array(pos.array.length)
  positions.set(pos.array as Float32Array)
  const index = welded.getIndex()!
  const indices = new Uint32Array(index.count)
  indices.set(index.array as ArrayLike<number>)
  welded.dispose()

  const mesh: MeshData = { positions, indices }
  bendText(mesh, p)
  return restOnGround(mesh)
}

/**
 * Bend the flat text (x = along baseline, y = up, z = extrusion 0…depth) into
 * its placement. Ring text wraps a vertical cylinder of the given diameter;
 * arc text bends the baseline along a circle in the text plane (coin face).
 */
function bendText(mesh: MeshData, p: Text3DParams) {
  if (p.placement === 'flat') return
  const R = Math.max(p.diameter / 2, 0.5)
  const pts = mesh.positions
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i]
    const y = pts[i + 1]
    const z = pts[i + 2]
    switch (p.placement) {
      case 'ring-outside': {
        // baseline on the outer surface, extruding outward
        const theta = x / R
        const r = R + z
        pts[i] = r * Math.sin(theta)
        pts[i + 1] = y
        pts[i + 2] = r * Math.cos(theta)
        break
      }
      case 'ring-inside': {
        // mirrored so it reads from inside; cutter bites outward into the band
        const theta = -x / R
        const r = p.cutter ? R + z : R - p.depthMm + z
        pts[i] = r * Math.sin(theta)
        pts[i + 1] = y
        pts[i + 2] = r * Math.cos(theta)
        break
      }
      case 'arc-up': {
        // along the top of a coin face, letter tops pointing outward
        const phi = Math.PI / 2 - x / R
        const r = R + y
        pts[i] = r * Math.cos(phi)
        pts[i + 1] = r * Math.sin(phi)
        pts[i + 2] = z
        break
      }
      case 'arc-down': {
        // along the bottom, letter tops pointing toward the coin centre
        const phi = -Math.PI / 2 + x / R
        const r = R - y
        pts[i] = r * Math.cos(phi)
        pts[i + 1] = r * Math.sin(phi)
        pts[i + 2] = z
        break
      }
    }
  }
}
