import { create } from 'zustand'
import type {
  AnalysisReport,
  DisplayMode,
  GizmoMode,
  HealOptions,
  Measurement,
  PartInfo,
  Projection,
  SectionAxis,
  Vec3,
  WorkflowTab,
} from '@/core/types'
import { HEAL_PRESETS } from '@/core/types'
import type { HistoryEntry, Material } from '@/core/calc/materials'
import type { Currency } from '@/core/calc/spotPrices'

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
}))
