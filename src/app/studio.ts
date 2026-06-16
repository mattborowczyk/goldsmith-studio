import { SceneManager } from '@/core/engine/SceneManager'
import { importFile, scaleMeshData } from '@/core/io/importers'
import { repairClient } from '@/core/geometry/repairClient'
import { thicknessClient, type ThicknessJob } from '@/core/geometry/thicknessClient'
import { fitClient, type FitJob } from '@/core/geometry/fitClient'
import { defaultInsertionAxis } from '@/core/geometry/undercut'
import {
  addHistoryEntries,
  clearHistoryStore,
  deleteHistoryEntry,
  dumpDatabase,
  estimateStorage,
  kvGet,
  kvSet,
  loadHistory,
  loadMaterials,
  loadScene,
  loadSettings,
  requestPersistentStorage,
  restoreDatabase,
  saveMaterials,
  saveScene,
  saveSettings,
  type SavedPart,
} from '@/core/persist/db'
import { parseBackup, serializeBackup } from '@/core/persist/backup'
import { saveFile, shareFiles, pickTextFile, type SaveData, type SaveType } from '@/app/files'
import { applyAccent, normalizeAccent } from '@/app/theme'
import {
  applySpotPrices,
  costOf,
  defaultMaterials,
  historyToCSV,
  weightGrams,
  type HistoryEntry,
  type Material,
} from '@/core/calc/materials'
import { fetchSpotPricesPerGram, type Currency } from '@/core/calc/spotPrices'
import { analyzeRingFrame, estimateInnerDiameter, volumeAndArea } from '@/core/geometry/measure'
import {
  export3MF,
  exportOBJ,
  exportPLY,
  exportSTL,
  mergeMeshData,
  scaleMeshDataCopy,
  type MeshFormat,
  type NamedMesh,
} from '@/core/io/exporters'
import {
  buildReportModel,
  reportToText,
  type GemListEntry,
  type ReportBranding,
  type ReportInput,
  type ReportPartInput,
} from '@/core/report/reportModel'
import { buildReportPDF } from '@/core/report/pdf'
import { detectHeadAngleDeg, pointAngleDeg, resizeRing } from '@/core/geometry/resize'
import { diameterToSize, sizeToDiameter, ukLabel, type SizeSystem } from '@/core/generators/ringSizes'
import type {
  DisplayMode,
  ImportUnit,
  Measurement,
  MeshData,
  PartAppearance,
  ResizeMode,
  ResizeOverlay,
  RingFrame,
  Vec3,
} from '@/core/types'
import { HEAL_PRESETS, UNIT_TO_MM } from '@/core/types'
import { useAppStore, type CostSettings, type DeliverState, type SectionState } from '@/store/appStore'

/**
 * Application controller: owns the SceneManager singleton and orchestrates
 * import, repair, persistence. React components call these functions; state
 * flows back through the zustand store.
 */

let engine: SceneManager | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let nextPartNum = 1
/** Which tab armed the shared pick mode — routes the pointPicked event. */
let pickConsumer: 'measure' | 'resize' | null = null
/** Non-destructive heal/resize: previous geometry+transform per part, newest last. */
const revisions = new Map<string, { data: MeshData; matrix: number[] }[]>()
/** In-flight wall-thickness compute, so the UI can cancel it. */
let thicknessJob: ThicknessJob | null = null
/** In-flight grillz fit op (offset / subtract / clearance map / survey / blockout). */
let fitJob: FitJob<unknown> | null = null
/** Debounce timer coalescing survey recomputes during an axis-gizmo drag. */
let surveyDebounce: ReturnType<typeof setTimeout> | null = null
/** Facet count of the Minkowski offset ball — coarse: a thin uniform gap needs no smooth sphere. */
const FIT_SPHERE_SEGMENTS = 16

export function getEngine(): SceneManager {
  if (!engine) throw new Error('Engine not initialized')
  return engine
}

export function initEngine(container: HTMLElement): SceneManager {
  if (engine) return engine
  engine = new SceneManager(container)
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>
    w.__engine = engine
    void import('three').then((three) => (w.__THREE = three))
  }
  const store = useAppStore.getState()

  engine.on('partsChanged', () => {
    const s = useAppStore.getState()
    s.setParts(engine!.listParts())
    // the engine drops its heatmap when the painted part is removed/replaced;
    // reconcile the store so the Measure panel doesn't show a stale overlay
    if (s.measure.heatmap.enabled && !engine!.hasThicknessHeatmap()) {
      s.patchHeatmap({ enabled: false, busy: false, progress: 0, range: null, partId: null, error: null })
    }
    // same reconcile for the clearance map (e.g. its shell part was removed/replaced)
    if (s.fit.mapEnabled && !engine!.hasClearanceMap()) {
      s.patchFit({ mapEnabled: false, mapRange: null, mapPartId: null })
    }
    // and for the undercut survey (its scan part removed/replaced → drop the gizmo too)
    if (s.fit.surveyEnabled && !engine!.hasUndercutSurvey()) {
      // a drag-scheduled recompute must not fire against the now-gone scan
      if (surveyDebounce) { clearTimeout(surveyDebounce); surveyDebounce = null }
      engine!.hideInsertionAxis()
      s.patchFit({ surveyEnabled: false, undercutArea: null, surveyPartId: null })
    }
    // and for the brush-select (its scan part removed/replaced → disarm + drop the overlay)
    if (s.fit.brushActive && !engine!.hasBrushSelect()) {
      s.patchFit({ brushActive: false, brushCount: 0 })
    }
    scheduleAutosave()
    if (s.tab === 'cost') scheduleVolumeRecompute()
  })
  engine.on('selectionChanged', (id) => {
    useAppStore.getState().setSelected(id)
    updateRepairUndoFlag(id)
  })
  engine.on('pointPicked', handlePointPicked)
  engine.on('resizeHandleDrag', (protectedDeg) => setResizeProtectedWidth(protectedDeg))
  engine.on('insertionAxisChanged', (axis) => setInsertionAxisFromGizmo(axis))
  engine.on('brushSelectionChanged', (count) => useAppStore.getState().patchFit({ brushCount: count }))

  void restoreSession()
  void initCostData()
  void initDeliverData()
  store.setParts(engine.listParts())
  return engine
}

export function disposeEngine() {
  engine?.dispose()
  engine = null
}

// ---------- import ----------

export async function importFiles(
  files: File[],
  opts: { unit: ImportUnit; mode: 'append' | 'replace' },
): Promise<void> {
  const store = useAppStore.getState()
  store.setImporting(true)
  try {
    const eng = getEngine()
    if (opts.mode === 'replace') {
      eng.clearParts()
      revisions.clear()
    }
    const factor = UNIT_TO_MM[opts.unit]
    for (const file of files) {
      const parts = await importFile(file)
      for (const part of parts) {
        const data = scaleMeshData(part.data, factor)
        eng.addPart(newPartId(), part.name, data, undefined, undefined, part.colors)
      }
    }
    eng.fitToView()
    store.setImporting(false)
  } catch (err) {
    store.setImporting(false, err instanceof Error ? err.message : String(err))
  }
}

function newPartId(): string {
  return `part-${Date.now()}-${nextPartNum++}`
}

// ---------- repair ----------

export async function analyzeSelected(): Promise<void> {
  const store = useAppStore.getState()
  const id = requireSelection()
  if (!id) return
  const mesh = getEngine().getWorldMeshData(id)
  if (!mesh) return
  store.patchRepair({ busy: 'analyze', error: null })
  try {
    const report = await repairClient.analyze(mesh)
    getEngine().showAnalysisHighlights(report)
    useAppStore.getState().patchRepair({ busy: null, report })
  } catch (err) {
    useAppStore.getState().patchRepair({ busy: null, error: String(err) })
  }
}

export async function healSelected(): Promise<void> {
  const store = useAppStore.getState()
  const id = requireSelection()
  if (!id) return
  const eng = getEngine()
  const mesh = eng.getWorldMeshData(id)
  if (!mesh) return
  store.patchRepair({ busy: 'heal', error: null })
  try {
    const outcome = await repairClient.heal(mesh, store.repair.options)
    // push current state for undo, then replace with healed world-space mesh
    const saved = eng.getPartForSave(id)
    if (saved) {
      const stack = revisions.get(id) ?? []
      stack.push({ data: saved.data, matrix: saved.matrix })
      revisions.set(id, stack)
    }
    replaceWithWorldMesh(id, outcome.mesh)
    eng.clearHighlights()
    useAppStore.getState().patchRepair({
      busy: null,
      beforeAfter: { before: outcome.before, after: outcome.after, unioned: outcome.unioned },
      report: outcome.after,
      canUndo: true,
    })
  } catch (err) {
    useAppStore.getState().patchRepair({ busy: null, error: String(err) })
  }
}

export function undoHeal(): void {
  const id = useAppStore.getState().selectedId
  if (!id) return
  const stack = revisions.get(id)
  const prev = stack?.pop()
  if (!prev) return
  const eng = getEngine()
  const name = eng.partInfo(id)?.name ?? 'part'
  eng.removePart(id)
  eng.addPart(id, name, prev.data, prev.matrix)
  eng.select(id)
  useAppStore.getState().patchRepair({ beforeAfter: null, report: null, canUndo: (stack?.length ?? 0) > 0 })
}

export async function splitSelected(): Promise<void> {
  const store = useAppStore.getState()
  const id = requireSelection()
  if (!id) return
  const eng = getEngine()
  const mesh = eng.getWorldMeshData(id)
  if (!mesh) return
  store.patchRepair({ busy: 'split', error: null })
  try {
    const shells = await repairClient.split(mesh)
    if (shells.length > 1) {
      const name = eng.partInfo(id)?.name ?? 'part'
      eng.removePart(id)
      revisions.delete(id)
      shells.forEach((shell, i) => {
        eng.addPart(newPartId(), `${name}.shell${i + 1}`, shell)
      })
    }
    useAppStore.getState().patchRepair({ busy: null })
  } catch (err) {
    useAppStore.getState().patchRepair({ busy: null, error: String(err) })
  }
}

/** Replace a part's geometry with world-space data and reset its transform. */
function replaceWithWorldMesh(id: string, mesh: MeshData) {
  const eng = getEngine()
  const info = eng.partInfo(id)
  if (!info) return
  eng.removePart(id)
  eng.addPart(id, info.name, mesh)
  eng.select(id)
}

function requireSelection(): string | null {
  const store = useAppStore.getState()
  if (store.selectedId) return store.selectedId
  // single part? select it implicitly
  if (store.parts.length === 1) {
    getEngine().select(store.parts[0].id)
    return store.parts[0].id
  }
  store.patchRepair({ error: 'Select a part first (tap it in the viewport or the parts list).' })
  return null
}

function updateRepairUndoFlag(id: string | null) {
  const canUndo = id ? (revisions.get(id)?.length ?? 0) > 0 : false
  useAppStore.getState().patchRepair({ canUndo, report: null, beforeAfter: null })
  engine?.clearHighlights()
}

// ---------- persistence ----------

/** A QuotaExceededError under any of the names browsers use for it. */
function isQuotaError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
  }
  return false
}

/**
 * Surface a persistence write failure on the storage banner instead of letting it
 * vanish into a console.warn — a swallowed QuotaExceededError means the user thinks
 * their work is saved when it isn't (issue #10).
 */
function reportWriteFailure(err: unknown) {
  console.warn('Persistence write failed', err)
  useAppStore.getState().patchStorage({ writeFailed: true, quotaExceeded: isQuotaError(err) })
}

/**
 * Run a fire-and-forget persistence write, routing any failure to the storage
 * banner. A subsequent success clears a previously-raised flag so the warning
 * doesn't linger once the write path recovers.
 */
function guardWrite(write: Promise<unknown>): Promise<void> {
  return write.then(
    () => {
      if (useAppStore.getState().storage.writeFailed) {
        useAppStore.getState().patchStorage({ writeFailed: false, quotaExceeded: false })
      }
    },
    reportWriteFailure,
  )
}

function scheduleAutosave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void persistScene(), 1500)
}

async function persistScene() {
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
  // Scenes are the heavy writes (multi-MB scans), so refresh the usage readout
  // once the scene has persisted (issue #32).
  void refreshStorageEstimate()
}

/**
 * Pull a fresh storage estimate into the store so the usage readout / proactive
 * near-quota warning stay current. Best-effort: a null estimate just leaves the
 * readout hidden.
 */
export async function refreshStorageEstimate(): Promise<void> {
  const estimate = await estimateStorage()
  useAppStore.getState().patchStorage({ estimate })
}

export function persistDisplaySettings() {
  const s = useAppStore.getState()
  void guardWrite(
    saveSettings({
      displayMode: s.displayMode,
      background: s.background,
      gridVisible: s.gridVisible,
      accent: s.accent,
    }),
  )
}

async function restoreSession() {
  const store = useAppStore.getState()
  // Ask once for durable storage so WebKit can't silently evict the scene under
  // storage pressure. Surface the grant state for the storage readout (issue #32).
  void requestPersistentStorage().then((granted) => {
    if (import.meta.env.DEV) console.info('Persistent storage:', granted)
    useAppStore.getState().patchStorage({ persisted: granted })
    // Re-read once the grant lands: persistence can change the effective quota.
    void refreshStorageEstimate()
  })
  // Eager first read so the readout appears even if the grant request is slow.
  void refreshStorageEstimate()
  try {
    const [parts, settings] = await Promise.all([loadScene(), loadSettings()])
    if (!engine) return
    if (settings) {
      engine.setDisplayMode(settings.displayMode)
      engine.setBackground(settings.background)
      engine.setGridVisible(settings.gridVisible)
      store.setDisplayMode(settings.displayMode)
      store.setBackground(settings.background)
      store.setGridVisible(settings.gridVisible)
      const accent = normalizeAccent(settings.accent)
      store.setAccent(accent)
      applyAccent(accent)
    }
    for (const p of parts) {
      engine.addPart(
        p.id, p.name, p.data, p.matrix,
        { material: p.material, flatShading: p.flatShading },
        p.colors ?? undefined,
      )
      engine.setPartVisible(p.id, p.visible)
    }
    if (parts.length) engine.fitToView()
    await restoreMeasurements()
  } catch (err) {
    console.warn('Session restore failed', err)
  } finally {
    useAppStore.getState().setRestoring(false)
  }
}

// ---------- display commands (engine + store + persisted settings) ----------

export function setDisplayMode(mode: DisplayMode) {
  getEngine().setDisplayMode(mode)
  useAppStore.getState().setDisplayMode(mode)
  persistDisplaySettings()
}

export function setBackground(name: string) {
  getEngine().setBackground(name)
  useAppStore.getState().setBackground(name)
  persistDisplaySettings()
}

export function setGridVisible(visible: boolean) {
  getEngine().setGridVisible(visible)
  useAppStore.getState().setGridVisible(visible)
  persistDisplaySettings()
}

/** Switch the accent-colour preset (plan §2.8 theming) and persist the choice. */
export function setAccent(id: string) {
  const accent = normalizeAccent(id)
  applyAccent(accent)
  useAppStore.getState().setAccent(accent)
  persistDisplaySettings()
}

export function downloadSnapshot() {
  downloadDataURL(getEngine().snapshotPNG(), 'goldsmith-snapshot')
}

/** High-res clean render for client previews (helpers hidden, full post FX). */
export function downloadClientPreview() {
  downloadDataURL(getEngine().renderPreviewPNG(2048), 'goldsmith-preview')
}

export function setPostFX(enabled: boolean) {
  getEngine().setPostFX(enabled)
  useAppStore.getState().setPostFX(enabled)
}

function downloadDataURL(url: string, prefix: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = `${prefix}-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.png`
  a.click()
}

/**
 * Save (or share) one or more exported files. Single-file shares go through the
 * Web Share API on iPad when requested + available, otherwise everything routes
 * through saveFile (File System Access picker → download fallback).
 */
async function deliverFiles(
  built: { data: SaveData; name: string; mime: string }[],
  opts: { share?: boolean; title?: string; type?: SaveType } = {},
) {
  if (opts.share && built.length === 1) {
    const f = built[0]
    if (await shareFiles(f.data, f.name, f.mime, opts.title)) return
  }
  for (const f of built) await saveFile(f.data, f.name, f.mime, opts.type)
}

/** Strip the `data:...;base64,` prefix and decode to bytes (for PDF embedding). */
function dataURLtoBytes(url: string): Uint8Array {
  const base64 = url.slice(url.indexOf(',') + 1)
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function safeFilename(name: string): string {
  return name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'goldsmith'
}

// ---------- cost: materials, weight, history (plan §2.4) ----------

const KV_COST_SETTINGS = 'costSettings'
const KV_ASSIGNMENTS = 'partMaterials'
const KV_MEASUREMENTS = 'measurements'
const KV_MEASURE_COLOR = 'measureColor'

async function initCostData() {
  const store = useAppStore.getState()
  try {
    let materials = await loadMaterials()
    if (materials.length === 0) {
      materials = defaultMaterials()
      await guardWrite(saveMaterials(materials))
    } else {
      // IndexedDB getAll returns key order — restore library order, customs last
      const rank = new Map(defaultMaterials().map((m, i) => [m.id, i]))
      materials.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
    }
    const [settings, assignments, history, color] = await Promise.all([
      kvGet<CostSettings>(KV_COST_SETTINGS),
      kvGet<Record<string, string>>(KV_ASSIGNMENTS),
      loadHistory(),
      kvGet<string>(KV_MEASURE_COLOR),
    ])
    store.patchCost({
      materials,
      history,
      ...(settings ? { settings } : {}),
      ...(assignments ? { assignments } : {}),
    })
    if (color) store.patchMeasure({ color })
  } catch (err) {
    console.warn('Cost data init failed', err)
  }
}

let volumeTimer: ReturnType<typeof setTimeout> | null = null

function scheduleVolumeRecompute() {
  if (volumeTimer) clearTimeout(volumeTimer)
  volumeTimer = setTimeout(recomputeVolumes, 300)
}

/** World-space volume per part — runs when the Cost tab needs fresh numbers. */
export function recomputeVolumes() {
  if (!engine) return
  const volumes: Record<string, number> = {}
  for (const info of engine.listParts()) {
    const mesh = engine.getWorldMeshData(info.id)
    if (mesh) volumes[info.id] = volumeAndArea(mesh).volume
  }
  useAppStore.getState().patchCost({ volumes })
}

export function setPartMaterial(partId: string, materialId: string) {
  const store = useAppStore.getState()
  const assignments = { ...store.cost.assignments }
  if (materialId) assignments[partId] = materialId
  else delete assignments[partId]
  store.patchCost({ assignments })
  void guardWrite(kvSet(KV_ASSIGNMENTS, assignments))
}

export function updateCostSettings(patch: Partial<CostSettings>) {
  const store = useAppStore.getState()
  const settings = { ...store.cost.settings, ...patch }
  store.patchCost({ settings })
  void guardWrite(kvSet(KV_COST_SETTINGS, settings))
}

export function updateMaterial(id: string, patch: Partial<Material>) {
  const store = useAppStore.getState()
  const materials = store.cost.materials.map((m) => (m.id === id ? { ...m, ...patch } : m))
  store.patchCost({ materials })
  void guardWrite(saveMaterials(materials))
}

export function addCustomMaterial() {
  const store = useAppStore.getState()
  const custom: Material = {
    id: `custom-${Date.now()}`,
    name: 'Custom material',
    density: 10,
    pricePerGram: 0,
    color: '#9aa0a8',
    builtin: false,
  }
  const materials = [...store.cost.materials, custom]
  store.patchCost({ materials })
  void guardWrite(saveMaterials(materials))
}

export function deleteMaterial(id: string) {
  const store = useAppStore.getState()
  const target = store.cost.materials.find((m) => m.id === id)
  if (!target || target.builtin) return
  const materials = store.cost.materials.filter((m) => m.id !== id)
  const assignments = Object.fromEntries(
    Object.entries(store.cost.assignments).filter(([, matId]) => matId !== id),
  )
  store.patchCost({ materials, assignments })
  void guardWrite(saveMaterials(materials))
  void guardWrite(kvSet(KV_ASSIGNMENTS, assignments))
}

/** Restore built-in densities/names; keeps custom materials and all prices at 0. */
export function resetMaterialLibrary() {
  const store = useAppStore.getState()
  const custom = store.cost.materials.filter((m) => !m.builtin)
  const materials = [...defaultMaterials(), ...custom]
  store.patchCost({ materials })
  void guardWrite(saveMaterials(materials))
}

export async function refreshMarketPrices(): Promise<void> {
  const store = useAppStore.getState()
  store.patchCost({ refreshing: true, error: null })
  try {
    const perGram = await fetchSpotPricesPerGram(store.cost.settings.currency)
    const materials = applySpotPrices(useAppStore.getState().cost.materials, perGram)
    useAppStore.getState().patchCost({ materials, refreshing: false })
    await guardWrite(saveMaterials(materials))
    updateCostSettings({ pricesUpdatedAt: new Date().toISOString() })
  } catch (err) {
    useAppStore.getState().patchCost({
      refreshing: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** One history row per part that has a material assigned. */
export async function saveCalculationToHistory(): Promise<void> {
  const store = useAppStore.getState()
  const { assignments, volumes, materials, settings } = store.cost
  const entries: HistoryEntry[] = []
  for (const part of store.parts) {
    const material = materials.find((m) => m.id === assignments[part.id])
    const volume = volumes[part.id]
    if (!material || volume === undefined) continue
    const weightG = weightGrams(volume, material.density)
    entries.push({
      id: `h-${Date.now()}-${part.id}`,
      date: new Date().toISOString(),
      model: part.name,
      material: material.name,
      volumeMm3: volume,
      weightG,
      cost: costOf(weightG, material.pricePerGram, settings.lossFactorPct),
      currency: settings.currency,
    })
  }
  if (!entries.length) return
  await addHistoryEntries(entries)
  store.patchCost({ history: await loadHistory() })
}

export async function removeHistoryEntry(id: string): Promise<void> {
  await deleteHistoryEntry(id)
  useAppStore.getState().patchCost({ history: await loadHistory() })
}

export async function clearHistoryLog(): Promise<void> {
  await clearHistoryStore()
  useAppStore.getState().patchCost({ history: [] })
}

export function exportHistoryCSV() {
  const csv = historyToCSV(useAppStore.getState().cost.history)
  void saveFile(csv, `goldsmith-history-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', {
    description: 'CSV spreadsheet',
    accept: { 'text/csv': ['.csv'] },
  })
}

/** Casting shrinkage helper: scale the selected part up by `pct` %. */
export function applyShrinkage(pct: number) {
  const id = requireSelection()
  if (!id || !(pct > -100)) return
  getEngine().applyScale(id, 1 + pct / 100)
}

export function formatMoney(value: number, currency: Currency): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value)
}

// ---------- measurements & sections (plan §2.3) ----------

function handlePointPicked(point: Vec3) {
  if (pickConsumer === 'resize') {
    handleResizePointPicked(point)
    return
  }
  const store = useAppStore.getState()
  const pending = store.measure.pendingPoint
  if (!pending) {
    store.patchMeasure({ pendingPoint: point })
    engine?.setPendingMarker(point)
    return
  }
  const distance = Math.hypot(point[0] - pending[0], point[1] - pending[1], point[2] - pending[2])
  const m: Measurement = {
    id: `m-${Date.now()}`,
    a: pending,
    b: point,
    distance,
    color: store.measure.color,
  }
  engine?.setPendingMarker(null)
  engine?.addMeasurement(m)
  const measurements = [...store.measure.measurements, m]
  store.patchMeasure({ pendingPoint: null, measurements })
  void guardWrite(kvSet(KV_MEASUREMENTS, measurements))
}

export function setMeasurePicking(on: boolean) {
  const store = useAppStore.getState()
  const eng = getEngine()
  pickConsumer = on ? 'measure' : null
  eng.setPickMode(on)
  // park the gizmo while picking so taps near it don't grab a handle
  eng.setGizmoMode(on ? 'none' : store.gizmoMode)
  store.patchMeasure({ picking: on, pendingPoint: null })
}

export function setMeasureColor(color: string) {
  useAppStore.getState().patchMeasure({ color })
  void guardWrite(kvSet(KV_MEASURE_COLOR, color))
}

export function removeMeasurementById(id: string) {
  const store = useAppStore.getState()
  getEngine().removeMeasurement(id)
  const measurements = store.measure.measurements.filter((m) => m.id !== id)
  store.patchMeasure({ measurements })
  void guardWrite(kvSet(KV_MEASUREMENTS, measurements))
}

export function undoLastMeasurement() {
  const last = useAppStore.getState().measure.measurements.at(-1)
  if (last) removeMeasurementById(last.id)
}

export function clearAllMeasurements() {
  getEngine().clearMeasurements()
  useAppStore.getState().patchMeasure({ measurements: [], pendingPoint: null })
  void guardWrite(kvSet(KV_MEASUREMENTS, []))
}

async function restoreMeasurements() {
  const saved = await kvGet<Measurement[]>(KV_MEASUREMENTS)
  if (!saved?.length || !engine) return
  for (const m of saved) engine.addMeasurement(m)
  useAppStore.getState().patchMeasure({ measurements: saved })
}

/** Patch section state, refit the slider range on enable/axis change, apply. */
export function updateSection(patch: Partial<SectionState>) {
  const store = useAppStore.getState()
  const prev = store.measure.section
  const next = { ...prev, ...patch }
  const axisChanged = next.axis !== prev.axis
  const justEnabled = next.enabled && !prev.enabled
  if (justEnabled || axisChanged) {
    const bounds = getEngine().getSceneBounds()
    if (bounds) {
      const i = 'xyz'.indexOf(next.axis)
      next.range = { min: bounds.min[i], max: bounds.max[i] }
      next.position = (next.range.min + next.range.max) / 2
    }
  }
  store.patchSection(next)
  getEngine().setSection(
    next.enabled
      ? {
          axis: next.axis,
          position: next.position,
          flip: next.flip,
          slice: next.slice,
          thickness: next.thickness,
        }
      : null,
  )
}

// ---------- wall-thickness heatmap (plan §2.3) ----------

/**
 * Compute the wall-thickness field for the selected (or only) part in a worker,
 * streaming progress, then paint it onto the surface. The heavy raycast never
 * blocks the UI and can be cancelled mid-run via cancelThicknessHeatmap.
 */
export async function computeThicknessHeatmap(): Promise<void> {
  const store = useAppStore.getState()
  const id = store.selectedId ?? (store.parts.length === 1 ? store.parts[0].id : null)
  if (!id) {
    store.patchHeatmap({ error: 'Select a part first (tap it in the viewport or the parts list).' })
    return
  }
  const eng = getEngine()
  const mesh = eng.getWorldMeshData(id)
  if (!mesh) return
  thicknessJob?.cancel()
  store.patchHeatmap({ busy: true, progress: 0, error: null, partId: id })
  const job = thicknessClient.compute(mesh, (p) =>
    useAppStore.getState().patchHeatmap({ progress: p }),
  )
  thicknessJob = job
  try {
    const field = await job.promise
    if (thicknessJob !== job) return // superseded by a newer run
    thicknessJob = null
    if (!field) {
      // cancelled — leave any previous heatmap untouched
      useAppStore.getState().patchHeatmap({ busy: false, progress: 0 })
      return
    }
    const threshold = useAppStore.getState().measure.heatmap.thresholdMm
    eng.setThicknessHeatmap(id, field.values, { min: field.min, max: field.max }, threshold)
    useAppStore.getState().patchHeatmap({
      busy: false,
      enabled: true,
      progress: 1,
      range: { min: field.min, max: field.max },
      partId: id,
    })
  } catch (err) {
    if (thicknessJob !== job) return // a newer run owns the state now
    thicknessJob = null
    useAppStore.getState().patchHeatmap({ busy: false, error: String(err) })
  }
}

/** Abort an in-flight heatmap compute. */
export function cancelThicknessHeatmap() {
  thicknessJob?.cancel()
  thicknessJob = null
  useAppStore.getState().patchHeatmap({ busy: false, progress: 0 })
}

/** Drag the minimum-thickness threshold — recolours the existing field, no recompute. */
export function setHeatmapThreshold(mm: number) {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchHeatmap({ thresholdMm: mm })
  if (useAppStore.getState().measure.heatmap.enabled) getEngine().setHeatmapThreshold(mm)
}

/** Remove the heatmap overlay, restoring the part's normal material. */
export function clearThicknessHeatmap() {
  thicknessJob?.cancel()
  thicknessJob = null
  engine?.clearThicknessHeatmap()
  useAppStore.getState().patchHeatmap({
    enabled: false, busy: false, progress: 0, range: null, partId: null, error: null,
  })
}

/** Tear the heatmap down when leaving the Measure tab. */
export function teardownHeatmap() {
  if (useAppStore.getState().measure.heatmap.enabled || thicknessJob) clearThicknessHeatmap()
}

// ---------- grillz fit: cement-gap offset + clearance map (plan §3.1) ----------

export function setFitScanPart(id: string | null) {
  useAppStore.getState().patchFit({ scanPartId: id, error: null })
}

export function setFitShellPart(id: string | null) {
  useAppStore.getState().patchFit({ shellPartId: id, error: null })
}

/** Cement gap (mm). Recolours a live clearance map without recomputing distances. */
export function setFitClearance(mm: number) {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchFit({ clearanceMm: mm })
  recolourClearanceBand()
}

/** Tolerance band half-width (mm). Recolours a live clearance map cheaply. */
export function setFitBandHalf(mm: number) {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchFit({ bandHalfMm: mm })
  recolourClearanceBand()
}

/** Green-band edges around the chosen clearance; lo is clamped non-negative. */
function fitBand(): { lo: number; hi: number } {
  const f = useAppStore.getState().fit
  return { lo: Math.max(f.clearanceMm - f.bandHalfMm, 0), hi: f.clearanceMm + f.bandHalfMm }
}

function recolourClearanceBand() {
  if (!useAppStore.getState().fit.mapEnabled) return
  const { lo, hi } = fitBand()
  getEngine().setClearanceBand(lo, hi)
}

/** The tooth scan: explicit pick, else the selection, else the only part. */
function fitScanId(): string | null {
  const s = useAppStore.getState()
  return s.fit.scanPartId ?? s.selectedId ?? (s.parts.length === 1 ? s.parts[0].id : null)
}

/** The grillz shell: explicit pick, else inferred as the other part when there are two. */
function fitShellId(scanId: string): string | null {
  const s = useAppStore.getState()
  if (s.fit.shellPartId) return s.fit.shellPartId
  if (s.parts.length === 2) return s.parts.find((p) => p.id !== scanId)?.id ?? null
  return null
}

function partName(id: string): string {
  return useAppStore.getState().parts.find((p) => p.id === id)?.name ?? 'Part'
}

/** Manifold/heal failures → an actionable message instead of a raw WASM error. */
function fitErrorMessage(err: unknown): string {
  const s = String(err)
  if (/manifold|watertight/i.test(s)) {
    return 'Couldn’t make the mesh watertight — run Repair on the scan and shell first.'
  }
  return s
}

/**
 * Action (b): generate the outward cement-gap offset of the tooth scan as a new
 * part to sculpt over in Nomad / use as the boolean operand. Runs in the worker
 * with staged progress; cancel resolves the UI immediately (the orphaned WASM
 * result is discarded by the supersede check).
 */
export async function generateOffsetPart(): Promise<void> {
  const store = useAppStore.getState()
  const scanId = fitScanId()
  if (!scanId) {
    store.patchFit({ error: 'Select the tooth scan first.' })
    return
  }
  const eng = getEngine()
  const scan = eng.getWorldMeshData(scanId)
  if (!scan) return
  const clearance = store.fit.clearanceMm
  fitJob?.cancel()
  store.patchFit({ busy: true, progress: 0, stage: 'Starting', error: null })
  const job = fitClient.offset(scan, clearance, FIT_SPHERE_SEGMENTS, (p, stage) =>
    useAppStore.getState().patchFit({ progress: p, stage }),
  )
  fitJob = job
  try {
    const mesh = await job.promise
    if (fitJob !== job) return // superseded / cancelled
    fitJob = null
    if (!mesh) {
      useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
      return
    }
    addGeneratedPart(`${partName(scanId)} offset ${clearance.toFixed(2)}`, mesh, {
      material: 'cutter',
      flatShading: false,
    })
    useAppStore.getState().patchFit({ busy: false, progress: 1, stage: null, scanPartId: scanId })
  } catch (err) {
    if (fitJob !== job) return
    fitJob = null
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

/**
 * Action (a): offset the scan and boolean-subtract it from the sculpted shell in
 * one job → a fitted grillz with uniform interior clearance, as a new part.
 */
export async function subtractFit(): Promise<void> {
  const store = useAppStore.getState()
  const scanId = fitScanId()
  if (!scanId) {
    store.patchFit({ error: 'Select the tooth scan first.' })
    return
  }
  const shellId = fitShellId(scanId)
  if (!shellId) {
    store.patchFit({ error: 'Pick the grillz shell to subtract from.' })
    return
  }
  if (shellId === scanId) {
    store.patchFit({ error: 'The scan and the shell must be different parts.' })
    return
  }
  const eng = getEngine()
  const scan = eng.getWorldMeshData(scanId)
  const shell = eng.getWorldMeshData(shellId)
  if (!scan || !shell) return
  const clearance = store.fit.clearanceMm
  fitJob?.cancel()
  store.patchFit({ busy: true, progress: 0, stage: 'Starting', error: null })
  const job = fitClient.subtract(scan, shell, clearance, FIT_SPHERE_SEGMENTS, (p, stage) =>
    useAppStore.getState().patchFit({ progress: p, stage }),
  )
  fitJob = job
  try {
    const mesh = await job.promise
    if (fitJob !== job) return
    fitJob = null
    if (!mesh) {
      useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
      return
    }
    addGeneratedPart(`${partName(shellId)} (fitted)`, mesh, { material: null, flatShading: false })
    useAppStore.getState().patchFit({
      busy: false, progress: 1, stage: null, scanPartId: scanId, shellPartId: shellId,
    })
  } catch (err) {
    if (fitJob !== job) return
    fitJob = null
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

/**
 * The clearance map: colour the grillz shell by signed gap to the tooth scan —
 * red (touch/interference) → green (in band) → blue (too loose). Compares the
 * raw shell to the raw scan (the true gap), so it works on the original sculpt or
 * a fitted result alike.
 */
export async function computeClearanceMap(): Promise<void> {
  const store = useAppStore.getState()
  const scanId = fitScanId()
  if (!scanId) {
    store.patchFit({ error: 'Select the tooth scan first.' })
    return
  }
  const shellId = fitShellId(scanId)
  if (!shellId) {
    store.patchFit({ error: 'Pick the grillz shell to map.' })
    return
  }
  if (shellId === scanId) {
    store.patchFit({ error: 'The scan and the shell must be different parts.' })
    return
  }
  const eng = getEngine()
  const scan = eng.getWorldMeshData(scanId)
  const shell = eng.getWorldMeshData(shellId)
  if (!scan || !shell) return
  fitJob?.cancel()
  store.patchFit({ busy: true, progress: 0, stage: 'Measuring clearance', error: null })
  const job = fitClient.clearance(shell, scan, (p, stage) =>
    useAppStore.getState().patchFit({ progress: p, stage }),
  )
  fitJob = job
  try {
    const field = await job.promise
    if (fitJob !== job) return
    fitJob = null
    if (!field) {
      useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
      return
    }
    // setClearanceMap is a no-op if the shell part vanished mid-compute — only
    // claim an active map when this call actually painted (not just any map)
    const painted = eng.setClearanceMap(shellId, field.values, fitBand())
    useAppStore.getState().patchFit({
      busy: false, progress: 1, stage: null,
      mapEnabled: painted,
      mapRange: painted ? { min: field.min, max: field.max } : null,
      mapPartId: painted ? shellId : null,
      scanPartId: scanId, shellPartId: shellId,
    })
  } catch (err) {
    if (fitJob !== job) return
    fitJob = null
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

/** Abort an in-flight fit op; the UI unblocks at once. */
export function cancelFit() {
  fitJob?.cancel()
  fitJob = null
  useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
}

/** Remove the clearance-map overlay, restoring the shell's normal material. */
export function clearFitMap() {
  engine?.clearClearanceMap()
  useAppStore.getState().patchFit({ mapEnabled: false, mapRange: null, mapPartId: null })
}

/** Tear the fit overlay + any in-flight job down when leaving the Fit tab. */
export function teardownFit() {
  const f = useAppStore.getState().fit
  if (fitJob || f.mapEnabled || f.surveyEnabled || f.brushActive) {
    if (surveyDebounce) { clearTimeout(surveyDebounce); surveyDebounce = null }
    fitJob?.cancel()
    fitJob = null
    clearFitMap()
    engine?.clearUndercutSurvey()
    engine?.hideInsertionAxis()
    engine?.setBrushSelect(null, 0)
    useAppStore.getState().patchFit({
      busy: false, progress: 0, stage: null,
      surveyEnabled: false, undercutArea: null, surveyPartId: null,
      brushActive: false, brushCount: 0,
    })
  }
}

// ---------- grillz undercut survey & blockout (plan §3.2) ----------

/** Bounding centre + radius of a world mesh, for placing the axis gizmo. */
function meshBounds(positions: Float32Array): { center: Vec3; radius: number } {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i]
    if (positions[i + 1] < minY) minY = positions[i + 1]
    if (positions[i + 2] < minZ) minZ = positions[i + 2]
    if (positions[i] > maxX) maxX = positions[i]
    if (positions[i + 1] > maxY) maxY = positions[i + 1]
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2]
  }
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
  const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 || 1
  return { center, radius }
}

/** Resolve the tooth scan to survey + its world mesh, or set an error. */
function surveyScan(): { id: string; mesh: MeshData } | null {
  const id = fitScanId()
  if (!id) {
    useAppStore.getState().patchFit({ error: 'Select the tooth scan first.' })
    return null
  }
  const mesh = getEngine().getWorldMeshData(id)
  return mesh ? { id, mesh } : null
}

/**
 * Run the undercut survey for the current insertion axis and paint it. `quiet`
 * skips the busy/progress UI for the rapid recomputes during an axis drag; the
 * in-flight job is always superseded so only the latest axis wins.
 */
async function runSurvey(quiet = false): Promise<void> {
  const scan = surveyScan()
  if (!scan) return
  const axis = useAppStore.getState().fit.insertionAxis
  fitJob?.cancel()
  if (!quiet) {
    useAppStore.getState().patchFit({ busy: true, progress: 0, stage: 'Surveying undercuts', error: null })
  }
  const job = fitClient.survey(scan.mesh, axis, (p, stage) => {
    if (!quiet) useAppStore.getState().patchFit({ progress: p, stage })
  })
  fitJob = job
  try {
    const field = await job.promise
    if (fitJob !== job) return // superseded / cancelled
    fitJob = null
    if (!field) {
      if (!quiet) useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
      return
    }
    const painted = getEngine().setUndercutSurvey(scan.id, field.values)
    if (painted) {
      // the survey replaced any heatmap/clearance overlay in the engine — keep the store in sync
      const st = useAppStore.getState()
      if (st.measure.heatmap.enabled) {
        st.patchHeatmap({ enabled: false, busy: false, progress: 0, range: null, partId: null, error: null })
      }
      if (st.fit.mapEnabled) st.patchFit({ mapEnabled: false, mapRange: null, mapPartId: null })
    }
    useAppStore.getState().patchFit({
      busy: false, progress: 1, stage: null,
      surveyEnabled: painted,
      undercutArea: painted ? field.area : null,
      surveyPartId: painted ? scan.id : null,
      scanPartId: scan.id,
    })
  } catch (err) {
    if (fitJob !== job) return
    fitJob = null
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

/** Coalesce the rapid axis-drag recomputes into one quiet survey on settle. */
function debounceSurvey() {
  if (surveyDebounce) clearTimeout(surveyDebounce)
  surveyDebounce = setTimeout(() => {
    surveyDebounce = null
    void runSurvey(true)
  }, 50)
}

/** Place the axis gizmo on the scan, sized to the scan and aimed at the current axis. */
function showAxisGizmo(scanMesh: MeshData) {
  const { center, radius } = meshBounds(scanMesh.positions)
  getEngine().showInsertionAxis(center, radius, useAppStore.getState().fit.insertionAxis)
}

/** Enable the undercut survey: default the axis, show the gizmo, run the survey. */
export function enableSurvey(): void {
  const scan = surveyScan()
  if (!scan) return
  const axis = defaultInsertionAxis(scan.mesh)
  useAppStore.getState().patchFit({ insertionAxis: axis, error: null })
  showAxisGizmo(scan.mesh)
  void runSurvey(false)
}

/** Remove the survey overlay + axis gizmo, cancelling any in-flight job. */
export function clearSurvey(): void {
  if (surveyDebounce) { clearTimeout(surveyDebounce); surveyDebounce = null }
  fitJob?.cancel()
  fitJob = null
  engine?.clearUndercutSurvey()
  engine?.hideInsertionAxis()
  useAppStore.getState().patchFit({
    surveyEnabled: false, undercutArea: null, surveyPartId: null, busy: false, progress: 0, stage: null,
  })
}

/** The survey toggle (panel button): on ↔ off. */
export function toggleSurvey(): void {
  if (useAppStore.getState().fit.surveyEnabled) clearSurvey()
  else enableSurvey()
}

/** Gizmo-drag callback: store the axis (live readout) + debounce a quiet recompute. */
function setInsertionAxisFromGizmo(axis: Vec3): void {
  useAppStore.getState().patchFit({ insertionAxis: axis })
  if (useAppStore.getState().fit.surveyEnabled) debounceSurvey()
}

/** Re-aim the insertion axis from the panel (reset / world snap), then resurvey. */
export function setInsertionAxis(axis: Vec3): void {
  const len = Math.hypot(axis[0], axis[1], axis[2])
  if (!(len > 1e-9)) return // reject a degenerate (zero-length) axis
  const norm: Vec3 = [axis[0] / len, axis[1] / len, axis[2] / len]
  useAppStore.getState().patchFit({ insertionAxis: norm })
  engine?.setInsertionAxisDirection(norm)
  if (useAppStore.getState().fit.surveyEnabled) debounceSurvey()
}

/** Reset the insertion axis to the scan's averaged outward normal. */
export function resetInsertionAxis(): void {
  const scan = surveyScan()
  if (!scan) return
  setInsertionAxis(defaultInsertionAxis(scan.mesh))
}

/** Search for the insertion axis minimising undercut area, then resurvey. */
export async function findBestFitAxis(): Promise<void> {
  const scan = surveyScan()
  if (!scan) return
  const seed = useAppStore.getState().fit.insertionAxis
  fitJob?.cancel()
  useAppStore.getState().patchFit({ busy: true, progress: 0, stage: 'Searching axes', error: null })
  const job = fitClient.bestAxis(scan.mesh, seed, (p, stage) =>
    useAppStore.getState().patchFit({ progress: p, stage }),
  )
  fitJob = job
  try {
    const result = await job.promise
    if (fitJob !== job) return
    fitJob = null
    if (!result) {
      useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
      return
    }
    useAppStore.getState().patchFit({ insertionAxis: result.axis, busy: false, progress: 1, stage: null })
    showAxisGizmo(scan.mesh) // ensure the gizmo is shown/repositioned before the survey turns on
    engine?.setInsertionAxisDirection(result.axis)
    void runSurvey(false)
  } catch (err) {
    if (fitJob !== job) return
    fitJob = null
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

/** Max retention allowance (mm) — beyond this a snap-fit gets hard to seat by hand. */
const MAX_RETENTION_MM = 0.05

/** Retention allowance (mm) for blockout — leaves a snap-fit undercut lip. */
export function setRetention(mm: number): void {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchFit({ retentionMm: Math.min(Math.max(mm, 0), MAX_RETENTION_MM) })
}

/**
 * Auto-blockout: fill the scan's undercuts along the insertion axis → a new,
 * draftable scan part that seats cleanly along that path (retention lip optional).
 * Reads only the axis + retention, leaving the original scan and its survey intact.
 */
export async function runBlockout(): Promise<void> {
  const scan = surveyScan()
  if (!scan) return
  const { insertionAxis: axis, retentionMm } = useAppStore.getState().fit
  fitJob?.cancel()
  useAppStore.getState().patchFit({ busy: true, progress: 0, stage: 'Starting', error: null })
  const job = fitClient.blockout(scan.mesh, axis, retentionMm, FIT_SPHERE_SEGMENTS, (p, stage) =>
    useAppStore.getState().patchFit({ progress: p, stage }),
  )
  fitJob = job
  try {
    const mesh = await job.promise
    if (fitJob !== job) return
    fitJob = null
    if (!mesh) {
      useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
      return
    }
    const suffix = retentionMm > 0 ? ` (retain ${retentionMm.toFixed(3)})` : ''
    // the draftable blockout is selected and becomes the active scan for follow-up fit actions
    const newId = addGeneratedPart(`${partName(scan.id)} blockout${suffix}`, mesh, { material: null, flatShading: false })
    useAppStore.getState().patchFit({ busy: false, progress: 1, stage: null, scanPartId: newId })
  } catch (err) {
    if (fitJob !== job) return
    fitJob = null
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

// ---------- grillz shell generator (plan §3.3) ----------

/** Shell wall-thickness bounds (mm) — the grillz/dental range from the plan. */
const MIN_SHELL_MM = 0.6
const MAX_SHELL_MM = 1.5
/** Fallback density (g/cm³) for the per-tooth weight when no cost material is assigned — 14k yellow. */
const DEFAULT_GRILLZ_DENSITY = 13.05

/** Arm/disarm the surface brush that selects which teeth the shell covers. */
export function setBrushSelect(on: boolean): void {
  const store = useAppStore.getState()
  if (on) {
    const id = fitScanId()
    if (!id) {
      store.patchFit({ error: 'Select the tooth scan first.' })
      return
    }
    const eng = getEngine()
    eng.setBrushSelect(id, store.fit.brushRadiusMm)
    eng.setGizmoMode('none') // park the transform gizmo so painting doesn't grab a handle
    store.patchFit({ brushActive: true, scanPartId: id, error: null })
  } else {
    getEngine().setBrushSelect(null, 0)
    getEngine().setGizmoMode(store.gizmoMode)
    store.patchFit({ brushActive: false })
  }
}

/** Brush radius (mm). */
export function setBrushRadius(mm: number): void {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchFit({ brushRadiusMm: mm })
  engine?.setBrushRadius(mm)
}

/** Empty the painted region (keeps the brush armed). */
export function clearBrushSelection(): void {
  getEngine().clearBrushSelection()
}

/** Uniform shell wall thickness (mm), clamped to the grillz range. */
export function setShellThickness(mm: number): void {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchFit({ shellThicknessMm: Math.min(Math.max(mm, MIN_SHELL_MM), MAX_SHELL_MM) })
}

/** Toggle the open gingival margin (grillz slide on from below). */
export function setOpenGingival(open: boolean): void {
  useAppStore.getState().patchFit({ openGingival: open })
}

/** Resolve a density (g/cm³) for the per-tooth weight: the scan's assigned cost material, else a default. */
function shellDensity(scanId: string): number {
  const cost = useAppStore.getState().cost
  const matId = cost.assignments[scanId]
  const mat = cost.materials.find((m) => m.id === matId)
  return mat?.density ?? DEFAULT_GRILLZ_DENSITY
}

/**
 * Generate the uniform-thickness grillz shell following the (blocked-out, offset)
 * tooth surface — the perfect Nomad base. Interior = the cement-gap clearance
 * surface; exterior = that surface grown by the wall thickness. Clipped to the
 * brushed region when one exists; opened at the gingival margin by default. Adds a
 * new part and reports a per-tooth (connected-component) weight estimate.
 */
export async function generateShell(): Promise<void> {
  const store = useAppStore.getState()
  const scanId = fitScanId()
  if (!scanId) {
    store.patchFit({ error: 'Select the tooth scan first.' })
    return
  }
  const eng = getEngine()
  const scan = eng.getWorldMeshData(scanId)
  if (!scan) return
  const { clearanceMm, shellThicknessMm, openGingival } = store.fit
  // the gingival cut needs a "down" — the user's insertion axis if surveying, else the scan normal
  const axis = store.fit.surveyEnabled ? store.fit.insertionAxis : defaultInsertionAxis(scan)
  const selection = eng.getBrushSelection()
  const indices = selection && selection.id === scanId ? selection.indices : null
  fitJob?.cancel()
  store.patchFit({ busy: true, progress: 0, stage: 'Starting', error: null })
  const job = fitClient.shell(
    scan, indices, axis, clearanceMm, shellThicknessMm, openGingival, FIT_SPHERE_SEGMENTS,
    (p, stage) => useAppStore.getState().patchFit({ progress: p, stage }),
  )
  fitJob = job
  try {
    const result = await job.promise
    if (fitJob !== job) return // superseded / cancelled
    fitJob = null
    if (!result) {
      useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
      return
    }
    addGeneratedPart(`${partName(scanId)} shell ${shellThicknessMm.toFixed(1)}`, result.mesh, {
      material: null, flatShading: false,
    })
    const density = shellDensity(scanId)
    const toothWeights = result.toothVolumes.map((v) => weightGrams(v, density))
    useAppStore.getState().patchFit({
      busy: false, progress: 1, stage: null, scanPartId: scanId, toothWeights,
    })
  } catch (err) {
    if (fitJob !== job) return
    fitJob = null
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

/** Drafting mode: orthographic side view, ready for a dimensioned snapshot. */
export function draftingView() {
  const eng = getEngine()
  eng.setProjection('orthographic')
  useAppStore.getState().setProjection('orthographic')
  eng.setViewPreset('front')
  eng.setTurntable(false)
  useAppStore.getState().setTurntable(false)
}

// ---------- parametric generators (plan §2.5) ----------

/** Drop a freshly generated mesh into the scene as a new selected part. */
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

export function detectInnerDiameter() {
  const id = requireSelection()
  if (!id) return
  const mesh = getEngine().getWorldMeshData(id)
  if (!mesh) return
  const est = estimateInnerDiameter(mesh)
  useAppStore.getState().patchMeasure({ innerDiameter: est ?? 'none' })
}

// ---------- smart ring resizer (plan §2.6) ----------

/** Resolve the part to resize: the selection, or the only part if there's one. */
function resizeTargetPart(): string | null {
  const store = useAppStore.getState()
  if (store.selectedId) return store.selectedId
  if (store.parts.length === 1) {
    getEngine().select(store.parts[0].id)
    return store.parts[0].id
  }
  store.patchResize({ error: 'Select a ring first (tap it in the viewport or the parts list).' })
  return null
}

/** "US 7.0" / "UK N½" / "EU 54.4" for the chosen system at a given inner Ø. */
function sizeLabelFor(system: SizeSystem, diameter: number): string {
  const size = diameterToSize(system, diameter)
  return system === 'UK' ? `UK ${ukLabel(size)}` : `${system} ${size.toFixed(1)}`
}

/** Rebuild the 3D protected-sector gauge + before/after labels from store state. */
function refreshResizeOverlay() {
  const r = useAppStore.getState().resize
  if (!engine) return
  if (!r.frame || r.detected !== true || r.currentDiameter === null) {
    engine.setResizeOverlay(null)
    return
  }
  const overlay: ResizeOverlay = {
    frame: r.frame,
    mode: r.mode,
    protectedCenterDeg: r.protectedCenterDeg,
    protectedDeg: r.protectedDeg,
    smoothingDeg: r.smoothingDeg,
    beforeLabel: `Before · ${sizeLabelFor(r.targetSystem, r.currentDiameter)} · Ø${r.currentDiameter.toFixed(2)}`,
    afterLabel: `After · ${sizeLabelFor(r.targetSystem, r.targetDiameter)} · Ø${r.targetDiameter.toFixed(2)}`,
  }
  engine.setResizeOverlay(overlay)
}

/**
 * Analyze a specific part's ring frame + current inner size and bind the resize
 * state to it (sourcePartId). Returns the frame, or null when it isn't a ring.
 */
function detectResizeFrameFor(id: string): RingFrame | null {
  const mesh = getEngine().getWorldMeshData(id)
  const store = useAppStore.getState()
  const frame = mesh ? analyzeRingFrame(mesh) : null
  if (!mesh || !frame) {
    store.patchResize({
      detected: 'none', frame: null, currentDiameter: null, sourcePartId: id, error: null,
    })
    getEngine().setResizeOverlay(null)
    return null
  }
  const centerDeg = store.resize.autoHead
    ? detectHeadAngleDeg(mesh, frame)
    : store.resize.protectedCenterDeg
  store.patchResize({
    detected: true,
    frame,
    currentDiameter: frame.innerR * 2,
    protectedCenterDeg: centerDeg,
    sourcePartId: id,
    error: null,
  })
  refreshResizeOverlay()
  return frame
}

/** Auto-detect the ring frame + current inner size of the selected part. */
export function detectResizeFrame() {
  const id = resizeTargetPart()
  if (id) detectResizeFrameFor(id)
}

export function setResizeMode(mode: ResizeMode) {
  useAppStore.getState().patchResize({ mode })
  refreshResizeOverlay()
}

export function setResizeTargetSystem(system: SizeSystem) {
  const r = useAppStore.getState().resize
  useAppStore.getState().patchResize({
    targetSystem: system,
    targetSize: diameterToSize(system, r.targetDiameter),
  })
  refreshResizeOverlay()
}

export function setResizeTargetSize(value: number) {
  if (!Number.isFinite(value)) return
  const r = useAppStore.getState().resize
  const targetDiameter = sizeToDiameter(r.targetSystem, value)
  if (!(Number.isFinite(targetDiameter) && targetDiameter > 0)) return
  useAppStore.getState().patchResize({ targetSize: value, targetDiameter })
  refreshResizeOverlay()
}

export function setResizeTargetDiameter(mm: number) {
  const r = useAppStore.getState().resize
  if (!(Number.isFinite(mm) && mm > 0)) return
  useAppStore.getState().patchResize({
    targetDiameter: mm,
    targetSize: diameterToSize(r.targetSystem, mm),
  })
  refreshResizeOverlay()
}

export function setResizeProtectedCenter(deg: number) {
  useAppStore.getState().patchResize({
    protectedCenterDeg: ((deg % 360) + 360) % 360,
    autoHead: false,
  })
  refreshResizeOverlay()
}

export function setResizeAutoHead(on: boolean) {
  const store = useAppStore.getState()
  store.patchResize({ autoHead: on })
  if (on) {
    // recompute the head angle from the current geometry
    const id = store.selectedId ?? (store.parts.length === 1 ? store.parts[0].id : null)
    const mesh = id ? getEngine().getWorldMeshData(id) : null
    if (mesh && store.resize.frame) {
      store.patchResize({ protectedCenterDeg: detectHeadAngleDeg(mesh, store.resize.frame) })
    }
  }
  refreshResizeOverlay()
}

export function setResizeProtectedWidth(deg: number) {
  useAppStore.getState().patchResize({ protectedDeg: Math.min(Math.max(deg, 4), 176) })
  refreshResizeOverlay()
}

export function setResizeSmoothing(deg: number) {
  useAppStore.getState().patchResize({ smoothingDeg: Math.min(Math.max(deg, 0), 120) })
  refreshResizeOverlay()
}

export function setResizeReheal(on: boolean) {
  useAppStore.getState().patchResize({ reheal: on })
}

/** Arm/disarm viewport picking to set the protected-zone centre. */
export function setResizePicking(on: boolean) {
  const store = useAppStore.getState()
  const eng = getEngine()
  pickConsumer = on ? 'resize' : null
  eng.setPickMode(on)
  eng.setGizmoMode(on ? 'none' : store.gizmoMode)
  store.patchResize({ picking: on })
}

function handleResizePointPicked(point: Vec3) {
  const frame = useAppStore.getState().resize.frame
  if (!frame) return
  setResizeProtectedCenter(pointAngleDeg(point, frame))
  setResizePicking(false)
}

/** Deform the selected ring to the target size, non-destructively. */
export async function applyResize(): Promise<void> {
  const id = resizeTargetPart()
  if (!id) return
  const eng = getEngine()
  // Always re-analyze the live mesh: the selection may have changed, or the
  // geometry may have been replaced in place (e.g. a heal) leaving a stale
  // frame. detectResizeFrameFor keeps a manual protected centre when autoHead
  // is off, so user intent is preserved.
  if (!detectResizeFrameFor(id)) {
    useAppStore.getState().patchResize({ error: 'Auto-detect the ring size first.' })
    return
  }
  const r = useAppStore.getState().resize
  if (!r.frame) return
  const mesh = eng.getWorldMeshData(id)
  if (!mesh) return
  useAppStore.getState().patchResize({ busy: true, error: null })
  try {
    let out = resizeRing(mesh, {
      frame: r.frame,
      mode: r.mode,
      targetInnerDiameter: r.targetDiameter,
      protectedCenterDeg: r.protectedCenterDeg,
      protectedDeg: r.protectedDeg,
      smoothingDeg: r.smoothingDeg,
    })
    if (r.reheal) {
      out = (await repairClient.heal(out, { mode: 'safe', ...HEAL_PRESETS.safe })).mesh
    }
    // push current state for undo, then swap in the resized world-space mesh
    const saved = eng.getPartForSave(id)
    if (saved) {
      const stack = revisions.get(id) ?? []
      stack.push({ data: saved.data, matrix: saved.matrix })
      revisions.set(id, stack)
    }
    replaceWithWorldMesh(id, out)
    // re-detect on the new geometry — the target becomes the new current size
    const newMesh = eng.getWorldMeshData(id)
    const newFrame = newMesh ? analyzeRingFrame(newMesh) : null
    useAppStore.getState().patchResize({
      busy: false,
      canUndo: true,
      sourcePartId: id,
      frame: newFrame ?? r.frame,
      currentDiameter: newFrame ? newFrame.innerR * 2 : r.currentDiameter,
    })
    refreshResizeOverlay()
  } catch (err) {
    useAppStore.getState().patchResize({ busy: false, error: String(err) })
  }
}

export function undoResize(): void {
  const id = useAppStore.getState().selectedId
  if (!id) return
  const stack = revisions.get(id)
  const prev = stack?.pop()
  if (!prev) return
  const eng = getEngine()
  const name = eng.partInfo(id)?.name ?? 'ring'
  eng.removePart(id)
  eng.addPart(id, name, prev.data, prev.matrix)
  eng.select(id)
  const mesh = eng.getWorldMeshData(id)
  const frame = mesh ? analyzeRingFrame(mesh) : null
  useAppStore.getState().patchResize({
    canUndo: (stack?.length ?? 0) > 0,
    sourcePartId: id,
    frame,
    currentDiameter: frame ? frame.innerR * 2 : null,
    detected: frame ? true : 'none',
  })
  refreshResizeOverlay()
}

/** Disarm picking + clear the 3D overlay when leaving the Resize tab. */
export function teardownResize() {
  if (pickConsumer === 'resize') setResizePicking(false)
  engine?.setResizeOverlay(null)
}

// ---------- export & reports (plan §2.7) ----------

const KV_BRANDING = 'reportBranding'
const KV_REPORT_PREFS = 'reportPrefs'

/** Durable report/export preferences (branding lives in its own KV record). */
interface ReportPrefs {
  template: DeliverState['template']
  labourRate: number
  billing: DeliverState['billing']
  showMetalPrices: boolean
  exportFormat: MeshFormat
  exportScope: 'merged' | 'per-part'
  applyShrinkage: boolean
  shrinkagePct: number
}

async function initDeliverData() {
  try {
    const [branding, prefs] = await Promise.all([
      kvGet<ReportBranding>(KV_BRANDING),
      kvGet<ReportPrefs>(KV_REPORT_PREFS),
    ])
    const patch: Partial<DeliverState> = {}
    if (branding && typeof branding === 'object') {
      const nextBranding: ReportBranding = { businessName: '', contact: '', logo: '' }
      if (typeof branding.businessName === 'string') nextBranding.businessName = branding.businessName
      if (typeof branding.contact === 'string') nextBranding.contact = branding.contact
      // only accept a logo we could actually re-embed (the data-URLs this feature writes)
      if (typeof branding.logo === 'string' && isSupportedLogoDataURL(branding.logo)) {
        nextBranding.logo = branding.logo
      }
      patch.branding = nextBranding
    }
    // whitelist persisted enums/numbers — a stale or corrupted record must not
    // feed an invalid value to the panel (.find(...) would return undefined)
    if (prefs && typeof prefs === 'object') {
      keepEnum(patch, prefs, 'template', ['quote', 'casting', 'internal'])
      keepEnum(patch, prefs, 'billing', ['exact', '15min', '30min', '1h'])
      keepEnum(patch, prefs, 'exportFormat', ['stl', 'obj', 'glb', 'ply', '3mf'])
      keepEnum(patch, prefs, 'exportScope', ['merged', 'per-part'])
      if (typeof prefs.showMetalPrices === 'boolean') patch.showMetalPrices = prefs.showMetalPrices
      if (typeof prefs.applyShrinkage === 'boolean') patch.applyShrinkage = prefs.applyShrinkage
      if (Number.isFinite(prefs.labourRate)) patch.labourRate = prefs.labourRate
      if (Number.isFinite(prefs.shrinkagePct)) patch.shrinkagePct = prefs.shrinkagePct
    }
    if (Object.keys(patch).length) useAppStore.getState().patchDeliver(patch)
  } catch (err) {
    console.warn('Deliver data init failed', err)
  }
}

/** Copy `key` from a persisted record into the patch only if it's an allowed value. */
function keepEnum<K extends keyof ReportPrefs>(
  patch: Partial<DeliverState>,
  prefs: ReportPrefs,
  key: K,
  allowed: readonly ReportPrefs[K][],
) {
  const value = prefs[key]
  if (allowed.includes(value)) (patch as Record<K, ReportPrefs[K]>)[key] = value
}

function persistReportPrefs() {
  const d = useAppStore.getState().deliver
  const prefs: ReportPrefs = {
    template: d.template,
    labourRate: d.labourRate,
    billing: d.billing,
    showMetalPrices: d.showMetalPrices,
    exportFormat: d.exportFormat,
    exportScope: d.exportScope,
    applyShrinkage: d.applyShrinkage,
    shrinkagePct: d.shrinkagePct,
  }
  void guardWrite(kvSet(KV_REPORT_PREFS, prefs))
}

/** Patch the deliver slice; durable prefs are written through to IndexedDB. */
export function patchDeliver(patch: Partial<DeliverState>) {
  useAppStore.getState().patchDeliver(patch)
  persistReportPrefs()
}

/** A logo we can actually re-embed in the PDF: empty, or a png/jpeg data-URL. */
function isSupportedLogoDataURL(value: string): boolean {
  return value === '' || /^data:image\/(?:png|jpeg);base64,/i.test(value)
}

export function setBranding(patch: Partial<ReportBranding>) {
  const current = useAppStore.getState().deliver.branding
  // enforce the ReportBranding contract on writes too, not just on rehydrate
  const branding: ReportBranding = {
    businessName: typeof patch.businessName === 'string' ? patch.businessName : current.businessName,
    contact: typeof patch.contact === 'string' ? patch.contact : current.contact,
    logo:
      typeof patch.logo === 'string' && isSupportedLogoDataURL(patch.logo)
        ? patch.logo
        : current.logo,
  }
  useAppStore.getState().patchDeliver({ branding })
  void guardWrite(kvSet(KV_BRANDING, branding))
}

/** Read an uploaded logo file as a data-URL and store it in branding. */
export function setLogoFromFile(file: File): void {
  if (!/^image\/(?:png|jpeg)$/i.test(file.type)) return
  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result === 'string' && isSupportedLogoDataURL(reader.result)) {
      setBranding({ logo: reader.result })
    }
  }
  reader.readAsDataURL(file)
}

/** World-space meshes for every part, optionally on a shrinkage-scaled copy. */
function preparedMeshes(): NamedMesh[] {
  const eng = getEngine()
  const d = useAppStore.getState().deliver
  const factor = d.applyShrinkage ? 1 + d.shrinkagePct / 100 : 1
  const out: NamedMesh[] = []
  for (const info of eng.listParts()) {
    const mesh = eng.getWorldMeshData(info.id)
    if (!mesh) continue
    out.push({ name: info.name, mesh: factor === 1 ? mesh : scaleMeshDataCopy(mesh, factor) })
  }
  return out
}

const MESH_MIME: Record<MeshFormat, string> = {
  stl: 'model/stl',
  obj: 'text/plain',
  glb: 'model/gltf-binary',
  ply: 'application/octet-stream',
  '3mf': 'model/3mf',
}

const MESH_SAVE_TYPE: Record<MeshFormat, SaveType> = {
  stl: { description: 'STL mesh', accept: { 'model/stl': ['.stl'] } },
  obj: { description: 'OBJ mesh', accept: { 'text/plain': ['.obj'] } },
  glb: { description: 'glTF binary', accept: { 'model/gltf-binary': ['.glb'] } },
  ply: { description: 'PLY mesh', accept: { 'application/octet-stream': ['.ply'] } },
  '3mf': { description: '3MF package', accept: { 'model/3mf': ['.3mf'] } },
}

/** Export the scene as STL / OBJ / GLB, merged or one file per part (§2.7). */
export async function exportMesh(opts: { share?: boolean } = {}): Promise<void> {
  const store = useAppStore.getState()
  const d = store.deliver
  if (d.applyShrinkage && !(1 + d.shrinkagePct / 100 > 0)) {
    store.patchDeliver({ error: 'Shrinkage % must be greater than −100.' })
    return
  }
  const prepared = preparedMeshes()
  if (!prepared.length) {
    store.patchDeliver({ error: 'Nothing to export — import or generate a part first.' })
    return
  }
  store.patchDeliver({ exporting: true, error: null })
  const base = safeFilename(d.title || 'goldsmith-export')
  const mime = MESH_MIME[d.exportFormat]
  try {
    const files: NamedMesh[] = d.exportScope === 'merged'
      ? [{ name: base, mesh: mergeMeshData(prepared.map((p) => p.mesh)) }]
      : prepared
    const built: { data: SaveData; name: string; mime: string }[] = []
    for (const file of files) {
      const fname = `${safeFilename(file.name)}.${d.exportFormat}`
      if (d.exportFormat === 'stl') {
        built.push({ data: exportSTL(file.mesh), name: fname, mime })
      } else if (d.exportFormat === 'obj') {
        built.push({ data: exportOBJ([file]), name: fname, mime })
      } else if (d.exportFormat === 'ply') {
        built.push({ data: exportPLY(file.mesh), name: fname, mime })
      } else if (d.exportFormat === '3mf') {
        built.push({ data: export3MF([file]), name: fname, mime })
      } else {
        built.push({ data: await getEngine().exportGLTF([file], { binary: true }), name: fname, mime })
      }
    }
    await deliverFiles(built, { share: opts.share, title: base, type: MESH_SAVE_TYPE[d.exportFormat] })
    useAppStore.getState().patchDeliver({ exporting: false })
  } catch (err) {
    useAppStore.getState().patchDeliver({
      exporting: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Group gem-tagged parts (names like "Round 6.0mm") into cut/size/qty lines. */
function deriveGemList(): GemListEntry[] {
  const groups = new Map<string, GemListEntry>()
  for (const info of useAppStore.getState().parts) {
    if (info.material !== 'gem') continue
    const match = /^(.*?)\s+([\d.]+)\s*mm$/i.exec(info.name)
    const cut = match ? match[1].trim() : info.name
    const sizeMm = match ? match[2] : '—'
    const key = `${cut}|${sizeMm}`
    const entry = groups.get(key) ?? { cut, sizeMm, qty: 0 }
    entry.qty += 1
    groups.set(key, entry)
  }
  return [...groups.values()]
}

/** Gather scene + cost + report-form state into a pure ReportInput. */
function buildReportInputFromState(): ReportInput {
  const s = useAppStore.getState()
  const { cost, deliver } = s
  const eng = getEngine()
  const parts: ReportPartInput[] = []
  for (const info of eng.listParts()) {
    // gems are listed separately; cutters are boolean tools, not deliverables
    if (info.material === 'gem' || info.material === 'cutter') continue
    const mesh = eng.getWorldMeshData(info.id)
    const va = mesh ? volumeAndArea(mesh) : { volume: 0, area: 0 }
    const material = cost.materials.find((m) => m.id === cost.assignments[info.id])
    parts.push({
      name: info.name,
      materialName: material?.name ?? null,
      density: material?.density ?? null,
      pricePerGram: material?.pricePerGram ?? 0,
      volumeMm3: va.volume,
      areaMm2: va.area,
      bbox: [info.bbox.x, info.bbox.y, info.bbox.z],
    })
  }
  const bounds = eng.getSceneBounds()
  const sceneBbox = bounds
    ? ([
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      ] as Vec3)
    : null
  return {
    template: deliver.template,
    branding: deliver.branding,
    title: deliver.title,
    date: new Date().toISOString(),
    currency: cost.settings.currency,
    lossFactorPct: cost.settings.lossFactorPct,
    labour: { hours: deliver.labourHours, rate: deliver.labourRate, billing: deliver.billing },
    showMetalPrices: deliver.showMetalPrices,
    notes: deliver.notes,
    parts,
    gems: deriveGemList(),
    sceneBbox,
  }
}

/** Build the branded PDF report (auto viewport snapshot + logo) and download it. */
export async function generateReportPDF(opts: { share?: boolean } = {}): Promise<void> {
  const store = useAppStore.getState()
  if (store.parts.length === 0) {
    store.patchDeliver({ error: 'Nothing to report — import or generate a part first.' })
    return
  }
  store.patchDeliver({ generating: true, error: null })
  try {
    const model = buildReportModel(buildReportInputFromState())
    const render = dataURLtoBytes(getEngine().renderPreviewPNG(1600))
    const logo = model.branding.logo ? dataURLtoBytes(model.branding.logo) : undefined
    const bytes = await buildReportPDF(model, { render, logo })
    const base = safeFilename(store.deliver.title || 'goldsmith')
    await deliverFiles(
      [{ data: bytes, name: `${base}-${model.template}.pdf`, mime: 'application/pdf' }],
      {
        share: opts.share,
        title: store.deliver.title || 'GoldSmith report',
        type: { description: 'PDF report', accept: { 'application/pdf': ['.pdf'] } },
      },
    )
    useAppStore.getState().patchDeliver({ generating: false })
  } catch (err) {
    useAppStore.getState().patchDeliver({
      generating: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------- local backup & restore (plan §2.8) ----------

const BACKUP_SAVE_TYPE: SaveType = {
  description: 'GoldSmith Studio backup',
  accept: { 'application/json': ['.json'] },
}

/**
 * Export every on-device store (parts, settings, materials, history, kv) as one
 * versioned JSON backup file — the local insurance copy, no cloud. Throws on
 * failure so the caller can surface the message.
 */
export async function exportBackup(opts: { share?: boolean } = {}): Promise<void> {
  const json = serializeBackup(await dumpDatabase())
  const name = `goldsmith-backup-${new Date().toISOString().slice(0, 10)}.json`
  await deliverFiles([{ data: json, name, mime: 'application/json' }], {
    share: opts.share,
    title: 'GoldSmith Studio backup',
    type: BACKUP_SAVE_TYPE,
  })
}

/**
 * Pick a backup file, validate it, replace ALL on-device data, then reload so
 * every store and store-slice rehydrates from the restored database. Returns
 * false if the user cancelled the file picker; throws (without touching the
 * database) if the file is invalid.
 */
export async function importBackup(): Promise<boolean> {
  const text = await pickTextFile('application/json,.json')
  if (text === null) return false
  const dump = parseBackup(text) // validates version + shape; throws on garbage
  await restoreDatabase(dump)
  location.reload()
  return true
}

/** Copy the plain-text version of the current report to the clipboard. */
export async function copyReportText(): Promise<void> {
  const store = useAppStore.getState()
  try {
    const model = buildReportModel(buildReportInputFromState())
    await navigator.clipboard.writeText(reportToText(model))
    store.patchDeliver({ copied: true, error: null })
    setTimeout(() => useAppStore.getState().patchDeliver({ copied: false }), 1500)
  } catch (err) {
    store.patchDeliver({ error: err instanceof Error ? err.message : String(err) })
  }
}
