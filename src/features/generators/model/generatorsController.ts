import { addGeneratedPart } from '@/core/controller/context'
import { generateBandRing, type BandRingParams } from '@/core/generators/bandRing'
import { generateGem, generateGemCutter, type GemParams } from '@/core/generators/gems'
import { makeCylinder } from '@/core/generators/meshBuilder'
import { generateText3D, type Text3DParams } from '@/core/generators/text3d'
import type { PartAppearance } from '@/core/types'

export { addGeneratedPart }
export * from '@/core/generators/bandRing'
export * from '@/core/generators/gems'
export * from '@/core/generators/meshBuilder'
export * from '@/core/generators/ringSizes'
export * from '@/core/generators/text3d'

export function createBandRingPart(name: string, params: BandRingParams): string {
  return addGeneratedPart(name, generateBandRing(params))
}

export function createGemPart(
  name: string,
  params: GemParams,
  appearance?: Partial<PartAppearance>,
): string {
  return addGeneratedPart(name, generateGem(params), appearance)
}

export function createGemCutterPart(name: string, params: GemParams, clearance: number): string {
  return addGeneratedPart(name, generateGemCutter(params, clearance), {
    material: null,
    flatShading: false,
  })
}

export function createText3DPart(name: string, params: Text3DParams): string {
  return addGeneratedPart(name, generateText3D(params))
}

export function createSizerPart(name: string, diameter: number): string {
  return addGeneratedPart(name, makeCylinder(diameter / 2, 1.5))
}
