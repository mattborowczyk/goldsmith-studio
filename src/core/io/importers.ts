import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { MeshData } from '../types'

export interface ImportedPart {
  name: string
  data: MeshData
  /**
   * Per-vertex colours (rgb in 0..1, one triple per position) when the source
   * file carries them — PLY from intraoral scans does (plan §3). Lean MeshData
   * stays colour-free for the geometry kernel; colour rides alongside here.
   */
  colors?: Float32Array
}

export const SUPPORTED_EXTENSIONS = ['stl', 'obj', 'glb', 'gltf', 'ply', '3mf'] as const

export function isSupportedFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)
}

/** Parse a model file into one or more raw meshes (positions in file units). */
export async function importFile(file: File): Promise<ImportedPart[]> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const baseName = file.name.replace(/\.[^.]+$/, '')
  switch (ext) {
    case 'stl': {
      const geo = new STLLoader().parse(await file.arrayBuffer())
      return [{ name: baseName, data: toMeshData(geo, true) }]
    }
    case 'obj': {
      const group = new OBJLoader().parse(await file.text())
      return collectMeshes(group, baseName)
    }
    case 'glb':
    case 'gltf': {
      const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), '')
      return collectMeshes(gltf.scene, baseName)
    }
    case 'ply': {
      // PLY may be ASCII or binary; PLYLoader handles both from an ArrayBuffer.
      // Already-indexed scans keep their topology; unindexed soup gets welded.
      const geo = new PLYLoader().parse(await file.arrayBuffer())
      const norm = normalizeGeometry(geo, !geo.index)
      return [{ name: baseName, data: meshDataFromGeo(norm), colors: colorsFromGeo(norm) }]
    }
    case '3mf': {
      const group = new ThreeMFLoader().parse(await file.arrayBuffer())
      return collectMeshes(group, baseName)
    }
    default:
      throw new Error(`Unsupported file type: .${ext}`)
  }
}

function collectMeshes(root: THREE.Object3D, baseName: string): ImportedPart[] {
  const parts: ImportedPart[] = []
  root.updateWorldMatrix(true, true)
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return
    const mesh = obj as THREE.Mesh
    const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
    const name = parts.length === 0 ? baseName : `${baseName}.${parts.length + 1}`
    parts.push({ name: mesh.name || name, data: toMeshData(geo, !mesh.geometry.index) })
  })
  if (parts.length === 0) throw new Error('No meshes found in file')
  return parts
}

/**
 * Normalize a BufferGeometry to an indexed form. Triangle-soup formats (STL,
 * unindexed OBJ) get exact-duplicate vertices welded so topology analysis sees
 * real connectivity instead of all-boundary edges. mergeVertices carries every
 * attribute (incl. `color`) through, so colours stay aligned to positions.
 */
function normalizeGeometry(geometry: THREE.BufferGeometry, weld: boolean): THREE.BufferGeometry {
  let geo = geometry
  if (weld) geo = mergeVertices(geo, 1e-6)
  if (!geo.index) geo = indexSequential(geo)
  return geo
}

/** Indexed MeshData from an already-normalized geometry. */
function meshDataFromGeo(geo: THREE.BufferGeometry): MeshData {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const positions = new Float32Array(pos.array.length)
  positions.set(pos.array as Float32Array)
  let indices: Uint32Array
  if (geo.index) {
    indices = new Uint32Array(geo.index.count)
    indices.set(geo.index.array as ArrayLike<number>)
  } else {
    indices = new Uint32Array(pos.count)
    for (let i = 0; i < pos.count; i++) indices[i] = i
  }
  return { positions, indices }
}

/** Per-vertex rgb (0..1) from a geometry's `color` attribute, or undefined. */
function colorsFromGeo(geo: THREE.BufferGeometry): Float32Array | undefined {
  const attr = geo.getAttribute('color') as THREE.BufferAttribute | undefined
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined
  // enforce the one-rgb-triple-per-vertex contract; bail on malformed geometry
  if (!attr || attr.itemSize < 3 || !pos || attr.count !== pos.count) return undefined
  const out = new Float32Array(attr.count * 3)
  for (let i = 0; i < attr.count; i++) {
    out[i * 3] = attr.getX(i)
    out[i * 3 + 1] = attr.getY(i)
    out[i * 3 + 2] = attr.getZ(i)
  }
  return out
}

/** Normalize + flatten to MeshData in one step (the non-coloured path). */
function toMeshData(geometry: THREE.BufferGeometry, weld: boolean): MeshData {
  return meshDataFromGeo(normalizeGeometry(geometry, weld))
}

function indexSequential(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const idx = new Uint32Array(pos.count)
  for (let i = 0; i < pos.count; i++) idx[i] = i
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  return geo
}

/**
 * A uniformly scaled copy of the mesh (unit conversion). Never mutates the
 * input — returns a fresh MeshData so callers can own the result, mirroring
 * `scaleMeshDataCopy` in exporters.ts.
 */
export function scaleMeshData(data: MeshData, factor: number): MeshData {
  const positions = new Float32Array(data.positions.length)
  for (let i = 0; i < data.positions.length; i++) positions[i] = data.positions[i] * factor
  return { positions, indices: data.indices.slice() }
}
