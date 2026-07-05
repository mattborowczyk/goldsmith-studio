import { getEngine } from '@/core/controller/context'
import type { SectionState } from '@/store/appStore'
import { useAppStore } from '@/store/appStore'

export function updateSection(patch: Partial<SectionState>) {
  const store = useAppStore.getState()
  const prev = store.measure.section
  const next = { ...prev, ...patch }
  const axisChanged = next.axis !== prev.axis
  const justEnabled = next.enabled && !prev.enabled
  if (justEnabled || axisChanged) {
    try {
      const bounds = getEngine().getSceneBounds()
      if (bounds) {
        const i = 'xyz'.indexOf(next.axis)
        next.range = { min: bounds.min[i], max: bounds.max[i] }
        next.position = (next.range.min + next.range.max) / 2
      }
    } catch { /* ignore */ }
  }
  store.patchSection(next)
  try {
    getEngine().setSection(
      next.enabled
        ? {
            axis: next.axis,
            position: next.position,
            flip: next.flip,
            slice: next.slice,
            thickness: next.thickness,
          }
        : null,
    )
  } catch { /* ignore */ }
}
