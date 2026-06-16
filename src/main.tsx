import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Button } from './components/ui/button'
import { initPWA } from './app/pwa'

initPWA()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Last-resort backstop: if App chrome itself throws, show a full-screen
        recoverable message instead of a blank white page. */}
    <ErrorBoundary
      fallback={({ error, reset }) => (
        <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center">
          <h1 className="text-lg font-semibold">GoldSmith Studio hit an unexpected error.</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            The workspace couldn't render. Try reloading — your saved work is kept on this device.
          </p>
          {import.meta.env.DEV && (
            <pre className="max-h-48 max-w-full overflow-auto rounded bg-muted/50 p-3 text-left text-[11px] text-muted-foreground">
              {error.message}
            </pre>
          )}
          <Button variant="outline" onClick={reset}>
            Reload app
          </Button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
