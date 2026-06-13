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
import { estimateInnerDiameter, volumeAndArea } from '@/core/geometry/measure'
import type { DisplayMode, ImportUnit, Measurement, MeshData, Vec3 } from '@/core/types'
import { UNIT_TO_MM } from '@/core/types'
import { useAppStore, type CostSettings, type SectionState } from '@/store/appStore'

/**
 * Application controller: owns the SceneManager singleton and orchestrates
 * import, repair, persistence. React components call these functions; state
 * flows back through the zustand store.
 */

let engine: SceneManager | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let nextPartNum = 1
/** Non-destructive heal: previous geometry+transform per part, newest last. */
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

  void restoreSession()
  void initCostData()
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
      engine.addPart(p.id, p.name, p.data, p.matrix)
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
export function addGeneratedPart(name: string, data: MeshData): string {
  const eng = getEngine()
  const id = newPartId()
  eng.addPart(id, name, data)
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
