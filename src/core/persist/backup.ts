/**
 * Local backup file (de)serialization — plan §2.8 "your insurance, no cloud".
 * Pure and DOM-light: turns a full {@link DatabaseDump} into one versioned JSON
 * string and back, with strict validation so a corrupt or foreign file is
 * rejected cleanly rather than poisoning the database.
 *
 * Parts carry typed arrays (positions: Float32Array, indices: Uint32Array);
 * JSON can't hold those, so we encode their raw bytes as **base64** — compact
 * (≈4 bytes → ~5.3 chars) versus a JSON number array (~7+ chars/byte), which
 * matters for multi-MB meshes. The file/disk plumbing lives in the app layer.
 */
import type { Material, HistoryEntry } from '../calc/materials'
import type { DatabaseDump, SavedPart, SavedSettings } from './db'

export const BACKUP_FORMAT = 'goldsmith-studio-backup'
export const BACKUP_VERSION = 1

/** A part with its typed arrays base64-encoded for JSON transport. */
type SerializedPart = Omit<SavedPart, 'positions' | 'indices'> & {
  positions: string
  indices: string
}

interface SerializedDump {
  parts: SerializedPart[]
  settings: { key: string; value: SavedSettings }[]
  materials: Material[]
  history: HistoryEntry[]
  kv: { key: string; value: unknown }[]
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: string
  data: SerializedDump
}

/** Serialize a full database dump to a pretty-printed JSON backup string. */
export function serializeBackup(dump: DatabaseDump): string {
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    data: {
      parts: dump.parts.map(serializePart),
      settings: dump.settings,
      materials: dump.materials,
      history: dump.history,
      kv: dump.kv,
    },
  }
  return JSON.stringify(file, null, 2)
}

/**
 * Parse + validate a backup string back into a database dump. Throws an `Error`
 * with a human-readable message on malformed JSON, a wrong/foreign format tag,
 * an unsupported version, or a structurally invalid payload.
 */
export function parseBackup(text: string): DatabaseDump {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Not a valid backup file (could not parse JSON).')
  }
  if (!isRecord(parsed)) throw new Error('Not a valid backup file.')
  if (parsed.format !== BACKUP_FORMAT) {
    throw new Error('This file is not a GoldSmith Studio backup.')
  }
  if (parsed.version !== BACKUP_VERSION) {
    throw new Error(
      `Unsupported backup version ${String(parsed.version)} (this app reads version ${BACKUP_VERSION}).`,
    )
  }
  const data = parsed.data
  if (!isRecord(data)) throw new Error('Backup is missing its data section.')
  for (const store of ['parts', 'settings', 'materials', 'history', 'kv'] as const) {
    if (!Array.isArray(data[store])) {
      throw new Error(`Backup is malformed: "${store}" is missing or not a list.`)
    }
  }
  // validate entry shapes before they reach restoreDatabase: every store put
  // needs a key (inline keyPath 'id', or out-of-line 'key'), so a malformed
  // entry must fail here rather than blow up mid-restore.
  // the Array.isArray guard above already proved each store is an array
  const parts = (data.parts as SerializedPart[]).map(deserializePart)
  requireIdentified(data.materials as unknown[], 'materials')
  requireIdentified(data.history as unknown[], 'history')
  requireKeyed(data.settings as unknown[], 'settings')
  requireKeyed(data.kv as unknown[], 'kv')
  return {
    parts,
    settings: data.settings as DatabaseDump['settings'],
    materials: data.materials as Material[],
    history: data.history as HistoryEntry[],
    kv: data.kv as DatabaseDump['kv'],
  }
}

/** Each entry must be an object with a string inline key (keyPath 'id'). */
function requireIdentified(entries: unknown[], store: string): void {
  for (const e of entries) {
    if (!isRecord(e) || typeof e.id !== 'string') {
      throw new Error(`Backup is malformed: an entry in "${store}" is missing its id.`)
    }
  }
}

/** Each entry must be a { key: string, value } pair (out-of-line keyed store). */
function requireKeyed(entries: unknown[], store: string): void {
  for (const e of entries) {
    if (!isRecord(e) || typeof e.key !== 'string') {
      throw new Error(`Backup is malformed: an entry in "${store}" is missing its key.`)
    }
  }
}

function serializePart(part: SavedPart): SerializedPart {
  return {
    ...part,
    positions: bytesToBase64(new Uint8Array(part.positions.buffer, part.positions.byteOffset, part.positions.byteLength)),
    indices: bytesToBase64(new Uint8Array(part.indices.buffer, part.indices.byteOffset, part.indices.byteLength)),
  }
}

function deserializePart(part: SerializedPart): SavedPart {
  if (typeof part?.id !== 'string') {
    throw new Error('Backup is malformed: a part is missing its id.')
  }
  if (typeof part.positions !== 'string' || typeof part.indices !== 'string') {
    throw new Error('Backup is malformed: a part is missing its geometry.')
  }
  let posBytes: Uint8Array
  let idxBytes: Uint8Array
  try {
    posBytes = base64ToBytes(part.positions)
    idxBytes = base64ToBytes(part.indices)
  } catch {
    throw new Error('Backup is malformed: part geometry is corrupt.')
  }
  if (posBytes.byteLength % 4 !== 0 || idxBytes.byteLength % 4 !== 0) {
    throw new Error('Backup is malformed: part geometry is corrupt.')
  }
  const { positions: _p, indices: _i, ...rest } = part
  void _p
  void _i
  return {
    ...rest,
    positions: new Float32Array(posBytes.buffer, posBytes.byteOffset, posBytes.byteLength / 4),
    indices: new Uint32Array(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength / 4),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// base64 helpers using the platform btoa/atob (present in browsers and Node ≥16),
// chunked so very large meshes don't blow the call-stack via spread.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
