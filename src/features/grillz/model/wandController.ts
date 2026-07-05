import { getClients, getEngine, getPickConsumer, registerPointPickHandler, setPickConsumer } from '@/core/controller/context'
import { defaultInsertionAxis } from '@/core/geometry/undercut'
import type { Vec3 } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import {
  fitErrorMessage,
  fitJob,
  fitScanId,
  setFitJob,
  setWandDebounce,
  setWandSeed,
  surveyScan,
  wandDebounce,
  wandSeed,
} from './fitState'

export function setWandSelect(on: boolean): void {
  const store = useAppStore.getState()
  const eng = getEngine()
  if (on) {
    const id = fitScanId()
    if (!id) {
      store.patchFit({ error: 'Select the tooth scan first.' })
      return
    }
    if (store.fit.brushActive) try { eng.setBrushPassive() } catch { /* ignore */ }
    setPickConsumer('wand')
    try {
      eng.setPickMode(true)
      eng.setGizmoMode('none')
    } catch { /* ignore */ }
    store.patchFit({ wandActive: true, brushActive: false, scanPartId: id, error: null })
  } else {
    if (getPickConsumer() === 'wand') setPickConsumer(null)
    setWandDebounce(null)
    setWandSeed(null)
    try {
      eng.setPickMode(false)
      eng.setGizmoMode(store.gizmoMode)
    } catch { /* ignore */ }
    store.patchFit({ wandActive: false })
  }
}

export function setWandThreshold(deg: number): void {
  if (!Number.isFinite(deg)) return
  useAppStore.getState().patchFit({ wandThresholdDeg: deg })
  if (!wandSeed) return
  if (wandDebounce) clearTimeout(wandDebounce)
  setWandDebounce(
    setTimeout(() => {
      setWandDebounce(null)
      if (wandSeed) void runWand(wandSeed)
    }, 150),
  )
}

async function runWand(seed: Vec3): Promise<void> {
  const scan = surveyScan()
  if (!scan) return
  setWandSeed(seed)
  const f = useAppStore.getState().fit
  const axis = f.surveyEnabled ? f.insertionAxis : defaultInsertionAxis(scan.mesh)
  const thresholdRad = (f.wandThresholdDeg * Math.PI) / 180
  fitJob?.cancel()
  useAppStore.getState().patchFit({ busy: true, progress: 0, stage: 'Growing tooth region', error: null })
  const job = getClients().fit.wand(scan.mesh, seed, axis, thresholdRad, (p, stage) =>
    useAppStore.getState().patchFit({ progress: p, stage }),
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
    if (result.faces.length === 0) {
      useAppStore.getState().patchFit({
        busy: false, progress: 0, stage: null,
        error: 'No tooth region found there — tap directly on the scan surface.',
      })
      return
    }
    if (!getEngine().setWandSelection(scan.id, result.vertices)) {
      useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
      return
    }
    const st = useAppStore.getState()
    if (st.measure.heatmap.enabled) {
      st.patchHeatmap({ enabled: false, busy: false, progress: 0, range: null, partId: null, error: null })
    }
    if (st.fit.mapEnabled) st.patchFit({ mapEnabled: false, mapRange: null, mapPartId: null })
    if (st.fit.surveyEnabled) {
      try { getEngine().hideInsertionAxis() } catch { /* ignore */ }
      st.patchFit({ surveyEnabled: false, undercutArea: null, surveyPartId: null })
    }
    useAppStore.getState().patchFit({
      busy: false, progress: 1, stage: null,
      marginCurves: result.curves, scanPartId: scan.id,
    })
  } catch (err) {
    if (fitJob !== job) return
    setFitJob(null)
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

registerPointPickHandler('wand', runWand)
