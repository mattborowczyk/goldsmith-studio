import { SceneManager } from '@/core/engine/SceneManager'
import { importFile, scaleMeshData } from '@/core/io/importers'
import { repairClient } from '@/core/geometry/repairClient'
import {
  addHistoryEntries,
  clearHistoryStore,
  deleteHistoryEntry,
  kvGet,
  kvSet,
  loadHistory,
  loadMaterials,
  loadScene,
  loadSettings,
  saveMaterials,
  saveScene,
  saveSettings,
  type SavedPart,
} from '@/core/persist/db'
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
  exportOBJ,
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
    useAppStore.getState().setParts(engine!.listParts())
    scheduleAutosave()
    if (useAppStore.getState().tab === 'cost') scheduleVolumeRecompute()
  })
  engine.on('selectionChanged', (id) => {
    useAppStore.getState().setSelected(id)
    updateRepairUndoFlag(id)
  })
  engine.on('pointPicked', handlePointPicked)
  engine.on('resizeHandleDrag', (protectedDeg) => setResizeProtectedWidth(protectedDeg))

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
        eng.addPart(newPartId(), part.name, data)
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
    })
  })
  try {
    await saveScene(parts)
  } catch (err) {
    console.warn('Autosave failed', err)
  }
}

export function persistDisplaySettings() {
  const s = useAppStore.getState()
  void saveSettings({
    displayMode: s.displayMode,
    background: s.background,
    gridVisible: s.gridVisible,
  })
}

async function restoreSession() {
  const store = useAppStore.getState()
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
    }
    for (const p of parts) {
      engine.addPart(p.id, p.name, p.data, p.matrix, {
        material: p.material,
        flatShading: p.flatShading,
      })
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

/** Trigger a download of arbitrary bytes/text as a named file. */
function downloadBlob(data: Uint8Array | ArrayBuffer | string, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // defer revoke so WebKit/Safari (the primary iPad target) finishes initiating
  // the download before the blob URL is invalidated
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
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
      await saveMaterials(materials)
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
  void kvSet(KV_ASSIGNMENTS, assignments)
}

export function updateCostSettings(patch: Partial<CostSettings>) {
  const store = useAppStore.getState()
  const settings = { ...store.cost.settings, ...patch }
  store.patchCost({ settings })
  void kvSet(KV_COST_SETTINGS, settings)
}

export function updateMaterial(id: string, patch: Partial<Material>) {
  const store = useAppStore.getState()
  const materials = store.cost.materials.map((m) => (m.id === id ? { ...m, ...patch } : m))
  store.patchCost({ materials })
  void saveMaterials(materials)
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
  void saveMaterials(materials)
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
  void saveMaterials(materials)
  void kvSet(KV_ASSIGNMENTS, assignments)
}

/** Restore built-in densities/names; keeps custom materials and all prices at 0. */
export function resetMaterialLibrary() {
  const store = useAppStore.getState()
  const custom = store.cost.materials.filter((m) => !m.builtin)
  const materials = [...defaultMaterials(), ...custom]
  store.patchCost({ materials })
  void saveMaterials(materials)
}

export async function refreshMarketPrices(): Promise<void> {
  const store = useAppStore.getState()
  store.patchCost({ refreshing: true, error: null })
  try {
    const perGram = await fetchSpotPricesPerGram(store.cost.settings.currency)
    const materials = applySpotPrices(useAppStore.getState().cost.materials, perGram)
    useAppStore.getState().patchCost({ materials, refreshing: false })
    await saveMaterials(materials)
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
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `goldsmith-history-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
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
  void kvSet(KV_MEASUREMENTS, measurements)
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
  void kvSet(KV_MEASURE_COLOR, color)
}

export function removeMeasurementById(id: string) {
  const store = useAppStore.getState()
  getEngine().removeMeasurement(id)
  const measurements = store.measure.measurements.filter((m) => m.id !== id)
  store.patchMeasure({ measurements })
  void kvSet(KV_MEASUREMENTS, measurements)
}

export function undoLastMeasurement() {
  const last = useAppStore.getState().measure.measurements.at(-1)
  if (last) removeMeasurementById(last.id)
}

export function clearAllMeasurements() {
  getEngine().clearMeasurements()
  useAppStore.getState().patchMeasure({ measurements: [], pendingPoint: null })
  void kvSet(KV_MEASUREMENTS, [])
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
      if (
        typeof branding.logo === 'string' &&
        (branding.logo === '' || /^data:image\/(?:png|jpeg);base64,/i.test(branding.logo))
      ) {
        nextBranding.logo = branding.logo
      }
      patch.branding = nextBranding
    }
    // whitelist persisted enums/numbers — a stale or corrupted record must not
    // feed an invalid value to the panel (.find(...) would return undefined)
    if (prefs && typeof prefs === 'object') {
      keepEnum(patch, prefs, 'template', ['quote', 'casting', 'internal'])
      keepEnum(patch, prefs, 'billing', ['exact', '15min', '30min', '1h'])
      keepEnum(patch, prefs, 'exportFormat', ['stl', 'obj', 'glb'])
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
  void kvSet(KV_REPORT_PREFS, prefs)
}

/** Patch the deliver slice; durable prefs are written through to IndexedDB. */
export function patchDeliver(patch: Partial<DeliverState>) {
  useAppStore.getState().patchDeliver(patch)
  persistReportPrefs()
}

export function setBranding(patch: Partial<ReportBranding>) {
  const branding = { ...useAppStore.getState().deliver.branding, ...patch }
  useAppStore.getState().patchDeliver({ branding })
  void kvSet(KV_BRANDING, branding)
}

/** Read an uploaded logo file as a data-URL and store it in branding. */
export function setLogoFromFile(file: File): void {
  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result === 'string') setBranding({ logo: reader.result })
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
}

/** Export the scene as STL / OBJ / GLB, merged or one file per part (§2.7). */
export async function exportMesh(): Promise<void> {
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
    for (const file of files) {
      const fname = `${safeFilename(file.name)}.${d.exportFormat}`
      if (d.exportFormat === 'stl') {
        downloadBlob(exportSTL(file.mesh), fname, mime)
      } else if (d.exportFormat === 'obj') {
        downloadBlob(exportOBJ([file]), fname, mime)
      } else {
        const glb = await getEngine().exportGLTF([file], { binary: true })
        downloadBlob(glb, fname, mime)
      }
    }
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
export async function generateReportPDF(): Promise<void> {
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
    downloadBlob(bytes, `${base}-${model.template}.pdf`, 'application/pdf')
    useAppStore.getState().patchDeliver({ generating: false })
  } catch (err) {
    useAppStore.getState().patchDeliver({
      generating: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
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
