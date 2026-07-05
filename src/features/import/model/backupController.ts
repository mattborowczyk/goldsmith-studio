import { parseBackup, serializeBackup } from '@/core/persist/backup'
import { dumpDatabase, restoreDatabase } from '@/core/persist/db'
import { deliverFiles, pickTextFile, type SaveType } from '@/app/files'

const BACKUP_SAVE_TYPE: SaveType = {
  description: 'GoldSmith Studio backup',
  accept: { 'application/json': ['.json'] },
}

export async function exportBackup(opts: { share?: boolean } = {}): Promise<void> {
  const json = serializeBackup(await dumpDatabase())
  const name = `goldsmith-backup-${new Date().toISOString().slice(0, 10)}.json`
  await deliverFiles([{ data: json, name, mime: 'application/json' }], {
    share: opts.share,
    title: 'GoldSmith Studio backup',
    type: BACKUP_SAVE_TYPE,
  })
}

export async function importBackup(): Promise<boolean> {
  const text = await pickTextFile('application/json,.json')
  if (text === null) return false
  const dump = parseBackup(text)
  await restoreDatabase(dump)
  location.reload()
  return true
}
