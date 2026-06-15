import type { MeshData } from '../types'
import type { ClearanceMsg, FitRequest, FitResponse } from './fit.worker'

export interface ClearanceResult {
  values: Float32Array
  min: number
  max: number
}

export interface FitJob<T> {
  /** Resolves with the result, or null if the job was cancelled. */
  promise: Promise<T | null>
  /** Ask the worker to abort; the promise then resolves null. */
  cancel: () => void
}

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
    { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: FitProgress }
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

  private start<T>(req: FitRequestBody, transfer: Transferable[], onProgress?: FitProgress): FitJob<T> {
    const id = this.nextId++
    // the executor runs synchronously, so rejectJob is set before the try below
    let rejectJob!: (e: Error) => void
    const promise = new Promise<T | null>((resolve, reject) => {
      rejectJob = reject
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress })
    })
    // a synchronous failure (worker spawn / postMessage) must still settle the job,
    // or the caller's busy state hangs forever
    try {
      this.getWorker().postMessage({ ...req, id }, transfer)
    } catch (err) {
      this.pending.delete(id)
      rejectJob(err instanceof Error ? err : new Error(String(err)))
    }
    return { promise, cancel: () => this.worker?.postMessage({ id, op: 'cancel' } satisfies FitRequest) }
  }

  /** Minkowski-style outward offset of the scan by `clearanceMm`. Copies inputs. */
  offset(scan: MeshData, clearanceMm: number, segments: number, onProgress?: FitProgress): FitJob<MeshData> {
    const s = clone(scan)
    return this.start({ op: 'offset', scan: s, clearanceMm, segments }, [s.positions.buffer, s.indices.buffer], onProgress)
  }

  /** Offset the scan, then subtract it from the shell — uniform interior gap. */
  subtract(
    scan: MeshData, shell: MeshData, clearanceMm: number, segments: number, onProgress?: FitProgress,
  ): FitJob<MeshData> {
    const s = clone(scan)
    const h = clone(shell)
    return this.start(
      { op: 'subtract', scan: s, shell: h, clearanceMm, segments },
      [s.positions.buffer, s.indices.buffer, h.positions.buffer, h.indices.buffer],
      onProgress,
    )
  }

  /** Signed gap from each shell vertex to the scan surface (the clearance map). */
  clearance(shell: MeshData, scan: MeshData, onProgress?: FitProgress): FitJob<ClearanceResult> {
    const h = clone(shell)
    const s = clone(scan)
    return this.start<ClearanceMsg>(
      { op: 'clearance', shell: h, scan: s },
      [h.positions.buffer, h.indices.buffer, s.positions.buffer, s.indices.buffer],
      onProgress,
    ) as FitJob<ClearanceResult>
  }
}

function clone(mesh: MeshData): MeshData {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() }
}

export const fitClient = new FitClient()
