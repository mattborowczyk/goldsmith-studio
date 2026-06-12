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
  MeshData,
  PartInfo,
  Projection,
  ViewPreset,
} from '../types'
import { createMaterials, type DisplayMaterialSet } from './materials'
import { createBackgroundTexture, createStudioEnvironment } from './environment'

interface ScenePart {
  id: string
  name: string
  mesh: THREE.Mesh
  backMesh: THREE.Mesh
  /** Source-of-truth geometry for repair/export/persistence. */
  data: MeshData
  displayGeometry: THREE.BufferGeometry
}

export interface SceneManagerEvents {
  /** Parts added/removed/renamed/transformed — UI + autosave listen to this. */
  partsChanged: () => void
  /** Selection changed from a viewport tap. */
  selectionChanged: (id: string | null) => void
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
  private materials: Record<DisplayMode, DisplayMaterialSet>
  private displayMode: DisplayMode = 'gold'
  private parts = new Map<string, ScenePart>()
  private partOrder: string[] = []
  private selectedId: string | null = null
  private grid: THREE.GridHelper
  private keyLight: THREE.DirectionalLight
  private shadowCatcher: THREE.Mesh
  private highlightGroup = new THREE.Group()
  private backgroundTexture: THREE.Texture | null = null
  private listeners: { [K in keyof SceneManagerEvents]: Set<SceneManagerEvents[K]> } = {
    partsChanged: new Set(),
    selectionChanged: new Set(),
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

    this.materials = createMaterials()
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

  addPart(id: string, name: string, data: MeshData, matrix?: number[]): PartInfo {
    const displayGeometry = this.buildDisplayGeometry(data)
    const set = this.materials[this.displayMode]
    const mesh = new THREE.Mesh(displayGeometry, set.main)
    mesh.castShadow = true
    const backMesh = new THREE.Mesh(displayGeometry, set.back)
    backMesh.visible = this.displayMode === 'backface'
    mesh.add(backMesh)
    mesh.userData.partId = id
    if (matrix) mesh.applyMatrix4(new THREE.Matrix4().fromArray(matrix))
    this.scene.add(mesh)

    this.parts.set(id, { id, name, mesh, backMesh, data, displayGeometry })
    this.partOrder.push(id)
    this.updateShadowRig()
    this.emit('partsChanged')
    return this.partInfo(id)!
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
  getPartForSave(id: string): { data: MeshData; matrix: number[]; name: string; visible: boolean } | null {
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
    const id = hits.length ? (hits[0].object.userData.partId as string) : null
    if (id !== this.selectedId) this.select(id)
  }

  // ---------- display ----------

  setDisplayMode(mode: DisplayMode) {
    this.displayMode = mode
    const set = this.materials[mode]
    for (const part of this.parts.values()) {
      part.mesh.material = set.main
      part.backMesh.visible = mode === 'backface'
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
    this.clearParts()
    this.composer?.dispose()
    this.controls.dispose()
    this.gizmo.dispose()
    this.backgroundTexture?.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
