/**
 * Framework-agnostic core types. Nothing in core/ may import React or DOM-heavy
 * libraries (Three.js rendering lives in core/engine, behind the SceneManager
 * facade, so the same geometry/IO code can ship in a React Native shell later).
 */

/** Raw indexed triangle mesh. Positions in millimetres. */
export interface MeshData {
  positions: Float32Array
  indices: Uint32Array
}

export type DisplayMode =
  | 'gold'
  | 'silver'
  | 'studio'
  | 'wireframe'
  | 'normals'
  | 'backface'

export type Projection = 'perspective' | 'orthographic'

export type ViewPreset = 'top' | 'front' | 'left' | 'right' | 'iso'

export type WorkflowTab =
  | 'import'
  | 'repair'
  | 'measure'
  | 'build'
  | 'resize'
  | 'fit'
  | 'cost'
  | 'deliver'
  | 'all'

export type ImportUnit = 'mm' | 'cm' | 'm' | 'in'

export const UNIT_TO_MM: Record<ImportUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
}

export type GizmoMode = 'none' | 'translate' | 'rotate' | 'scale'

/** UI-facing metadata for one part; geometry lives in the engine + autosave DB. */
export interface PartInfo {
  id: string
  name: string
  visible: boolean
  triangles: number
  /** Axis-aligned bounding box in mm, after transform. */
  bbox: { x: number; y: number; z: number }
}

/** Result of the (pure-TS) mesh analysis pass. */
export interface AnalysisReport {
  triangles: number
  vertices: number
  shells: number
  boundaryEdges: number
  boundaryLoops: number
  nonManifoldEdges: number
  invertedShells: number
  watertight: boolean
  manifold: boolean
  /** mm³ — signed-volume sum, meaningful when watertight. */
  volume: number
  /** mm² */
  surfaceArea: number
  /** Vertex pairs (a,b) of boundary edges, for viewport highlighting. */
  boundaryEdgePositions: Float32Array
  /** Triangle centroids of flipped (inverted-shell) faces, for highlighting. */
  flippedFacePositions: Float32Array
}

export type HealMode = 'safe' | 'aggressive' | 'custom'

export interface HealOptions {
  mode: HealMode
  /** Vertex-weld tolerance in mm (used by custom mode). */
  tolerance: number
  /** Drop shells whose volume is below this (mm³). 0 = keep all. */
  minShellVolume: number
  /** Attempt to fill boundary loops up to this many edges. */
  fillHolesUpTo: number
}

export const HEAL_PRESETS: Record<Exclude<HealMode, 'custom'>, Omit<HealOptions, 'mode'>> = {
  safe: { tolerance: 1e-4, minShellVolume: 0, fillHolesUpTo: 64 },
  aggressive: { tolerance: 0.01, minShellVolume: 0.05, fillHolesUpTo: 512 },
}

export interface HealResult {
  mesh: MeshData
  before: AnalysisReport
  after: AnalysisReport
}

// ---------- measurement & sections ----------

export type Vec3 = [number, number, number]

/** A persistent point-to-point dimension in the scene. */
export interface Measurement {
  id: string
  a: Vec3
  b: Vec3
  /** mm, cached so the UI list never recomputes. */
  distance: number
  color: string
}

export type SectionAxis = 'x' | 'y' | 'z'

export interface SectionOptions {
  axis: SectionAxis
  /** Cut position along the axis, mm (world). */
  position: number
  /** Keep the other half instead. */
  flip: boolean
  /** Slab mode: keep only a thin slice instead of a half-space. */
  slice: boolean
  /** Slab thickness in mm (slice mode). */
  thickness: number
}
