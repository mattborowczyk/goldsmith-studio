import { registerSW } from 'virtual:pwa-register'
import { useAppStore } from '@/store/appStore'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null
let deferredInstall: BeforeInstallPromptEvent | null = null

export function initPWA(): void {
  updateSW = registerSW({
    onNeedRefresh() {
      useAppStore.getState().patchPwa({ needRefresh: true })
    },
    onOfflineReady() {
      useAppStore.getState().patchPwa({ offlineReady: true })
    },
  })

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredInstall = e as BeforeInstallPromptEvent
    useAppStore.getState().patchPwa({ canInstall: true })
  })
  window.addEventListener('appinstalled', () => {
    deferredInstall = null
    useAppStore.getState().patchPwa({ canInstall: false })
  })
}

export function reloadForUpdate(): void {
  useAppStore.getState().patchPwa({ needRefresh: false })
  void updateSW?.(true)
}

export function dismissPwaBanner(): void {
  useAppStore.getState().patchPwa({ needRefresh: false, offlineReady: false, canInstall: false })
}

export async function promptInstall(): Promise<void> {
  if (!deferredInstall) return
  await deferredInstall.prompt()
  deferredInstall = null
  useAppStore.getState().patchPwa({ canInstall: false })
}
