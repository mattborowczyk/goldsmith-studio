import type { MeshData } from '../types'
import type { ThicknessFieldMsg, ThicknessResponse } from './thickness.worker'

export interface ThicknessResult {
  values: Float32Array
  min: number
  max: number
}

export interface ThicknessJob {
  /** Resolves with the field, or null if the job was cancelled. */
  promise: Promise<ThicknessResult | null>
  /** Ask the worker to abort; the promise then resolves null. */
  cancel: () => void
}

/**
 * Promise facade over the thickness worker, parallel to repairClient but with
 * progress streaming + cancel. One shared worker; requests matched by id.
 */
class ThicknessClient {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: ThicknessResult | null) => void; reject: (e: Error) => void; onProgress?: (p: number) => void }
  >()

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./thickness.worker.ts', import.meta.url), {
        type: 'module',
      })
      this.worker.onmessage = (ev: MessageEvent<ThicknessResponse>) => {
        const res = ev.data
        const entry = this.pending.get(res.id)
        if (!entry) return
        if (res.type === 'progress') {
          entry.onProgress?.(res.progress)
          return
        }
        this.pending.delete(res.id)
        if (!res.ok) {
          entry.reject(new Error(res.error))
        } else if ('cancelled' in res) {
          entry.resolve(null)
        } else {
          const field = res.result as ThicknessFieldMsg
          entry.resolve({ values: field.values, min: field.min, max: field.max })
        }
      }
    }
    return this.worker
  }

  /** Note: copies the mesh so the caller's buffers stay usable. */
  compute(mesh: MeshData, onProgress?: (p: number) => void): ThicknessJob {
    const id = this.nextId++
    const copy: MeshData = { positions: mesh.positions.slice(), indices: mesh.indices.slice() }
    const promise = new Promise<ThicknessResult | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
    })
    this.getWorker().postMessage({ id, op: 'thickness', mesh: copy }, [
      copy.positions.buffer,
      copy.indices.buffer,
    ])
    return {
      promise,
      cancel: () => this.worker?.postMessage({ id, op: 'cancel' }),
    }
  }
}

export const thicknessClient = new ThicknessClient()
