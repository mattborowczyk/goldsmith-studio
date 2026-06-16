import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface FallbackProps {
  error: Error
  reset: () => void
}

interface Props {
  children: ReactNode
  /** Noun shown in the default fallback, e.g. "panel" → "This panel hit an error." */
  label?: string
  /** Custom fallback. When omitted, a compact recoverable card is rendered. */
  fallback?: (props: FallbackProps) => ReactNode
}

interface State {
  error: Error | null
  /** Bumped on reset so the children subtree fully re-mounts, not just re-renders. */
  resetKey: number
}

/**
 * Reusable React error boundary (issue #11). A render-time throw in a wrapped
 * subtree is caught here so the rest of the app — including the live 3D viewport
 * and the user's unsaved scene — stays alive instead of white-screening.
 *
 * Reset re-mounts the children (fresh `resetKey`) rather than just clearing the
 * error, so a panel that crashed on bad transient state gets a clean start.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // No backend/telemetry by design — log to the console so the crash is still
    // diagnosable from devtools.
    console.error('[ErrorBoundary] caught render error', error, info.componentStack)
  }

  reset = () => this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }))

  render() {
    const { error, resetKey } = this.state
    const { children, fallback, label } = this.props

    if (error) {
      if (fallback) return fallback({ error, reset: this.reset })
      return <DefaultFallback error={error} reset={this.reset} label={label} />
    }

    return <Fragment key={resetKey}>{children}</Fragment>
  }
}

function DefaultFallback({ error, reset, label = 'view' }: FallbackProps & { label?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <AlertTriangle className="size-6 shrink-0 text-destructive" />
      <p className="text-sm font-medium">This {label} hit an error.</p>
      {import.meta.env.DEV && (
        <pre className="max-h-40 max-w-full overflow-auto rounded bg-muted/50 p-2 text-left text-[11px] text-muted-foreground">
          {error.message}
        </pre>
      )}
      <Button variant="outline" size="sm" onClick={reset}>
        <RotateCcw />
        Reload {label}
      </Button>
    </div>
  )
}
