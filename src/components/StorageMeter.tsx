import { HardDrive, Shield, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { STORAGE_WARN_RATIO } from '@/core/persist/db'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Proactive on-device storage readout (issue #32): how much of the origin's
 * approximate quota is in use, plus whether the browser has granted persistence.
 * "All data on-device" means the device's storage budget is the product's budget —
 * this turns a silent cliff into a managed resource before a write ever fails.
 */
export function StorageMeter() {
  const estimate = useAppStore((s) => s.storage.estimate)
  const persisted = useAppStore((s) => s.storage.persisted)

  const ratio = estimate ? Math.min(estimate.usage / estimate.quota, 1) : 0
  const pct = Math.round(ratio * 100)
  const near = ratio >= STORAGE_WARN_RATIO

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
      <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <HardDrive className="size-3.5" />
        On-device storage
      </label>

      {estimate ? (
        <>
          <div className="flex items-baseline justify-between text-xs">
            <span className="readout text-muted-foreground">
              {formatBytes(estimate.usage)} of {formatBytes(estimate.quota)}
            </span>
            <span className={cn('tabular-nums', near ? 'text-destructive' : 'text-muted-foreground')}>
              {pct}%
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              role="progressbar"
              aria-label="On-device storage used"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              className={cn(
                'h-full rounded-full transition-all',
                near ? 'bg-destructive' : 'bg-primary',
              )}
              // keep a sliver visible at low usage so the bar reads as a bar
              style={{ width: `${Math.max(pct, 2)}%` }}
            />
          </div>
          {near && (
            <p className="text-xs text-destructive">
              Storage is almost full — export your work and delete old scenes to free space.
            </p>
          )}
          <p className="text-[11px] text-muted-foreground/80">Figures are estimates.</p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Usage estimate isn’t available in this browser.
        </p>
      )}

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {persisted === true ? (
          <>
            <ShieldCheck className="size-3.5 shrink-0 text-primary" />
            Saved data is protected from automatic cleanup.
          </>
        ) : persisted === false ? (
          <>
            <ShieldAlert className="size-3.5 shrink-0" />
            The browser may evict saved data under storage pressure.
          </>
        ) : (
          <>
            <Shield className="size-3.5 shrink-0" />
            Data-persistence status unknown.
          </>
        )}
      </p>
    </div>
  )
}
