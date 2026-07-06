import { importFile, scaleMeshData } from '@/core/io/importers'
import { UNIT_TO_MM, type ImportUnit } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import { getEngine, newPartId, revisions } from '@/core/controller/context'

export async function importFiles(
  files: File[],
  opts: { unit: ImportUnit; mode: 'append' | 'replace' },
): Promise<void> {
  const store = useAppStore.getState()
  store.setImporting(true)
  try {
    const eng = getEngine()
    const factor = UNIT_TO_MM[opts.unit]
    // Parse everything up front so a mid-batch failure never destroys the
    // existing scene — the destructive clear only runs once all files are in.
    const imported: { name: string; data: ReturnType<typeof scaleMeshData>; colors?: Parameters<typeof eng.addPart>[5] }[] = []
    for (const file of files) {
      const parts = await importFile(file)
      for (const part of parts) {
        imported.push({ name: part.name, data: scaleMeshData(part.data, factor), colors: part.colors })
      }
    }
    if (opts.mode === 'replace') {
      eng.clearParts()
      revisions.clear()
    }
    for (const part of imported) {
      eng.addPart(newPartId(), part.name, part.data, undefined, undefined, part.colors)
    }
    eng.fitToView()
    store.setImporting(false)
  } catch (err) {
    store.setImporting(false, err instanceof Error ? err.message : String(err))
  }
}
