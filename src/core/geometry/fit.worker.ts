/// <reference lib="webworker" />
import type { MeshData, Vec3 } from '../types'
import { computeClearance } from './fit'
import { blockoutMesh, offsetMesh, shellMesh, subtractMesh } from './fitManifold'
import { findBestAxis, surveyUndercut } from './undercut'

/**
 * Grillz fit worker (plan §3.1 + §3.2). Heavy ops behind one id-matched facade,
 * mirroring thickness.worker's streamed `progress` + `cancel`:
 *
 *  - `offset`    Minkowski-style outward offset of the tooth scan by the cement
 *                gap → the offset scan to sculpt over.
 *  - `subtract`  offset, then boolean-subtract it from the sculpted shell → an
 *                interior with uniform clearance, in one job.
 *  - `clearance` per-shell-vertex signed gap to the scan → the clearance map.
 *  - `survey`    per-scan-vertex undercut value along an insertion axis.
 *  - `bestAxis`  search the insertion axis minimising undercut area.
 *  - `blockout`  fill the undercuts → a draftable scan (a new part).
 *  - `shell`     uniform-thickness shell following the offset surface (a new part),
 *                optionally clipped to a brushed region, with per-tooth volumes.
 *
 * Manifold's Minkowski/boolean are synchronous WASM, so we can't interrupt them
 * mid-call from this single thread; instead the kernel half (fitManifold.ts)
 * emits *staged* progress and checks a cancel flag between stages. The JS-loop
 * ops (clearance, survey, bestAxis) stream real progress and observe cancel mid-run.
 */

export type FitRequest =
  | { id: number; op: 'offset'; scan: MeshData; clearanceMm: number; segments: number }
  | { id: number; op: 'subtract'; scan: MeshData; shell: MeshData; clearanceMm: number; segments: number }
  | { id: number; op: 'clearance'; shell: MeshData; scan: MeshData }
  | { id: number; op: 'survey'; scan: MeshData; axis: Vec3 }
  | { id: number; op: 'bestAxis'; scan: MeshData; seedAxis: Vec3 }
  | { id: number; op: 'blockout'; scan: MeshData; axis: Vec3; retentionMm: number; segments: number }
  | {
      id: number; op: 'shell'; scan: MeshData; selectedIndices: Uint32Array | null; axis: Vec3
      clearanceMm: number; thicknessMm: number; openGingival: boolean; segments: number
    }
  | { id: number; op: 'cancel' }

export interface ClearanceMsg {
  values: Float32Array
  min: number
  max: number
}

export interface SurveyMsg {
  values: Float32Array
  area: number
}

export interface BestAxisMsg {
  axis: Vec3
}

export interface ShellMsg {
  mesh: MeshData
  /** Per connected-component (≈per-tooth) shell volume, mm³, descending. */
  toothVolumes: number[]
}

export type FitResponse =
  | { id: number; type: 'progress'; progress: number; stage: string }
  | { id: number; type: 'done'; ok: true; result: MeshData | ClearanceMsg | SurveyMsg | BestAxisMsg | ShellMsg }
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
      case 'survey': {
        const field = await surveyUndercut(req.scan, req.axis, {
          onProgress: (p) => progress(req.id, p, 'Surveying undercuts'),
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
      case 'bestAxis': {
        const result = await findBestAxis(req.scan, req.seedAxis, {
          onProgress: (p) => progress(req.id, p, 'Searching axes'),
          shouldCancel: () => cancelled.has(req.id),
        })
        if (!result) postCancelled(req.id)
        else {
          cancelled.delete(req.id)
          self.postMessage({ id: req.id, type: 'done', ok: true, result } satisfies FitResponse)
        }
        break
      }
      case 'blockout': {
        const mesh = await blockoutMesh(req.scan, req.axis, req.retentionMm, req.segments, hooks(req.id))
        if (!mesh) postCancelled(req.id)
        else postMesh(req.id, mesh)
        break
      }
      case 'shell': {
        const result = await shellMesh(
          req.scan, req.selectedIndices, req.axis,
          req.clearanceMm, req.thicknessMm, req.openGingival, req.segments, hooks(req.id),
        )
        if (!result) postCancelled(req.id)
        else {
          cancelled.delete(req.id)
          self.postMessage(
            { id: req.id, type: 'done', ok: true, result } satisfies FitResponse,
            { transfer: [result.mesh.positions.buffer, result.mesh.indices.buffer] },
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
