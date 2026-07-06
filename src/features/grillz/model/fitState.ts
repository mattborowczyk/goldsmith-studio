import { getEngine } from '@/core/controller/context'
import type { FitJob } from '@/core/geometry/fitClient'
import type { MeshData, Vec3 } from '@/core/types'
import { useAppStore } from '@/store/appStore'

export const FIT_SPHERE_SEGMENTS = 16

export let fitJob: FitJob<unknown> | null = null
export function setFitJob(job: FitJob<unknown> | null) {
  fitJob = job
}

export let wandSeed: Vec3 | null = null
export function setWandSeed(seed: Vec3 | null) {
  wandSeed = seed
}

export let wandDebounce: ReturnType<typeof setTimeout> | null = null
export function setWandDebounce(t: ReturnType<typeof setTimeout> | null) {
  if (wandDebounce) clearTimeout(wandDebounce)
  wandDebounce = t
}

export let surveyDebounce: ReturnType<typeof setTimeout> | null = null
export function setSurveyDebounce(t: ReturnType<typeof setTimeout> | null) {
  if (surveyDebounce) clearTimeout(surveyDebounce)
  surveyDebounce = t
}

export function fitBand(): { lo: number; hi: number } {
  const f = useAppStore.getState().fit
  return { lo: Math.max(f.clearanceMm - f.bandHalfMm, 0), hi: f.clearanceMm + f.bandHalfMm }
}

export function recolourClearanceBand() {
  if (!useAppStore.getState().fit.mapEnabled) return
  try {
    const { lo, hi } = fitBand()
    getEngine().setClearanceBand(lo, hi)
  } catch { /* ignore */ }
}

export function fitScanId(): string | null {
  const s = useAppStore.getState()
  return s.fit.scanPartId ?? s.selectedId ?? (s.parts.length === 1 ? s.parts[0].id : null)
}

export function fitShellId(scanId: string): string | null {
  const s = useAppStore.getState()
  if (s.fit.shellPartId) return s.fit.shellPartId
  if (s.parts.length === 2) return s.parts.find((p) => p.id !== scanId)?.id ?? null
  return null
}

export function partName(id: string): string {
  return useAppStore.getState().parts.find((p) => p.id === id)?.name ?? 'Part'
}

export function fitErrorMessage(err: unknown): string {
  const s = String(err)
  if (/manifold|watertight/i.test(s)) {
    return 'Couldn’t make the mesh watertight — run Repair on the scan and shell first. If the scan is an open shell (whole top missing), use Repair → Close open base.'
  }
  return s
}

export function surveyScan(): { id: string; mesh: MeshData } | null {
  const id = fitScanId()
  if (!id) {
    useAppStore.getState().patchFit({ error: 'Select the tooth scan first.' })
    return null
  }
  const mesh = getEngine().getWorldMeshData(id)
  return mesh ? { id, mesh } : null
}

