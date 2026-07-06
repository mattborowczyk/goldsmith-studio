import * as THREE from 'three'

export interface BrushData {
  id: string
  radius: number
  selected: Set<number>
  worldPos: Float32Array
  interactive: boolean
}

export interface BrushHost {
  applyColorAttribute(partId: string, srcColors: Float32Array): void
  getVertexColorMaterial(flatShading: boolean): THREE.Material
  applyPartMaterial(partId: string): void
  getPart(
    partId: string,
  ): { data: { positions: Float32Array }; mesh: THREE.Mesh; backMesh: THREE.Mesh; flatShading: boolean } | undefined
  emitBrushSelectionChanged(count: number): void
  clearOtherOverlays(): void
}

export class BrushOverlay {
  private brush: BrushData | null = null
  private painting = false

  setSelect(id: string | null, radius: number, host: BrushHost) {
    if (!id) {
      this.clear(host)
      return
    }
    const part = host.getPart(id)
    if (!part) return
    if (this.brush && this.brush.id !== id) this.clear(host)
    host.clearOtherOverlays()
    const selected = this.brush?.id === id ? this.brush.selected : new Set<number>()
    this.brush = {
      id,
      radius,
      selected,
      worldPos: this.worldVertexPositions(part),
      interactive: true,
    }
    this.paintOverlay(part, host)
  }

  setWandSelection(id: string, indices: Uint32Array, host: BrushHost): boolean {
    const part = host.getPart(id)
    if (!part) return false
    if (this.brush && this.brush.id !== id) this.clear(host)
    host.clearOtherOverlays()
    const selected = new Set<number>()
    for (let i = 0; i < indices.length; i++) selected.add(indices[i])
    this.brush = {
      id,
      radius: this.brush?.radius ?? 1.5,
      selected,
      worldPos: this.brush?.worldPos ?? this.worldVertexPositions(part),
      interactive: this.brush?.interactive ?? false,
    }
    this.paintOverlay(part, host)
    host.emitBrushSelectionChanged(selected.size)
    return true
  }

  setPassive() {
    if (!this.brush) return
    this.brush.interactive = false
    this.painting = false
  }

  setRadius(radius: number) {
    if (this.brush) this.brush.radius = radius
  }

  clearSelection(host: BrushHost) {
    if (!this.brush) return
    this.brush.selected.clear()
    const part = host.getPart(this.brush.id)
    if (part) this.paintOverlay(part, host)
    host.emitBrushSelectionChanged(0)
  }

  getSelection(): { id: string; indices: Uint32Array } | null {
    if (!this.brush || this.brush.selected.size === 0) return null
    return { id: this.brush.id, indices: Uint32Array.from(this.brush.selected) }
  }

  has(): boolean {
    return this.brush !== null
  }

  tryStartPaint(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    raycaster: THREE.Raycaster,
    host: BrushHost,
    e: PointerEvent,
  ): boolean {
    if (!this.brush || !this.brush.interactive) return false
    const part = host.getPart(this.brush.id)
    if (!part || !part.mesh.visible) return false
    raycaster.setFromCamera(ndc, camera)
    if (!raycaster.intersectObject(part.mesh, false).length) return false
    this.painting = true
    this.paintAt(ndc, camera, raycaster, host, e)
    return true
  }

  paintAt(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    raycaster: THREE.Raycaster,
    host: BrushHost,
    e: PointerEvent,
  ) {
    const brush = this.brush
    if (!brush) return
    const part = host.getPart(brush.id)
    if (!part) return
    raycaster.setFromCamera(ndc, camera)
    const hits = raycaster.intersectObject(part.mesh, false)
    if (!hits.length) return
    const { x, y, z } = hits[0].point
    const r2 = brush.radius * brush.radius
    const erase = e.altKey
    const pos = brush.worldPos
    let changed = false
    for (let v = 0; v < pos.length / 3; v++) {
      const dx = pos[v * 3] - x,
        dy = pos[v * 3 + 1] - y,
        dz = pos[v * 3 + 2] - z
      if (dx * dx + dy * dy + dz * dz > r2) continue
      if (erase) changed = brush.selected.delete(v) || changed
      else if (!brush.selected.has(v)) {
        brush.selected.add(v)
        changed = true
      }
    }
    if (!changed) return
    this.paintOverlay(part, host)
    host.emitBrushSelectionChanged(brush.selected.size)
  }

  endPaint(): boolean {
    if (!this.painting) return false
    this.painting = false
    return true
  }

  isPainting(): boolean {
    return this.painting
  }

  private worldVertexPositions(part: { data: { positions: Float32Array }; mesh: THREE.Mesh }): Float32Array {
    const src = part.data.positions
    const out = new Float32Array(src.length)
    const m = part.mesh.matrixWorld
    const v = new THREE.Vector3()
    for (let i = 0; i < src.length; i += 3) {
      v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(m)
      out[i] = v.x
      out[i + 1] = v.y
      out[i + 2] = v.z
    }
    return out
  }

  private paintOverlay(part: { data: { positions: Float32Array }; mesh: THREE.Mesh; backMesh: THREE.Mesh; flatShading: boolean }, host: BrushHost) {
    const sel = this.brush!.selected
    const srcColors = new Float32Array(part.data.positions.length)
    for (let v = 0; v < srcColors.length / 3; v++) {
      const on = sel.has(v)
      srcColors[v * 3] = on ? 0.12 : 0.6
      srcColors[v * 3 + 1] = on ? 0.8 : 0.6
      srcColors[v * 3 + 2] = on ? 0.95 : 0.6
    }
    host.applyColorAttribute(this.brush!.id, srcColors)
    part.mesh.material = host.getVertexColorMaterial(part.flatShading)
    part.backMesh.visible = false
  }

  clear(host: BrushHost) {
    const b = this.brush
    if (!b) return
    this.brush = null
    this.painting = false
    host.applyPartMaterial(b.id)
  }

  dispose(host: BrushHost) {
    this.clear(host)
  }
}
