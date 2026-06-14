import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DisplayMode, MaterialPreset, MeshData } from '../types'
import type { HistoryEntry, Material } from '../calc/materials'

export interface SavedPart {
  id: string
  name: string
  visible: boolean
  matrix: number[]
  positions: Float32Array
  indices: Uint32Array
  order: number
  /** Per-part display material override; absent/null follows the global mode. */
  material?: MaterialPreset | null
  flatShading?: boolean
}

export interface SavedSettings {
  displayMode: DisplayMode
  background: string
  gridVisible: boolean
  /** Accent-colour preset id (see src/app/theme.ts); absent = the gold default. */
  accent?: string
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

export async function loadScene(): Promise<
  {
    id: string
    name: string
    visible: boolean
    matrix: number[]
    data: MeshData
    material: MaterialPreset | null
    flatShading: boolean
  }[]
> {
  const db = await getDB()
  const parts = await db.getAll('parts')
  parts.sort((a, b) => a.order - b.order)
  return parts.map((p) => ({
    id: p.id,
    name: p.name,
    visible: p.visible,
    matrix: p.matrix,
    data: { positions: p.positions, indices: p.indices },
    material: p.material ?? null,
    flatShading: p.flatShading ?? false,
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

// ---------- full-database backup/restore (plan §2.8) ----------

/** A complete snapshot of every IndexedDB store, ready to (de)serialize. */
export interface DatabaseDump {
  parts: SavedPart[]
  /** Out-of-line keyed store: key/value pairs. */
  settings: { key: string; value: SavedSettings }[]
  materials: Material[]
  history: HistoryEntry[]
  /** Generic store enumerated by key — never hardcode the key list. */
  kv: { key: string; value: unknown }[]
}

/** Read every store into a plain object (settings + kv enumerated by key). */
export async function dumpDatabase(): Promise<DatabaseDump> {
  const db = await getDB()
  const [parts, materials, history] = await Promise.all([
    db.getAll('parts'),
    db.getAll('materials'),
    db.getAll('history'),
  ])
  const settingsKeys = await db.getAllKeys('settings')
  const settings = await Promise.all(
    settingsKeys.map(async (key) => ({
      key: String(key),
      value: (await db.get('settings', key))!,
    })),
  )
  const kvKeys = await db.getAllKeys('kv')
  const kv = await Promise.all(
    kvKeys.map(async (key) => ({ key: String(key), value: await db.get('kv', key) })),
  )
  return { parts, settings, materials, history, kv }
}

/** Replace the entire database contents with a dump (clears each store first). */
export async function restoreDatabase(dump: DatabaseDump): Promise<void> {
  const db = await getDB()
  // inline-key stores
  for (const store of ['parts', 'materials', 'history'] as const) {
    const tx = db.transaction(store, 'readwrite')
    await tx.store.clear()
    for (const value of dump[store]) await tx.store.put(value as never)
    await tx.done
  }
  // out-of-line keyed stores
  const sTx = db.transaction('settings', 'readwrite')
  await sTx.store.clear()
  for (const { key, value } of dump.settings) await sTx.store.put(value, key)
  await sTx.done

  const kTx = db.transaction('kv', 'readwrite')
  await kTx.store.clear()
  for (const { key, value } of dump.kv) await kTx.store.put(value, key)
  await kTx.done
}
