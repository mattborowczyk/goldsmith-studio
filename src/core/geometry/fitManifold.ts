import Module from 'manifold-3d'
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import type { MeshData } from '../types'
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
