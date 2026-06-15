/// <reference lib="webworker" />
import type { MeshData } from '../types'
import { computeClearance } from './fit'
import { offsetMesh, subtractMesh } from './fitManifold'

/**
 * Grillz fit worker (plan §3.1). Three heavy ops behind one id-matched facade,
 * mirroring thickness.worker's streamed `progress` + `cancel`:
 *
 *  - `offset`    Minkowski-style outward offset of the tooth scan by the cement
 *                gap → the offset scan to sculpt over.
 *  - `subtract`  offset, then boolean-subtract it from the sculpted shell → an
 *                interior with uniform clearance, in one job.
 *  - `clearance` per-shell-vertex signed gap to the scan → the clearance map.
 *
 * Manifold's Minkowski/boolean are synchronous WASM, so we can't interrupt them
 * mid-call from this single thread; instead the kernel half (fitManifold.ts)
 * emits *staged* progress and checks a cancel flag between stages. The clearance
 * op is a JS loop, so it streams real progress and observes cancel mid-run.
 */

export type FitRequest =
  | { id: number; op: 'offset'; scan: MeshData; clearanceMm: number; segments: number }
  | { id: number; op: 'subtract'; scan: MeshData; shell: MeshData; clearanceMm: number; segments: number }
  | { id: number; op: 'clearance'; shell: MeshData; scan: MeshData }
  | { id: number; op: 'cancel' }

export interface ClearanceMsg {
  values: Float32Array
  min: number
  max: number
}

export type FitResponse =
  | { id: number; type: 'progress'; progress: number; stage: string }
  | { id: number; type: 'done'; ok: true; result: MeshData | ClearanceMsg }
  | { id: number; type: 'done'; ok: true; cancelled: true }
  | { id: number; type: 'done'; ok: false; error: string }

const cancelled = new Set<number>()

self.onmessage = async (ev: MessageEvent<FitRequest>) => {
  const req = ev.data
  if (req.op === 'cancel') {
    cancelled.add(req.id)
    return
  }
  try {
    switch (req.op) {
      case 'offset': {
        const mesh = await offsetMesh(req.scan, req.clearanceMm, req.segments, hooks(req.id))
        if (!mesh) postCancelled(req.id)
        else postMesh(req.id, mesh)
        break
      }
      case 'subtract': {
        const mesh = await subtractMesh(req.scan, req.shell, req.clearanceMm, req.segments, hooks(req.id))
        if (!mesh) postCancelled(req.id)
        else postMesh(req.id, mesh)
        break
      }
      case 'clearance': {
        const field = await computeClearance(req.shell, req.scan, {
          onProgress: (p) => progress(req.id, p, 'Measuring clearance'),
          shouldCancel: () => cancelled.has(req.id),
        })
        if (!field) postCancelled(req.id)
        else {
          cancelled.delete(req.id)
          self.postMessage(
            { id: req.id, type: 'done', ok: true, result: field } satisfies FitResponse,
            { transfer: [field.values.buffer] },
          )
        }
        break
      }
    }
  } catch (err) {
    cancelled.delete(req.id)
    self.postMessage({ id: req.id, type: 'done', ok: false, error: String(err) } satisfies FitResponse)
  }
}

function hooks(id: number) {
  return {
    onStage: (p: number, stage: string) => progress(id, p, stage),
    shouldCancel: () => cancelled.has(id),
  }
}

function progress(id: number, p: number, stage: string) {
  self.postMessage({ id, type: 'progress', progress: p, stage } satisfies FitResponse)
}

function postCancelled(id: number) {
  cancelled.delete(id)
  self.postMessage({ id, type: 'done', ok: true, cancelled: true } satisfies FitResponse)
}

function postMesh(id: number, mesh: MeshData) {
  cancelled.delete(id)
  self.postMessage(
    { id, type: 'done', ok: true, result: mesh } satisfies FitResponse,
    { transfer: [mesh.positions.buffer, mesh.indices.buffer] },
  )
}
