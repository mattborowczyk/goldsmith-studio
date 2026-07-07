import type { SceneManager } from '../engine/SceneManager'
import { fitClient } from '../geometry/fitClient'
import { repairClient } from '../geometry/repairClient'
import { thicknessClient } from '../geometry/thicknessClient'
import type { MeshData, Vec3, PartAppearance } from '../types'
import { estimateStorage, saveScene, type SavedPart } from '../persist/db'
import { useAppStore } from '../../store/appStore'

export interface StudioClients {
  fit: Pick<
    typeof fitClient,
    'offset' | 'subtract' | 'clearance' | 'survey' | 'wand' | 'bestAxis' | 'blockout' | 'shell'
  >
  thickness: Pick<typeof thicknessClient, 'compute'>
  repair: Pick<typeof repairClient, 'analyze' | 'heal' | 'split' | 'baseCapInfo' | 'baseCap'>
}

const realClients: StudioClients = {
  fit: fitClient,
  thickness: thicknessClient,
  repair: repairClient,
}

let engine: SceneManager | null = null
let clients: StudioClients = realClients
let nextPartNum = 1
let pickConsumer: 'measure' | 'resize' | 'wand' | null = null

export const revisions = new Map<string, { data: MeshData; matrix: number[] }[]>()

const selectionListeners = new Set<(id: string | null) => void>()

export function addSelectionListener(cb: (id: string | null) => void): () => void {
  selectionListeners.add(cb)
  return () => selectionListeners.delete(cb)
}

export function notifySelectionChanged(id: string | null) {
  for (const listener of selectionListeners) {
    listener(id)
  }
}

export function getEngine(): SceneManager {
  if (!engine) throw new Error('Engine not initialized')
  return engine
}

export function setEngine(eng: SceneManager | null) {
  engine = eng
}

export function getClients(): StudioClients {
  return clients
}

export function setClients(c: StudioClients) {
  clients = c
}

export function newPartId(): string {
  return `part-${Date.now()}-${nextPartNum++}`
}

export function getPickConsumer(): 'measure' | 'resize' | 'wand' | null {
  return pickConsumer
}

export function setPickConsumer(val: 'measure' | 'resize' | 'wand' | null) {
  pickConsumer = val
}

const pointPickHandlers: Record<'measure' | 'resize' | 'wand', ((point: Vec3) => void) | null> = {
  measure: null,
  resize: null,
  wand: null,
}

export function registerPointPickHandler(type: 'measure' | 'resize' | 'wand', handler: (point: Vec3) => void) {
  pointPickHandlers[type] = handler
}

export function handlePointPicked(point: Vec3) {
  if (pickConsumer && pointPickHandlers[pickConsumer]) {
    pointPickHandlers[pickConsumer]!(point)
  }
}


/**
 * Resolve the part to operate on: the current selection, or the sole part when
 * there's exactly one. When neither holds, the caller-supplied `onError` (if any)
 * receives the message so each feature can surface it in its own UI — this helper
 * is shared by Repair, Measure and Cost, so it must not hardcode any one slice.
 */
export function requireSelection(onError?: (message: string) => void): string | null {
  const store = useAppStore.getState()
  if (store.selectedId) return store.selectedId
  if (store.parts.length === 1) {
    getEngine().select(store.parts[0].id)
    return store.parts[0].id
  }
  onError?.('Select a part first (tap it in the viewport or the parts list).')
  return null
}

/**
 * Re-seat a world-space mesh so its transform origin sits at the geometry's
 * bounding-box centre, with the offset carried in the part matrix. The move/
 * resize gizmo pivots about the mesh origin, so baking world coordinates in at
 * the identity matrix would snap the gizmo to the scene origin whenever the part
 * lives off-centre. Centring keeps the gizmo on the part, as it is for a freshly
 * imported model.
 */
function centerWorldMesh(mesh: MeshData): { data: MeshData; matrix: number[] } {
  const p = mesh.positions
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  if (!c.every(Number.isFinite)) return { data: mesh, matrix: [...IDENTITY_MATRIX] }
  const positions = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    positions[i] = p[i] - c[0]
    positions[i + 1] = p[i + 1] - c[1]
    positions[i + 2] = p[i + 2] - c[2]
  }
  // column-major 4×4: identity rotation, translation in the last column
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, c[0], c[1], c[2], 1]
  return { data: { positions, indices: mesh.indices.slice() }, matrix }
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

export function replaceWithWorldMesh(id: string, mesh: MeshData) {
  const eng = getEngine()
  const info = eng.partInfo(id)
  if (!info) return
  eng.removePart(id)
  const { data, matrix } = centerWorldMesh(mesh)
  eng.addPart(id, info.name, data, matrix)
  eng.select(id)
}

export function addGeneratedPart(
  name: string,
  data: MeshData,
  appearance?: Partial<PartAppearance>,
): string {
  const eng = getEngine()
  const id = newPartId()
  eng.addPart(id, name, data, undefined, appearance)
  eng.select(id)
  eng.fitToView()
  return id
}


let saveTimer: ReturnType<typeof setTimeout> | null = null

function isQuotaError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
  }
  return false
}

function reportWriteFailure(err: unknown) {
  console.warn('Persistence write failed', err)
  useAppStore.getState().patchStorage({ writeFailed: true, quotaExceeded: isQuotaError(err) })
}

export function guardWrite(write: Promise<unknown>): Promise<void> {
  return write.then(
    () => {
      if (useAppStore.getState().storage.writeFailed) {
        useAppStore.getState().patchStorage({ writeFailed: false, quotaExceeded: false })
      }
    },
    reportWriteFailure,
  )
}

export function scheduleAutosave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void persistScene(), 1500)
}

export async function persistScene() {
  if (!engine) return
  const parts: SavedPart[] = []
  engine.listParts().forEach((info, order) => {
    const saved = engine!.getPartForSave(info.id)
    if (!saved) return
    parts.push({
      id: info.id,
      name: saved.name,
      visible: saved.visible,
      matrix: saved.matrix,
      positions: saved.data.positions,
      indices: saved.data.indices,
      order,
      material: saved.material,
      flatShading: saved.flatShading,
      colors: saved.colors,
    })
  })
  await guardWrite(saveScene(parts))
  void refreshStorageEstimate()
}

export async function refreshStorageEstimate(): Promise<void> {
  const estimate = await estimateStorage()
  useAppStore.getState().patchStorage({ estimate })
}

export function __resetContext(): void {
  engine = null
  clients = realClients
  nextPartNum = 1
  pickConsumer = null
  revisions.clear()
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}


