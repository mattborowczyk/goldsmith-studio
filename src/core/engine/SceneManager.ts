import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing'
import { N8AOPostPass } from 'n8ao'
import type {
  AnalysisReport,
  DisplayMode,
  GizmoMode,
  MaterialPreset,
  Measurement,
  MeshData,
  PartAppearance,
  PartInfo,
  Projection,
  ResizeOverlay,
  SectionOptions,
  Vec3,
  ViewPreset,
} from '../types'
import { anglePointOnRing, pointAngleDeg } from '../geometry/resize'
import { thicknessColor } from '../geometry/thickness'
import { clearanceColor } from '../geometry/fit'
import { undercutColor } from '../geometry/undercut'
import type { NamedMesh } from '../io/exporters'
import { createBackMaterial, createMaterial } from './materials'
import { createBackgroundTexture, createStudioEnvironment } from './environment'

interface ScenePart {
  id: string
  name: string
  mesh: THREE.Mesh
  backMesh: THREE.Mesh
  /** Source-of-truth geometry for repair/export/persistence. */
  data: MeshData
  displayGeometry: THREE.BufferGeometry
  /** Per-part material override; null follows the global display mode. */
  materialOverride: MaterialPreset | null
  flatShading: boolean
  /** Source-vertex rgb (0..1) from a coloured import (PLY scans); shown by default. */
  vertexColors: Float32Array | null
}

/** Active wall-thickness heatmap: stored so a threshold drag recolours cheaply. */
interface HeatmapState {
  id: string
  values: Float32Array
  min: number
  max: number
  threshold: number
}

/** Active grillz clearance map: stored so a band drag recolours cheaply. */
interface ClearanceState {
  id: string
  /** Per source-vertex signed gap to the tooth scan (mm). */
  values: Float32Array
  /** Green-band edges (mm) for the colour ramp. */
  lo: number
  hi: number
}

/** Active undercut survey: per source-vertex undercut value (0 clear, >0 undercut). */
interface SurveyState {
  id: string
  values: Float32Array
}

/** Active surface brush-select (plan §3.3): the painted scan-vertex region for the shell. */
interface BrushState {
  id: string
  /** Brush radius in world units (mm). */
  radius: number
  /** Selected source-vertex indices. */
  selected: Set<number>
  /** World-space source-vertex positions, cached so each stroke move is one pass. */
  worldPos: Float32Array
}

/** The draggable insertion-axis arrow overlay (plan §3.2). */
interface AxisGizmo {
  group: THREE.Group
  /** Grabbable sphere at the arrow tip. */
  handle: THREE.Mesh
  /** Arrow length in world units (tip distance from the origin). */
  length: number
  /** World-space origin the arrow pivots about (the scan centroid). */
  center: THREE.Vector3
}

export interface SceneManagerEvents {
  /** Parts added/removed/renamed/transformed — UI + autosave listen to this. */
  partsChanged: () => void
  /** Selection changed from a viewport tap. */
  selectionChanged: (id: string | null) => void
  /** A surface/vertex point was picked while measure-pick mode is armed. */
  pointPicked: (point: Vec3) => void
  /** A resizer sector handle was dragged to a new protected-zone width (deg). */
  resizeHandleDrag: (protectedDeg: number) => void
  /** The insertion-axis arrow gizmo was dragged to a new (normalised) direction. */
  insertionAxisChanged: (axis: Vec3) => void
  /** The surface brush-select painted/erased — carries the new selected-vertex count. */
  brushSelectionChanged: (count: number) => void
}

/** One rendered dimension: line + endpoint markers + screen-sized label. */
interface MeasureItem {
  group: THREE.Group
  markers: THREE.Mesh[]
  sprite: THREE.Sprite
  /** canvas width / height, for sprite scaling. */
  aspect: number
}

/** Crease angle: edges sharper than this stay hard instead of being smoothed. */
const CREASE_ANGLE = THREE.MathUtils.degToRad(38)

/**
 * Imperative Three.js engine. Owns renderer, cameras, controls, gizmo, parts.
 * React mounts it into a container div and issues commands; it never reaches
 * back into React except via the two events above.
 */
export class SceneManager {
  readonly scene = new THREE.Scene()
  private renderer: THREE.WebGLRenderer
  private composer: EffectComposer | null = null
  private postEnabled = true
  private perspCamera: THREE.PerspectiveCamera
  private orthoCamera: THREE.OrthographicCamera
  private activeCamera: THREE.Camera
  private controls: OrbitControls
  private gizmo: TransformControls
  private gizmoHelper: THREE.Object3D
  private container: HTMLElement
  private resizeObserver: ResizeObserver
  /** Main materials cached by `${preset}:${flat}`, built lazily. */
  private matCache = new Map<string, THREE.Material>()
  private backMaterial: THREE.Material
  /** Active clipping planes from the section tool, applied to every material. */
  private clipPlanes: THREE.Plane[] = []
  private displayMode: DisplayMode = 'gold'
  private heatmap: HeatmapState | null = null
  private clearance: ClearanceState | null = null
  private survey: SurveyState | null = null
  private brush: BrushState | null = null
  private painting = false
  private parts = new Map<string, ScenePart>()
  private partOrder: string[] = []
  private selectedId: string | null = null
  private grid: THREE.GridHelper
  private keyLight: THREE.DirectionalLight
  private shadowCatcher: THREE.Mesh
  private highlightGroup = new THREE.Group()
  private measureGroup = new THREE.Group()
  private measureItems = new Map<string, MeasureItem>()
  private pendingMarker: THREE.Mesh | null = null
  private pickMode = false
  private resizeGroup = new THREE.Group()
  private resizeOverlay: ResizeOverlay | null = null
  /** Draggable sector-edge handles; index 0/1 stored in userData.handleIndex. */
  private resizeHandles: THREE.Mesh[] = []
  private draggingHandle: number | null = null
  private axisGroup = new THREE.Group()
  private axisGizmo: AxisGizmo | null = null
  private draggingAxis = false
  private sectionHelper: THREE.Object3D | null = null
  private backgroundTexture: THREE.Texture | null = null
  private listeners: { [K in keyof SceneManagerEvents]: Set<SceneManagerEvents[K]> } = {
    partsChanged: new Set(),
    selectionChanged: new Set(),
    pointPicked: new Set(),
    resizeHandleDrag: new Set(),
    insertionAxisChanged: new Set(),
    brushSelectionChanged: new Set(),
  }
  private tween: {
    fromPos: THREE.Vector3
    toPos: THREE.Vector3
    fromTarget: THREE.Vector3
    toTarget: THREE.Vector3
    start: number
    duration: number
  } | null = null
  private turntable = false
  private disposed = false
  private raycaster = new THREE.Raycaster()
  private downPos = new THREE.Vector2()

  constructor(container: HTMLElement) {
    this.container = container
    const w = container.clientWidth || 1
    const h = container.clientHeight || 1

    // antialias off — SMAA in the post stack covers it (and MSAA breaks with
    // the HalfFloat composer buffers anyway)
    this.renderer = new THREE.WebGLRenderer({ antialias: false, stencil: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h)
    // tone mapping happens in the post stack; keep it for the no-FX fallback
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(this.renderer.domElement)

    this.scene.environment = createStudioEnvironment(this.renderer)
    this.setBackground('studio')

    this.perspCamera = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000)
    this.perspCamera.position.set(40, 30, 40)
    const orthoHalf = 30
    this.orthoCamera = new THREE.OrthographicCamera(
      (-orthoHalf * w) / h, (orthoHalf * w) / h, orthoHalf, -orthoHalf, -5000, 5000,
    )
    this.orthoCamera.position.copy(this.perspCamera.position)
    this.activeCamera = this.perspCamera

    this.controls = new OrbitControls(this.perspCamera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }

    this.gizmo = new TransformControls(this.perspCamera, this.renderer.domElement)
    this.gizmo.setSize(0.9)
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value
      this.controls.enabled = !dragging
      // hide the insertion-axis arrow while transforming a part, to avoid handle conflicts
      this.axisGroup.visible = !dragging && this.axisGizmo !== null
      if (!dragging) this.emit('partsChanged')
    })
    this.gizmoHelper = this.gizmo.getHelper()
    this.scene.add(this.gizmoHelper)

    this.grid = new THREE.GridHelper(100, 50, 0x4a4640, 0x2e2c28)
    this.scene.add(this.grid)
    this.scene.add(this.highlightGroup)
    this.scene.add(this.measureGroup)
    this.scene.add(this.resizeGroup)
    this.scene.add(this.axisGroup)
    this.renderer.localClippingEnabled = true

    // Key light exists mostly to cast the soft ground shadow; the softbox
    // environment provides the actual illumination.
    this.keyLight = new THREE.DirectionalLight(0xfff3e0, 1.5)
    this.keyLight.position.set(30, 55, 20)
    this.keyLight.castShadow = true
    this.keyLight.shadow.mapSize.set(2048, 2048)
    this.keyLight.shadow.bias = -0.0004
    this.keyLight.shadow.normalBias = 0.03
    this.keyLight.shadow.radius = 8
    this.scene.add(this.keyLight, this.keyLight.target)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.05))

    this.shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.32 }),
    )
    this.shadowCatcher.rotation.x = -Math.PI / 2
    this.shadowCatcher.receiveShadow = true
    this.shadowCatcher.visible = false
    this.scene.add(this.shadowCatcher)

    this.backMaterial = createBackMaterial()
    this.buildComposer()

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(container)

    // resizer / insertion-axis handle drag takes priority over tap-select / orbit
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      this.downPos.set(e.clientX, e.clientY)
      if (this.tryGrabHandle(e) || this.tryGrabAxisHandle(e) || this.tryStartPaint(e)) {
        this.controls.enabled = false
        try {
          this.renderer.domElement.setPointerCapture(e.pointerId)
        } catch {
          // non-fatal: drag still works via the move/up listeners
        }
      }
    })
    this.renderer.domElement.addEventListener('pointermove', (e) => {
      if (this.draggingHandle !== null) this.updateHandleDrag(e)
      else if (this.draggingAxis) this.updateAxisDrag(e)
      else if (this.painting) this.paintAt(e)
    })
    this.renderer.domElement.addEventListener('pointercancel', (e) => {
      this.endHandleDrag(e.pointerId)
      this.endAxisDrag(e.pointerId)
      this.endPaint(e.pointerId)
    })
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (this.draggingHandle !== null) {
        this.endHandleDrag(e.pointerId)
        return
      }
      if (this.draggingAxis) {
        this.endAxisDrag(e.pointerId)
        return
      }
      if (this.painting) {
        this.endPaint(e.pointerId)
        return
      }
      const dx = e.clientX - this.downPos.x
      const dy = e.clientY - this.downPos.y
      if (dx * dx + dy * dy < 25) this.handleTap(e)
    })

    this.renderer.setAnimationLoop(() => this.renderFrame())
  }

  // ---------- post-processing ----------

  private buildComposer() {
    this.composer?.dispose()
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
    })
    this.composer.addPass(new RenderPass(this.scene, this.activeCamera))

    const n8ao = new N8AOPostPass(this.scene, this.activeCamera, w, h)
    n8ao.configuration.aoRadius = 2.5
    n8ao.configuration.distanceFalloff = 4.0
    n8ao.configuration.intensity = 4.0
    n8ao.setQualityMode('High')
    this.composer.addPass(n8ao)

    const bloom = new BloomEffect({
      luminanceThreshold: 1.0,
      luminanceSmoothing: 0.6,
      intensity: 0.5,
      mipmapBlur: true,
    })
    const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })
    this.composer.addPass(new EffectPass(this.activeCamera, bloom, new SMAAEffect(), toneMapping))
    this.composer.setSize(w, h)
  }

  setPostFX(enabled: boolean) {
    this.postEnabled = enabled
    // fallback path needs renderer-side tone mapping
    this.renderer.toneMapping = enabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping
  }

  getPostFX(): boolean {
    return this.postEnabled
  }

  // ---------- events ----------

  on<K extends keyof SceneManagerEvents>(event: K, cb: SceneManagerEvents[K]): () => void {
    this.listeners[event].add(cb)
    return () => this.listeners[event].delete(cb)
  }

  private emit<K extends keyof SceneManagerEvents>(event: K, ...args: Parameters<SceneManagerEvents[K]>) {
    for (const cb of this.listeners[event]) {
      ;(cb as (...a: Parameters<SceneManagerEvents[K]>) => void)(...args)
    }
  }

  // ---------- parts ----------

  addPart(
    id: string,
    name: string,
    data: MeshData,
    matrix?: number[],
    appearance?: Partial<PartAppearance>,
    colors?: Float32Array,
  ): PartInfo {
    const displayGeometry = this.buildDisplayGeometry(data)
    const mesh = new THREE.Mesh(displayGeometry)
    mesh.castShadow = true
    const backMesh = new THREE.Mesh(displayGeometry, this.backMaterial)
    mesh.add(backMesh)
    mesh.userData.partId = id
    if (matrix) mesh.applyMatrix4(new THREE.Matrix4().fromArray(matrix))
    this.scene.add(mesh)

    const part: ScenePart = {
      id, name, mesh, backMesh, data, displayGeometry,
      materialOverride: appearance?.material ?? null,
      flatShading: appearance?.flatShading ?? false,
      vertexColors: colors && colors.length >= data.positions.length ? colors : null,
    }
    this.parts.set(id, part)
    this.partOrder.push(id)
    this.applyPartMaterial(part)
    this.updateShadowRig()
    this.emit('partsChanged')
    return this.partInfo(id)!
  }

  /** Get (or lazily build) the cached material for a preset + shading, with live clip planes. */
  private getMaterial(preset: MaterialPreset, flat: boolean): THREE.Material {
    const key = `${preset}:${flat}`
    let mat = this.matCache.get(key)
    if (!mat) {
      mat = createMaterial(preset, flat)
      this.matCache.set(key, mat)
    }
    mat.clippingPlanes = this.clipPlanes
    mat.clipShadows = true
    // section view needs interiors visible; otherwise the material's resting side
    mat.side = this.clipPlanes.length ? THREE.DoubleSide : (mat.userData.baseSide as THREE.Side)
    return mat
  }

  /** Get (or lazily build) a vertex-colour material (PLY colours, heatmap). */
  private getVertexColorMaterial(flat: boolean): THREE.Material {
    const key = `__vcolor:${flat}`
    let mat = this.matCache.get(key) as THREE.MeshStandardMaterial | undefined
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        vertexColors: true, metalness: 0, roughness: 0.85, flatShading: flat,
      })
      mat.userData.baseSide = THREE.FrontSide
      this.matCache.set(key, mat)
    }
    // keep section clipping working on coloured/heatmapped parts too
    mat.clippingPlanes = this.clipPlanes
    mat.clipShadows = true
    mat.side = this.clipPlanes.length ? THREE.DoubleSide : THREE.FrontSide
    return mat
  }

  /**
   * Whether a part should show its imported vertex colours: it has them, no
   * explicit per-part override, and the global mode is a normal lit one (the
   * debug modes — wireframe/normals/backface — still take precedence).
   */
  private showsVertexColors(part: ScenePart): boolean {
    if (!part.vertexColors || part.materialOverride !== null) return false
    return this.displayMode === 'gold' || this.displayMode === 'silver' || this.displayMode === 'studio'
  }

  /** Assign a part its effective material (override, else global mode) + back overlay. */
  private applyPartMaterial(part: ScenePart) {
    if (this.heatmap?.id === part.id) return // heatmap owns this part's material
    if (this.clearance?.id === part.id) return // clearance map owns this part's material
    if (this.survey?.id === part.id) return // undercut survey owns this part's material
    if (this.brush?.id === part.id) return // brush-select overlay owns this part's material
    if (this.showsVertexColors(part)) {
      this.applyColorAttribute(part, part.vertexColors!)
      part.mesh.material = this.getVertexColorMaterial(part.flatShading)
      part.backMesh.visible = false
      return
    }
    const preset = part.materialOverride ?? this.displayMode
    part.mesh.material = this.getMaterial(preset, part.flatShading)
    part.backMesh.visible = preset === 'backface'
  }

  /**
   * Write a per-source-vertex rgb field (0..1) onto the display geometry's
   * `color` attribute. buildDisplayGeometry's toCreasedNormals expands each
   * indexed triangle to three vertices in face order, so display vertex i maps to
   * source vertex data.indices[i] (or i directly if the geometry stays indexed).
   */
  private applyColorAttribute(part: ScenePart, srcColors: Float32Array) {
    const geo = part.displayGeometry
    const posAttr = geo.getAttribute('position')
    const vcount = posAttr.count
    const colors = new Float32Array(vcount * 3)
    const index = geo.getIndex()
    const map = part.data.indices
    for (let i = 0; i < vcount; i++) {
      let src = index ? index.getX(i) : (i < map.length ? map[i] : i)
      if (src * 3 + 2 >= srcColors.length) src = 0
      colors[i * 3] = srcColors[src * 3]
      colors[i * 3 + 1] = srcColors[src * 3 + 1]
      colors[i * 3 + 2] = srcColors[src * 3 + 2]
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  }

  setPartMaterial(id: string, material: MaterialPreset | null) {
    const part = this.parts.get(id)
    if (!part) return
    part.materialOverride = material
    this.applyPartMaterial(part)
    this.emit('partsChanged')
  }

  setPartFlatShading(id: string, flat: boolean) {
    const part = this.parts.get(id)
    if (!part) return
    part.flatShading = flat
    this.applyPartMaterial(part)
    this.emit('partsChanged')
  }

  private buildDisplayGeometry(data: MeshData): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions.slice(), 3))
    geometry.setIndex(new THREE.BufferAttribute(data.indices.slice(), 1))
    // hard edges stay hard, curved regions stay smooth
    const creased = toCreasedNormals(geometry, CREASE_ANGLE)
    geometry.dispose()
    creased.computeBoundingBox()
    creased.computeBoundingSphere()
    return creased
  }

  removePart(id: string) {
    const part = this.parts.get(id)
    if (!part) return
    if (this.heatmap?.id === id) this.heatmap = null
    if (this.clearance?.id === id) this.clearance = null
    if (this.survey?.id === id) this.survey = null
    if (this.brush?.id === id) { this.brush = null; this.painting = false }
    if (this.selectedId === id) this.select(null)
    this.scene.remove(part.mesh)
    part.displayGeometry.dispose()
    this.parts.delete(id)
    this.partOrder = this.partOrder.filter((p) => p !== id)
    this.updateShadowRig()
    this.emit('partsChanged')
  }

  clearParts() {
    for (const id of [...this.partOrder]) this.removePart(id)
  }

  renamePart(id: string, name: string) {
    const part = this.parts.get(id)
    if (!part) return
    part.name = name
    this.emit('partsChanged')
  }

  setPartVisible(id: string, visible: boolean) {
    const part = this.parts.get(id)
    if (!part) return
    part.mesh.visible = visible
    if (this.selectedId === id && !visible) this.select(null)
    this.updateShadowRig()
    this.emit('partsChanged')
  }

  listParts(): PartInfo[] {
    return this.partOrder.map((id) => this.partInfo(id)!).filter(Boolean)
  }

  partInfo(id: string): PartInfo | null {
    const part = this.parts.get(id)
    if (!part) return null
    const box = new THREE.Box3().setFromObject(part.mesh)
    const size = box.getSize(new THREE.Vector3())
    return {
      id,
      name: part.name,
      visible: part.mesh.visible,
      triangles: part.data.indices.length / 3,
      bbox: { x: size.x, y: size.y, z: size.z },
      material: part.materialOverride,
      flatShading: part.flatShading,
    }
  }

  /** Mesh data in world space (transform baked) — what repair/export operate on. */
  getWorldMeshData(id: string): MeshData | null {
    const part = this.parts.get(id)
    if (!part) return null
    part.mesh.updateWorldMatrix(true, false)
    const src = part.data.positions
    const positions = new Float32Array(src.length)
    const v = new THREE.Vector3()
    for (let i = 0; i < src.length; i += 3) {
      v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(part.mesh.matrixWorld)
      positions[i] = v.x
      positions[i + 1] = v.y
      positions[i + 2] = v.z
    }
    return { positions, indices: part.data.indices.slice() }
  }

  /** Local-space mesh data + transform matrix, for persistence. */
  getPartForSave(id: string): {
    data: MeshData
    matrix: number[]
    name: string
    visible: boolean
    material: MaterialPreset | null
    flatShading: boolean
    colors: Float32Array | null
  } | null {
    const part = this.parts.get(id)
    if (!part) return null
    return {
      data: {
        positions: part.data.positions.slice(),
        indices: part.data.indices.slice(),
      },
      matrix: part.mesh.matrix.toArray(),
      name: part.name,
      visible: part.mesh.visible,
      material: part.materialOverride,
      flatShading: part.flatShading,
      colors: part.vertexColors ? part.vertexColors.slice() : null,
    }
  }

  applyScale(id: string, factor: number) {
    const part = this.parts.get(id)
    if (!part || factor <= 0) return
    part.mesh.scale.multiplyScalar(factor)
    this.updateShadowRig()
    this.emit('partsChanged')
  }

  // ---------- selection & gizmo ----------

  select(id: string | null) {
    this.selectedId = id
    const part = id ? this.parts.get(id) : undefined
    if (part) this.gizmo.attach(part.mesh)
    else this.gizmo.detach()
    this.emit('selectionChanged', id)
  }

  getSelected(): string | null {
    return this.selectedId
  }

  setGizmoMode(mode: GizmoMode) {
    if (mode === 'none') {
      this.gizmo.detach()
      return
    }
    this.gizmo.setMode(mode)
    if (this.selectedId) this.gizmo.attach(this.parts.get(this.selectedId)!.mesh)
  }

  /** Pointer event → normalized device coords in the canvas. */
  private ndcOf(e: PointerEvent): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect()
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
  }

  private handleTap(e: PointerEvent) {
    if (this.brush) return // brush mode consumes taps (painting), never selects
    const ndc = this.ndcOf(e)
    this.raycaster.setFromCamera(ndc, this.activeCamera)
    const meshes = [...this.parts.values()].filter((p) => p.mesh.visible).map((p) => p.mesh)
    const hits = this.raycaster.intersectObjects(meshes, false)

    if (this.pickMode) {
      if (hits.length) {
        const p = this.snapToVertex(hits[0])
        this.emit('pointPicked', [p.x, p.y, p.z])
      }
      return
    }

    const id = hits.length ? (hits[0].object.userData.partId as string) : null
    if (id !== this.selectedId) this.select(id)
  }

  /** Snap a raycast hit to the nearest triangle vertex when within ~14 px. */
  private snapToVertex(hit: THREE.Intersection): THREE.Vector3 {
    const face = hit.face
    const mesh = hit.object as THREE.Mesh
    if (!face) return hit.point
    const pos = mesh.geometry.getAttribute('position')
    let best: THREE.Vector3 | null = null
    let bestDist = this.worldPerPixel(hit.point) * 14
    for (const i of [face.a, face.b, face.c]) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
      const d = v.distanceTo(hit.point)
      if (d < bestDist) {
        bestDist = d
        best = v
      }
    }
    return best ?? hit.point
  }

  // ---------- measurements ----------

  setPickMode(on: boolean) {
    this.pickMode = on
    if (!on) this.setPendingMarker(null)
  }

  /** Marker for the first picked point while waiting for the second. */
  setPendingMarker(point: Vec3 | null) {
    if (this.pendingMarker) {
      this.measureGroup.remove(this.pendingMarker)
      this.pendingMarker.geometry.dispose()
      ;(this.pendingMarker.material as THREE.Material).dispose()
      this.pendingMarker = null
    }
    if (!point) return
    this.pendingMarker = this.makeMarker('#e8c260')
    this.pendingMarker.position.fromArray(point)
    this.measureGroup.add(this.pendingMarker)
  }

  addMeasurement(m: Measurement) {
    this.removeMeasurement(m.id)
    const a = new THREE.Vector3().fromArray(m.a)
    const b = new THREE.Vector3().fromArray(m.b)
    const group = new THREE.Group()

    const lineGeo = new THREE.BufferGeometry().setFromPoints([a, b])
    const line = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: m.color, depthTest: false, transparent: true }),
    )
    line.renderOrder = 998
    group.add(line)

    const markers = [a, b].map((p) => {
      const marker = this.makeMarker(m.color)
      marker.position.copy(p)
      group.add(marker)
      return marker
    })

    const { sprite, aspect } = this.makeLabelSprite(`${m.distance.toFixed(2)} mm`, m.color)
    sprite.position.lerpVectors(a, b, 0.5)
    group.add(sprite)

    this.measureGroup.add(group)
    this.measureItems.set(m.id, { group, markers, sprite, aspect })
  }

  removeMeasurement(id: string) {
    const item = this.measureItems.get(id)
    if (!item) return
    this.measureGroup.remove(item.group)
    item.group.traverse((obj) => {
      const o = obj as THREE.Mesh
      o.geometry?.dispose()
      const mat = o.material as THREE.Material & { map?: THREE.Texture | null }
      mat?.map?.dispose?.()
      mat?.dispose?.()
    })
    this.measureItems.delete(id)
  }

  clearMeasurements() {
    for (const id of [...this.measureItems.keys()]) this.removeMeasurement(id)
    this.setPendingMarker(null)
  }

  private makeMarker(color: string): THREE.Mesh {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 12, 8),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }),
    )
    marker.renderOrder = 999
    return marker
  }

  private makeLabelSprite(text: string, color: string): { sprite: THREE.Sprite; aspect: number } {
    const dpr = 2
    const font = `600 ${36 * dpr}px ui-monospace, SF Mono, Menlo, monospace`
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    ctx.font = font
    const pad = 16 * dpr
    const textW = ctx.measureText(text).width
    canvas.width = Math.ceil(textW + pad * 2)
    canvas.height = 64 * dpr

    ctx.font = font
    ctx.textBaseline = 'middle'
    const r = 14 * dpr
    ctx.beginPath()
    ctx.roundRect(dpr, dpr, canvas.width - 2 * dpr, canvas.height - 2 * dpr, r)
    ctx.fillStyle = 'rgba(24, 22, 18, 0.92)'
    ctx.fill()
    ctx.lineWidth = 2 * dpr
    ctx.strokeStyle = color
    ctx.stroke()
    ctx.fillStyle = '#f2efe9'
    ctx.fillText(text, pad, canvas.height / 2 + 2 * dpr)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }),
    )
    sprite.renderOrder = 1000
    return { sprite, aspect: canvas.width / canvas.height }
  }

  /** World size of one screen pixel at a given point (both camera types). */
  private worldPerPixel(at: THREE.Vector3): number {
    const h = this.container.clientHeight || 1
    if (this.activeCamera === this.perspCamera) {
      const dist = this.perspCamera.position.distanceTo(at)
      return (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.perspCamera.fov) / 2)) / h
    }
    return (this.orthoCamera.top - this.orthoCamera.bottom) / (h * this.orthoCamera.zoom)
  }

  /** Keep measurement markers/labels a constant screen size. */
  private updateMeasureScales() {
    const MARKER_PX = 9
    const LABEL_PX = 30
    for (const item of this.measureItems.values()) {
      for (const marker of item.markers) {
        marker.scale.setScalar(this.worldPerPixel(marker.position) * MARKER_PX)
      }
      const labelH = this.worldPerPixel(item.sprite.position) * LABEL_PX
      item.sprite.scale.set(labelH * item.aspect, labelH, 1)
    }
    if (this.pendingMarker) {
      this.pendingMarker.scale.setScalar(
        this.worldPerPixel(this.pendingMarker.position) * (MARKER_PX + 3),
      )
    }
    // resizer handles + before/after labels keep a constant screen size too
    for (const handle of this.resizeHandles) {
      handle.scale.setScalar(this.worldPerPixel(handle.position) * 14)
    }
    // the insertion-axis arrowhead grab handle keeps a constant screen size
    if (this.axisGizmo && this.axisGroup.visible) {
      const at = this.axisGizmo.handle.getWorldPosition(new THREE.Vector3())
      this.axisGizmo.handle.scale.setScalar(this.worldPerPixel(at) * 11)
    }
    for (const child of this.resizeGroup.children) {
      const aspect = child.userData.labelAspect as number | undefined
      if (aspect === undefined) continue
      const h = this.worldPerPixel(child.position) * LABEL_PX
      child.scale.set(h * aspect, h, 1)
    }
  }

  // ---------- ring resizer (plan §2.6) ----------

  /**
   * Draw (or clear) the protected-sector gauge, drag handles and before/after
   * labels for the smart resizer. Rebuilt wholesale on every change — cheap, and
   * safe mid-drag because handles are grabbed by index, not object identity.
   */
  setResizeOverlay(overlay: ResizeOverlay | null) {
    this.clearResizeOverlay()
    this.resizeOverlay = overlay
    if (!overlay) return
    const { frame } = overlay
    const gap = Math.max(frame.outerR * 0.2, 1.5)
    const r0 = frame.outerR * 1.08
    const r1 = r0 + gap

    if (overlay.mode === 'uniform') {
      // the whole band resizes — highlight the full gauge ring
      this.resizeGroup.add(this.buildSectorMesh(overlay, 0, 360, r0, r1, 0xe8c260, 0.3))
    } else {
      const half = overlay.protectedDeg / 2
      const c = overlay.protectedCenterDeg
      // faint full ring for context, the rigid wedge, and the two blend zones
      this.resizeGroup.add(this.buildSectorMesh(overlay, 0, 360, r0, r1, 0x6b6256, 0.12))
      this.resizeGroup.add(this.buildSectorMesh(overlay, c - half, c + half, r0, r1, 0xe8c260, 0.6))
      this.resizeGroup.add(
        this.buildSectorMesh(overlay, c + half, c + half + overlay.smoothingDeg, r0, r1, 0x4fc3f7, 0.32),
      )
      this.resizeGroup.add(
        this.buildSectorMesh(overlay, c - half - overlay.smoothingDeg, c - half, r0, r1, 0x4fc3f7, 0.32),
      )
      // grabbable handles on the rigid-zone edges
      const rMid = (r0 + r1) / 2
      for (const [i, edge] of [c - half, c + half].entries()) {
        const handle = this.makeMarker('#f2efe9')
        handle.scale.setScalar(1)
        handle.position.fromArray(anglePointOnRing(frame, edge, rMid))
        handle.userData.handleIndex = i
        this.resizeGroup.add(handle)
        this.resizeHandles.push(handle)
      }
    }

    // before/after labels stacked above the ring (world up)
    const center = new THREE.Vector3()
    center.setComponent(frame.axis, frame.axialCenter)
    center.setComponent((frame.axis + 1) % 3, frame.center[0])
    center.setComponent((frame.axis + 2) % 3, frame.center[1])
    const up = new THREE.Vector3(0, 1, 0)
    const before = this.makeLabelSprite(overlay.beforeLabel, '#9aa0a8')
    before.sprite.position.copy(center).addScaledVector(up, frame.outerR * 1.4)
    before.sprite.userData.labelAspect = before.aspect
    const after = this.makeLabelSprite(overlay.afterLabel, '#e8c260')
    after.sprite.position.copy(center).addScaledVector(up, frame.outerR * 2.0)
    after.sprite.userData.labelAspect = after.aspect
    this.resizeGroup.add(before.sprite, after.sprite)
  }

  private buildSectorMesh(
    overlay: ResizeOverlay, a1Deg: number, a2Deg: number, r0: number, r1: number,
    color: number, opacity: number,
  ): THREE.Mesh {
    const { axis, center, axialCenter } = overlay.frame
    const u = (axis + 1) % 3
    const v = (axis + 2) % 3
    const span = a2Deg - a1Deg
    const steps = Math.max(2, Math.ceil(Math.abs(span) / 4))
    const positions: number[] = []
    const indices: number[] = []
    for (let s = 0; s <= steps; s++) {
      const rad = ((a1Deg + (span * s) / steps) * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      for (const r of [r0, r1]) {
        const p = [0, 0, 0]
        p[axis] = axialCenter
        p[u] = center[0] + r * cos
        p[v] = center[1] + r * sin
        positions.push(p[0], p[1], p[2])
      }
    }
    for (let s = 0; s < steps; s++) {
      const a = s * 2, b = s * 2 + 1, c = s * 2 + 2, d = s * 2 + 3
      indices.push(a, b, d, a, d, c)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setIndex(indices)
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, side: THREE.DoubleSide,
        depthTest: false, depthWrite: false,
      }),
    )
    mesh.renderOrder = 996
    return mesh
  }

  /** Did pointer-down land on a sector handle? Arms the drag if so. */
  private tryGrabHandle(e: PointerEvent): boolean {
    if (!this.resizeHandles.length) return false
    this.raycaster.setFromCamera(this.ndcOf(e), this.activeCamera)
    const hits = this.raycaster.intersectObjects(this.resizeHandles, false)
    if (!hits.length) return false
    this.draggingHandle = hits[0].object.userData.handleIndex as number
    return true
  }

  /** Project the pointer onto the ring plane → symmetric protected width, emit. */
  private updateHandleDrag(e: PointerEvent) {
    const overlay = this.resizeOverlay
    if (!overlay) return
    this.raycaster.setFromCamera(this.ndcOf(e), this.activeCamera)
    const normal = new THREE.Vector3().setComponent(overlay.frame.axis, 1)
    const onPlane = new THREE.Vector3().setComponent(overlay.frame.axis, overlay.frame.axialCenter)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, onPlane)
    const hit = new THREE.Vector3()
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return
    const angle = pointAngleDeg([hit.x, hit.y, hit.z], overlay.frame)
    const half = Math.abs(((angle - overlay.protectedCenterDeg + 540) % 360) - 180)
    const protectedDeg = Math.min(Math.max(half * 2, 4), 176)
    this.emit('resizeHandleDrag', protectedDeg)
  }

  /** End a handle drag from any exit path (up / cancel / overlay cleared). */
  private endHandleDrag(pointerId?: number) {
    if (this.draggingHandle === null) return
    this.draggingHandle = null
    this.controls.enabled = true
    if (pointerId !== undefined) {
      try {
        this.renderer.domElement.releasePointerCapture(pointerId)
      } catch {
        // capture may never have been acquired
      }
    }
  }

  private clearResizeOverlay() {
    this.endHandleDrag()
    this.resizeHandles = []
    for (const child of [...this.resizeGroup.children]) {
      this.resizeGroup.remove(child)
      const obj = child as THREE.Mesh
      obj.geometry?.dispose()
      const mat = obj.material as (THREE.Material & { map?: THREE.Texture | null }) | undefined
      mat?.map?.dispose?.()
      mat?.dispose?.()
    }
  }

  // ---------- section / clipping ----------

  setSection(opts: SectionOptions | null) {
    if (this.sectionHelper) {
      this.scene.remove(this.sectionHelper)
      this.sectionHelper.traverse((obj) => {
        const o = obj as THREE.Mesh
        o.geometry?.dispose()
        ;(o.material as THREE.Material | undefined)?.dispose?.()
      })
      this.sectionHelper = null
    }

    let planes: THREE.Plane[] = []
    if (opts) {
      const axis = new THREE.Vector3(
        opts.axis === 'x' ? 1 : 0,
        opts.axis === 'y' ? 1 : 0,
        opts.axis === 'z' ? 1 : 0,
      )
      if (opts.slice) {
        // keep position ≤ coord ≤ position + thickness
        planes = [
          new THREE.Plane(axis.clone(), -opts.position),
          new THREE.Plane(axis.clone().negate(), opts.position + opts.thickness),
        ]
      } else if (opts.flip) {
        // keep coord ≥ position
        planes = [new THREE.Plane(axis.clone(), -opts.position)]
      } else {
        // keep coord ≤ position
        planes = [new THREE.Plane(axis.clone().negate(), opts.position)]
      }
      this.sectionHelper = this.buildSectionHelper(opts, axis)
      if (this.sectionHelper) this.scene.add(this.sectionHelper)
    }

    this.clipPlanes = planes
    // apply to every built material (cache + the shared back overlay)
    for (const mat of [...this.matCache.values(), this.backMaterial]) {
      mat.clippingPlanes = planes
      mat.clipShadows = true
      // show the interior while cut open; otherwise restore the resting side.
      // Only the back overlay is excluded — it must stay BackSide; the wireframe
      // preset (also MeshBasicMaterial) should still toggle.
      const base = (mat.userData.baseSide as THREE.Side) ?? THREE.FrontSide
      if (mat !== this.backMaterial) {
        mat.side = planes.length ? THREE.DoubleSide : base
        mat.needsUpdate = true
      }
    }
  }

  /** Translucent gold quad showing where the cut plane sits. */
  private buildSectionHelper(opts: SectionOptions, axis: THREE.Vector3): THREE.Object3D | null {
    const box = this.partsBox()
    if (box.isEmpty()) return null
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    // after rotating +z onto the axis, the plane's local x/y land on:
    const [lw, lh] = {
      x: [size.z, size.y],
      y: [size.x, size.z],
      z: [size.x, size.y],
    }[opts.axis]
    const w = Math.max(lw, 1) * 1.15
    const h = Math.max(lh, 1) * 1.15

    const group = new THREE.Group()
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: 0xc9a554,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(quad.geometry),
      new THREE.LineBasicMaterial({ color: 0xc9a554, transparent: true, opacity: 0.5 }),
    )
    group.add(quad, border)

    // PlaneGeometry faces +z with extents (x=w, y=h); orient its normal and
    // in-plane axes to match the cut axis, then position at the cut.
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis)
    const pos = center.clone()
    pos.setComponent('xyz'.indexOf(opts.axis), opts.position)
    group.position.copy(pos)
    return group
  }

  /** World-space bounds of all visible parts, or null when the scene is empty. */
  getSceneBounds(): { min: Vec3; max: Vec3 } | null {
    const box = this.partsBox()
    if (box.isEmpty()) return null
    return {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
    }
  }

  // ---------- display ----------

  setDisplayMode(mode: DisplayMode) {
    this.displayMode = mode
    // only parts following the global mode change; per-part overrides stay put
    for (const part of this.parts.values()) {
      if (part.materialOverride === null) this.applyPartMaterial(part)
    }
  }

  setBackground(name: string) {
    this.backgroundTexture?.dispose()
    this.backgroundTexture = createBackgroundTexture(name)
    this.scene.background = this.backgroundTexture
  }

  setGridVisible(visible: boolean) {
    this.grid.visible = visible
  }

  setTurntable(on: boolean) {
    this.turntable = on
    this.controls.autoRotate = on
    this.controls.autoRotateSpeed = 1.5
  }

  isTurntable(): boolean {
    return this.turntable
  }

  /** Fit the shadow light + catcher plane to the current scene contents. */
  private updateShadowRig() {
    const box = this.partsBox()
    if (box.isEmpty()) {
      this.shadowCatcher.visible = false
      return
    }
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1)

    this.shadowCatcher.visible = true
    this.shadowCatcher.scale.setScalar(radius * 12)
    this.shadowCatcher.position.set(center.x, box.min.y - 0.02, center.z)

    this.keyLight.position.copy(center).add(new THREE.Vector3(0.6, 1.6, 0.45).multiplyScalar(radius * 2.2))
    this.keyLight.target.position.copy(center)
    const cam = this.keyLight.shadow.camera
    cam.left = -radius * 1.8
    cam.right = radius * 1.8
    cam.top = radius * 1.8
    cam.bottom = -radius * 1.8
    cam.near = 0.1
    cam.far = radius * 8
    cam.updateProjectionMatrix()
  }

  // ---------- analysis highlights ----------

  showAnalysisHighlights(report: AnalysisReport) {
    this.clearHighlights()
    if (report.boundaryEdgePositions.length >= 6) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(report.boundaryEdgePositions, 3))
      const lines = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ color: 0xff4040, depthTest: false }),
      )
      lines.renderOrder = 999
      this.highlightGroup.add(lines)
    }
    if (report.flippedFacePositions.length >= 3) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(report.flippedFacePositions, 3))
      const pts = new THREE.Points(
        g,
        new THREE.PointsMaterial({ color: 0x4090ff, size: 0.6, depthTest: false }),
      )
      pts.renderOrder = 999
      this.highlightGroup.add(pts)
    }
  }

  clearHighlights() {
    for (const child of [...this.highlightGroup.children]) {
      this.highlightGroup.remove(child)
      const obj = child as THREE.Mesh
      obj.geometry?.dispose()
      ;(obj.material as THREE.Material | undefined)?.dispose?.()
    }
  }

  // ---------- wall-thickness heatmap (plan §2.3) ----------

  /**
   * Paint a per-source-vertex thickness field onto a part: red (thin) → green →
   * blue (thick), with everything at/under `threshold` mm in hard red. Transient
   * overlay (recomputed on demand, never autosaved) — mirrors the analysis
   * highlight pattern. Dragging the threshold goes through setHeatmapThreshold,
   * which only recolours.
   */
  setThicknessHeatmap(
    id: string,
    values: Float32Array,
    range: { min: number; max: number },
    threshold: number,
  ) {
    const part = this.parts.get(id)
    if (!part) return
    // the thickness heatmap, clearance map and undercut survey are mutually exclusive overlays
    this.clearClearanceMap()
    this.clearUndercutSurvey()
    if (this.heatmap && this.heatmap.id !== id) this.clearThicknessHeatmap()
    this.heatmap = { id, values, min: range.min, max: range.max, threshold }
    this.paintHeatmap(part)
  }

  /** Recolour the active heatmap for a new minimum-thickness threshold. */
  setHeatmapThreshold(threshold: number) {
    if (!this.heatmap) return
    this.heatmap.threshold = threshold
    const part = this.parts.get(this.heatmap.id)
    if (part) this.paintHeatmap(part)
  }

  private paintHeatmap(part: ScenePart) {
    const h = this.heatmap!
    const srcColors = new Float32Array(part.data.positions.length)
    for (let v = 0; v < h.values.length; v++) {
      const [r, g, b] = thicknessColor(h.values[v], h.min, h.max, h.threshold)
      srcColors[v * 3] = r
      srcColors[v * 3 + 1] = g
      srcColors[v * 3 + 2] = b
    }
    this.applyColorAttribute(part, srcColors)
    part.mesh.material = this.getVertexColorMaterial(part.flatShading)
    part.backMesh.visible = false
  }

  clearThicknessHeatmap() {
    const h = this.heatmap
    if (!h) return
    this.heatmap = null
    const part = this.parts.get(h.id)
    if (part) this.applyPartMaterial(part) // restores preset / imported colours
  }

  hasThicknessHeatmap(): boolean {
    return this.heatmap !== null
  }

  // ---------- grillz clearance map (plan §3.1) ----------

  /**
   * Paint a per-source-vertex signed clearance field onto the grillz shell: red
   * ≤ 0 (touch/interference) → green (in the cement-gap band [lo, hi]) → blue
   * (too loose). Transient overlay, mutually exclusive with the wall-thickness
   * heatmap. Dragging the band goes through setClearanceBand, which only recolours.
   */
  /** Returns true when the map was painted; false if the target part is gone. */
  setClearanceMap(id: string, values: Float32Array, band: { lo: number; hi: number }): boolean {
    const part = this.parts.get(id)
    if (!part) return false
    this.clearThicknessHeatmap()
    this.clearUndercutSurvey()
    if (this.clearance && this.clearance.id !== id) this.clearClearanceMap()
    this.clearance = { id, values, lo: band.lo, hi: band.hi }
    this.paintClearance(part)
    return true
  }

  /** Recolour the active clearance map for a new tolerance band. */
  setClearanceBand(lo: number, hi: number) {
    if (!this.clearance) return
    this.clearance.lo = lo
    this.clearance.hi = hi
    const part = this.parts.get(this.clearance.id)
    if (part) this.paintClearance(part)
  }

  private paintClearance(part: ScenePart) {
    const c = this.clearance!
    const srcColors = new Float32Array(part.data.positions.length)
    for (let v = 0; v < c.values.length; v++) {
      const [r, g, b] = clearanceColor(c.values[v], c.lo, c.hi)
      srcColors[v * 3] = r
      srcColors[v * 3 + 1] = g
      srcColors[v * 3 + 2] = b
    }
    this.applyColorAttribute(part, srcColors)
    part.mesh.material = this.getVertexColorMaterial(part.flatShading)
    part.backMesh.visible = false
  }

  clearClearanceMap() {
    const c = this.clearance
    if (!c) return
    this.clearance = null
    const part = this.parts.get(c.id)
    if (part) this.applyPartMaterial(part) // restores preset / imported colours
  }

  hasClearanceMap(): boolean {
    return this.clearance !== null
  }

  // ---------- grillz undercut survey (plan §3.2) ----------

  /**
   * Paint a per-source-vertex undercut field onto the tooth scan: neutral where
   * the surface draws cleanly along the insertion axis, amber → red on undercut
   * regions by depth (the classic survey view). Transient overlay, mutually
   * exclusive with the heatmap + clearance map. Returns true when it painted.
   */
  setUndercutSurvey(id: string, values: Float32Array): boolean {
    const part = this.parts.get(id)
    if (!part) return false
    this.clearThicknessHeatmap()
    this.clearClearanceMap()
    if (this.survey && this.survey.id !== id) this.clearUndercutSurvey()
    this.survey = { id, values }
    this.paintSurvey(part)
    return true
  }

  private paintSurvey(part: ScenePart) {
    const s = this.survey!
    const srcColors = new Float32Array(part.data.positions.length)
    for (let v = 0; v < s.values.length; v++) {
      const [r, g, b] = undercutColor(s.values[v])
      srcColors[v * 3] = r
      srcColors[v * 3 + 1] = g
      srcColors[v * 3 + 2] = b
    }
    this.applyColorAttribute(part, srcColors)
    part.mesh.material = this.getVertexColorMaterial(part.flatShading)
    part.backMesh.visible = false
  }

  clearUndercutSurvey() {
    const s = this.survey
    if (!s) return
    this.survey = null
    const part = this.parts.get(s.id)
    if (part) this.applyPartMaterial(part) // restores preset / imported colours
  }

  hasUndercutSurvey(): boolean {
    return this.survey !== null
  }

  // ---------- grillz surface brush-select (plan §3.3) ----------

  /**
   * Arm/disarm the surface brush on part `id` (null disarms). Drag over the scan to
   * paint the teeth the shell will cover (hold Alt to erase). The selection is shown
   * as a transient overlay; world-space vertex positions are cached up front so each
   * stroke move is a single O(verts) radius pass. Re-arming the same part keeps the
   * existing selection.
   */
  setBrushSelect(id: string | null, radius: number) {
    if (!id) {
      this.clearBrushOverlay()
      return
    }
    const part = this.parts.get(id)
    if (!part) return
    if (this.brush && this.brush.id !== id) this.clearBrushOverlay()
    // the brush overlay is mutually exclusive with the other vertex-colour overlays
    this.clearThicknessHeatmap()
    this.clearClearanceMap()
    this.clearUndercutSurvey()
    const selected = this.brush?.id === id ? this.brush.selected : new Set<number>()
    this.brush = { id, radius, selected, worldPos: this.worldVertexPositions(part) }
    this.paintBrushOverlay(part)
  }

  setBrushRadius(radius: number) {
    if (this.brush) this.brush.radius = radius
  }

  /** Empty the painted selection (keeps the brush armed). */
  clearBrushSelection() {
    if (!this.brush) return
    this.brush.selected.clear()
    const part = this.parts.get(this.brush.id)
    if (part) this.paintBrushOverlay(part)
    this.emit('brushSelectionChanged', 0)
  }

  /** The painted selection as source-vertex indices, or null if none/unarmed. */
  getBrushSelection(): { id: string; indices: Uint32Array } | null {
    if (!this.brush || this.brush.selected.size === 0) return null
    return { id: this.brush.id, indices: Uint32Array.from(this.brush.selected) }
  }

  hasBrushSelect(): boolean {
    return this.brush !== null
  }

  /** Begin a paint stroke if the brush is armed and the pointer is over its part. */
  private tryStartPaint(e: PointerEvent): boolean {
    if (!this.brush) return false
    const part = this.parts.get(this.brush.id)
    if (!part || !part.mesh.visible) return false
    this.raycaster.setFromCamera(this.ndcOf(e), this.activeCamera)
    if (!this.raycaster.intersectObject(part.mesh, false).length) return false
    this.painting = true
    this.paintAt(e)
    return true
  }

  /** Add (or, with Alt, remove) all selected-part vertices within the brush radius of the hit. */
  private paintAt(e: PointerEvent) {
    const brush = this.brush
    if (!brush) return
    const part = this.parts.get(brush.id)
    if (!part) return
    this.raycaster.setFromCamera(this.ndcOf(e), this.activeCamera)
    const hits = this.raycaster.intersectObject(part.mesh, false)
    if (!hits.length) return
    const { x, y, z } = hits[0].point
    const r2 = brush.radius * brush.radius
    const erase = e.altKey
    const pos = brush.worldPos
    let changed = false
    for (let v = 0; v < pos.length / 3; v++) {
      const dx = pos[v * 3] - x, dy = pos[v * 3 + 1] - y, dz = pos[v * 3 + 2] - z
      if (dx * dx + dy * dy + dz * dz > r2) continue
      if (erase) changed = brush.selected.delete(v) || changed
      else if (!brush.selected.has(v)) { brush.selected.add(v); changed = true }
    }
    if (!changed) return
    this.paintBrushOverlay(part)
    this.emit('brushSelectionChanged', brush.selected.size)
  }

  private endPaint(pointerId: number) {
    if (!this.painting) return
    this.painting = false
    this.controls.enabled = true
    try {
      this.renderer.domElement.releasePointerCapture(pointerId)
    } catch {
      // capture may never have been taken; ignore
    }
  }

  /** World-space copy of a part's source vertices (data-order, for the brush radius test). */
  private worldVertexPositions(part: ScenePart): Float32Array {
    const src = part.data.positions
    const out = new Float32Array(src.length)
    const m = part.mesh.matrixWorld
    const v = new THREE.Vector3()
    for (let i = 0; i < src.length; i += 3) {
      v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(m)
      out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z
    }
    return out
  }

  private paintBrushOverlay(part: ScenePart) {
    const sel = this.brush!.selected
    const srcColors = new Float32Array(part.data.positions.length)
    for (let v = 0; v < srcColors.length / 3; v++) {
      const on = sel.has(v)
      srcColors[v * 3] = on ? 0.12 : 0.6
      srcColors[v * 3 + 1] = on ? 0.8 : 0.6
      srcColors[v * 3 + 2] = on ? 0.95 : 0.6
    }
    this.applyColorAttribute(part, srcColors)
    part.mesh.material = this.getVertexColorMaterial(part.flatShading)
    part.backMesh.visible = false
  }

  private clearBrushOverlay() {
    const b = this.brush
    if (!b) return
    this.brush = null
    this.painting = false
    const part = this.parts.get(b.id)
    if (part) this.applyPartMaterial(part) // restores preset / imported colours
  }

  // ---------- insertion-axis gizmo (plan §3.2) ----------

  /**
   * Show (or re-target) the draggable insertion-axis arrow at `center`, pointing
   * along `axis`, with the shaft `length` world units long. Rebuilt when the
   * length changes; otherwise just re-oriented. Dragging the arrowhead emits
   * `insertionAxisChanged`.
   */
  showInsertionAxis(center: Vec3, length: number, axis: Vec3) {
    const c = new THREE.Vector3(center[0], center[1], center[2])
    if (!this.axisGizmo || Math.abs(this.axisGizmo.length - length) > length * 0.01) {
      this.buildAxisGizmo(length)
    }
    this.axisGizmo!.center.copy(c)
    this.axisGroup.position.copy(c)
    this.axisGroup.visible = true
    this.setInsertionAxisDirection(axis)
  }

  /** Re-orient the arrow without rebuilding it (e.g. after a best-axis search). */
  setInsertionAxisDirection(axis: Vec3) {
    if (!this.axisGizmo) return
    const dir = new THREE.Vector3(axis[0], axis[1], axis[2])
    if (dir.lengthSq() === 0) return
    dir.normalize()
    this.axisGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  }

  hideInsertionAxis() {
    this.endAxisDrag()
    for (const child of [...this.axisGroup.children]) {
      this.axisGroup.remove(child)
      const obj = child as THREE.Mesh
      obj.geometry?.dispose()
      ;(obj.material as THREE.Material | undefined)?.dispose?.()
    }
    this.axisGizmo = null
    this.axisGroup.visible = false
  }

  /** Build the arrow (shaft + head + grab handle) along local +Y, length `len`. */
  private buildAxisGizmo(len: number) {
    this.hideInsertionAxis()
    const shaftR = len * 0.02
    const headLen = len * 0.16
    const headR = len * 0.06
    const accent = 0x6cc0ff
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftR, shaftR, len - headLen, 12),
      new THREE.MeshBasicMaterial({ color: accent, depthTest: false, transparent: true, opacity: 0.9 }),
    )
    shaft.position.y = (len - headLen) / 2
    shaft.renderOrder = 998
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(headR, headLen, 16),
      new THREE.MeshBasicMaterial({ color: accent, depthTest: false, transparent: true, opacity: 0.9 }),
    )
    head.position.y = len - headLen / 2
    head.renderOrder = 998
    const handle = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xf2efe9, depthTest: false, transparent: true }),
    )
    handle.position.y = len
    handle.renderOrder = 999
    this.axisGroup.add(shaft, head, handle)
    this.axisGizmo = { group: this.axisGroup, handle, length: len, center: new THREE.Vector3() }
  }

  /** Did pointer-down land on the axis arrowhead? Arms the arcball drag if so. */
  private tryGrabAxisHandle(e: PointerEvent): boolean {
    if (!this.axisGizmo || !this.axisGroup.visible) return false
    this.raycaster.setFromCamera(this.ndcOf(e), this.activeCamera)
    if (!this.raycaster.intersectObject(this.axisGizmo.handle, false).length) return false
    this.draggingAxis = true
    return true
  }

  /** Arcball: intersect the pointer ray with a sphere about the gizmo origin → new axis. */
  private updateAxisDrag(e: PointerEvent) {
    const g = this.axisGizmo
    if (!g) return
    this.raycaster.setFromCamera(this.ndcOf(e), this.activeCamera)
    const sphere = new THREE.Sphere(g.center, g.length)
    const hit = new THREE.Vector3()
    if (!this.raycaster.ray.intersectSphere(sphere, hit)) {
      // ray misses the sphere — clamp to the nearest point on the ray (the silhouette)
      this.raycaster.ray.closestPointToPoint(g.center, hit)
    }
    const dir = hit.sub(g.center)
    if (dir.lengthSq() === 0) return
    dir.normalize()
    this.axisGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    this.emit('insertionAxisChanged', [dir.x, dir.y, dir.z])
  }

  private endAxisDrag(pointerId?: number) {
    if (!this.draggingAxis) return
    this.draggingAxis = false
    this.controls.enabled = true
    if (pointerId !== undefined) {
      try {
        this.renderer.domElement.releasePointerCapture(pointerId)
      } catch {
        // capture may never have been acquired
      }
    }
  }

  // ---------- camera ----------

  setProjection(p: Projection) {
    const from = this.activeCamera
    const to = p === 'perspective' ? this.perspCamera : this.orthoCamera
    if (from === to) return
    to.position.copy((from as THREE.PerspectiveCamera).position)
    if (to === this.orthoCamera) {
      const dist = this.perspCamera.position.distanceTo(this.controls.target)
      const halfH = dist * Math.tan((this.perspCamera.fov * Math.PI) / 360)
      const aspect = this.aspect()
      this.orthoCamera.top = halfH
      this.orthoCamera.bottom = -halfH
      this.orthoCamera.left = -halfH * aspect
      this.orthoCamera.right = halfH * aspect
      this.orthoCamera.updateProjectionMatrix()
    }
    this.activeCamera = to
    this.controls.object = to
    this.gizmo.camera = to
    this.controls.update()
    this.buildComposer()
  }

  getProjection(): Projection {
    return this.activeCamera === this.perspCamera ? 'perspective' : 'orthographic'
  }

  setViewPreset(preset: ViewPreset) {
    const target = this.sceneCenter()
    const dist = Math.max(this.sceneRadius() * 2.5, 20)
    const dir = {
      top: new THREE.Vector3(0, 1, 0.0001),
      front: new THREE.Vector3(0, 0, 1),
      left: new THREE.Vector3(-1, 0, 0),
      right: new THREE.Vector3(1, 0, 0),
      iso: new THREE.Vector3(1, 0.8, 1).normalize(),
    }[preset]
    this.tweenCameraTo(target.clone().addScaledVector(dir, dist), target)
  }

  fitToView() {
    const target = this.sceneCenter()
    const dist = Math.max(this.sceneRadius() * 2.5, 20)
    const dir = new THREE.Vector3()
      .subVectors((this.activeCamera as THREE.PerspectiveCamera).position, this.controls.target)
      .normalize()
    if (dir.lengthSq() === 0) dir.set(1, 0.8, 1).normalize()
    this.tweenCameraTo(target.clone().addScaledVector(dir, dist), target)
  }

  private sceneCenter(): THREE.Vector3 {
    const box = this.partsBox()
    return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
  }

  private sceneRadius(): number {
    const box = this.partsBox()
    if (box.isEmpty()) return 10
    return box.getSize(new THREE.Vector3()).length() / 2
  }

  private partsBox(): THREE.Box3 {
    const box = new THREE.Box3()
    for (const part of this.parts.values()) {
      if (part.mesh.visible) box.expandByObject(part.mesh)
    }
    return box
  }

  private tweenCameraTo(pos: THREE.Vector3, target: THREE.Vector3) {
    this.tween = {
      fromPos: (this.activeCamera as THREE.PerspectiveCamera).position.clone(),
      toPos: pos,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      start: performance.now(),
      duration: 450,
    }
  }

  /** Quick capture of the viewport as the user sees it. */
  snapshotPNG(): string {
    this.renderScene()
    return this.renderer.domElement.toDataURL('image/png')
  }

  /**
   * Clean high-resolution client render: helpers hidden, full post stack,
   * rendered at `width` px regardless of viewport size.
   */
  renderPreviewPNG(width = 2048): string {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const outW = width
    const outH = Math.round((width * h) / w)

    const hidden: THREE.Object3D[] = [
      this.grid, this.gizmoHelper, this.highlightGroup, this.resizeGroup, this.axisGroup,
    ]
    if (this.sectionHelper) hidden.push(this.sectionHelper)
    const prevVisible = hidden.map((o) => o.visible)
    hidden.forEach((o) => (o.visible = false))
    const prevPixelRatio = this.renderer.getPixelRatio()

    this.renderer.setPixelRatio(1)
    this.renderer.setSize(outW, outH, false)
    this.composer?.setSize(outW, outH, false)
    this.renderScene()
    const url = this.renderer.domElement.toDataURL('image/png')

    this.renderer.setPixelRatio(prevPixelRatio)
    this.renderer.setSize(w, h)
    this.composer?.setSize(w, h)
    hidden.forEach((o, i) => (o.visible = prevVisible[i]))
    return url
  }

  // ---------- mesh export (plan §2.7) ----------

  /**
   * GLB/GLTF export. Lives behind the facade because GLTFExporter needs THREE
   * objects; STL/OBJ stay pure in core/io/exporters. Builds a throwaway scene
   * from the given (already world-space, shrinkage-applied) meshes so the result
   * is independent of display materials and viewport state. `binary` → GLB
   * ArrayBuffer, otherwise a pretty-printed glTF JSON string.
   */
  exportGLTF(parts: NamedMesh[], opts: { binary: boolean }): Promise<ArrayBuffer | string> {
    const root = new THREE.Group()
    const material = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.0, roughness: 0.6 })
    for (const { name, mesh } of parts) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3))
      geo.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1))
      geo.computeVertexNormals()
      const m = new THREE.Mesh(geo, material)
      m.name = name
      root.add(m)
    }
    return new Promise((resolve, reject) => {
      new GLTFExporter().parse(
        root,
        (result) => {
          root.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
          material.dispose()
          resolve(result as ArrayBuffer | string)
        },
        (err) => {
          root.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
          material.dispose()
          reject(err instanceof Error ? err : new Error(String(err)))
        },
        { binary: opts.binary },
      )
    })
  }

  // ---------- loop & lifecycle ----------

  private renderScene() {
    if (this.postEnabled && this.composer) this.composer.render()
    else this.renderer.render(this.scene, this.activeCamera)
  }

  private renderFrame() {
    if (this.disposed) return
    if (this.tween) {
      const t = Math.min((performance.now() - this.tween.start) / this.tween.duration, 1)
      const e = 1 - Math.pow(1 - t, 3) // easeOutCubic
      ;(this.activeCamera as THREE.PerspectiveCamera).position.lerpVectors(
        this.tween.fromPos, this.tween.toPos, e,
      )
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e)
      if (t >= 1) this.tween = null
    }
    this.controls.update()
    this.updateMeasureScales()
    this.renderScene()
  }

  private aspect(): number {
    return (this.container.clientWidth || 1) / (this.container.clientHeight || 1)
  }

  private handleResize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.composer?.setSize(w, h)
    this.perspCamera.aspect = w / h
    this.perspCamera.updateProjectionMatrix()
    const halfH = this.orthoCamera.top
    this.orthoCamera.left = -halfH * (w / h)
    this.orthoCamera.right = halfH * (w / h)
    this.orthoCamera.updateProjectionMatrix()
  }

  dispose() {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.clearHighlights()
    this.clearMeasurements()
    this.clearResizeOverlay()
    this.hideInsertionAxis()
    this.setSection(null)
    this.clearParts()
    for (const mat of this.matCache.values()) mat.dispose()
    this.matCache.clear()
    this.backMaterial.dispose()
    this.composer?.dispose()
    this.controls.dispose()
    this.gizmo.dispose()
    this.backgroundTexture?.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
