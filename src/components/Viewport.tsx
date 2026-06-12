import { useEffect, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { initEngine, importFiles } from '@/app/studio'
import { isSupportedFile } from '@/core/io/importers'
import { useAppStore } from '@/store/appStore'
import { cn } from '@/lib/utils'

export function Viewport() {
  const ref = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const parts = useAppStore((s) => s.parts)
  const restoring = useAppStore((s) => s.restoring)
  const importing = useAppStore((s) => s.importing)

  useEffect(() => {
    if (ref.current) initEngine(ref.current)
  }, [])

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = [...e.dataTransfer.files].filter((f) => isSupportedFile(f.name))
    if (files.length) await importFiles(files, { unit: 'mm', mode: 'append' })
  }

  return (
    <div
      className="absolute inset-0"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div ref={ref} className="absolute inset-0 touch-none" />

      {dragOver && (
        <div className="pointer-events-none absolute inset-4 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/70 bg-primary/10">
          <p className="text-lg font-medium text-primary">Drop to import</p>
        </div>
      )}

      {!restoring && !importing && parts.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-center">
            <FolderOpen className="size-10 text-muted-foreground/60" />
            <p className="text-base text-muted-foreground">
              Drop an STL, OBJ or GLB here
              <br />
              <span className="text-sm text-muted-foreground/70">
                or use the Import panel to pick a file
              </span>
            </p>
          </div>
        </div>
      )}

      {(restoring || importing) && (
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 top-16 z-10 flex justify-center',
          )}
        >
          <div className="panel-glass px-4 py-2 text-sm text-muted-foreground">
            {restoring ? 'Restoring last session…' : 'Importing…'}
          </div>
        </div>
      )}
    </div>
  )
}
