import * as THREE from 'three'
import type { MaterialPreset } from '../types'

/** Presets offered as a per-part display material (Auto = follow global). */
export const MATERIAL_PRESETS: { id: MaterialPreset; label: string }[] = [
  { id: 'gold', label: 'Polished gold' },
  { id: 'silver', label: 'Polished silver' },
  { id: 'studio', label: 'Neutral studio' },
  { id: 'gem', label: 'Gemstone' },
  { id: 'cutter', label: 'Cutter (tool)' },
  { id: 'wireframe', label: 'Wireframe' },
  { id: 'normals', label: 'Normals debug' },
  { id: 'backface', label: 'Backface debug' },
]

/** Backface-debug overlay material (inside faces painted red); shared by all parts. */
export function createBackMaterial(): THREE.Material {
  return new THREE.MeshBasicMaterial({ color: 0xe53935, side: THREE.BackSide })
}

/**
 * Build the main material for one preset. `flat` selects faceted shading
 * (per-face normals) — crisp gem facets vs. smoothed metal. Each instance
 * records its resting `side` in userData so the section tool can restore it.
 */
export function createMaterial(preset: MaterialPreset, flat: boolean): THREE.Material {
  const mat = buildMaterial(preset, flat)
  mat.userData.baseSide = mat.side
  return mat
}

function buildMaterial(preset: MaterialPreset, flatShading: boolean): THREE.Material {
  switch (preset) {
    case 'gold':
      return new THREE.MeshPhysicalMaterial({
        color: 0xffd17a,
        metalness: 1.0,
        roughness: 0.12,
        clearcoat: 0.3,
        clearcoatRoughness: 0.05,
        envMapIntensity: 1.5,
        flatShading,
      })
    case 'silver':
      return new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        metalness: 1.0,
        roughness: 0.1,
        clearcoat: 0.3,
        clearcoatRoughness: 0.05,
        envMapIntensity: 1.5,
        flatShading,
      })
    case 'studio':
      return new THREE.MeshStandardMaterial({
        color: 0x9aa0a8,
        metalness: 0.1,
        roughness: 0.55,
        flatShading,
      })
    case 'gem':
      // clear, brilliant stone — translucent + crisp facets so it reads as a
      // gemstone distinct from the metal jewellery
      return new THREE.MeshPhysicalMaterial({
        color: 0xeaf4ff,
        metalness: 0,
        roughness: 0.02,
        ior: 2.4,
        clearcoat: 1,
        clearcoatRoughness: 0,
        envMapIntensity: 2.2,
        transparent: true,
        opacity: 0.82,
        side: THREE.DoubleSide,
        flatShading,
      })
    case 'cutter':
      // translucent red "negative" — the CAD convention for a boolean tool
      return new THREE.MeshPhysicalMaterial({
        color: 0xff4d4d,
        metalness: 0,
        roughness: 0.4,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        side: THREE.DoubleSide,
        flatShading,
      })
    case 'wireframe':
      return new THREE.MeshBasicMaterial({ color: 0xc9a554, wireframe: true })
    case 'normals':
      return new THREE.MeshNormalMaterial({ flatShading })
    case 'backface':
      return new THREE.MeshStandardMaterial({
        color: 0x9aa0a8,
        metalness: 0.05,
        roughness: 0.7,
        side: THREE.FrontSide,
        flatShading,
      })
    default:
      // Safety net for a stale/invalid persisted preset — fall back to studio
      // so session restore can never crash on an unknown value.
      return new THREE.MeshStandardMaterial({
        color: 0x9aa0a8,
        metalness: 0.1,
        roughness: 0.55,
        flatShading,
      })
  }
}
