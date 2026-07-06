import { useAppStore, type BaseCapState } from '@/store/appStore'
import {
  getClients,
  getEngine,
  newPartId,
  replaceWithWorldMesh,
  requireSelection,
  revisions,
} from '@/core/controller/context'
import { AXIS_INDEX, type RimSummary } from '@/core/geometry/baseCap'
import type { SectionAxis } from '@/core/types'

export async function analyzeSelected(): Promise<void> {
  const store = useAppStore.getState()
  const id = requireSelection((msg) => store.patchRepair({ error: msg }))
  if (!id) return
  const mesh = getEngine().getWorldMeshData(id)
  if (!mesh) return
  store.patchRepair({ busy: 'analyze', error: null })
  try {
    const report = await getClients().repair.analyze(mesh)
    getEngine().showAnalysisHighlights(report)
    useAppStore.getState().patchRepair({ busy: null, report })
  } catch (err) {
    useAppStore.getState().patchRepair({ busy: null, error: String(err) })
  }
}

export async function healSelected(): Promise<void> {
  const store = useAppStore.getState()
  const id = requireSelection((msg) => store.patchRepair({ error: msg }))
  if (!id) return
  const eng = getEngine()
  const mesh = eng.getWorldMeshData(id)
  if (!mesh) return
  store.patchRepair({ busy: 'heal', error: null })
  try {
    const outcome = await getClients().repair.heal(mesh, store.repair.options)
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
  const id = requireSelection((msg) => store.patchRepair({ error: msg }))
  if (!id) return
  const eng = getEngine()
  const mesh = eng.getWorldMeshData(id)
  if (!mesh) return
  store.patchRepair({ busy: 'split', error: null })
  try {
    const shells = await getClients().repair.split(mesh)
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

function flattestRimAxis(info: RimSummary): SectionAxis {
  let best: SectionAxis = 'z'
  let bestScore = Infinity
  for (const axis of ['x', 'y', 'z'] as const) {
    const ai = AXIS_INDEX[axis]
    const extent = Math.max(info.meshMax[ai] - info.meshMin[ai], 1e-6)
    const score = (info.rimMax[ai] - info.rimMin[ai]) / extent
    if (score < bestScore) {
      bestScore = score
      best = axis
    }
  }
  return best
}

function capRange(info: RimSummary, axis: SectionAxis): { position: number; min: number; max: number } {
  const ai = AXIS_INDEX[axis]
  const side = info.rimCentroid[ai] > info.meshCentroid[ai] ? 1 : -1
  const extent = Math.max(info.meshMax[ai] - info.meshMin[ai], 1)
  const rimEdge = side > 0 ? info.rimMax[ai] : info.rimMin[ai]
  const position = rimEdge + side * Math.max(extent * 0.02, 0.2)
  const far = rimEdge + side * extent * 0.5
  return side > 0 ? { position, min: rimEdge, max: far } : { position, min: far, max: rimEdge }
}

export async function beginBaseCap(): Promise<void> {
  const store = useAppStore.getState()
  const id = requireSelection((msg) => store.patchRepair({ error: msg }))
  if (!id) return
  const mesh = getEngine().getWorldMeshData(id)
  if (!mesh) return
  store.patchRepair({ busy: 'baseCap', error: null })
  try {
    const info = await getClients().repair.baseCapInfo(mesh)
    if (!info) {
      useAppStore.getState().patchRepair({
        busy: null,
        error: 'No open rim found — the mesh is already closed. Use Heal for small holes.',
      })
      return
    }
    const axis = flattestRimAxis(info)
    const { position, min, max } = capRange(info, axis)
    useAppStore.getState().patchRepair({ busy: null, baseCap: { axis, position, min, max, info } })
    getEngine().setCapPlanePreview({ axis, position })
  } catch (err) {
    useAppStore.getState().patchRepair({ busy: null, error: String(err) })
  }
}

export function updateBaseCap(patch: Partial<Pick<BaseCapState, 'axis' | 'position'>>): void {
  const store = useAppStore.getState()
  const prev = store.repair.baseCap
  if (!prev) return
  let next: BaseCapState = { ...prev, ...patch }
  if (patch.axis && patch.axis !== prev.axis) {
    next = { ...next, ...capRange(prev.info, patch.axis) }
  }
  next.position = Math.min(Math.max(next.position, next.min), next.max)
  store.patchRepair({ baseCap: next })
  getEngine().setCapPlanePreview({ axis: next.axis, position: next.position })
}

export async function applyBaseCap(): Promise<void> {
  const store = useAppStore.getState()
  const cap = store.repair.baseCap
  const id = requireSelection((msg) => store.patchRepair({ error: msg }))
  if (!cap || !id) return
  const eng = getEngine()
  const mesh = eng.getWorldMeshData(id)
  if (!mesh) return
  store.patchRepair({ busy: 'baseCap', error: null })
  try {
    const outcome = await getClients().repair.baseCap(mesh, { axis: cap.axis, position: cap.position })
    const saved = eng.getPartForSave(id)
    if (saved) {
      const stack = revisions.get(id) ?? []
      stack.push({ data: saved.data, matrix: saved.matrix })
      revisions.set(id, stack)
    }
    replaceWithWorldMesh(id, outcome.mesh)
    eng.clearHighlights()
    eng.setCapPlanePreview(null)
    useAppStore.getState().patchRepair({
      busy: null,
      baseCap: null,
      beforeAfter: { before: outcome.before, after: outcome.after, unioned: outcome.unioned },
      report: outcome.after,
      canUndo: true,
    })
  } catch (err) {
    useAppStore.getState().patchRepair({ busy: null, error: String(err) })
  }
}

export function cancelBaseCap(): void {
  try { getEngine().setCapPlanePreview(null) } catch { /* ignore */ }
  if (useAppStore.getState().repair.baseCap) useAppStore.getState().patchRepair({ baseCap: null })
}

export function updateRepairUndoFlag(id: string | null) {
  const canUndo = id ? (revisions.get(id)?.length ?? 0) > 0 : false
  useAppStore.getState().patchRepair({ canUndo, report: null, beforeAfter: null })
  try { getEngine().clearHighlights() } catch { /* ignore */ }
  cancelBaseCap()
}


