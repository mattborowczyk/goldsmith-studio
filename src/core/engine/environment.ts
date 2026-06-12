import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/**
 * Realistic lighting environment using RoomEnvironment.
 * Provides highly realistic, physically-based varied reflections on metals.
 */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer)
  pmrem.compileEquirectangularShader()
  
  const room = new RoomEnvironment()
  // Generate the environment map
  const envMap = pmrem.fromScene(room, 0.04).texture
  
  room.dispose()
  pmrem.dispose()
  
  return envMap
}

export interface BackgroundSpec {
  /** Center and edge colors of a radial vignette. */
  inner: string
  outer: string
}

export const BACKGROUND_PRESETS: Record<string, BackgroundSpec> = {
  studio: { inner: '#34302a', outer: '#161412' },
  charcoal: { inner: '#26262a', outer: '#101012' },
  slate: { inner: '#2a3038', outer: '#13161b' },
  black: { inner: '#141414', outer: '#000000' },
}

/** Screen-space radial vignette texture used as scene background. */
export function createBackgroundTexture(name: string): THREE.CanvasTexture {
  const spec = BACKGROUND_PRESETS[name] ?? BACKGROUND_PRESETS.studio
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 1024
  const ctx = canvas.getContext('2d')!
  // center pulled up a touch — the model usually sits slightly above center
  const g = ctx.createRadialGradient(512, 430, 80, 512, 512, 780)
  g.addColorStop(0, spec.inner)
  g.addColorStop(1, spec.outer)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 1024, 1024)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
