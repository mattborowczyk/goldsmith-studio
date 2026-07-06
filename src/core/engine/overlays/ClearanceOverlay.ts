import * as THREE from 'three'
import { clearanceColor } from '../../geometry/fit'
import type { VertexColorHost } from './HeatmapOverlay'

export interface ClearanceData {
  id: string
  values: Float32Array
  lo: number
  hi: number
}

export class ClearanceOverlay {
  private data: ClearanceData | null = null

  set(
    id: string,
    values: Float32Array,
    band: { lo: number; hi: number },
    host: VertexColorHost,
    onConflictClear?: () => void,
  ): boolean {
    const part = host.getPart(id)
    if (!part) return false
    onConflictClear?.()
    if (this.data && this.data.id !== id) this.clear(host)
    this.data = { id, values, lo: band.lo, hi: band.hi }
    this.paint(part, host)
    return true
  }

  setBand(lo: number, hi: number, host: VertexColorHost) {
    if (!this.data) return
    this.data.lo = lo
    this.data.hi = hi
    const part = host.getPart(this.data.id)
    if (part) this.paint(part, host)
  }

  private paint(part: { data: { positions: Float32Array }; mesh: THREE.Mesh; backMesh: THREE.Mesh; flatShading: boolean }, host: VertexColorHost) {
    const c = this.data!
    const srcColors = new Float32Array(part.data.positions.length)
    for (let v = 0; v < c.values.length; v++) {
      const [r, g, b] = clearanceColor(c.values[v], c.lo, c.hi)
      srcColors[v * 3] = r
      srcColors[v * 3 + 1] = g
      srcColors[v * 3 + 2] = b
    }
    host.applyColorAttribute(c.id, srcColors)
    part.mesh.material = host.getVertexColorMaterial(part.flatShading)
    part.backMesh.visible = false
  }

  clear(host: VertexColorHost) {
    const c = this.data
    if (!c) return
    this.data = null
    host.applyPartMaterial(c.id)
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
