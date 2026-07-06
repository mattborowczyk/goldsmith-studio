import * as THREE from 'three'
import { undercutColor } from '../../geometry/undercut'
import type { VertexColorHost } from './HeatmapOverlay'

export interface SurveyData {
  id: string
  values: Float32Array
}

export class SurveyOverlay {
  private data: SurveyData | null = null

  set(
    id: string,
    values: Float32Array,
    host: VertexColorHost,
    onConflictClear?: () => void,
  ): boolean {
    const part = host.getPart(id)
    if (!part) return false
    onConflictClear?.()
    if (this.data && this.data.id !== id) this.clear(host)
    this.data = { id, values }
    this.paint(part, host)
    return true
  }

  private paint(part: { data: { positions: Float32Array }; mesh: THREE.Mesh; backMesh: THREE.Mesh; flatShading: boolean }, host: VertexColorHost) {
    const s = this.data!
    const srcColors = new Float32Array(part.data.positions.length)
    for (let v = 0; v < s.values.length; v++) {
      const [r, g, b] = undercutColor(s.values[v])
      srcColors[v * 3] = r
      srcColors[v * 3 + 1] = g
      srcColors[v * 3 + 2] = b
    }
    host.applyColorAttribute(s.id, srcColors)
    part.mesh.material = host.getVertexColorMaterial(part.flatShading)
    part.backMesh.visible = false
  }

  clear(host: VertexColorHost) {
    const s = this.data
    if (!s) return
    this.data = null
    host.applyPartMaterial(s.id)
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
