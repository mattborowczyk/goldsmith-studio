import Module from 'manifold-3d'
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d'
import type { MeshData, Vec3 } from '../types'
import { fillHoles, fixWinding, removeDegenerateTriangles, weldVertices } from './meshRepair'

/**
 * Manifold-kernel half of the grillz fit pipeline (plan §3.1): the Minkowski-
 * style cement-gap offset and the boolean subtract. Kept free of any worker
 * (`self`) / DOM references so it's unit-testable in node — the worker
 * (fit.worker.ts) is just plumbing around these, exactly as repair.worker
 * delegates to meshRepair/meshAnalysis.
 */

let manifoldModule: ManifoldToplevel | null = null
let manifoldModulePromise: Promise<ManifoldToplevel> | null = null
async function getManifold(): Promise<ManifoldToplevel> {
  if (manifoldModule) return manifoldModule
  // cache the in-flight init so two concurrent first-use jobs share one Module()
  if (!manifoldModulePromise) {
    manifoldModulePromise = Module()
      .then((module) => {
        module.setup()
        manifoldModule = module
        return module
      })
      .catch((err) => {
        manifoldModulePromise = null // let a later call retry after a failed init
        throw err
      })
  }
  return manifoldModulePromise
}

/** Coarse stage hooks so the worker can stream progress + observe cancel between stages. */
export interface ManifoldHooks {
  onStage?: (progress: number, stage: string) => void
  /** Polled between stages; true aborts and resolves null. */
  shouldCancel?: () => boolean
}

/**
 * Report a stage, then yield a macrotask so a cancel message queued on the worker
 * (which can't interrupt the synchronous WASM stages) gets a turn to update
 * shouldCancel. Returns true when the op should abort. Mirrors thickness.ts.
 */
async function checkpoint(hooks: ManifoldHooks, progress: number, stage: string): Promise<boolean> {
  hooks.onStage?.(progress, stage)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return hooks.shouldCancel?.() ?? false
}

/**
 * Minkowski-style outward offset: scan ⊕ sphere(clearance). The scan is healed to
 * a watertight 2-manifold first; throws if it can't be. Returns null if cancelled
 * between stages.
 */
export async function offsetMesh(
  scan: MeshData, clearanceMm: number, segments: number, hooks: ManifoldHooks = {},
): Promise<MeshData | null> {
  const wasm = await getManifold()
  if (await checkpoint(hooks, 0.15, 'Healing scan')) return null
  const scanMan = toManifold(wasm, scan)
  const ball = wasm.Manifold.sphere(clearanceMm, segments)
  let offset: Manifold | null = null
  try {
    if (await checkpoint(hooks, 0.45, 'Offsetting')) return null
    offset = scanMan.minkowskiSum(ball)
    if (await checkpoint(hooks, 0.95, 'Building surface')) return null
    return meshOf(offset)
  } finally {
    scanMan.delete()
    ball.delete()
    offset?.delete()
  }
}

/**
 * Offset the scan, then boolean-subtract it from the shell → an interior with
 * uniform clearance. Both meshes are heal-guarded. Returns null if cancelled.
 */
export async function subtractMesh(
  scan: MeshData, shell: MeshData, clearanceMm: number, segments: number, hooks: ManifoldHooks = {},
): Promise<MeshData | null> {
  const wasm = await getManifold()
  if (await checkpoint(hooks, 0.1, 'Healing scan')) return null
  const scanMan = toManifold(wasm, scan)
  const ball = wasm.Manifold.sphere(clearanceMm, segments)
  let offset: Manifold | null = null
  let shellMan: Manifold | null = null
  let result: Manifold | null = null
  try {
    if (await checkpoint(hooks, 0.35, 'Offsetting')) return null
    offset = scanMan.minkowskiSum(ball)
    if (await checkpoint(hooks, 0.55, 'Healing shell')) return null
    shellMan = toManifold(wasm, shell)
    if (await checkpoint(hooks, 0.8, 'Subtracting')) return null
    result = shellMan.subtract(offset)
    if (await checkpoint(hooks, 0.95, 'Building surface')) return null
    return meshOf(result)
  } finally {
    scanMan.delete()
    ball.delete()
    offset?.delete()
    shellMan?.delete()
    result?.delete()
  }
}

/**
 * Auto-blockout (plan §3.2): fill the scan's undercuts along the insertion axis
 * so the result seats cleanly along that path. We sweep the healed scan one full
 * axial extent down the −axis (minkowskiSum with a thin needle box) — filling
 * every void directly beneath an overhang, which is the geometric definition of
 * an undercut — and union the sweep back onto the scan. With `retentionMm > 0`
 * the *added* fill is eroded by that much (minkowskiDifference), leaving a thin
 * lip of original undercut for snap-fit grip while the original surface is left
 * untouched. Heal-guarded; returns null if cancelled between stages.
 */
export async function blockoutMesh(
  scan: MeshData, axis: Vec3, retentionMm: number, segments: number, hooks: ManifoldHooks = {},
): Promise<MeshData | null> {
  const wasm = await getManifold()
  if (await checkpoint(hooks, 0.1, 'Healing scan')) return null
  const scanMan = toManifold(wasm, scan)
  const box = sweepBox(wasm, scan, axis)
  let swept: Manifold | null = null
  let fillOnly: Manifold | null = null
  let ball: Manifold | null = null
  let fillEroded: Manifold | null = null
  let result: Manifold | null = null
  try {
    if (await checkpoint(hooks, 0.4, 'Sweeping undercuts')) return null
    swept = scanMan.minkowskiSum(box)
    if (retentionMm > 0) {
      if (await checkpoint(hooks, 0.6, 'Applying retention')) return null
      fillOnly = swept.subtract(scanMan) // just the material the sweep adds
      ball = wasm.Manifold.sphere(retentionMm, segments)
      fillEroded = fillOnly.minkowskiDifference(ball) // shrink it → leave a retention lip
      if (await checkpoint(hooks, 0.85, 'Building surface')) return null
      result = scanMan.add(fillEroded)
    } else {
      if (await checkpoint(hooks, 0.85, 'Building surface')) return null
      result = scanMan.add(swept)
    }
    return meshOf(result)
  } finally {
    scanMan.delete()
    box.delete()
    swept?.delete()
    fillOnly?.delete()
    ball?.delete()
    fillEroded?.delete()
    result?.delete()
  }
}

/** Frac of the axial extent used for the needle box's lateral thickness (tiny — a near-segment). */
const SWEEP_THICKNESS_FRAC = 1e-3

/**
 * A thin needle box spanning the origin to −extent·axis: minkowski-summing it
 * with the scan sweeps the solid that far down the insertion axis. Built from a
 * centred cube, shifted to local z ∈ [−L, 0], then oriented so local +z = axis.
 */
function sweepBox(wasm: ManifoldToplevel, scan: MeshData, axis: Vec3): Manifold {
  const [ax, ay, az] = unit(axis)
  let lo = Infinity, hi = -Infinity
  const p = scan.positions
  for (let i = 0; i < p.length; i += 3) {
    const d = p[i] * ax + p[i + 1] * ay + p[i + 2] * az
    if (d < lo) lo = d
    if (d > hi) hi = d
  }
  const L = Math.max(hi - lo, 1e-3)
  const thick = Math.max(L * SWEEP_THICKNESS_FRAC, 1e-4)
  const [u, v] = basis([ax, ay, az])
  // column-major Mat4 (last row ignored): local +x→u, +y→v, +z→axis, no translation
  const m: Mat4 = [
    u[0], u[1], u[2], 0,
    v[0], v[1], v[2], 0,
    ax, ay, az, 0,
    0, 0, 0, 1,
  ]
  return wasm.Manifold.cube([thick, thick, L], true).translate(0, 0, -L / 2).transform(m)
}

function unit(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 1, 0]
}

/** Two unit vectors orthogonal to `axis` (and to each other). */
function basis(axis: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let ux = ref[1] * axis[2] - ref[2] * axis[1]
  let uy = ref[2] * axis[0] - ref[0] * axis[2]
  let uz = ref[0] * axis[1] - ref[1] * axis[0]
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul; uy /= ul; uz /= ul
  return [[ux, uy, uz], [axis[1] * uz - axis[2] * uy, axis[2] * ux - axis[0] * uz, axis[0] * uy - axis[1] * ux]]
}

/** MeshData out of a Manifold result (copied off the WASM heap). */
function meshOf(m: Manifold): MeshData {
  const out = m.getMesh()
  return {
    positions: new Float32Array(out.vertProperties),
    indices: new Uint32Array(out.triVerts),
  }
}

/**
 * Mesh → Manifold for the boolean/Minkowski. Tries the raw input first; if it
 * isn't an oriented 2-manifold, runs the repair.worker heal path (weld →
 * de-degenerate → fix winding → fill small holes) and retries. Still throws if
 * the heal can't make it watertight — the caller surfaces an actionable error.
 */
function toManifold(wasm: ManifoldToplevel, mesh: MeshData): Manifold {
  try {
    return rawManifold(wasm, mesh)
  } catch {
    let h = weldVertices(mesh, 1e-4)
    h = removeDegenerateTriangles(h)
    h = fixWinding(h)
    h = fillHoles(h, 64)
    return rawManifold(wasm, h)
  }
}

function rawManifold(wasm: ManifoldToplevel, mesh: MeshData): Manifold {
  const m = new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices })
  m.merge()
  return new wasm.Manifold(m) // throws if the result is not an oriented 2-manifold
}
