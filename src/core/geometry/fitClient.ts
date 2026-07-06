import type { MarginCurve, MeshData, Vec3 } from '../types'
import type { BestAxisMsg, ClearanceMsg, FitRequest, FitResponse, ShellMsg, SurveyMsg, WandMsg } from './fit.worker'

export interface ClearanceResult {
  values: Float32Array
  min: number
  max: number
}

export interface SurveyResult {
  values: Float32Array
  area: number
}

export interface BestAxisResult {
  axis: Vec3
}

export interface WandSelectionResult {
  faces: Uint32Array
  vertices: Uint32Array
  curves: MarginCurve[]
}

export interface ShellResult {
  mesh: MeshData
  toothVolumes: number[]
}

export interface FitJob<T> {
  /** Resolves with the result, or null if the job was cancelled. */
  promise: Promise<T | null>
  /**
   * Ask the worker to abort; the promise then resolves null. The Manifold stages
   * are synchronous WASM the worker can't interrupt, so if the job doesn't settle
   * shortly the worker is terminated and respawned — cancel always lands.
   */
  cancel: () => void
}

/** How long a cancel may go unacknowledged before the worker is torn down (ms). */
const HARD_CANCEL_MS = 2000

/** Progress callback: a 0..1 fraction plus a human stage label. */
export type FitProgress = (progress: number, stage: string) => void

/** Distributive Omit so each request variant keeps its own fields (sans id). */
type FitRequestBody = FitRequest extends infer R ? (R extends FitRequest ? Omit<R, 'id'> : never) : never

/**
 * Promise facade over the fit worker, parallel to thicknessClient: one shared
 * worker, requests matched by id, streamed progress + cancel. The Manifold ops
 * (offset/subtract) report staged progress; clearance streams real progress.
 */
class FitClient {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      onProgress?: FitProgress
      /** Retained request so a job queued behind a hard-cancelled one can be replayed. */
      req: FitRequest
    }
  >()

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./fit.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev: MessageEvent<FitResponse>) => {
        const res = ev.data
        const entry = this.pending.get(res.id)
        if (!entry) return
        if (res.type === 'progress') {
          entry.onProgress?.(res.progress, res.stage)
          return
        }
        this.pending.delete(res.id)
        if (!res.ok) entry.reject(new Error(res.error))
        else if ('cancelled' in res) entry.resolve(null)
        else entry.resolve(res.result)
      }
    }
    return this.worker
  }

  private start<T>(req: FitRequestBody, onProgress?: FitProgress): FitJob<T> {
    const id = this.nextId++
    const idReq = { ...req, id } as FitRequest
    // the executor runs synchronously, so rejectJob is set before the try below
    let rejectJob!: (e: Error) => void
    const promise = new Promise<T | null>((resolve, reject) => {
      rejectJob = reject
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress, req: idReq })
    })
    // a synchronous failure (worker spawn / postMessage) must still settle the job,
    // or the caller's busy state hangs forever. The request is structured-cloned
    // (not transferred) so it can be replayed if the worker gets torn down.
    try {
      this.getWorker().postMessage(idReq)
    } catch (err) {
      this.pending.delete(id)
      rejectJob(err instanceof Error ? err : new Error(String(err)))
    }
    return {
      promise,
      cancel: () => {
        if (!this.pending.has(id)) return
        this.worker?.postMessage({ id, op: 'cancel' } satisfies FitRequest)
        // a job stuck inside a synchronous Manifold stage never sees the cancel
        // message — give it a moment, then tear the worker down so the cancel
        // (and anything queued behind the stuck job) doesn't hang forever
        setTimeout(() => {
          if (this.pending.has(id)) this.hardCancel(id)
        }, HARD_CANCEL_MS)
      },
    }
  }

  /**
   * Kill the worker: the cancelled job resolves null and every other in-flight
   * request is replayed onto a fresh worker (their retained copies were never
   * transferred), so a job superseding a stuck one still runs.
   */
  private hardCancel(cancelledId: number): void {
    this.worker?.terminate()
    this.worker = null
    const entry = this.pending.get(cancelledId)
    this.pending.delete(cancelledId)
    entry?.resolve(null)
    for (const survivor of this.pending.values()) this.getWorker().postMessage(survivor.req)
  }

  /** Minkowski-style outward offset of the scan by `clearanceMm`. Copies inputs. */
  offset(scan: MeshData, clearanceMm: number, segments: number, onProgress?: FitProgress): FitJob<MeshData> {
    return this.start({ op: 'offset', scan: clone(scan), clearanceMm, segments }, onProgress)
  }

  /** Offset the scan, then subtract it from the shell — uniform interior gap. */
  subtract(
    scan: MeshData, shell: MeshData, clearanceMm: number, segments: number, onProgress?: FitProgress,
  ): FitJob<MeshData> {
    return this.start({ op: 'subtract', scan: clone(scan), shell: clone(shell), clearanceMm, segments }, onProgress)
  }

  /** Signed gap from each shell vertex to the scan surface (the clearance map). */
  clearance(shell: MeshData, scan: MeshData, onProgress?: FitProgress): FitJob<ClearanceResult> {
    return this.start<ClearanceMsg>(
      { op: 'clearance', shell: clone(shell), scan: clone(scan) },
      onProgress,
    ) as FitJob<ClearanceResult>
  }

  /** Per-scan-vertex undercut value along an insertion axis (the survey). */
  survey(scan: MeshData, axis: Vec3, onProgress?: FitProgress): FitJob<SurveyResult> {
    return this.start<SurveyMsg>({ op: 'survey', scan: clone(scan), axis }, onProgress) as FitJob<SurveyResult>
  }

  /** Magic-wand tooth pick: region-grow from a clicked point up to the creases. */
  wand(
    scan: MeshData, seedPoint: Vec3, axis: Vec3, thresholdRad: number, onProgress?: FitProgress,
  ): FitJob<WandSelectionResult> {
    return this.start<WandMsg>(
      { op: 'wand', scan: clone(scan), seedPoint, axis, thresholdRad },
      onProgress,
    ) as FitJob<WandSelectionResult>
  }

  /** Search the insertion axis minimising undercut area (around a seed axis). */
  bestAxis(scan: MeshData, seedAxis: Vec3, onProgress?: FitProgress): FitJob<BestAxisResult> {
    return this.start<BestAxisMsg>({ op: 'bestAxis', scan: clone(scan), seedAxis }, onProgress) as FitJob<BestAxisResult>
  }

  /** Fill the scan's undercuts along the axis → a draftable scan (retention lip optional). */
  blockout(
    scan: MeshData, axis: Vec3, retentionMm: number, segments: number, onProgress?: FitProgress,
  ): FitJob<MeshData> {
    return this.start({ op: 'blockout', scan: clone(scan), axis, retentionMm, segments }, onProgress)
  }

  /**
   * Uniform-thickness shell following the offset surface (a new part). Clips to a
   * brushed `selectedIndices` region when given; opens the gingival margin when set.
   */
  shell(
    scan: MeshData, selectedIndices: Uint32Array | null, axis: Vec3,
    clearanceMm: number, thicknessMm: number, openGingival: boolean, segments: number,
    onProgress?: FitProgress,
  ): FitJob<ShellResult> {
    return this.start<ShellMsg>(
      {
        op: 'shell', scan: clone(scan), selectedIndices: selectedIndices ? selectedIndices.slice() : null,
        axis, clearanceMm, thicknessMm, openGingival, segments,
      },
      onProgress,
    ) as FitJob<ShellResult>
  }
}

/**
 * Defensive copy: the request is retained for a possible hard-cancel replay, so
 * it must not alias buffers the caller (or the engine) may mutate later.
 */
function clone(mesh: MeshData): MeshData {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() }
}

export const fitClient = new FitClient()
