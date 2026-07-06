import {
  getClients,
  getEngine,
  revisions,
  setClients as __setClients,
  setEngine as __setEngine,
  __resetContext,
  refreshStorageEstimate,
  scheduleAutosave,
  handlePointPicked,
} from '@/core/controller/context'
import { SceneManager } from '@/core/engine/SceneManager'
import { loadScene, loadSettings, requestPersistentStorage } from '@/core/persist/db'
import { useAppStore } from '@/store/appStore'
import { applyAccent, normalizeAccent } from '@/app/theme'
import { restoreMeasurements } from '@/features/measure-section'
import { initCostData, scheduleVolumeRecompute } from '@/features/cost-materials'
import { initDeliverData } from '@/features/deliver'
import { __getThicknessJob, __resetThicknessJob, updateRepairUndoFlag } from '@/features/repair'
import { fitJob, setFitJob, setWandSelect, setWandSeed, setInsertionAxisFromGizmo } from '@/features/grillz'
import { setResizeProtectedWidth } from '@/features/resize'
import type { StudioClients } from '@/core/controller/context'
import type { Vec3 } from '@/core/types'

export {
  getClients,
  getEngine,
  __setClients,
  __setEngine,
  __resetContext,
}

let createEngine: (container: HTMLElement) => SceneManager = (container) => new SceneManager(container)

export function initEngine(container: HTMLElement): SceneManager {
  let eng: SceneManager | null = null
  try {
    eng = getEngine()
  } catch { /* ignore */ }
  if (eng) return eng
  eng = createEngine(container)
  __setEngine(eng)
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>
    w.__engine = eng
    void import('three').then((three) => (w.__THREE = three))
  }
  const store = useAppStore.getState()

  eng.on('partsChanged', handlePartsChanged)
  eng.on('selectionChanged', (id) => {
    useAppStore.getState().setSelected(id)
    updateRepairUndoFlag(id)
  })
  eng.on('pointPicked', handlePointPicked)
  eng.on('resizeHandleDrag', (protectedDeg) => setResizeProtectedWidth(protectedDeg))
  eng.on('insertionAxisChanged', (axis) => setInsertionAxisFromGizmo(axis))
  eng.on('brushSelectionChanged', (count) => useAppStore.getState().patchFit({ brushCount: count }))

  void restoreSession()
  void initCostData()
  void initDeliverData()
  store.setParts(eng.listParts())
  return eng
}

export function disposeEngine() {
  try {
    const eng = getEngine()
    eng?.dispose()
  } catch { /* ignore */ }
  __setEngine(null)
}

function handlePartsChanged() {
  let eng: SceneManager | null = null
  try { eng = getEngine() } catch { /* ignore */ }
  if (!eng) return
  const s = useAppStore.getState()
  s.setParts(eng.listParts())
  if (s.measure.heatmap.enabled && !eng.hasThicknessHeatmap()) {
    s.patchHeatmap({ enabled: false, busy: false, progress: 0, range: null, partId: null, error: null })
  }
  if (s.fit.mapEnabled && !eng.hasClearanceMap()) {
    s.patchFit({ mapEnabled: false, mapRange: null, mapPartId: null })
  }
  if (s.fit.surveyEnabled && !eng.hasUndercutSurvey()) {
    eng.hideInsertionAxis()
    s.patchFit({ surveyEnabled: false, undercutArea: null, surveyPartId: null })
  }
  if (s.fit.brushActive && !eng.hasBrushSelect()) {
    s.patchFit({ brushActive: false, brushCount: 0 })
  }
  if (s.fit.wandActive && s.fit.scanPartId && !eng.listParts().some((p) => p.id === s.fit.scanPartId)) {
    setWandSelect(false)
  }
  if ((s.fit.marginCurves || s.fit.brushCount > 0) && !eng.hasBrushSelect()) {
    setWandSeed(null)
    s.patchFit({ marginCurves: null, brushCount: 0 })
  }
  scheduleAutosave()
  if (s.tab === 'cost') scheduleVolumeRecompute()
}

async function restoreSession() {
  const store = useAppStore.getState()
  void requestPersistentStorage().then((granted) => {
    if (import.meta.env.DEV) console.info('Persistent storage:', granted)
    useAppStore.getState().patchStorage({ persisted: granted })
    void refreshStorageEstimate()
  })
  void refreshStorageEstimate()
  try {
    const [parts, settings] = await Promise.all([loadScene(), loadSettings()])
    let eng: SceneManager | null = null
    try { eng = getEngine() } catch { /* ignore */ }
    if (!eng) return
    if (settings) {
      eng.setDisplayMode(settings.displayMode)
      eng.setBackground(settings.background)
      eng.setGridVisible(settings.gridVisible)
      store.setDisplayMode(settings.displayMode)
      store.setBackground(settings.background)
      store.setGridVisible(settings.gridVisible)
      const accent = normalizeAccent(settings.accent)
      store.setAccent(accent)
      applyAccent(accent)
    }
    for (const p of parts) {
      eng.addPart(
        p.id, p.name, p.data, p.matrix,
        { material: p.material, flatShading: p.flatShading },
        p.colors ?? undefined,
      )
      eng.setPartVisible(p.id, p.visible)
    }
    if (parts.length) eng.fitToView()
    await restoreMeasurements()
  } catch (err) {
    console.warn('Session restore failed', err)
  } finally {
    useAppStore.getState().setRestoring(false)
  }
}

export const __studioTestSeams = {
  setEngine(fake: SceneManager | null) {
    __setEngine(fake)
  },
  setEngineFactory(factory: (container: HTMLElement) => SceneManager) {
    createEngine = factory
  },
  setClients(overrides: Partial<StudioClients>) {
    __setClients({ ...getClients(), ...overrides })
  },
  getRevisions() {
    return revisions
  },
  getJobs() {
    return { fitJob, thicknessJob: __getThicknessJob() }
  },
  firePartsChanged() {
    handlePartsChanged()
  },
  firePointPicked(point: Vec3) {
    handlePointPicked(point)
  },
  reset() {
    __setEngine(null)
    __resetContext()
    createEngine = (container) => new SceneManager(container)
    fitJob?.cancel()
    setFitJob(null)
    __resetThicknessJob()
    setWandSeed(null)
  },
}
