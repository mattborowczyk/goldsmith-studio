import * as THREE from 'three'
import { thicknessColor } from '../../geometry/thickness'

export interface HeatmapData {
  id: string
  values: Float32Array
  min: number
  max: number
  threshold: number
}

export interface VertexColorHost {
  applyColorAttribute(partId: string, srcColors: Float32Array): void
  getVertexColorMaterial(flatShading: boolean): THREE.Material
  applyPartMaterial(partId: string): void
  getPart(partId: string): { data: { positions: Float32Array }; mesh: THREE.Mesh; backMesh: THREE.Mesh; flatShading: boolean } | undefined
}

export class HeatmapOverlay {
  private data: HeatmapData | null = null

  set(
    id: string,
    values: Float32Array,
    range: { min: number; max: number },
    threshold: number,
    host: VertexColorHost,
    onConflictClear?: () => void,
  ) {
    const part = host.getPart(id)
    if (!part) return
    onConflictClear?.()
    if (this.data && this.data.id !== id) this.clear(host)
    this.data = { id, values, min: range.min, max: range.max, threshold }
    this.paint(part, host)
  }

  setThreshold(threshold: number, host: VertexColorHost) {
    if (!this.data) return
    this.data.threshold = threshold
    const part = host.getPart(this.data.id)
    if (part) this.paint(part, host)
  }

  private paint(part: { data: { positions: Float32Array }; mesh: THREE.Mesh; backMesh: THREE.Mesh; flatShading: boolean }, host: VertexColorHost) {
    const h = this.data!
    const srcColors = new Float32Array(part.data.positions.length)
    for (let v = 0; v < h.values.length; v++) {
      const [r, g, b] = thicknessColor(h.values[v], h.min, h.max, h.threshold)
      srcColors[v * 3] = r
      srcColors[v * 3 + 1] = g
      srcColors[v * 3 + 2] = b
    }
    host.applyColorAttribute(h.id, srcColors)
    part.mesh.material = host.getVertexColorMaterial(part.flatShading)
    part.backMesh.visible = false
  }

  clear(host: VertexColorHost) {
    const h = this.data
    if (!h) return
    this.data = null
    host.applyPartMaterial(h.id)
  }

  has(): boolean {
    return this.data !== null
  }

  getId(): string | null {
    return this.data?.id ?? null
  }

  dispose(host: VertexColorHost) {
    this.clear(host)
  }
}
