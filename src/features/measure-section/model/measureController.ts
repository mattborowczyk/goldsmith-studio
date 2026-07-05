import { getEngine, guardWrite, registerPointPickHandler, requireSelection, setPickConsumer } from '@/core/controller/context'
import { estimateInnerDiameter } from '@/core/geometry/measure'
import { kvGet, kvSet } from '@/core/persist/db'
import type { Measurement, Vec3 } from '@/core/types'
import { useAppStore } from '@/store/appStore'

const KV_MEASUREMENTS = 'measurements'
const KV_MEASURE_COLOR = 'measureColor'

function handlePointPickedForMeasure(point: Vec3) {
  const store = useAppStore.getState()
  const pending = store.measure.pendingPoint
  const eng = getEngine()
  if (!pending) {
    store.patchMeasure({ pendingPoint: point })
    try { eng.setPendingMarker(point) } catch { /* ignore */ }
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
  try {
    eng.setPendingMarker(null)
    eng.addMeasurement(m)
  } catch { /* ignore */ }
  const measurements = [...store.measure.measurements, m]
  store.patchMeasure({ pendingPoint: null, measurements })
  void guardWrite(kvSet(KV_MEASUREMENTS, measurements))
}

registerPointPickHandler('measure', handlePointPickedForMeasure)

export function setMeasurePicking(on: boolean) {
  const store = useAppStore.getState()
  const eng = getEngine()
  setPickConsumer(on ? 'measure' : null)
  eng.setPickMode(on)
  eng.setGizmoMode(on ? 'none' : store.gizmoMode)
  store.patchMeasure({ picking: on, pendingPoint: null })
}

export function setMeasureColor(color: string) {
  useAppStore.getState().patchMeasure({ color })
  void guardWrite(kvSet(KV_MEASURE_COLOR, color))
}

export function removeMeasurementById(id: string) {
  const store = useAppStore.getState()
  try { getEngine().removeMeasurement(id) } catch { /* ignore */ }
  const measurements = store.measure.measurements.filter((m) => m.id !== id)
  store.patchMeasure({ measurements })
  void guardWrite(kvSet(KV_MEASUREMENTS, measurements))
}

export function undoLastMeasurement() {
  const last = useAppStore.getState().measure.measurements.at(-1)
  if (last) removeMeasurementById(last.id)
}

export function clearAllMeasurements() {
  try { getEngine().clearMeasurements() } catch { /* ignore */ }
  useAppStore.getState().patchMeasure({ measurements: [], pendingPoint: null })
  void guardWrite(kvSet(KV_MEASUREMENTS, []))
}

export async function restoreMeasurements() {
  const saved = await kvGet<Measurement[]>(KV_MEASUREMENTS)
  if (!saved?.length) return
  try {
    const eng = getEngine()
    for (const m of saved) eng.addMeasurement(m)
  } catch { /* ignore */ }
  useAppStore.getState().patchMeasure({ measurements: saved })
}

export function draftingView() {
  const eng = getEngine()
  eng.setProjection('orthographic')
  useAppStore.getState().setProjection('orthographic')
  eng.setViewPreset('front')
  eng.setTurntable(false)
  useAppStore.getState().setTurntable(false)
}

export function detectInnerDiameter() {
  const id = requireSelection()
  if (!id) return
  const mesh = getEngine().getWorldMeshData(id)
  if (!mesh) return
  const est = estimateInnerDiameter(mesh)
  useAppStore.getState().patchMeasure({ innerDiameter: est ?? 'none' })
}
