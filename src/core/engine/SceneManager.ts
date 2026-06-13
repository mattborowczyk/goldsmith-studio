import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
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
  SectionOptions,
  Vec3,
  ViewPreset,
} from '../types'
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
}

export interface SceneManagerEvents {
  /** Parts added/removed/renamed/transformed — UI + autosave listen to this. */
  partsChanged: () => void
  /** Selection changed from a viewport tap. */
  selectionChanged: (id: string | null) => void
  /** A surface/vertex point was picked while measure-pick mode is armed. */
  pointPicked: (point: Vec3) => void
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
  private sectionHelper: THREE.Object3D | null = null
  private backgroundTexture: THREE.Texture | null = null
  private listeners: { [K in keyof SceneManagerEvents]: Set<SceneManagerEvents[K]> } = {
    partsChanged: new Set(),
    selectionChanged: new Set(),
    pointPicked: new Set(),
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
      this.controls.enabled = !(e as unknown as { value: boolean }).value
      if (!(e as unknown as { value: boolean }).value) this.emit('partsChanged')
    })
    this.gizmoHelper = this.gizmo.getHelper()
    this.scene.add(this.gizmoHelper)

    this.grid = new THREE.GridHelper(100, 50, 0x4a4640, 0x2e2c28)
    this.scene.add(this.grid)
    this.scene.add(this.highlightGroup)
    this.scene.add(this.measureGroup)
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

    // tap-select (only when the pointer didn't drag)
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      this.downPos.set(e.clientX, e.clientY)
    })
    this.renderer.domElement.addEventListener('pointerup', (e) => {
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

  /** Assign a part its effective material (override, else global mode) + back overlay. */
  private applyPartMaterial(part: ScenePart) {
    const preset = part.materialOverride ?? this.displayMode
    part.mesh.material = this.getMaterial(preset, part.flatShading)
    part.backMesh.visible = preset === 'backface'
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

  private handleTap(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
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
      // show the interior while cut open; otherwise restore the resting side
      const base = (mat.userData.baseSide as THREE.Side) ?? THREE.FrontSide
      if (!(mat instanceof THREE.MeshBasicMaterial)) {
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

    const hidden: THREE.Object3D[] = [this.grid, this.gizmoHelper, this.highlightGroup]
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
