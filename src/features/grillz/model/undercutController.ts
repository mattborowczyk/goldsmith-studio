import { addGeneratedPart, getClients, getEngine } from '@/core/controller/context'
import { defaultInsertionAxis } from '@/core/geometry/undercut'
import type { MeshData, Vec3 } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import {
  FIT_SPHERE_SEGMENTS,
  fitErrorMessage,
  fitJob,
  partName,
  setFitJob,
  setSurveyDebounce,
  surveyDebounce,
  surveyScan,
} from './fitState'

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

async function runSurvey(quiet = false): Promise<void> {
  const scan = surveyScan()
  if (!scan) return
  const axis = useAppStore.getState().fit.insertionAxis
  fitJob?.cancel()
  if (!quiet) {
    useAppStore.getState().patchFit({ busy: true, progress: 0, stage: 'Surveying undercuts', error: null })
  }
  const job = getClients().fit.survey(scan.mesh, axis, (p, stage) => {
    if (!quiet) useAppStore.getState().patchFit({ progress: p, stage })
  })
  setFitJob(job)
  try {
    const field = await job.promise
    if (fitJob !== job) return
    setFitJob(null)
    if (!field) {
      if (!quiet) useAppStore.getState().patchFit({ busy: false, progress: 0, stage: null })
      return
    }
    const painted = getEngine().setUndercutSurvey(scan.id, field.values)
    if (painted) {
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
    setFitJob(null)
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

function debounceSurvey() {
  if (surveyDebounce) clearTimeout(surveyDebounce)
  setSurveyDebounce(
    setTimeout(() => {
      setSurveyDebounce(null)
      void runSurvey(true)
    }, 50),
  )
}

function showAxisGizmo(scanMesh: MeshData) {
  const { center, radius } = meshBounds(scanMesh.positions)
  getEngine().showInsertionAxis(center, radius, useAppStore.getState().fit.insertionAxis)
}

export function enableSurvey(): void {
  const scan = surveyScan()
  if (!scan) return
  const axis = defaultInsertionAxis(scan.mesh)
  useAppStore.getState().patchFit({ insertionAxis: axis, error: null })
  showAxisGizmo(scan.mesh)
  void runSurvey(false)
}

export function clearSurvey(): void {
  setSurveyDebounce(null)
  fitJob?.cancel()
  setFitJob(null)
  try {
    getEngine().clearUndercutSurvey()
    getEngine().hideInsertionAxis()
  } catch { /* ignore */ }
  useAppStore.getState().patchFit({
    surveyEnabled: false, undercutArea: null, surveyPartId: null, busy: false, progress: 0, stage: null,
  })
}

export function toggleSurvey(): void {
  if (useAppStore.getState().fit.surveyEnabled) clearSurvey()
  else enableSurvey()
}

export function setInsertionAxisFromGizmo(axis: Vec3): void {
  useAppStore.getState().patchFit({ insertionAxis: axis })
  if (useAppStore.getState().fit.surveyEnabled) debounceSurvey()
}

export function setInsertionAxis(axis: Vec3): void {
  const len = Math.hypot(axis[0], axis[1], axis[2])
  if (!(len > 1e-9)) return
  const norm: Vec3 = [axis[0] / len, axis[1] / len, axis[2] / len]
  useAppStore.getState().patchFit({ insertionAxis: norm })
  try { getEngine().setInsertionAxisDirection(norm) } catch { /* ignore */ }
  if (useAppStore.getState().fit.surveyEnabled) debounceSurvey()
}

export function resetInsertionAxis(): void {
  const scan = surveyScan()
  if (!scan) return
  setInsertionAxis(defaultInsertionAxis(scan.mesh))
}

export async function findBestFitAxis(): Promise<void> {
  const scan = surveyScan()
  if (!scan) return
  const seed = useAppStore.getState().fit.insertionAxis
  fitJob?.cancel()
  useAppStore.getState().patchFit({ busy: true, progress: 0, stage: 'Searching axes', error: null })
  const job = getClients().fit.bestAxis(scan.mesh, seed, (p, stage) =>
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
    useAppStore.getState().patchFit({ insertionAxis: result.axis, busy: false, progress: 1, stage: null })
    showAxisGizmo(scan.mesh)
    try { getEngine().setInsertionAxisDirection(result.axis) } catch { /* ignore */ }
    void runSurvey(false)
  } catch (err) {
    if (fitJob !== job) return
    setFitJob(null)
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}

const MAX_RETENTION_MM = 0.05

export function setRetention(mm: number): void {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchFit({ retentionMm: Math.min(Math.max(mm, 0), MAX_RETENTION_MM) })
}

export async function runBlockout(): Promise<void> {
  const scan = surveyScan()
  if (!scan) return
  const { insertionAxis: axis, retentionMm } = useAppStore.getState().fit
  fitJob?.cancel()
  useAppStore.getState().patchFit({ busy: true, progress: 0, stage: 'Starting', error: null })
  const job = getClients().fit.blockout(scan.mesh, axis, retentionMm, FIT_SPHERE_SEGMENTS, (p, stage) =>
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
    const suffix = retentionMm > 0 ? ` (retain ${retentionMm.toFixed(3)})` : ''
    const newId = addGeneratedPart(`${partName(scan.id)} blockout${suffix}`, mesh, { material: null, flatShading: false })
    useAppStore.getState().patchFit({ busy: false, progress: 1, stage: null, scanPartId: newId })
  } catch (err) {
    if (fitJob !== job) return
    setFitJob(null)
    useAppStore.getState().patchFit({ busy: false, stage: null, error: fitErrorMessage(err) })
  }
}
