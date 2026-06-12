import { create } from 'zustand'
import type {
  AnalysisReport,
  DisplayMode,
  GizmoMode,
  HealOptions,
  PartInfo,
  Projection,
  WorkflowTab,
} from '@/core/types'
import { HEAL_PRESETS } from '@/core/types'

export interface RepairState {
  /** Per-part revision stack for non-destructive heal undo. */
  busy: 'analyze' | 'heal' | 'split' | null
  report: AnalysisReport | null
  beforeAfter: { before: AnalysisReport; after: AnalysisReport; unioned: boolean } | null
  options: HealOptions
  error: string | null
  canUndo: boolean
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
}))
