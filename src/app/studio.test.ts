import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeCube } from '@/core/geometry/testFixtures'
import type { AnalysisReport, MaterialPreset, MeshData, PartInfo } from '@/core/types'
import type {
  BestAxisResult,
  ClearanceResult,
  FitJob,
  ShellResult,
  SurveyResult,
} from '@/core/geometry/fitClient'
import type { ThicknessJob, ThicknessResult } from '@/core/geometry/thicknessClient'
import type { HealOutcome } from '@/core/geometry/repairClient'
import { useAppStore } from '@/store/appStore'
import {
  __studioTestSeams as seams,
  cancelFit,
  cancelThicknessHeatmap,
  computeThicknessHeatmap,
  generateOffsetPart,
  healSelected,
  teardownFit,
  teardownHeatmap,
  teardownResize,
  undoHeal,
  undoResize,
  setResizePicking,
} from '@/app/studio'

/**
 * Controller (src/app/studio.ts) orchestration tests (issue #18). These run the
 * real controller against a fake SceneManager and fake worker-job clients,
 * injected through the module's test seams — no WebGL context, no real workers.
 */

// ---------- deferred job handles ----------

interface Deferred<T> {
  job: FitJob<T>
  resolve: (v: T | null) => void
  reject: (e: Error) => void
}

/** A FitJob/ThicknessJob whose promise the test settles by hand, with a spy cancel. */
function makeJob<T>(): Deferred<T> {
  let resolve!: (v: T | null) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { job: { promise, cancel: vi.fn() }, resolve, reject }
}

/** A fit facade that hands out hand-settled jobs, recording every job per op. */
function fakeFitClient() {
  const jobs = {
    offset: [] as Deferred<MeshData>[],
    subtract: [] as Deferred<MeshData>[],
    clearance: [] as Deferred<ClearanceResult>[],
    survey: [] as Deferred<SurveyResult>[],
    bestAxis: [] as Deferred<BestAxisResult>[],
    blockout: [] as Deferred<MeshData>[],
    shell: [] as Deferred<ShellResult>[],
  }
  const hand = <T>(bucket: Deferred<T>[]): FitJob<T> => {
    const d = makeJob<T>()
    bucket.push(d)
    return d.job
  }
  const client = {
    offset: vi.fn((): FitJob<MeshData> => hand(jobs.offset)),
    subtract: vi.fn((): FitJob<MeshData> => hand(jobs.subtract)),
    clearance: vi.fn((): FitJob<ClearanceResult> => hand(jobs.clearance)),
    survey: vi.fn((): FitJob<SurveyResult> => hand(jobs.survey)),
    bestAxis: vi.fn((): FitJob<BestAxisResult> => hand(jobs.bestAxis)),
    blockout: vi.fn((): FitJob<MeshData> => hand(jobs.blockout)),
    shell: vi.fn((): FitJob<ShellResult> => hand(jobs.shell)),
  }
  return { client, jobs }
}

// ---------- fake SceneManager ----------

interface FakePart {
  id: string
  name: string
  data: MeshData
  matrix: number[]
  material: MaterialPreset | null
  flatShading: boolean
  visible: boolean
  colors: Float32Array | null
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/**
 * Minimal stand-in for SceneManager covering exactly the surface the controller
 * touches in these flows. Parts are backed by a Map so add/remove/list/info stay
 * self-consistent (the undo flows depend on that); the rest are spies, and the
 * `has*` overlay predicates are flags the test flips.
 */
class FakeSceneManager {
  parts = new Map<string, FakePart>()
  order: string[] = []
  selectedId: string | null = null

  // overlay-presence flags, reconciled by handlePartsChanged
  thicknessHeatmap = false
  clearanceMap = false
  undercutSurvey = false
  brushSelect = false
  /** What setClearanceMap reports it painted. */
  clearancePainted = true

  // spies the tests assert on
  fitToView = vi.fn()
  select = vi.fn((id: string | null) => {
    this.selectedId = id
  })
  clearHighlights = vi.fn()
  clearThicknessHeatmap = vi.fn()
  clearClearanceMap = vi.fn()
  clearUndercutSurvey = vi.fn()
  hideInsertionAxis = vi.fn()
  setBrushSelect = vi.fn()
  setGizmoMode = vi.fn()
  setPickMode = vi.fn()
  setResizeOverlay = vi.fn()
  setThicknessHeatmap = vi.fn()
  setHeatmapThreshold = vi.fn()
  on = vi.fn(() => () => {})

  hasThicknessHeatmap() {
    return this.thicknessHeatmap
  }
  hasClearanceMap() {
    return this.clearanceMap
  }
  hasUndercutSurvey() {
    return this.undercutSurvey
  }
  hasBrushSelect() {
    return this.brushSelect
  }

  setClearanceMap = vi.fn(() => this.clearancePainted)

  addPart(
    id: string,
    name: string,
    data: MeshData,
    matrix?: number[],
    appearance?: { material?: MaterialPreset | null; flatShading?: boolean },
    colors?: Float32Array,
  ) {
    if (!this.parts.has(id)) this.order.push(id)
    this.parts.set(id, {
      id,
      name,
      data,
      matrix: matrix ?? [...IDENTITY],
      material: appearance?.material ?? null,
      flatShading: appearance?.flatShading ?? false,
      visible: true,
      colors: colors ?? null,
    })
  }

  removePart(id: string) {
    this.parts.delete(id)
    this.order = this.order.filter((x) => x !== id)
  }

  partInfo(id: string): PartInfo | null {
    const p = this.parts.get(id)
    if (!p) return null
    return {
      id,
      name: p.name,
      visible: p.visible,
      triangles: p.data.indices.length / 3,
      bbox: { x: 0, y: 0, z: 0 },
      material: p.material,
      flatShading: p.flatShading,
    }
  }

  listParts(): PartInfo[] {
    return this.order.map((id) => this.partInfo(id)!).filter(Boolean)
  }

  getWorldMeshData(id: string): MeshData | null {
    const p = this.parts.get(id)
    return p ? { positions: p.data.positions.slice(), indices: p.data.indices.slice() } : null
  }

  getPartForSave(id: string) {
    const p = this.parts.get(id)
    if (!p) return null
    return {
      data: { positions: p.data.positions.slice(), indices: p.data.indices.slice() },
      matrix: [...p.matrix],
      name: p.name,
      visible: p.visible,
      material: p.material,
      flatShading: p.flatShading,
      colors: p.colors ? p.colors.slice() : null,
    }
  }
}

/** Install a fake engine and return it (typed loosely — it's a structural stand-in). */
function installEngine(): FakeSceneManager {
  const fake = new FakeSceneManager()
  seams.setEngine(fake as unknown as Parameters<typeof seams.setEngine>[0])
  return fake
}

const report = {} as AnalysisReport

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

afterEach(() => {
  seams.reset()
  vi.clearAllMocks()
})

// ---------- in-flight fit job: supersede / cancel ----------

describe('fit job supersede / cancel', () => {
  it('supersedes the prior offset job, cancels it, and ignores its late result', async () => {
    const fake = installEngine()
    fake.addPart('scan', 'Scan', makeCube())
    const { client, jobs } = fakeFitClient()
    seams.setClients({ fit: client })
    useAppStore.setState({ selectedId: 'scan' })

    const first = generateOffsetPart()
    const second = generateOffsetPart()

    // the second run armed over the first
    expect(client.offset).toHaveBeenCalledTimes(2)
    expect(jobs.offset[0].job.cancel).toHaveBeenCalledTimes(1)
    expect(seams.getJobs().fitJob).toBe(jobs.offset[1].job)

    // the superseded job's late result must not add a part or unblock the UI
    jobs.offset[0].resolve(makeCube())
    await first
    expect(fake.parts.has('scan')).toBe(true)
    expect(fake.parts.size).toBe(1)
    expect(useAppStore.getState().fit.busy).toBe(true)

    // the winning job adds the generated part and clears busy
    jobs.offset[1].resolve(makeCube())
    await second
    expect(fake.parts.size).toBe(2)
    expect(useAppStore.getState().fit.busy).toBe(false)
    expect(seams.getJobs().fitJob).toBeNull()
  })

  it('cancelFit aborts the in-flight job and unblocks immediately', async () => {
    const fake = installEngine()
    fake.addPart('scan', 'Scan', makeCube())
    const { client, jobs } = fakeFitClient()
    seams.setClients({ fit: client })
    useAppStore.setState({ selectedId: 'scan' })

    const run = generateOffsetPart()
    expect(useAppStore.getState().fit.busy).toBe(true)

    cancelFit()
    expect(jobs.offset[0].job.cancel).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().fit.busy).toBe(false)
    expect(seams.getJobs().fitJob).toBeNull()

    // even if the worker later resolves, the cancelled job adds nothing
    jobs.offset[0].resolve(makeCube())
    await run
    expect(fake.parts.size).toBe(1)
  })

  it('a worker-cancelled (null) result unblocks without adding a part', async () => {
    const fake = installEngine()
    fake.addPart('scan', 'Scan', makeCube())
    const { client, jobs } = fakeFitClient()
    seams.setClients({ fit: client })
    useAppStore.setState({ selectedId: 'scan' })

    const run = generateOffsetPart()
    jobs.offset[0].resolve(null)
    await run
    expect(fake.parts.size).toBe(1)
    expect(useAppStore.getState().fit.busy).toBe(false)
    expect(seams.getJobs().fitJob).toBeNull()
  })
})

// ---------- in-flight thickness job: supersede / cancel ----------

describe('thickness heatmap job supersede / cancel', () => {
  function fakeThicknessClient() {
    const jobs: Deferred<ThicknessResult>[] = []
    const compute = vi.fn((): ThicknessJob => {
      const d = makeJob<ThicknessResult>()
      jobs.push(d)
      return d.job
    })
    return { client: { compute }, jobs }
  }

  it('supersedes the prior compute and ignores its late field', async () => {
    const fake = installEngine()
    fake.addPart('p1', 'Part', makeCube())
    const { client, jobs } = fakeThicknessClient()
    seams.setClients({ thickness: client })
    useAppStore.setState({ selectedId: 'p1' })

    const first = computeThicknessHeatmap()
    const second = computeThicknessHeatmap()

    expect(client.compute).toHaveBeenCalledTimes(2)
    expect(jobs[0].job.cancel).toHaveBeenCalledTimes(1)

    // late result from the superseded run paints nothing
    jobs[0].resolve({ values: new Float32Array([1]), min: 0, max: 1 })
    await first
    expect(fake.setThicknessHeatmap).not.toHaveBeenCalled()

    // the winning run paints and enables
    jobs[1].resolve({ values: new Float32Array([1, 2]), min: 0.5, max: 2 })
    await second
    expect(fake.setThicknessHeatmap).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().measure.heatmap.enabled).toBe(true)
    expect(seams.getJobs().thicknessJob).toBeNull()
  })

  it('cancelThicknessHeatmap aborts and clears busy', async () => {
    const fake = installEngine()
    fake.addPart('p1', 'Part', makeCube())
    const { client, jobs } = fakeThicknessClient()
    seams.setClients({ thickness: client })
    useAppStore.setState({ selectedId: 'p1' })

    const run = computeThicknessHeatmap()
    cancelThicknessHeatmap()
    expect(jobs[0].job.cancel).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().measure.heatmap.busy).toBe(false)
    expect(seams.getJobs().thicknessJob).toBeNull()

    jobs[0].resolve({ values: new Float32Array([1]), min: 0, max: 1 })
    await run
    expect(fake.setThicknessHeatmap).not.toHaveBeenCalled()
  })
})

// ---------- teardown on tab-leave ----------

describe('teardown on tab-leave', () => {
  it('teardownHeatmap clears an active heatmap and is a no-op otherwise', () => {
    const fake = installEngine()

    // nothing active → no engine call, no spurious store churn
    teardownHeatmap()
    expect(fake.clearThicknessHeatmap).not.toHaveBeenCalled()

    useAppStore.getState().patchHeatmap({ enabled: true, partId: 'p1' })
    teardownHeatmap()
    expect(fake.clearThicknessHeatmap).toHaveBeenCalledTimes(1)
    const hm = useAppStore.getState().measure.heatmap
    expect(hm.enabled).toBe(false)
    expect(hm.partId).toBeNull()
  })

  it('teardownFit cancels the job and tears every fit overlay down', async () => {
    const fake = installEngine()
    fake.addPart('scan', 'Scan', makeCube())
    const { client, jobs } = fakeFitClient()
    seams.setClients({ fit: client })
    useAppStore.setState({ selectedId: 'scan' })

    const run = generateOffsetPart()
    useAppStore.getState().patchFit({
      mapEnabled: true,
      surveyEnabled: true,
      brushActive: true,
    })

    teardownFit()

    expect(jobs.offset[0].job.cancel).toHaveBeenCalledTimes(1)
    expect(seams.getJobs().fitJob).toBeNull()
    expect(fake.clearClearanceMap).toHaveBeenCalledTimes(1)
    expect(fake.clearUndercutSurvey).toHaveBeenCalledTimes(1)
    expect(fake.hideInsertionAxis).toHaveBeenCalledTimes(1)
    expect(fake.setBrushSelect).toHaveBeenCalledWith(null, 0)
    const f = useAppStore.getState().fit
    expect(f).toMatchObject({
      busy: false,
      mapEnabled: false,
      surveyEnabled: false,
      brushActive: false,
    })

    // the cancelled job resolving late must stay inert
    jobs.offset[0].resolve(makeCube())
    await run
    expect(fake.parts.size).toBe(1)
  })

  it('teardownResize disarms picking and clears the 3D overlay', () => {
    const fake = installEngine()
    setResizePicking(true)
    expect(useAppStore.getState().resize.picking).toBe(true)

    teardownResize()

    // last setPickMode call disarmed picking; overlay cleared
    expect(fake.setPickMode).toHaveBeenLastCalledWith(false)
    expect(fake.setResizeOverlay).toHaveBeenLastCalledWith(null)
    expect(useAppStore.getState().resize.picking).toBe(false)
  })
})

// ---------- non-destructive undo stacks (revisions Map) ----------

describe('heal / resize undo stacks', () => {
  it('healSelected pushes a revision and undoHeal restores it', async () => {
    const fake = installEngine()
    const original = makeCube(10)
    fake.addPart('p1', 'Ring', original)
    useAppStore.setState({ selectedId: 'p1' })

    const healed = makeCube(12)
    const heal = vi.fn(
      (): Promise<HealOutcome> =>
        Promise.resolve({ mesh: healed, before: report, after: report, unioned: false }),
    )
    seams.setClients({
      repair: { analyze: vi.fn(), heal, split: vi.fn() },
    })

    await healSelected()

    // a revision was stacked and the geometry replaced with the healed mesh
    expect(seams.getRevisions().get('p1')?.length).toBe(1)
    expect(useAppStore.getState().repair.canUndo).toBe(true)
    expect(fake.getWorldMeshData('p1')!.positions.length).toBe(healed.positions.length)

    undoHeal()

    // the stack popped back to empty and the original geometry returned
    expect(seams.getRevisions().get('p1')?.length).toBe(0)
    expect(useAppStore.getState().repair.canUndo).toBe(false)
    expect(fake.getWorldMeshData('p1')!.positions.length).toBe(original.positions.length)
  })

  it('undoResize pops the revision stack one entry at a time', () => {
    const fake = installEngine()
    fake.addPart('ring', 'Ring', makeCube(14))
    useAppStore.setState({ selectedId: 'ring' })

    // seed two stacked revisions (as two prior resizes would have)
    seams.getRevisions().set('ring', [
      { data: makeCube(10), matrix: [...IDENTITY] },
      { data: makeCube(12), matrix: [...IDENTITY] },
    ])

    undoResize()
    expect(seams.getRevisions().get('ring')?.length).toBe(1)
    expect(useAppStore.getState().resize.canUndo).toBe(true)

    undoResize()
    expect(seams.getRevisions().get('ring')?.length).toBe(0)
    expect(useAppStore.getState().resize.canUndo).toBe(false)
    expect(fake.parts.has('ring')).toBe(true)
  })

  it('undoResize is a no-op with an empty stack', () => {
    const fake = installEngine()
    fake.addPart('ring', 'Ring', makeCube())
    useAppStore.setState({ selectedId: 'ring' })

    undoResize()
    expect(fake.select).not.toHaveBeenCalled()
  })
})

// ---------- partsChanged reconcile ----------

describe('partsChanged reconcile', () => {
  it('drops store overlay flags when the engine no longer holds the overlay', () => {
    const fake = installEngine()
    fake.addPart('p1', 'Part', makeCube())
    // engine reports every overlay gone (its part was removed/replaced)
    useAppStore.getState().patchHeatmap({ enabled: true, partId: 'p1' })
    useAppStore.getState().patchFit({
      mapEnabled: true,
      surveyEnabled: true,
      brushActive: true,
      brushCount: 5,
    })

    seams.firePartsChanged()

    expect(useAppStore.getState().parts.map((p) => p.id)).toEqual(['p1'])
    expect(useAppStore.getState().measure.heatmap.enabled).toBe(false)
    const f = useAppStore.getState().fit
    expect(f.mapEnabled).toBe(false)
    expect(f.surveyEnabled).toBe(false)
    expect(f.brushActive).toBe(false)
    expect(fake.hideInsertionAxis).toHaveBeenCalledTimes(1)
  })

  it('keeps overlay flags when the engine still holds the overlay', () => {
    const fake = installEngine()
    fake.addPart('p1', 'Part', makeCube())
    fake.thicknessHeatmap = true
    fake.clearanceMap = true
    fake.undercutSurvey = true
    fake.brushSelect = true
    useAppStore.getState().patchHeatmap({ enabled: true, partId: 'p1' })
    useAppStore.getState().patchFit({ mapEnabled: true, surveyEnabled: true, brushActive: true })

    seams.firePartsChanged()

    expect(useAppStore.getState().measure.heatmap.enabled).toBe(true)
    const f = useAppStore.getState().fit
    expect(f.mapEnabled).toBe(true)
    expect(f.surveyEnabled).toBe(true)
    expect(f.brushActive).toBe(true)
    expect(fake.hideInsertionAxis).not.toHaveBeenCalled()
  })
})
