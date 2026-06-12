import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Styled native select — on iPad the native picker is the best touch UX,
 * so we deliberately avoid a custom dropdown here.
 */
export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn('relative inline-flex w-full', className)}>
      <select
        className="h-11 w-full appearance-none rounded-md border border-border bg-input/50 pl-3 pr-9 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}
