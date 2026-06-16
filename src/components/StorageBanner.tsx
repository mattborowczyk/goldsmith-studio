import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { STORAGE_WARN_RATIO } from '@/core/persist/db'

/**
 * Storage warnings, bottom-left. Two distinct cases:
 *  - Reactive (issue #10): a saved-to-disk write *already* failed — work may be
 *    unsaved. Clears itself once a later write succeeds.
 *  - Proactive (issue #32): usage is approaching the quota, so a write is *about*
 *    to start failing. Dismissable for the session so it doesn't nag.
 * The reactive failure takes priority when both apply.
 */
export function StorageBanner() {
  const storage = useAppStore((s) => s.storage)
  const { writeFailed, quotaExceeded, estimate } = storage
  const [nearDismissed, setNearDismissed] = useState(false)

  if (writeFailed) {
    return (
      <div className="panel-glass absolute bottom-3 left-3 z-40 flex max-w-xs items-center gap-3 p-3">
        <AlertTriangle className="size-4 shrink-0 text-destructive" />
        <span className="text-xs">
          {quotaExceeded
            ? 'Out of storage space — recent changes may not be saved. Export your work, then free up space.'
            : "Couldn't save to this device — recent changes may not be saved."}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            useAppStore.getState().patchStorage({ writeFailed: false, quotaExceeded: false })
          }
        >
          Dismiss
        </Button>
      </div>
    )
  }

  const nearQuota = estimate ? estimate.usage / estimate.quota >= STORAGE_WARN_RATIO : false
  if (nearQuota && !nearDismissed) {
    return (
      <div className="panel-glass absolute bottom-3 left-3 z-40 flex max-w-xs items-center gap-3 p-3">
        <AlertTriangle className="size-4 shrink-0 text-destructive" />
        <span className="text-xs">
          On-device storage is almost full. Export your work and remove old scenes to avoid failed
          saves.
        </span>
        <Button variant="ghost" size="sm" onClick={() => setNearDismissed(true)}>
          Dismiss
        </Button>
      </div>
    )
  }

  return null
}
