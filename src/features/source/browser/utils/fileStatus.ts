/**
 * File status utilities for the file browser
 *
 * NOTE: A parallel `getDiffStatusClass` / `getDiffStatusCardClass` / `getDiffStatusLabel` /
 * `getDiffStatusColor` set previously lived here. None of them were ever called from a
 * component (verified before the 4.3.3 pending-move-visibility work), so they were removed
 * rather than extended with a `'moved_away'` case. The live equivalents are:
 * - List row CSS class: the `diffClass` computed in `FileList/buildVirtualRows.ts`
 * - Tree row CSS class: `DIFF_STATUS_CLASS_PREFIX` + `diffStatus` in
 *   `explorer/file-tree/constants.ts` / `VirtualizedTreeRow.tsx`
 * - Grid card ring class: `getDiffClass` in `FileGrid/hooks/useFileCardStatus.ts`
 * - Human labels: `t('diffStatus.<status>')` from `src/lib/i18n`
 */
import type { LocalFile } from '@/stores/pdmStore'

/**
 * Check if a file is synced (exists on server and locally with no changes)
 */
export function isFileSynced(file: LocalFile): boolean {
  // A file is synced if it has pdmData and no diffStatus (or diffStatus is undefined)
  return !!(file.pdmData && !file.diffStatus)
}

/**
 * Check if a file exists only in the cloud (not downloaded)
 */
export function isCloudOnly(file: LocalFile): boolean {
  return file.diffStatus === 'cloud'
}

/**
 * Check if a file is local only (not synced to server)
 */
export function isLocalOnly(file: LocalFile): boolean {
  return file.diffStatus === 'added' || (!file.pdmData && file.diffStatus !== 'cloud')
}

/**
 * Check if a file has local modifications
 */
export function hasLocalModifications(file: LocalFile): boolean {
  return file.diffStatus === 'modified'
}

/**
 * Check if a file is outdated (server has newer version)
 */
export function isOutdated(file: LocalFile): boolean {
  return file.diffStatus === 'outdated'
}

/**
 * Check if a file is checked out by the current user
 */
export function isCheckedOutByMe(file: LocalFile, userId: string | undefined): boolean {
  return !!(userId && file.pdmData?.checked_out_by === userId)
}

/**
 * Check if a file is checked out by someone else
 */
export function isCheckedOutByOthers(file: LocalFile, userId: string | undefined): boolean {
  const checkedOutBy = file.pdmData?.checked_out_by
  return !!(checkedOutBy && checkedOutBy !== userId)
}

/**
 * Get the checkout status for a file relative to the current user
 */
export function getCheckoutStatus(
  file: LocalFile,
  userId: string | undefined,
): 'mine' | 'others' | 'none' {
  if (!file.pdmData?.checked_out_by) return 'none'
  return file.pdmData.checked_out_by === userId ? 'mine' : 'others'
}

/**
 * Get folder checkout status based on contained files
 */
export function getFolderCheckoutStatus(
  folderPath: string,
  files: LocalFile[],
  userId: string | undefined,
): 'mine' | 'others' | 'both' | null {
  const folderPrefix = folderPath + '/'
  const serverOnlyStatuses = ['cloud', 'deleted']

  const folderFiles = files.filter((f) => {
    if (f.isDirectory) return false
    if (serverOnlyStatuses.includes(f.diffStatus || '')) return false
    return f.relativePath.replace(/\\/g, '/').startsWith(folderPrefix)
  })

  const hasMyCheckouts = folderFiles.some((f) => f.pdmData?.checked_out_by === userId)
  const hasOthersCheckouts = folderFiles.some(
    (f) => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== userId,
  )

  if (hasMyCheckouts && hasOthersCheckouts) return 'both'
  if (hasOthersCheckouts) return 'others'
  if (hasMyCheckouts) return 'mine'
  return null
}

/**
 * Check if a folder is fully synced (all files synced)
 */
export function isFolderSynced(folderPath: string, files: LocalFile[]): boolean {
  const folderPrefix = folderPath + '/'

  const folderFiles = files.filter((f) => {
    if (f.isDirectory) return false
    return f.relativePath.replace(/\\/g, '/').startsWith(folderPrefix)
  })

  // No files means synced (empty folder)
  if (folderFiles.length === 0) return true

  // Check if any files are not synced
  return folderFiles.every((f) => isFileSynced(f))
}
