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
import type { HistoryEntry, Material } from '@/core/calc/materials'
import type { Currency } from '@/core/calc/spotPrices'
import type { SizeSystem } from '@/core/generators/ringSizes'
import type {
  BillingIncrement,
  ReportBranding,
  ReportTemplate,
} from '@/core/report/reportModel'
import type { MeshFormat } from '@/core/io/exporters'

export interface RepairState {
  /** Per-part revision stack for non-destructive heal undo. */
  busy: 'analyze' | 'heal' | 'split' | null
  report: AnalysisReport | null
  beforeAfter: { before: AnalysisReport; after: AnalysisReport; unioned: boolean } | null
  options: HealOptions
  error: string | null
  canUndo: boolean
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

export interface MeasureState {
  /** Pick mode armed: viewport taps place measurement points. */
  picking: boolean
  pendingPoint: Vec3 | null
  measurements: Measurement[]
  /** Color for newly created dimensions. */
  color: string
  section: SectionState
  innerDiameter: { diameter: number; axis: string } | null | 'none'
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

interface AppState {
  tab: WorkflowTab
  parts: PartInfo[]
  selectedId: string | null
  displayMode: DisplayMode
  projection: Projection
  gizmoMode: GizmoMode
  gridVisible: boolean
  background: string
  turntable: boolean
  postFX: boolean
  importing: boolean
  importError: string | null
  restoring: boolean
  repair: RepairState
  cost: CostState
  measure: MeasureState
  resize: ResizeState
  deliver: DeliverState

  setTab: (tab: WorkflowTab) => void
  setParts: (parts: PartInfo[]) => void
  setSelected: (id: string | null) => void
  setDisplayMode: (mode: DisplayMode) => void
  setProjection: (p: Projection) => void
  setGizmoMode: (m: GizmoMode) => void
  setGridVisible: (v: boolean) => void
  setBackground: (b: string) => void
  setTurntable: (v: boolean) => void
  setPostFX: (v: boolean) => void
  setImporting: (v: boolean, error?: string | null) => void
  setRestoring: (v: boolean) => void
  patchRepair: (patch: Partial<RepairState>) => void
  patchCost: (patch: Partial<CostState>) => void
  patchMeasure: (patch: Partial<MeasureState>) => void
  patchSection: (patch: Partial<SectionState>) => void
  patchResize: (patch: Partial<ResizeState>) => void
  patchDeliver: (patch: Partial<DeliverState>) => void
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

  setTab: (tab) => set({ tab }),
  setParts: (parts) => set({ parts }),
  setSelected: (selectedId) => set({ selectedId }),
  setDisplayMode: (displayMode) => set({ displayMode }),
  setProjection: (projection) => set({ projection }),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  setGridVisible: (gridVisible) => set({ gridVisible }),
  setBackground: (background) => set({ background }),
  setTurntable: (turntable) => set({ turntable }),
  setPostFX: (postFX) => set({ postFX }),
  setImporting: (importing, importError = null) => set({ importing, importError }),
  setRestoring: (restoring) => set({ restoring }),
  patchRepair: (patch) => set((s) => ({ repair: { ...s.repair, ...patch } })),
  patchCost: (patch) => set((s) => ({ cost: { ...s.cost, ...patch } })),
  patchMeasure: (patch) => set((s) => ({ measure: { ...s.measure, ...patch } })),
  patchSection: (patch) =>
    set((s) => ({ measure: { ...s.measure, section: { ...s.measure.section, ...patch } } })),
  patchResize: (patch) => set((s) => ({ resize: { ...s.resize, ...patch } })),
  patchDeliver: (patch) => set((s) => ({ deliver: { ...s.deliver, ...patch } })),
}))
