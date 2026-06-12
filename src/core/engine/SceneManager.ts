import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
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

interface ScenePart {
  id: string
  name: string
  mesh: THREE.Mesh
  backMesh: THREE.Mesh
  baseGeometry: THREE.BufferGeometry
}

export interface SceneManagerEvents {
  /** Parts added/removed/renamed/transformed — UI + autosave listen to this. */
  partsChanged: () => void
  /** Selection changed from a viewport tap. */
  selectionChanged: (id: string | null) => void
}

const BACKGROUNDS: Record<string, number> = {
  studio: 0x232220,
  charcoal: 0x1a1a1c,
  slate: 0x20242b,
  black: 0x000000,
}

/**
 * Imperative Three.js engine. Owns renderer, cameras, controls, gizmo, parts.
 * React mounts it into a container div and issues commands; it never reaches
 * back into React except via the two events above.
 */
export class SceneManager {
  readonly scene = new THREE.Scene()
  private renderer: THREE.WebGLRenderer
  private perspCamera: THREE.PerspectiveCamera
  private orthoCamera: THREE.OrthographicCamera
  private activeCamera: THREE.Camera
  private controls: OrbitControls
  private gizmo: TransformControls
  private container: HTMLElement
  private resizeObserver: ResizeObserver
  private materials: Record<DisplayMode, DisplayMaterialSet>
  private displayMode: DisplayMode = 'gold'
  private parts = new Map<string, ScenePart>()
  private partOrder: string[] = []
  private selectedId: string | null = null
  private grid: THREE.GridHelper
  private highlightGroup = new THREE.Group()
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

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    container.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color(BACKGROUNDS.studio)
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

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
    this.scene.add(this.gizmo.getHelper())

    this.grid = new THREE.GridHelper(100, 50, 0x4a4640, 0x2e2c28)
    this.scene.add(this.grid)
    this.scene.add(this.highlightGroup)

    // soft key light so studio (non-PBR-env) materials read well too
    const key = new THREE.DirectionalLight(0xffffff, 1.2)
    key.position.set(50, 80, 30)
    this.scene.add(key, new THREE.AmbientLight(0xffffff, 0.25))

    this.materials = createMaterials()

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
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1))
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()

    const set = this.materials[this.displayMode]
    const mesh = new THREE.Mesh(geometry, set.main)
    const backMesh = new THREE.Mesh(geometry, set.back)
    backMesh.visible = this.displayMode === 'backface'
    mesh.add(backMesh)
    mesh.userData.partId = id
    if (matrix) mesh.applyMatrix4(new THREE.Matrix4().fromArray(matrix))
    this.scene.add(mesh)

    this.parts.set(id, { id, name, mesh, backMesh, baseGeometry: geometry })
    this.partOrder.push(id)
    this.emit('partsChanged')
    return this.partInfo(id)!
  }

  removePart(id: string) {
    const part = this.parts.get(id)
    if (!part) return
    if (this.selectedId === id) this.select(null)
    this.scene.remove(part.mesh)
    part.baseGeometry.dispose()
    this.parts.delete(id)
    this.partOrder = this.partOrder.filter((p) => p !== id)
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
    this.emit('partsChanged')
  }

  /** Replace a part's geometry in place (e.g. after heal) — transform kept. */
  replacePartGeometry(id: string, data: MeshData) {
    const part = this.parts.get(id)
    if (!part) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1))
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    part.baseGeometry.dispose()
    part.baseGeometry = geometry
    part.mesh.geometry = geometry
    part.backMesh.geometry = geometry
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
      triangles: (part.baseGeometry.index?.count ?? 0) / 3,
      bbox: { x: size.x, y: size.y, z: size.z },
    }
  }

  /** Mesh data in world space (transform baked) — what repair/export operate on. */
  getWorldMeshData(id: string): MeshData | null {
    const part = this.parts.get(id)
    if (!part) return null
    part.mesh.updateWorldMatrix(true, false)
    const src = part.baseGeometry.getAttribute('position') as THREE.BufferAttribute
    const positions = new Float32Array(src.count * 3)
    const v = new THREE.Vector3()
    for (let i = 0; i < src.count; i++) {
      v.fromBufferAttribute(src, i).applyMatrix4(part.mesh.matrixWorld)
      positions[i * 3] = v.x
      positions[i * 3 + 1] = v.y
      positions[i * 3 + 2] = v.z
    }
    const indices = new Uint32Array((part.baseGeometry.index as THREE.BufferAttribute).array)
    return { positions, indices }
  }

  /** Local-space mesh data + transform matrix, for persistence. */
  getPartForSave(id: string): { data: MeshData; matrix: number[]; name: string; visible: boolean } | null {
    const part = this.parts.get(id)
    if (!part) return null
    const pos = part.baseGeometry.getAttribute('position') as THREE.BufferAttribute
    return {
      data: {
        positions: new Float32Array(pos.array),
        indices: new Uint32Array((part.baseGeometry.index as THREE.BufferAttribute).array),
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
      if (this.selectedId) {
        // keep selection, hide gizmo
      }
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
    const color = BACKGROUNDS[name] ?? BACKGROUNDS.studio
    this.scene.background = new THREE.Color(color)
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

  snapshotPNG(): string {
    this.renderer.render(this.scene, this.activeCamera)
    return this.renderer.domElement.toDataURL('image/png')
  }

  // ---------- loop & lifecycle ----------

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
    this.renderer.render(this.scene, this.activeCamera)
  }

  private aspect(): number {
    return (this.container.clientWidth || 1) / (this.container.clientHeight || 1)
  }

  private handleResize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
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
    this.controls.dispose()
    this.gizmo.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
