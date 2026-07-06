import { refreshStorageEstimate } from '@/core/controller/context'
import { estimateStorage, requestPersistentStorage } from '@/core/persist/db'
import { useAppStore } from '@/store/appStore'

export { estimateStorage, refreshStorageEstimate, requestPersistentStorage }

export function dismissStorageWarning() {
  useAppStore.getState().patchStorage({ writeFailed: false, quotaExceeded: false })
}
