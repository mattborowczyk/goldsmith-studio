import * as THREE from 'three'
import type { Vec3 } from '../../types'

export class AxisGizmo {
  readonly group = new THREE.Group()
  private gizmo: { group: THREE.Group; handle: THREE.Mesh; length: number; center: THREE.Vector3 } | null = null
  private dragging = false
  private raycaster = new THREE.Raycaster()

  show(center: Vec3, length: number, axis: Vec3) {
    const c = new THREE.Vector3(center[0], center[1], center[2])
    if (!this.gizmo || Math.abs(this.gizmo.length - length) > length * 0.01) {
      this.build(length)
    }
    this.gizmo!.center.copy(c)
    this.group.position.copy(c)
    this.group.visible = true
    this.setDirection(axis)
  }

  setDirection(axis: Vec3) {
    if (!this.gizmo) return
    const dir = new THREE.Vector3(axis[0], axis[1], axis[2])
    if (dir.lengthSq() === 0) return
    dir.normalize()
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  }

  hide() {
    this.endDrag()
    for (const child of [...this.group.children]) {
      this.group.remove(child)
      const obj = child as THREE.Mesh
      obj.geometry?.dispose()
      ;(obj.material as THREE.Material | undefined)?.dispose?.()
    }
    this.gizmo = null
    this.group.visible = false
  }

  private build(len: number) {
    this.hide()
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
    this.group.add(shaft, head, handle)
    this.gizmo = { group: this.group, handle, length: len, center: new THREE.Vector3() }
  }

  tryGrabHandle(ndc: THREE.Vector2, camera: THREE.Camera): boolean {
    if (!this.gizmo || !this.group.visible) return false
    this.raycaster.setFromCamera(ndc, camera)
    if (!this.raycaster.intersectObject(this.gizmo.handle, false).length) return false
    this.dragging = true
    return true
  }

  updateDrag(ndc: THREE.Vector2, camera: THREE.Camera, onChange: (axis: Vec3) => void) {
    const g = this.gizmo
    if (!g || !this.dragging) return
    this.raycaster.setFromCamera(ndc, camera)
    const sphere = new THREE.Sphere(g.center, g.length)
    const hit = new THREE.Vector3()
    if (!this.raycaster.ray.intersectSphere(sphere, hit)) {
      this.raycaster.ray.closestPointToPoint(g.center, hit)
    }
    const dir = hit.sub(g.center)
    if (dir.lengthSq() === 0) return
    dir.normalize()
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    onChange([dir.x, dir.y, dir.z])
  }

  endDrag(): boolean {
    if (!this.dragging) return false
    this.dragging = false
    return true
  }

  isDragging(): boolean {
    return this.dragging
  }

  updateScale(worldPerPixel: (pos: THREE.Vector3) => number) {
    if (this.gizmo && this.group.visible) {
      const at = this.gizmo.handle.getWorldPosition(new THREE.Vector3())
      this.gizmo.handle.scale.setScalar(worldPerPixel(at) * 11)
    }
  }

  dispose() {
    this.hide()
  }
}
