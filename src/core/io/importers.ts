import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { MeshData } from '../types'

export interface ImportedPart {
  name: string
  data: MeshData
}

export const SUPPORTED_EXTENSIONS = ['stl', 'obj', 'glb', 'gltf'] as const

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
 * Normalize a BufferGeometry to indexed MeshData. Triangle-soup formats (STL,
 * unindexed OBJ) get exact-duplicate vertices welded so topology analysis sees
 * real connectivity instead of all-boundary edges.
 */
function toMeshData(geometry: THREE.BufferGeometry, weld: boolean): MeshData {
  let geo = geometry
  if (weld) geo = mergeVertices(geo, 1e-6)
  if (!geo.index) geo = indexSequential(geo)
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

function indexSequential(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const idx = new Uint32Array(pos.count)
  for (let i = 0; i < pos.count; i++) idx[i] = i
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  return geo
}

/** Scale mesh positions in place by a uniform factor (unit conversion). */
export function scaleMeshData(data: MeshData, factor: number): MeshData {
  if (factor === 1) return data
  const positions = data.positions
  for (let i = 0; i < positions.length; i++) positions[i] *= factor
  return data
}
