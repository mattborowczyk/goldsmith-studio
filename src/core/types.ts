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

/**
 * A part's display material. The global display modes plus two generator
 * finishes: `gem` (clear, brilliant) and `cutter` (translucent boolean tool).
 */
export type MaterialPreset = DisplayMode | 'gem' | 'cutter'

/** Per-part appearance override; `material: null` follows the global display mode. */
export interface PartAppearance {
  material: MaterialPreset | null
  /** Flat (faceted) shading instead of smoothed normals — crisp gem facets. */
  flatShading: boolean
}

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
  /** Per-part material override; null follows the global display mode. */
  material: MaterialPreset | null
  flatShading: boolean
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

// ---------- grillz margin curves (epic #45, issue #47) ----------

/**
 * One control point of a tooth-margin curve: a position on/near the scan
 * surface, optionally bound back to the scan so the drag-handle editor (#49)
 * can re-project it after a move and the wand (#48) can refine it.
 */
export interface MarginControlPoint {
  /** Position on/near the scan surface (mm, scan space). */
  position: Vec3
  /** Scan vertex this point was derived from, when it came from a selection. */
  vertex?: number
  /** Scan triangle adjacent to the curve here — re-projection anchor after drags. */
  face?: number
}

/**
 * An ordered **closed** loop of control points tracing a tooth margin on the
 * scan surface (consecutive points are connected; the last closes back to the
 * first). This is the editable selection model the magic wand emits, the
 * drag-handle UI mutates, and the shell clip consumes via
 * `buildSelectionPrismFromCurve` — replacing the raw vertex `Set` as the
 * canonical selection once a margin is being edited.
 */
export interface MarginCurve {
  points: MarginControlPoint[]
}

// ---------- smart ring resizer (plan §2.6) ----------

/**
 * Cylindrical frame of a ring, recovered from its mesh: the ring axis, the
 * in-plane centre the band turns about, and inner/outer radii. The resizer
 * deforms vertices in the (axis, centre) cylindrical coordinate system.
 */
export interface RingFrame {
  /** Index (0=x, 1=y, 2=z) of the ring axis — the smallest bbox extent. */
  axis: 0 | 1 | 2
  /** In-plane centre [cu, cv] on the u=(axis+1)%3, v=(axis+2)%3 axes. */
  center: [number, number]
  /** Midpoint along the ring axis (where overlay/labels sit). */
  axialCenter: number
  /** Smallest radial vertex distance from the axis (mm). */
  innerR: number
  /** Largest radial vertex distance from the axis (mm). */
  outerR: number
}

/**
 * Wedding band resizes the whole shank uniformly; solitaire keeps a protected
 * angular zone (the head/setting) rigid and deforms only the shank.
 */
export type ResizeMode = 'uniform' | 'protect-head'

/** Everything the engine needs to draw the protected-sector gauge + labels. */
export interface ResizeOverlay {
  frame: RingFrame
  mode: ResizeMode
  /** Centre of the protected zone, degrees around the ring axis. */
  protectedCenterDeg: number
  /** Full angular width of the rigid protected zone (degrees). */
  protectedDeg: number
  /** Angular width of each blend zone flanking the protected zone (degrees). */
  smoothingDeg: number
  /** Centre of the seam (sacrificial stretch) sector, degrees. */
  seamCenterDeg: number
  /** Effective full width of the seam sector (degrees) — post fold-guard. */
  seamDeg: number
  beforeLabel: string
  afterLabel: string
}
