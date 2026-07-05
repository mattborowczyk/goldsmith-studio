import { weightGrams } from '@/core/calc/materials'
import { addGeneratedPart, getClients, getEngine } from '@/core/controller/context'
import { defaultInsertionAxis } from '@/core/geometry/undercut'
import { useAppStore } from '@/store/appStore'
import {
  FIT_SPHERE_SEGMENTS,
  fitErrorMessage,
  fitJob,
  fitScanId,
  partName,
  setFitJob,
  setWandSeed,
} from './fitState'
import { setWandSelect } from './wandController'

const MIN_SHELL_MM = 0.6
const MAX_SHELL_MM = 1.5
const DEFAULT_GRILLZ_DENSITY = 13.05

export function setBrushSelect(on: boolean): void {
  const store = useAppStore.getState()
  if (on) {
    const id = fitScanId()
    if (!id) {
      store.patchFit({ error: 'Select the tooth scan first.' })
      return
    }
    if (store.fit.wandActive) setWandSelect(false)
    const eng = getEngine()
    eng.setBrushSelect(id, store.fit.brushRadiusMm)
    eng.setGizmoMode('none')
    store.patchFit({ brushActive: true, scanPartId: id, error: null })
  } else {
    try {
      getEngine().setBrushSelect(null, 0)
      getEngine().setGizmoMode(store.gizmoMode)
    } catch { /* ignore */ }
    store.patchFit({ brushActive: false })
  }
}

export function setBrushRadius(mm: number): void {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchFit({ brushRadiusMm: mm })
  try { getEngine().setBrushRadius(mm) } catch { /* ignore */ }
}

export function clearBrushSelection(): void {
  try { getEngine().clearBrushSelection() } catch { /* ignore */ }
  setWandSeed(null)
  useAppStore.getState().patchFit({ marginCurves: null })
}

export function setShellThickness(mm: number): void {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchFit({ shellThicknessMm: Math.min(Math.max(mm, MIN_SHELL_MM), MAX_SHELL_MM) })
}

export function setOpenGingival(open: boolean): void {
  useAppStore.getState().patchFit({ openGingival: open })
}

function shellDensity(scanId: string): number {
  const cost = useAppStore.getState().cost
  const matId = cost.assignments[scanId]
  const mat = cost.materials.find((m) => m.id === matId)
  return mat?.density ?? DEFAULT_GRILLZ_DENSITY
}

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
  const axis = store.fit.surveyEnabled ? store.fit.insertionAxis : defaultInsertionAxis(scan)
  const selection = eng.getBrushSelection()
  const indices = selection && selection.id === scanId ? selection.indices : null
  fitJob?.cancel()
  store.patchFit({ busy: true, progress: 0, stage: 'Starting', error: null })
  const job = getClients().fit.shell(
    scan, indices, axis, clearanceMm, shellThicknessMm, openGingival, FIT_SPHERE_SEGMENTS,
    (p, stage) => useAppStore.getState().patchFit({ progress: p, stage }),
  )
  setFitJob(job)
  try {
    const result = await job.promise
    if (fitJob !== job) return
    setFitJob(null)
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
    setFitJob(null)
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}
