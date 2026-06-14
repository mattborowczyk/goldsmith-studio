/// <reference lib="webworker" />
import type { MeshData } from '../types'
import { computeThickness, type ThicknessField } from './thickness'

/**
 * Wall-thickness worker. Mirrors repair.worker's id-matched request/response
 * shape but adds two extras the heavy heatmap needs: streamed `progress`
 * messages and a `cancel` op. The compute loop yields between chunks so a
 * queued cancel message is actually delivered mid-run (see thickness.ts).
 */

export type ThicknessRequest =
  | { id: number; op: 'thickness'; mesh: MeshData }
  | { id: number; op: 'cancel' }

export type ThicknessResponse =
  | { id: number; type: 'progress'; progress: number }
  | { id: number; type: 'done'; ok: true; result: ThicknessFieldMsg }
  | { id: number; type: 'done'; ok: true; cancelled: true }
  | { id: number; type: 'done'; ok: false; error: string }

/** Wire form of ThicknessField (the buffer is transferred, not copied). */
export interface ThicknessFieldMsg {
  values: Float32Array
  min: number
  max: number
}

const cancelled = new Set<number>()

self.onmessage = async (ev: MessageEvent<ThicknessRequest>) => {
  const req = ev.data
  if (req.op === 'cancel') {
    cancelled.add(req.id)
    return
  }
  try {
    const field: ThicknessField | null = await computeThickness(req.mesh, {
      onProgress: (progress) =>
        self.postMessage({ id: req.id, type: 'progress', progress } satisfies ThicknessResponse),
      shouldCancel: () => cancelled.has(req.id),
    })
    if (!field) {
      cancelled.delete(req.id)
      self.postMessage({ id: req.id, type: 'done', ok: true, cancelled: true } satisfies ThicknessResponse)
      return
    }
    const msg: ThicknessResponse = {
      id: req.id,
      type: 'done',
      ok: true,
      result: { values: field.values, min: field.min, max: field.max },
    }
    cancelled.delete(req.id) // clear any late cancel that raced the result
    self.postMessage(msg, { transfer: [field.values.buffer] })
  } catch (err) {
    cancelled.delete(req.id)
    self.postMessage({ id: req.id, type: 'done', ok: false, error: String(err) } satisfies ThicknessResponse)
  }
}
