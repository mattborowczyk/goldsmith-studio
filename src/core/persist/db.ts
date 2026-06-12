import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DisplayMode, MeshData } from '../types'
import type { HistoryEntry, Material } from '../calc/materials'

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
  materials: { key: string; value: Material }
  history: { key: string; value: HistoryEntry }
  /** Small odds and ends: cost settings, part→material map, measurements. */
  kv: { key: string; value: unknown }
}

let dbPromise: Promise<IDBPDatabase<StudioDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<StudioDB>('goldsmith-studio', 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('parts', { keyPath: 'id' })
          db.createObjectStore('settings')
        }
        if (oldVersion < 2) {
          db.createObjectStore('materials', { keyPath: 'id' })
          db.createObjectStore('history', { keyPath: 'id' })
          db.createObjectStore('kv')
        }
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

// ---------- materials ----------

export async function saveMaterials(materials: Material[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('materials', 'readwrite')
  await tx.store.clear()
  for (const m of materials) await tx.store.put(m)
  await tx.done
}

export async function loadMaterials(): Promise<Material[]> {
  const db = await getDB()
  return db.getAll('materials')
}

// ---------- history ----------

export async function addHistoryEntries(entries: HistoryEntry[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('history', 'readwrite')
  for (const e of entries) await tx.store.put(e)
  await tx.done
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  const db = await getDB()
  const all = await db.getAll('history')
  return all.sort((a, b) => b.date.localeCompare(a.date))
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('history', id)
}

export async function clearHistoryStore(): Promise<void> {
  const db = await getDB()
  await db.clear('history')
}

// ---------- generic key-value ----------

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await getDB()
  await db.put('kv', value, key)
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await getDB()
  return (await db.get('kv', key)) as T | undefined
}
