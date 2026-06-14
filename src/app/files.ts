/**
 * Browser file plumbing for exports/backups (plan §2.8). Progressive
 * enhancement: where the File System Access API exists (Chromium desktop) the
 * user picks a save location; everywhere else (Safari/iPad, Firefox) we fall
 * back to a classic `<a download>`. The Web Share API path lets iPad send an
 * exported file straight to Mail/AirDrop. All of this is app-layer, DOM-bound —
 * the pure (de)serialization lives in src/core/persist/backup.ts.
 */

export interface SaveType {
  description: string
  /** MIME → list of extensions, e.g. { 'application/json': ['.json'] }. */
  accept: Record<string, string[]>
}

export type SaveData = Uint8Array | ArrayBuffer | string

function toBlob(data: SaveData, mime: string): Blob {
  return new Blob([data as BlobPart], { type: mime })
}

/** `<a download>` fallback; defers revoke so WebKit finishes the download. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Save bytes/text to disk. Uses showSaveFilePicker where available (the user
 * chooses the location); otherwise triggers a download. Must be called from a
 * user gesture. A cancelled picker resolves quietly.
 */
export async function saveFile(
  data: SaveData,
  filename: string,
  mime: string,
  type?: SaveType,
): Promise<void> {
  const blob = toBlob(data, mime)
  const picker = (
    window as unknown as { showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle> }
  ).showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: type ? [type] : undefined,
      })
      const writable = await (handle as unknown as { createWritable: () => Promise<{
        write: (d: Blob) => Promise<void>
        close: () => Promise<void>
      }> }).createWritable()
      await writable.write(blob)
      await writable.close()
      return
    } catch (err) {
      // user cancelled the picker — not an error worth surfacing
      if (err instanceof DOMException && err.name === 'AbortError') return
      // any other picker failure: fall back to a plain download
    }
  }
  downloadBlob(blob, filename)
}

/** Read a single picked text file (used to import a backup). */
export function pickTextFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      file.text().then(resolve, () => resolve(null))
    }
    // dismissing the picker fires 'cancel' (not 'change') in modern browsers —
    // resolve null so the returned Promise never dangles
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/** Can we share these files via the Web Share API on this device? */
export function canShareFiles(files: File[]): boolean {
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean }
  return typeof nav.canShare === 'function' && nav.canShare({ files })
}

/**
 * Share an exported file (STL/PDF/backup) through the native share sheet. Returns
 * true if the share was initiated; false (or throws) if unavailable so callers
 * can fall back to {@link saveFile}.
 */
export async function shareFiles(
  data: SaveData,
  filename: string,
  mime: string,
  title?: string,
): Promise<boolean> {
  const file = new File([data as BlobPart], filename, { type: mime })
  if (!canShareFiles([file])) return false
  try {
    await navigator.share({ files: [file], title: title ?? filename })
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return true
    return false
  }
}
