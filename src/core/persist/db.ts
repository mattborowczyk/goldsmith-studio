import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DisplayMode, MeshData } from '../types'

export interface SavedPart {
  id: string
  name: string
  visible: boolean
  matrix: number[]
  positions: Float32Array
  indices: Uint32Array
  order: number
}

export interface SavedSettings {
  displayMode: DisplayMode
  background: string
  gridVisible: boolean
}

interface StudioDB extends DBSchema {
  parts: { key: string; value: SavedPart }
  settings: { key: string; value: SavedSettings }
}

let dbPromise: Promise<IDBPDatabase<StudioDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<StudioDB>('goldsmith-studio', 1, {
      upgrade(db) {
        db.createObjectStore('parts', { keyPath: 'id' })
        db.createObjectStore('settings')
      },
    })
  }
  return dbPromise
}

export async function saveScene(parts: SavedPart[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('parts', 'readwrite')
  await tx.store.clear()
  for (const part of parts) await tx.store.put(part)
  await tx.done
}

export async function loadScene(): Promise<{ id: string; name: string; visible: boolean; matrix: number[]; data: MeshData }[]> {
  const db = await getDB()
  const parts = await db.getAll('parts')
  parts.sort((a, b) => a.order - b.order)
  return parts.map((p) => ({
    id: p.id,
    name: p.name,
    visible: p.visible,
    matrix: p.matrix,
    data: { positions: p.positions, indices: p.indices },
  }))
}

export async function saveSettings(settings: SavedSettings): Promise<void> {
  const db = await getDB()
  await db.put('settings', settings, 'app')
}

export async function loadSettings(): Promise<SavedSettings | undefined> {
  const db = await getDB()
  return db.get('settings', 'app')
}
