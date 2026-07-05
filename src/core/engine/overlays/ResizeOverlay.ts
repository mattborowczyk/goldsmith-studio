import * as THREE from 'three'
import type { ResizeOverlay as ResizeOverlayData } from '../../types'
import { anglePointOnRing, pointAngleDeg } from '../../geometry/resize'
import { makeLabelSprite, makeMarker } from './overlayUtils'

export class ResizeOverlay {
  readonly group = new THREE.Group()
  private overlay: ResizeOverlayData | null = null
  private handles: THREE.Mesh[] = []
  private draggingHandle: number | null = null
  private raycaster = new THREE.Raycaster()

  setOverlay(overlay: ResizeOverlayData | null) {
    this.clear()
    this.overlay = overlay
    if (!overlay) return
    const { frame } = overlay
    const gap = Math.max(frame.outerR * 0.2, 1.5)
    const r0 = frame.outerR * 1.08
    const r1 = r0 + gap

    if (overlay.mode === 'uniform') {
      this.group.add(this.buildSectorMesh(overlay, 0, 360, r0, r1, 0xe8c260, 0.3))
    } else {
      const half = overlay.protectedDeg / 2
      const c = overlay.protectedCenterDeg
      this.group.add(this.buildSectorMesh(overlay, 0, 360, r0, r1, 0x6b6256, 0.12))
      this.group.add(this.buildSectorMesh(overlay, c - half, c + half, r0, r1, 0xe8c260, 0.6))
      this.group.add(
        this.buildSectorMesh(overlay, c + half, c + half + overlay.smoothingDeg, r0, r1, 0x4fc3f7, 0.32),
      )
      this.group.add(
        this.buildSectorMesh(overlay, c - half - overlay.smoothingDeg, c - half, r0, r1, 0x4fc3f7, 0.32),
      )
      const rMid = (r0 + r1) / 2
      for (const [i, edge] of [c - half, c + half].entries()) {
        const handle = makeMarker('#f2efe9')
        handle.scale.setScalar(1)
        handle.position.fromArray(anglePointOnRing(frame, edge, rMid))
        handle.userData.handleIndex = i
        this.group.add(handle)
        this.handles.push(handle)
      }
    }

    const center = new THREE.Vector3()
    center.setComponent(frame.axis, frame.axialCenter)
    center.setComponent((frame.axis + 1) % 3, frame.center[0])
    center.setComponent((frame.axis + 2) % 3, frame.center[1])
    const up = new THREE.Vector3(0, 1, 0)
    const before = makeLabelSprite(overlay.beforeLabel, '#9aa0a8')
    before.sprite.position.copy(center).addScaledVector(up, frame.outerR * 1.4)
    before.sprite.userData.labelAspect = before.aspect
    const after = makeLabelSprite(overlay.afterLabel, '#e8c260')
    after.sprite.position.copy(center).addScaledVector(up, frame.outerR * 2.0)
    after.sprite.userData.labelAspect = after.aspect
    this.group.add(before.sprite, after.sprite)
  }

  private buildSectorMesh(
    overlay: ResizeOverlayData,
    a1Deg: number,
    a2Deg: number,
    r0: number,
    r1: number,
    color: number,
    opacity: number,
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
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
    )
    mesh.renderOrder = 996
    return mesh
  }

  tryGrabHandle(ndc: THREE.Vector2, camera: THREE.Camera): boolean {
    if (!this.handles.length) return false
    this.raycaster.setFromCamera(ndc, camera)
    const hits = this.raycaster.intersectObjects(this.handles, false)
    if (!hits.length) return false
    this.draggingHandle = hits[0].object.userData.handleIndex as number
    return true
  }

  updateHandleDrag(ndc: THREE.Vector2, camera: THREE.Camera, onDrag: (protectedDeg: number) => void) {
    if (this.draggingHandle === null || !this.overlay) return
    this.raycaster.setFromCamera(ndc, camera)
    const normal = new THREE.Vector3().setComponent(this.overlay.frame.axis, 1)
    const onPlane = new THREE.Vector3().setComponent(
      this.overlay.frame.axis,
      this.overlay.frame.axialCenter,
    )
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, onPlane)
    const hit = new THREE.Vector3()
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return
    const angle = pointAngleDeg([hit.x, hit.y, hit.z], this.overlay.frame)
    const half = Math.abs(((angle - this.overlay.protectedCenterDeg + 540) % 360) - 180)
    const protectedDeg = Math.min(Math.max(half * 2, 4), 176)
    onDrag(protectedDeg)
  }

  endHandleDrag(): boolean {
    if (this.draggingHandle === null) return false
    this.draggingHandle = null
    return true
  }

  isDragging(): boolean {
    return this.draggingHandle !== null
  }

  clear() {
    this.endHandleDrag()
    this.handles = []
    for (const child of [...this.group.children]) {
      this.group.remove(child)
      const obj = child as THREE.Mesh
      obj.geometry?.dispose()
      const mat = obj.material as (THREE.Material & { map?: THREE.Texture | null }) | undefined
      mat?.map?.dispose?.()
      mat?.dispose?.()
    }
  }

  updateScale(worldPerPixel: (pos: THREE.Vector3) => number) {
    const LABEL_PX = 30
    for (const handle of this.handles) {
      handle.scale.setScalar(worldPerPixel(handle.position) * 14)
    }
    for (const child of this.group.children) {
      const aspect = child.userData.labelAspect as number | undefined
      if (aspect === undefined) continue
      const h = worldPerPixel(child.position) * LABEL_PX
      child.scale.set(h * aspect, h, 1)
    }
  }

  dispose() {
    this.clear()
  }
}
