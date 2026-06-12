import { SceneManager } from '@/core/engine/SceneManager'
import { importFile, scaleMeshData } from '@/core/io/importers'
import { repairClient } from '@/core/geometry/repairClient'
import { loadScene, loadSettings, saveScene, saveSettings, type SavedPart } from '@/core/persist/db'
import type { DisplayMode, ImportUnit, MeshData } from '@/core/types'
import { UNIT_TO_MM } from '@/core/types'
import { useAppStore } from '@/store/appStore'

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
  })
  engine.on('selectionChanged', (id) => {
    useAppStore.getState().setSelected(id)
    updateRepairUndoFlag(id)
  })

  void restoreSession()
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
