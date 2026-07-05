import { addGeneratedPart, getClients, getEngine, getPickConsumer, setPickConsumer } from '@/core/controller/context'
import { useAppStore } from '@/store/appStore'
import {
  FIT_SPHERE_SEGMENTS,
  fitBand,
  fitErrorMessage,
  fitJob,
  fitScanId,
  fitShellId,
  partName,
  recolourClearanceBand,
  setFitJob,
  setSurveyDebounce,
  setWandDebounce,
  setWandSeed,
} from './fitState'

export function setFitScanPart(id: string | null) {
  useAppStore.getState().patchFit({ scanPartId: id, error: null })
}

export function setFitShellPart(id: string | null) {
  useAppStore.getState().patchFit({ shellPartId: id, error: null })
}

export function setFitClearance(mm: number) {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchFit({ clearanceMm: mm })
  recolourClearanceBand()
}

export function setFitBandHalf(mm: number) {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchFit({ bandHalfMm: mm })
  recolourClearanceBand()
}

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
  const job = getClients().fit.offset(scan, clearance, FIT_SPHERE_SEGMENTS, (p, stage) =>
    useAppStore.getState().patchFit({ progress: p, stage }),
  )
  setFitJob(job)
  try {
    const mesh = await job.promise
    if (fitJob !== job) return
    setFitJob(null)
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
    setFitJob(null)
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

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
  const job = getClients().fit.subtract(scan, shell, clearance, FIT_SPHERE_SEGMENTS, (p, stage) =>
    useAppStore.getState().patchFit({ progress: p, stage }),
  )
  setFitJob(job)
  try {
    const mesh = await job.promise
    if (fitJob !== job) return
    setFitJob(null)
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
    setFitJob(null)
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

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
  const job = getClients().fit.clearance(shell, scan, (p, stage) =>
    useAppStore.getState().patchFit({ progress: p, stage }),
  )
  setFitJob(job)
  try {
    const field = await job.promise
    if (fitJob !== job) return
    setFitJob(null)
    if (!field) {
      useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
      return
    }
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
    setFitJob(null)
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

export function cancelFit() {
  fitJob?.cancel()
  setFitJob(null)
  useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
}

export function clearFitMap() {
  try { getEngine().clearClearanceMap() } catch { /* ignore */ }
  useAppStore.getState().patchFit({ mapEnabled: false, mapRange: null, mapPartId: null })
}

export function teardownFit() {
  const f = useAppStore.getState().fit
  if (fitJob || f.mapEnabled || f.surveyEnabled || f.brushActive || f.wandActive || f.marginCurves) {
    setSurveyDebounce(null)
    setWandDebounce(null)
    setWandSeed(null)
    if (getPickConsumer() === 'wand') {
      setPickConsumer(null)
      try { getEngine().setPickMode(false) } catch { /* ignore */ }
    }
    fitJob?.cancel()
    setFitJob(null)
    clearFitMap()
    try {
      getEngine().clearUndercutSurvey()
      getEngine().hideInsertionAxis()
      getEngine().setBrushSelect(null, 0)
    } catch { /* ignore */ }
    useAppStore.getState().patchFit({
      busy: false, progress: 0, stage: null,
      surveyEnabled: false, undercutArea: null, surveyPartId: null,
      brushActive: false, brushCount: 0,
      wandActive: false, marginCurves: null,
    })
  }
}
