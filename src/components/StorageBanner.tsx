import { AlertTriangle } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'

/**
 * Durability warning (issue #10): a saved-to-disk write failed, so on-device work
 * may not actually be persisted. Non-blocking and dismissable — the flag clears on
 * its own once a later write succeeds. Quota errors get a more actionable message.
 */
export function StorageBanner() {
  const { writeFailed, quotaExceeded } = useAppStore((s) => s.storage)

  if (!writeFailed) return null

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
        onClick={() => useAppStore.getState().patchStorage({ writeFailed: false, quotaExceeded: false })}
      >
        Dismiss
      </Button>
    </div>
  )
}
