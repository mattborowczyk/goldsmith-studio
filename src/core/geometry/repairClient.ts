import type { AnalysisReport, HealOptions, MeshData } from '../types'
import type { BaseCapOptions, RimSummary } from './baseCap'
import type { WorkerRequest, WorkerResponse } from './repair.worker'

export interface HealOutcome {
  mesh: MeshData
  before: AnalysisReport
  after: AnalysisReport
  unioned: boolean
}

/**
 * Promise-based facade over the geometry worker. One shared worker instance;
 * requests are matched to responses by id.
 */
class RepairClient {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./repair.worker.ts', import.meta.url), {
        type: 'module',
      })
      this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const res = ev.data
        const entry = this.pending.get(res.id)
        if (!entry) return
        this.pending.delete(res.id)
        if (res.ok) entry.resolve(res.result)
        else entry.reject(new Error(res.error))
      }
    }
    return this.worker
  }

  private call<T>(
    req: WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.getWorker().postMessage({ ...req, id }, transfer)
    })
  }

  /** Note: copies the mesh so the caller's buffers stay usable. */
  analyze(mesh: MeshData): Promise<AnalysisReport> {
    const copy = cloneMesh(mesh)
    return this.call({ op: 'analyze', mesh: copy }, [copy.positions.buffer, copy.indices.buffer])
  }

  heal(mesh: MeshData, options: HealOptions): Promise<HealOutcome> {
    const copy = cloneMesh(mesh)
    return this.call({ op: 'heal', mesh: copy, options }, [copy.positions.buffer, copy.indices.buffer])
  }

  split(mesh: MeshData): Promise<MeshData[]> {
    const copy = cloneMesh(mesh)
    return this.call({ op: 'split', mesh: copy }, [copy.positions.buffer, copy.indices.buffer])
  }

  /** Largest open rim + bounds, or null when the mesh has no loop to cap. */
  baseCapInfo(mesh: MeshData): Promise<RimSummary | null> {
    const copy = cloneMesh(mesh)
    return this.call({ op: 'baseCapInfo', mesh: copy }, [copy.positions.buffer, copy.indices.buffer])
  }

  /** Close the largest open loop with a planar base cap (issue #26). */
  baseCap(mesh: MeshData, options: BaseCapOptions): Promise<HealOutcome> {
    const copy = cloneMesh(mesh)
    return this.call({ op: 'baseCap', mesh: copy, options }, [copy.positions.buffer, copy.indices.buffer])
  }
}

function cloneMesh(mesh: MeshData): MeshData {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() }
}

export const repairClient = new RepairClient()
