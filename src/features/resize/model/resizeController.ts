import { getClients, getEngine, getPickConsumer, registerPointPickHandler, replaceWithWorldMesh, revisions, setPickConsumer } from '@/core/controller/context'
import { analyzeRingFrame } from '@/core/geometry/measure'
import { diameterToSize, sizeToDiameter, ukLabel, type SizeSystem } from '@/core/generators/ringSizes'
import {
  detectHeadAngleDeg,
  pointAngleDeg,
  resizeRing,
} from '@/core/geometry/resize'
import { HEAL_PRESETS, type ResizeMode, type ResizeOverlay, type RingFrame, type Vec3 } from '@/core/types'
import { useAppStore } from '@/store/appStore'

function resizeTargetPart(): string | null {
  const store = useAppStore.getState()
  if (store.selectedId) return store.selectedId
  if (store.parts.length === 1) {
    getEngine().select(store.parts[0].id)
    return store.parts[0].id
  }
  store.patchResize({ error: 'Select a ring first (tap it in the viewport or the parts list).' })
  return null
}

function sizeLabelFor(system: SizeSystem, diameter: number): string {
  const size = diameterToSize(system, diameter)
  return system === 'UK' ? `UK ${ukLabel(size)}` : `${system} ${size.toFixed(1)}`
}

function refreshResizeOverlay() {
  const r = useAppStore.getState().resize
  try {
    const eng = getEngine()
    if (!r.frame || r.detected !== true || r.currentDiameter === null) {
      eng.setResizeOverlay(null)
      return
    }
    const overlay: ResizeOverlay = {
      frame: r.frame,
      mode: r.mode,
      protectedCenterDeg: r.protectedCenterDeg,
      protectedDeg: r.protectedDeg,
      smoothingDeg: r.smoothingDeg,
      beforeLabel: `Before · ${sizeLabelFor(r.targetSystem, r.currentDiameter)} · Ø${r.currentDiameter.toFixed(2)}`,
      afterLabel: `After · ${sizeLabelFor(r.targetSystem, r.targetDiameter)} · Ø${r.targetDiameter.toFixed(2)}`,
    }
    eng.setResizeOverlay(overlay)
  } catch { /* ignore */ }
}

function detectResizeFrameFor(id: string): RingFrame | null {
  const mesh = getEngine().getWorldMeshData(id)
  const store = useAppStore.getState()
  const frame = mesh ? analyzeRingFrame(mesh) : null
  if (!mesh || !frame) {
    store.patchResize({
      detected: 'none', frame: null, currentDiameter: null, sourcePartId: id, error: null,
    })
    try { getEngine().setResizeOverlay(null) } catch { /* ignore */ }
    return null
  }
  const centerDeg = store.resize.autoHead
    ? detectHeadAngleDeg(mesh, frame)
    : store.resize.protectedCenterDeg
  store.patchResize({
    detected: true,
    frame,
    currentDiameter: frame.innerR * 2,
    protectedCenterDeg: centerDeg,
    sourcePartId: id,
    error: null,
  })
  refreshResizeOverlay()
  return frame
}

export function detectResizeFrame() {
  const id = resizeTargetPart()
  if (id) detectResizeFrameFor(id)
}

export function setResizeMode(mode: ResizeMode) {
  useAppStore.getState().patchResize({ mode })
  refreshResizeOverlay()
}

export function setResizeTargetSystem(system: SizeSystem) {
  const r = useAppStore.getState().resize
  useAppStore.getState().patchResize({
    targetSystem: system,
    targetSize: diameterToSize(system, r.targetDiameter),
  })
  refreshResizeOverlay()
}

export function setResizeTargetSize(value: number) {
  if (!Number.isFinite(value)) return
  const r = useAppStore.getState().resize
  const targetDiameter = sizeToDiameter(r.targetSystem, value)
  if (!(Number.isFinite(targetDiameter) && targetDiameter > 0)) return
  useAppStore.getState().patchResize({ targetSize: value, targetDiameter })
  refreshResizeOverlay()
}

export function setResizeTargetDiameter(mm: number) {
  const r = useAppStore.getState().resize
  if (!(Number.isFinite(mm) && mm > 0)) return
  useAppStore.getState().patchResize({
    targetDiameter: mm,
    targetSize: diameterToSize(r.targetSystem, mm),
  })
  refreshResizeOverlay()
}

export function setResizeProtectedCenter(deg: number) {
  useAppStore.getState().patchResize({
    protectedCenterDeg: ((deg % 360) + 360) % 360,
    autoHead: false,
  })
  refreshResizeOverlay()
}

export function setResizeAutoHead(on: boolean) {
  const store = useAppStore.getState()
  store.patchResize({ autoHead: on })
  if (on) {
    const id = store.selectedId ?? (store.parts.length === 1 ? store.parts[0].id : null)
    const mesh = id ? getEngine().getWorldMeshData(id) : null
    if (mesh && store.resize.frame) {
      store.patchResize({ protectedCenterDeg: detectHeadAngleDeg(mesh, store.resize.frame) })
    }
  }
  refreshResizeOverlay()
}

export function setResizeProtectedWidth(deg: number) {
  useAppStore.getState().patchResize({ protectedDeg: Math.min(Math.max(deg, 4), 176) })
  refreshResizeOverlay()
}

export function setResizeSmoothing(deg: number) {
  useAppStore.getState().patchResize({ smoothingDeg: Math.min(Math.max(deg, 0), 120) })
  refreshResizeOverlay()
}

export function setResizeReheal(on: boolean) {
  useAppStore.getState().patchResize({ reheal: on })
}

export function setResizePicking(on: boolean) {
  const store = useAppStore.getState()
  const eng = getEngine()
  setPickConsumer(on ? 'resize' : null)
  try {
    eng.setPickMode(on)
    eng.setGizmoMode(on ? 'none' : store.gizmoMode)
  } catch { /* ignore */ }
  store.patchResize({ picking: on })
}

function handleResizePointPicked(point: Vec3) {
  const frame = useAppStore.getState().resize.frame
  if (!frame) return
  setResizeProtectedCenter(pointAngleDeg(point, frame))
  setResizePicking(false)
}

registerPointPickHandler('resize', handleResizePointPicked)

export async function applyResize(): Promise<void> {
  const id = resizeTargetPart()
  if (!id) return
  const eng = getEngine()
  if (!detectResizeFrameFor(id)) {
    useAppStore.getState().patchResize({ error: 'Auto-detect the ring size first.' })
    return
  }
  const r = useAppStore.getState().resize
  if (!r.frame) return
  const mesh = eng.getWorldMeshData(id)
  if (!mesh) return
  useAppStore.getState().patchResize({ busy: true, error: null })
  try {
    let out = resizeRing(mesh, {
      frame: r.frame,
      mode: r.mode,
      targetInnerDiameter: r.targetDiameter,
      protectedCenterDeg: r.protectedCenterDeg,
      protectedDeg: r.protectedDeg,
      smoothingDeg: r.smoothingDeg,
    })
    if (r.reheal) {
      out = (await getClients().repair.heal(out, { mode: 'safe', ...HEAL_PRESETS.safe })).mesh
    }
    const saved = eng.getPartForSave(id)
    if (saved) {
      const stack = revisions.get(id) ?? []
      stack.push({ data: saved.data, matrix: saved.matrix })
      revisions.set(id, stack)
    }
    replaceWithWorldMesh(id, out)
    const newMesh = eng.getWorldMeshData(id)
    const newFrame = newMesh ? analyzeRingFrame(newMesh) : null
    useAppStore.getState().patchResize({
      busy: false,
      canUndo: true,
      sourcePartId: id,
      frame: newFrame ?? r.frame,
      currentDiameter: newFrame ? newFrame.innerR * 2 : r.currentDiameter,
    })
    refreshResizeOverlay()
  } catch (err) {
    useAppStore.getState().patchResize({ busy: false, error: String(err) })
  }
}

export function undoResize(): void {
  const id = useAppStore.getState().selectedId
  if (!id) return
  const stack = revisions.get(id)
  const prev = stack?.pop()
  if (!prev) return
  const eng = getEngine()
  const name = eng.partInfo(id)?.name ?? 'ring'
  eng.removePart(id)
  eng.addPart(id, name, prev.data, prev.matrix)
  eng.select(id)
  const mesh = eng.getWorldMeshData(id)
  const frame = mesh ? analyzeRingFrame(mesh) : null
  useAppStore.getState().patchResize({
    canUndo: (stack?.length ?? 0) > 0,
    sourcePartId: id,
    frame,
    currentDiameter: frame ? frame.innerR * 2 : null,
    detected: frame ? true : 'none',
  })
  refreshResizeOverlay()
}

export function teardownResize() {
  if (getPickConsumer() === 'resize') setResizePicking(false)
  try { getEngine().setResizeOverlay(null) } catch { /* ignore */ }
}
