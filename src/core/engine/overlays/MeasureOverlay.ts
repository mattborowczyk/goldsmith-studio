import * as THREE from 'three'
import type { Measurement, Vec3 } from '../../types'
import { makeLabelSprite, makeMarker } from './overlayUtils'

interface MeasureItem {
  group: THREE.Group
  markers: THREE.Mesh[]
  sprite: THREE.Sprite
  aspect: number
}

export class MeasureOverlay {
  readonly group = new THREE.Group()
  private items = new Map<string, MeasureItem>()
  private pendingMarker: THREE.Mesh | null = null
  private pickMode = false

  setPickMode(on: boolean) {
    this.pickMode = on
    if (!on) this.setPendingMarker(null)
  }

  getPickMode(): boolean {
    return this.pickMode
  }

  setPendingMarker(point: Vec3 | null) {
    if (this.pendingMarker) {
      this.group.remove(this.pendingMarker)
      this.pendingMarker.geometry.dispose()
      ;(this.pendingMarker.material as THREE.Material).dispose()
      this.pendingMarker = null
    }
    if (!point) return
    this.pendingMarker = makeMarker('#e8c260')
    this.pendingMarker.position.fromArray(point)
    this.group.add(this.pendingMarker)
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
      const marker = makeMarker(m.color)
      marker.position.copy(p)
      group.add(marker)
      return marker
    })

    const { sprite, aspect } = makeLabelSprite(`${m.distance.toFixed(2)} mm`, m.color)
    sprite.position.lerpVectors(a, b, 0.5)
    group.add(sprite)

    this.group.add(group)
    this.items.set(m.id, { group, markers, sprite, aspect })
  }

  removeMeasurement(id: string) {
    const item = this.items.get(id)
    if (!item) return
    this.group.remove(item.group)
    item.group.traverse((obj) => {
      const o = obj as THREE.Mesh
      o.geometry?.dispose()
      const mat = o.material as THREE.Material & { map?: THREE.Texture | null }
      mat?.map?.dispose?.()
      mat?.dispose?.()
    })
    this.items.delete(id)
  }

  clearMeasurements() {
    for (const id of [...this.items.keys()]) this.removeMeasurement(id)
    this.setPendingMarker(null)
  }

  updateScale(worldPerPixel: (pos: THREE.Vector3) => number) {
    const MARKER_PX = 9
    const LABEL_PX = 30
    for (const item of this.items.values()) {
      for (const marker of item.markers) {
        marker.scale.setScalar(worldPerPixel(marker.position) * MARKER_PX)
      }
      const labelH = worldPerPixel(item.sprite.position) * LABEL_PX
      item.sprite.scale.set(labelH * item.aspect, labelH, 1)
    }
    if (this.pendingMarker) {
      this.pendingMarker.scale.setScalar(
        worldPerPixel(this.pendingMarker.position) * (MARKER_PX + 3),
      )
    }
  }

  dispose() {
    this.clearMeasurements()
  }
}
