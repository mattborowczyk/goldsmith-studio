import * as THREE from 'three'
import type { DisplayMode } from '../types'

export interface DisplayMaterialSet {
  main: THREE.Material
  /** Shown only in 'backface' mode: paints inside faces red. */
  back: THREE.Material
}

export function createMaterials(): Record<DisplayMode, DisplayMaterialSet> {
  const back = new THREE.MeshBasicMaterial({
    color: 0xe53935,
    side: THREE.BackSide,
  })

  const gold = new THREE.MeshPhysicalMaterial({
    color: 0xffc24d,
    metalness: 1,
    roughness: 0.18,
    envMapIntensity: 1.1,
  })
  const silver = new THREE.MeshPhysicalMaterial({
    color: 0xd9dade,
    metalness: 1,
    roughness: 0.15,
    envMapIntensity: 1.0,
  })
  const studio = new THREE.MeshStandardMaterial({
    color: 0x9aa0a8,
    metalness: 0.1,
    roughness: 0.55,
  })
  const wireframe = new THREE.MeshBasicMaterial({
    color: 0xc9a554,
    wireframe: true,
  })
  const normals = new THREE.MeshNormalMaterial()
  const backfaceFront = new THREE.MeshStandardMaterial({
    color: 0x9aa0a8,
    metalness: 0.05,
    roughness: 0.7,
    side: THREE.FrontSide,
  })

  return {
    gold: { main: gold, back },
    silver: { main: silver, back },
    studio: { main: studio, back },
    wireframe: { main: wireframe, back },
    normals: { main: normals, back },
    backface: { main: backfaceFront, back },
  }
}
