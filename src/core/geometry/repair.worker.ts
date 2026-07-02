/// <reference lib="webworker" />
import Module from 'manifold-3d'
import type { ManifoldToplevel } from 'manifold-3d'
import type { AnalysisReport, HealOptions, MeshData } from '../types'
import { closeOpenBase, summarizeOpenRim, type BaseCapOptions, type RimSummary } from './baseCap'
import { analyzeMesh } from './meshAnalysis'
import {
  fillHoles,
  filterSmallShells,
  fixWinding,
  removeDegenerateTriangles,
  splitShells,
  weldVertices,
} from './meshRepair'

let manifoldModule: ManifoldToplevel | null = null
async function getManifold(): Promise<ManifoldToplevel> {
  if (!manifoldModule) {
    manifoldModule = await Module()
    manifoldModule.setup()
  }
  return manifoldModule
}

export type WorkerRequest =
  | { id: number; op: 'analyze'; mesh: MeshData }
  | { id: number; op: 'heal'; mesh: MeshData; options: HealOptions }
  | { id: number; op: 'split'; mesh: MeshData }
  | { id: number; op: 'baseCapInfo'; mesh: MeshData }
  | { id: number; op: 'baseCap'; mesh: MeshData; options: BaseCapOptions }

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

/**
 * Boolean-union all shells through Manifold so overlapping shells become one
 * watertight solid. Throws if the input is not manifold — caller falls back.
 */
async function unionShells(mesh: MeshData): Promise<MeshData> {
  const wasm = await getManifold()
  const { Manifold, Mesh } = wasm
  const m = new Mesh({
    numProp: 3,
    vertProperties: mesh.positions,
    triVerts: mesh.indices,
  })
  m.merge()
  const solid = new Manifold(m)
  try {
    const parts = solid.decompose()
    const result = parts.length <= 1 ? solid : parts.reduce((acc, p) => acc.add(p))
    const out = result.getMesh()
    return {
      positions: new Float32Array(out.vertProperties),
      indices: new Uint32Array(out.triVerts),
    }
  } finally {
    solid.delete()
  }
}

async function heal(mesh: MeshData, options: HealOptions): Promise<{ mesh: MeshData; before: AnalysisReport; after: AnalysisReport; unioned: boolean }> {
  const before = analyzeMesh(mesh)
  let m = weldVertices(mesh, options.tolerance)
  m = removeDegenerateTriangles(m)
  m = fixWinding(m)
  if (options.fillHolesUpTo > 0) m = fillHoles(m, options.fillHolesUpTo)
  if (options.minShellVolume > 0) m = filterSmallShells(m, options.minShellVolume)

  let unioned = false
  try {
    m = await unionShells(m)
    unioned = true
  } catch {
    // not manifold even after repair — keep the TS-repaired mesh
  }
  const after = analyzeMesh(m)
  return { mesh: m, before, after, unioned }
}

/**
 * Close the largest open boundary loop with a planar base cap (issue #26),
 * then attempt the same Manifold union pass heal uses — on success it both
 * validates the capped solid and merges any overlapping shells.
 */
async function baseCap(mesh: MeshData, options: BaseCapOptions): Promise<{ mesh: MeshData; before: AnalysisReport; after: AnalysisReport; unioned: boolean }> {
  const before = analyzeMesh(mesh)
  let m = closeOpenBase(mesh, options)
  let unioned = false
  try {
    m = await unionShells(m)
    unioned = true
  } catch {
    // not manifold (e.g. other holes remain) — keep the TS-capped mesh
  }
  const after = analyzeMesh(m)
  return { mesh: m, before, after, unioned }
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data
  try {
    switch (req.op) {
      case 'analyze': {
        const report = analyzeMesh(req.mesh)
        postResult(req.id, report, [
          report.boundaryEdgePositions.buffer,
          report.flippedFacePositions.buffer,
        ])
        break
      }
      case 'heal': {
        const result = await heal(req.mesh, req.options)
        postResult(req.id, result, [
          result.mesh.positions.buffer,
          result.mesh.indices.buffer,
          result.before.boundaryEdgePositions.buffer,
          result.before.flippedFacePositions.buffer,
          result.after.boundaryEdgePositions.buffer,
          result.after.flippedFacePositions.buffer,
        ])
        break
      }
      case 'split': {
        const parts = splitShells(req.mesh)
        postResult(
          req.id,
          parts,
          parts.flatMap((p) => [p.positions.buffer, p.indices.buffer]),
        )
        break
      }
      case 'baseCapInfo': {
        const summary: RimSummary | null = summarizeOpenRim(req.mesh)
        postResult(req.id, summary, [])
        break
      }
      case 'baseCap': {
        const result = await baseCap(req.mesh, req.options)
        postResult(req.id, result, [
          result.mesh.positions.buffer,
          result.mesh.indices.buffer,
          result.before.boundaryEdgePositions.buffer,
          result.before.flippedFacePositions.buffer,
          result.after.boundaryEdgePositions.buffer,
          result.after.flippedFacePositions.buffer,
        ])
        break
      }
    }
  } catch (err) {
    const msg: WorkerResponse = { id: req.id, ok: false, error: String(err) }
    self.postMessage(msg)
  }
}

function postResult(id: number, result: unknown, transfer: Transferable[]) {
  const msg: WorkerResponse = { id, ok: true, result }
  self.postMessage(msg, { transfer })
}
