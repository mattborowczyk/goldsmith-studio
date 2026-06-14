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

const ALL_STORES = ['parts', 'settings', 'materials', 'history', 'kv'] as const

/**
 * Read every store into a plain object within ONE read-only transaction so the
 * snapshot is internally consistent (settings + kv enumerated by key). getAll and
 * getAllKeys share the store's key order, so zipping them keeps key↔value paired.
 */
export async function dumpDatabase(): Promise<DatabaseDump> {
  const db = await getDB()
  const tx = db.transaction(ALL_STORES, 'readonly')
  const parts = await tx.objectStore('parts').getAll()
  const materials = await tx.objectStore('materials').getAll()
  const history = await tx.objectStore('history').getAll()
  const settingsStore = tx.objectStore('settings')
  const [settingsKeys, settingsVals] = await Promise.all([
    settingsStore.getAllKeys(),
    settingsStore.getAll(),
  ])
  const settings = settingsKeys.map((key, i) => ({ key: String(key), value: settingsVals[i] }))
  const kvStore = tx.objectStore('kv')
  const [kvKeys, kvVals] = await Promise.all([kvStore.getAllKeys(), kvStore.getAll()])
  const kv = kvKeys.map((key, i) => ({ key: String(key), value: kvVals[i] }))
  await tx.done
  return { parts, settings, materials, history, kv }
}

/**
 * Replace the entire database with a dump in ONE read-write transaction — the
 * restore is all-or-nothing: if any write fails the transaction aborts and the
 * existing data is left untouched. Requests are issued without intermediate
 * awaits so the transaction can't auto-commit early.
 */
export async function restoreDatabase(dump: DatabaseDump): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(ALL_STORES, 'readwrite')
  for (const store of ['parts', 'materials', 'history'] as const) {
    const os = tx.objectStore(store)
    os.clear()
    for (const value of dump[store]) os.put(value as never)
  }
  const settingsStore = tx.objectStore('settings')
  settingsStore.clear()
  for (const { key, value } of dump.settings) settingsStore.put(value, key)
  const kvStore = tx.objectStore('kv')
  kvStore.clear()
  for (const { key, value } of dump.kv) kvStore.put(value, key)
  await tx.done
}
