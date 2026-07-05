import { getClients, getEngine } from '@/core/controller/context'
import type { ThicknessJob } from '@/core/geometry/thicknessClient'
import { useAppStore } from '@/store/appStore'

let thicknessJob: ThicknessJob | null = null

export function __getThicknessJob(): ThicknessJob | null {
  return thicknessJob
}

export function __resetThicknessJob(): void {
  thicknessJob?.cancel()
  thicknessJob = null
}

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
  const job = getClients().thickness.compute(mesh, (p) =>
    useAppStore.getState().patchHeatmap({ progress: p }),
  )
  thicknessJob = job
  try {
    const field = await job.promise
    if (thicknessJob !== job) return
    thicknessJob = null
    if (!field) {
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
    if (thicknessJob !== job) return
    thicknessJob = null
    useAppStore.getState().patchHeatmap({ busy: false, error: String(err) })
  }
}

export function cancelThicknessHeatmap() {
  thicknessJob?.cancel()
  thicknessJob = null
  useAppStore.getState().patchHeatmap({ busy: false, progress: 0 })
}

export function setHeatmapThreshold(mm: number) {
  if (!Number.isFinite(mm)) return
  useAppStore.getState().patchHeatmap({ thresholdMm: mm })
  if (useAppStore.getState().measure.heatmap.enabled) {
    try { getEngine().setHeatmapThreshold(mm) } catch { /* ignore */ }
  }
}

export function clearThicknessHeatmap() {
  thicknessJob?.cancel()
  thicknessJob = null
  try { getEngine().clearThicknessHeatmap() } catch { /* ignore */ }
  useAppStore.getState().patchHeatmap({
    enabled: false, busy: false, progress: 0, range: null, partId: null, error: null,
  })
}

export function teardownHeatmap() {
  if (useAppStore.getState().measure.heatmap.enabled || thicknessJob) clearThicknessHeatmap()
}
