import { useEffect } from 'react'
import { Download, RefreshCw, WifiOff, X } from 'lucide-react'
import { dismissPwaBanner, promptInstall, reloadForUpdate } from '@/app/pwa'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'

/**
 * Lightweight PWA affordance (plan §2.8): a corner banner offering "reload to
 * update" when a new service worker is waiting, an "offline ready" confirmation
 * on first precache, and a native "install app" button on Chromium.
 */
export function PwaBanner() {
  const { needRefresh, offlineReady, canInstall } = useAppStore((s) => s.pwa)

  // The "offline ready" note is informational — fade it out on its own.
  useEffect(() => {
    if (offlineReady && !needRefresh) {
      const t = setTimeout(dismissPwaBanner, 6000)
      return () => clearTimeout(t)
    }
  }, [offlineReady, needRefresh])

  if (!needRefresh && !offlineReady && !canInstall) return null

  return (
    <div className="panel-glass absolute bottom-3 left-3 z-40 flex max-w-xs items-center gap-3 p-3">
      {needRefresh ? (
        <>
          <RefreshCw className="size-4 shrink-0 text-primary" />
          <span className="text-xs">A new version is ready.</span>
          <Button size="sm" onClick={reloadForUpdate}>
            Reload
          </Button>
          <DismissButton />
        </>
      ) : canInstall ? (
        <>
          <Download className="size-4 shrink-0 text-primary" />
          <span className="text-xs">Install GoldSmith Studio for offline use.</span>
          <Button size="sm" onClick={() => void promptInstall()}>
            Install
          </Button>
          <DismissButton />
        </>
      ) : (
        <>
          <WifiOff className="size-4 shrink-0 text-success" />
          <span className="text-xs">Ready to work offline.</span>
          <DismissButton />
        </>
      )}
    </div>
  )
}

function DismissButton() {
  return (
    <Button variant="ghost" size="iconSm" title="Dismiss" onClick={dismissPwaBanner}>
      <X />
    </Button>
  )
}
