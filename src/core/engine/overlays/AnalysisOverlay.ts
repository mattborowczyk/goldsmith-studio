import * as THREE from 'three'
import type { AnalysisReport } from '../../types'

export class AnalysisOverlay {
  readonly group = new THREE.Group()

  show(report: AnalysisReport) {
    this.clear()
    if (report.boundaryEdgePositions.length >= 6) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(report.boundaryEdgePositions, 3))
      const lines = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ color: 0xff4040, depthTest: false }),
      )
      lines.renderOrder = 999
      this.group.add(lines)
    }
    if (report.flippedFacePositions.length >= 3) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(report.flippedFacePositions, 3))
      const pts = new THREE.Points(
        g,
        new THREE.PointsMaterial({ color: 0x4090ff, size: 0.6, depthTest: false }),
      )
      pts.renderOrder = 999
      this.group.add(pts)
    }
  }

  clear() {
    for (const child of [...this.group.children]) {
      this.group.remove(child)
      const obj = child as THREE.Mesh
      obj.geometry?.dispose()
      ;(obj.material as THREE.Material | undefined)?.dispose?.()
    }
  }

  dispose() {
    this.clear()
  }
}
