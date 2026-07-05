import * as THREE from 'three'
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing'
import { N8AOPostPass } from 'n8ao'

export class PostProcessingManager {
  private composer: EffectComposer | null = null
  private enabled = true

  build(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number,
  ) {
    this.composer?.dispose()
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
    })
    this.composer.addPass(new RenderPass(scene, camera))

    const n8ao = new N8AOPostPass(scene, camera, width, height)
    n8ao.configuration.aoRadius = 2.5
    n8ao.configuration.distanceFalloff = 4.0
    n8ao.configuration.intensity = 4.0
    n8ao.setQualityMode('High')
    this.composer.addPass(n8ao)

    const bloom = new BloomEffect({
      luminanceThreshold: 1.0,
      luminanceSmoothing: 0.6,
      intensity: 0.5,
      mipmapBlur: true,
    })
    const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })
    this.composer.addPass(new EffectPass(camera, bloom, new SMAAEffect(), toneMapping))
    this.composer.setSize(width, height)
  }

  setSize(width: number, height: number, updateStyle = true) {
    this.composer?.setSize(width, height, updateStyle)
  }

  render() {
    if (this.enabled && this.composer) {
      this.composer.render()
      return true
    }
    return false
  }

  setEnabled(enabled: boolean, renderer: THREE.WebGLRenderer) {
    this.enabled = enabled
    renderer.toneMapping = enabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping
  }

  getEnabled(): boolean {
    return this.enabled
  }

  dispose() {
    this.composer?.dispose()
    this.composer = null
  }
}
