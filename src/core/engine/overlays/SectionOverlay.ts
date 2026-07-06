import * as THREE from 'three'
import type { SectionAxis, SectionOptions } from '../../types'

export class SectionOverlay {
  private sectionHelper: THREE.Object3D | null = null
  private capPlaneHelper: THREE.Object3D | null = null
  private clipPlanes: THREE.Plane[] = []

  getClipPlanes(): THREE.Plane[] {
    return this.clipPlanes
  }

  setSection(
    opts: SectionOptions | null,
    scene: THREE.Scene,
    partsBox: THREE.Box3,
    materials: THREE.Material[],
    backMaterial: THREE.Material,
  ) {
    if (this.sectionHelper) {
      scene.remove(this.sectionHelper)
      this.sectionHelper.traverse((obj) => {
        const o = obj as THREE.Mesh
        o.geometry?.dispose()
        ;(o.material as THREE.Material | undefined)?.dispose?.()
      })
      this.sectionHelper = null
    }

    let planes: THREE.Plane[] = []
    if (opts) {
      const axis = new THREE.Vector3(
        opts.axis === 'x' ? 1 : 0,
        opts.axis === 'y' ? 1 : 0,
        opts.axis === 'z' ? 1 : 0,
      )
      if (opts.slice) {
        planes = [
          new THREE.Plane(axis.clone(), -opts.position),
          new THREE.Plane(axis.clone().negate(), opts.position + opts.thickness),
        ]
      } else if (opts.flip) {
        planes = [new THREE.Plane(axis.clone(), -opts.position)]
      } else {
        planes = [new THREE.Plane(axis.clone().negate(), opts.position)]
      }
      this.sectionHelper = this.buildSectionHelper(opts, axis, partsBox)
      if (this.sectionHelper) scene.add(this.sectionHelper)
    }

    this.clipPlanes = planes
    for (const mat of [...materials, backMaterial]) {
      mat.clippingPlanes = planes
      mat.clipShadows = true
      const base = (mat.userData.baseSide as THREE.Side) ?? THREE.FrontSide
      if (mat !== backMaterial) {
        mat.side = planes.length ? THREE.DoubleSide : base
        mat.needsUpdate = true
      }
    }
  }

  setCapPlanePreview(
    opts: { axis: SectionAxis; position: number } | null,
    scene: THREE.Scene,
    partsBox: THREE.Box3,
  ) {
    if (this.capPlaneHelper) {
      scene.remove(this.capPlaneHelper)
      this.capPlaneHelper.traverse((obj) => {
        const o = obj as THREE.Mesh
        o.geometry?.dispose()
        ;(o.material as THREE.Material | undefined)?.dispose?.()
      })
      this.capPlaneHelper = null
    }
    if (!opts) return
    const axis = new THREE.Vector3(
      opts.axis === 'x' ? 1 : 0,
      opts.axis === 'y' ? 1 : 0,
      opts.axis === 'z' ? 1 : 0,
    )
    this.capPlaneHelper = this.buildSectionHelper(
      { axis: opts.axis, position: opts.position, flip: false, slice: false, thickness: 0 },
      axis,
      partsBox,
    )
    if (this.capPlaneHelper) scene.add(this.capPlaneHelper)
  }

  private buildSectionHelper(
    opts: SectionOptions,
    axis: THREE.Vector3,
    partsBox: THREE.Box3,
  ): THREE.Object3D | null {
    if (partsBox.isEmpty()) return null
    const size = partsBox.getSize(new THREE.Vector3())
    const center = partsBox.getCenter(new THREE.Vector3())
    const [lw, lh] = {
      x: [size.z, size.y],
      y: [size.x, size.z],
      z: [size.x, size.y],
    }[opts.axis]
    const w = Math.max(lw, 1) * 1.15
    const h = Math.max(lh, 1) * 1.15

    const group = new THREE.Group()
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: 0xc9a554,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(quad.geometry),
      new THREE.LineBasicMaterial({ color: 0xc9a554, transparent: true, opacity: 0.5 }),
    )
    group.add(quad, border)

    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis)
    const pos = center.clone()
    pos.setComponent('xyz'.indexOf(opts.axis), opts.position)
    group.position.copy(pos)
    return group
  }

  dispose(scene: THREE.Scene) {
    this.setSection(null, scene, new THREE.Box3(), [], new THREE.MeshBasicMaterial())
    this.setCapPlanePreview(null, scene, new THREE.Box3())
  }
}
