import { applyAccent, normalizeAccent } from '@/app/theme'
import { getEngine, guardWrite } from '@/core/controller/context'
import { saveSettings } from '@/core/persist/db'
import type { DisplayMode } from '@/core/types'
import { useAppStore } from '@/store/appStore'

export function persistDisplaySettings() {
  const s = useAppStore.getState()
  void guardWrite(
    saveSettings({
      displayMode: s.displayMode,
      background: s.background,
      gridVisible: s.gridVisible,
      accent: s.accent,
    }),
  )
}

export function setDisplayMode(mode: DisplayMode) {
  getEngine().setDisplayMode(mode)
  useAppStore.getState().setDisplayMode(mode)
  persistDisplaySettings()
}

export function setBackground(name: string) {
  getEngine().setBackground(name)
  useAppStore.getState().setBackground(name)
  persistDisplaySettings()
}

export function setGridVisible(visible: boolean) {
  getEngine().setGridVisible(visible)
  useAppStore.getState().setGridVisible(visible)
  persistDisplaySettings()
}

export function setAccent(id: string) {
  const accent = normalizeAccent(id)
  applyAccent(accent)
  useAppStore.getState().setAccent(accent)
  persistDisplaySettings()
}

function downloadDataURL(url: string, prefix: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = `${prefix}-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.png`
  a.click()
}

export function downloadSnapshot() {
  downloadDataURL(getEngine().snapshotPNG(), 'goldsmith-snapshot')
}

export function downloadClientPreview() {
  downloadDataURL(getEngine().renderPreviewPNG(2048), 'goldsmith-preview')
}

export function setPostFX(enabled: boolean) {
  getEngine().setPostFX(enabled)
  useAppStore.getState().setPostFX(enabled)
}
