import { create } from 'zustand'
import type {
  AnalysisReport,
  DisplayMode,
  GizmoMode,
  HealOptions,
  Measurement,
  PartInfo,
  Projection,
  ResizeMode,
  RingFrame,
  SectionAxis,
  Vec3,
  WorkflowTab,
} from '@/core/types'
import { HEAL_PRESETS } from '@/core/types'
import type { RimSummary } from '@/core/geometry/baseCap'
import type { HistoryEntry, Material } from '@/core/calc/materials'
import type { Currency } from '@/core/calc/spotPrices'
import type { SizeSystem } from '@/core/generators/ringSizes'
import type {
  BillingIncrement,
  ReportBranding,
  ReportTemplate,
} from '@/core/report/reportModel'
import type { MeshFormat } from '@/core/io/exporters'

/** Close-open-base tool (issue #26): live plane placement over the rim info. */
export interface BaseCapState {
  axis: SectionAxis
  /** Cap-plane coordinate along the axis (mm, world). */
  position: number
  /** Slider range: from just past the rim outward. */
  min: number
  max: number
  /** Largest-rim summary the defaults were derived from. */
  info: RimSummary
}

export interface RepairState {
  /** Per-part revision stack for non-destructive heal undo. */
  busy: 'analyze' | 'heal' | 'split' | 'baseCap' | null
  report: AnalysisReport | null
  beforeAfter: { before: AnalysisReport; after: AnalysisReport; unioned: boolean } | null
  options: HealOptions
  error: string | null
  canUndo: boolean
  /** Non-null while the close-open-base tool is active (plane preview shown). */
  baseCap: BaseCapState | null
}

export interface CostSettings {
  /** Casting loss factor % applied on top of net weight cost. */
  lossFactorPct: number
  currency: Currency
  /** ISO timestamp of the last successful market refresh. */
  pricesUpdatedAt: string | null
}

export interface CostState {
  materials: Material[]
  /** partId → materialId */
  assignments: Record<string, string>
  /** partId → world-space volume in mm³ */
  volumes: Record<string, number>
  settings: CostSettings
  history: HistoryEntry[]
  refreshing: boolean
  error: string | null
}

export interface SectionState {
  enabled: boolean
  axis: SectionAxis
  position: number
  flip: boolean
  slice: boolean
  thickness: number
  /** Slider range along the active axis (scene bounds). */
  range: { min: number; max: number }
}

/** Wall-thickness heatmap (plan §2.3): transient surface overlay + threshold. */
export interface HeatmapState {
  /** A heatmap is painted on a part right now. */
  enabled: boolean
  /** Worker compute in flight. */
  busy: boolean
  /** Compute progress 0..1. */
  progress: number
  /** Minimum-thickness threshold (mm): walls at/under this go hard red. */
  thresholdMm: number
  /** Measured thickness range of the active heatmap (mm), or null. */
  range: { min: number; max: number } | null
  /** Part the heatmap belongs to. */
  partId: string | null
  error: string | null
}

export interface MeasureState {
  /** Pick mode armed: viewport taps place measurement points. */
  picking: boolean
  pendingPoint: Vec3 | null
  measurements: Measurement[]
  /** Color for newly created dimensions. */
  color: string
  section: SectionState
  innerDiameter: { diameter: number; axis: string } | null | 'none'
  heatmap: HeatmapState
}

export interface ResizeState {
  mode: ResizeMode
  /** Part the detected frame belongs to — apply/undo must match it. */
  sourcePartId: string | null
  /** Target size input. */
  targetSystem: SizeSystem
  targetSize: number
  /** Source of truth for the resize — target inner diameter in mm. */
  targetDiameter: number
  /** Detected current ring frame + inner Ø, or null/'none' when not a ring. */
  frame: RingFrame | null
  currentDiameter: number | null
  detected: boolean | 'none'
  /** protect-head zone. */
  protectedCenterDeg: number
  /** Use the auto-detected head angle instead of a manual centre. */
  autoHead: boolean
  protectedDeg: number
  smoothingDeg: number
  /** Re-heal pass after deforming. */
  reheal: boolean
  /** Viewport pick mode armed to set the protected centre. */
  picking: boolean
  busy: boolean
  canUndo: boolean
  error: string | null
}

/** Grillz/dental Fit tab (plan §3.1): cement-gap offset + clearance map. */
export interface FitState {
  /** Tooth scan part the offset is generated from. */
  scanPartId: string | null
  /** Sculpted grillz shell — boolean operand + clearance-map target. */
  shellPartId: string | null
  /** Cement gap in mm (the outward offset). */
  clearanceMm: number
  /** Half-width of the green tolerance band around the clearance, in mm. */
  bandHalfMm: number
  /** A Manifold/clearance job is in flight. */
  busy: boolean
  /** Job progress 0..1. */
  progress: number
  /** Current stage label for the busy UI. */
  stage: string | null
  /** A clearance map is painted right now. */
  mapEnabled: boolean
  /** Signed gap range of the active map (mm), or null. */
  mapRange: { min: number; max: number } | null
  /** Part the clearance map is painted on. */
  mapPartId: string | null
  // ----- undercut survey & blockout (plan §3.2) -----
  /** Insertion (path-of-withdrawal) axis, normalised, for the undercut survey. */
  insertionAxis: Vec3
  /** The undercut survey overlay is painted right now (and the axis gizmo shown). */
  surveyEnabled: boolean
  /** Total undercut surface area of the active survey (mm²), or null. */
  undercutArea: number | null
  /** Part the survey is painted on. */
  surveyPartId: string | null
  /** Retention allowance for blockout (mm) — leaves a snap-fit undercut lip. */
  retentionMm: number
  // ----- shell generator (plan §3.3) -----
  /** Surface brush-select is armed (paint the teeth the shell covers). */
  brushActive: boolean
  /** Brush radius in mm. */
  brushRadiusMm: number
  /** Count of brushed scan vertices — drives the "selection ready" affordance. */
  brushCount: number
  /** Uniform shell wall thickness (mm). */
  shellThicknessMm: number
  /** Trim the shell at the scan base, opening the cavity at the gingival margin. */
  openGingival: boolean
  /** Per-tooth (connected-component) weight estimate of the last shell, grams. */
  toothWeights: number[] | null
  error: string | null
}

/** Deliver tab: mesh export + branded report generation (plan §2.7). */
export interface DeliverState {
  // mesh export
  exportFormat: MeshFormat
  exportScope: 'merged' | 'per-part'
  applyShrinkage: boolean
  shrinkagePct: number
  exporting: boolean
  // report
  template: ReportTemplate
  title: string
  branding: ReportBranding
  labourHours: number
  labourRate: number
  billing: BillingIncrement
  showMetalPrices: boolean
  notes: string
  generating: boolean
  /** Transient flag for the "copied!" affordance on the clipboard button. */
  copied: boolean
  error: string | null
}

/** Service-worker / install lifecycle for the install/update banner (§2.8). */
export interface PwaState {
  /** A new SW is waiting — offer reload-to-update. */
  needRefresh: boolean
  /** First-load precache finished — the app now works offline. */
  offlineReady: boolean
  /** A native install prompt is available (Chromium). */
  canInstall: boolean
}

/** On-device durability: surfaces silent autosave/quota failures (issue #10). */
export interface StorageState {
  /** A persistence write (scene/materials/settings/kv) failed — work may be unsaved. */
  writeFailed: boolean
  /** The last failure looked like a quota/out-of-space error (drives the message). */
  quotaExceeded: boolean
  /** navigator.storage.persisted(): true granted, false denied, null can't-ask. */
  persisted: boolean | null
  /** Latest approximate usage/quota in bytes (issue #32), or null if unavailable. */
  estimate: { usage: number; quota: number } | null
}

interface AppState {
  tab: WorkflowTab
  parts: PartInfo[]
  selectedId: string | null
  displayMode: DisplayMode
  projection: Projection
  gizmoMode: GizmoMode
  gridVisible: boolean
  background: string
  /** Accent-colour preset id (see src/app/theme.ts). */
  accent: string
  turntable: boolean
  postFX: boolean
  importing: boolean
  importError: string | null
  restoring: boolean
  repair: RepairState
  cost: CostState
  measure: MeasureState
  resize: ResizeState
  fit: FitState
  deliver: DeliverState
  pwa: PwaState
  storage: StorageState

  setTab: (tab: WorkflowTab) => void
  setParts: (parts: PartInfo[]) => void
  setSelected: (id: string | null) => void
  setDisplayMode: (mode: DisplayMode) => void
  setProjection: (p: Projection) => void
  setGizmoMode: (m: GizmoMode) => void
  setGridVisible: (v: boolean) => void
  setBackground: (b: string) => void
  setAccent: (a: string) => void
  setTurntable: (v: boolean) => void
  setPostFX: (v: boolean) => void
  setImporting: (v: boolean, error?: string | null) => void
  setRestoring: (v: boolean) => void
  patchRepair: (patch: Partial<RepairState>) => void
  patchCost: (patch: Partial<CostState>) => void
  patchMeasure: (patch: Partial<MeasureState>) => void
  patchSection: (patch: Partial<SectionState>) => void
  patchHeatmap: (patch: Partial<HeatmapState>) => void
  patchResize: (patch: Partial<ResizeState>) => void
  patchFit: (patch: Partial<FitState>) => void
  patchDeliver: (patch: Partial<DeliverState>) => void
  patchPwa: (patch: Partial<PwaState>) => void
  patchStorage: (patch: Partial<StorageState>) => void
}

export const useAppStore = create<AppState>((set) => ({
  tab: 'import',
  parts: [],
  selectedId: null,
  displayMode: 'gold',
  projection: 'perspective',
  gizmoMode: 'translate',
  gridVisible: true,
  background: 'studio',
  accent: 'gold',
  turntable: false,
  postFX: true,
  importing: false,
  importError: null,
  restoring: true,
  repair: {
    busy: null,
    report: null,
    beforeAfter: null,
    options: { mode: 'safe', ...HEAL_PRESETS.safe },
    error: null,
    canUndo: false,
    baseCap: null,
  },
  cost: {
    materials: [],
    assignments: {},
    volumes: {},
    settings: { lossFactorPct: 0, currency: 'USD', pricesUpdatedAt: null },
    history: [],
    refreshing: false,
    error: null,
  },
  measure: {
    picking: false,
    pendingPoint: null,
    measurements: [],
    color: '#e8c260',
    section: {
      enabled: false,
      axis: 'x',
      position: 0,
      flip: false,
      slice: false,
      thickness: 1,
      range: { min: -50, max: 50 },
    },
    innerDiameter: null,
    heatmap: {
      enabled: false,
      busy: false,
      progress: 0,
      thresholdMm: 0.6,
      range: null,
      partId: null,
      error: null,
    },
  },
  resize: {
    mode: 'uniform',
    sourcePartId: null,
    targetSystem: 'US',
    targetSize: 7,
    targetDiameter: 17.35, // US 7
    frame: null,
    currentDiameter: null,
    detected: false,
    protectedCenterDeg: 90,
    autoHead: true,
    protectedDeg: 45,
    smoothingDeg: 40,
    reheal: false,
    picking: false,
    busy: false,
    canUndo: false,
    error: null,
  },
  fit: {
    scanPartId: null,
    shellPartId: null,
    clearanceMm: 0.05,
    bandHalfMm: 0.02,
    busy: false,
    progress: 0,
    stage: null,
    mapEnabled: false,
    mapRange: null,
    mapPartId: null,
    insertionAxis: [0, 1, 0],
    surveyEnabled: false,
    undercutArea: null,
    surveyPartId: null,
    retentionMm: 0,
    brushActive: false,
    brushRadiusMm: 1.5,
    brushCount: 0,
    shellThicknessMm: 1.0,
    openGingival: true,
    toothWeights: null,
    error: null,
  },
  deliver: {
    exportFormat: 'stl',
    exportScope: 'merged',
    applyShrinkage: false,
    shrinkagePct: 1.75,
    exporting: false,
    template: 'quote',
    title: '',
    branding: { businessName: '', contact: '', logo: '' },
    labourHours: 0,
    labourRate: 0,
    billing: '15min',
    showMetalPrices: false,
    notes: '',
    generating: false,
    copied: false,
    error: null,
  },
  pwa: {
    needRefresh: false,
    offlineReady: false,
    canInstall: false,
  },
  storage: {
    writeFailed: false,
    quotaExceeded: false,
    persisted: null,
    estimate: null,
  },

  setTab: (tab) => set({ tab }),
  setParts: (parts) => set({ parts }),
  setSelected: (selectedId) => set({ selectedId }),
  setDisplayMode: (displayMode) => set({ displayMode }),
  setProjection: (projection) => set({ projection }),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  setGridVisible: (gridVisible) => set({ gridVisible }),
  setBackground: (background) => set({ background }),
  setAccent: (accent) => set({ accent }),
  setTurntable: (turntable) => set({ turntable }),
  setPostFX: (postFX) => set({ postFX }),
  setImporting: (importing, importError = null) => set({ importing, importError }),
  setRestoring: (restoring) => set({ restoring }),
  patchRepair: (patch) => set((s) => ({ repair: { ...s.repair, ...patch } })),
  patchCost: (patch) => set((s) => ({ cost: { ...s.cost, ...patch } })),
  patchMeasure: (patch) => set((s) => ({ measure: { ...s.measure, ...patch } })),
  patchSection: (patch) =>
    set((s) => ({ measure: { ...s.measure, section: { ...s.measure.section, ...patch } } })),
  patchHeatmap: (patch) =>
    set((s) => ({ measure: { ...s.measure, heatmap: { ...s.measure.heatmap, ...patch } } })),
  patchResize: (patch) => set((s) => ({ resize: { ...s.resize, ...patch } })),
  patchFit: (patch) => set((s) => ({ fit: { ...s.fit, ...patch } })),
  patchDeliver: (patch) => set((s) => ({ deliver: { ...s.deliver, ...patch } })),
  patchPwa: (patch) => set((s) => ({ pwa: { ...s.pwa, ...patch } })),
  patchStorage: (patch) => set((s) => ({ storage: { ...s.storage, ...patch } })),
}))
