/**
 * Utility functions to count visible menu items
 * Used to determine whether to show "More Actions" expandable section
 *
 * These functions mirror the conditional rendering logic in each action component
 */
import type { LocalFile } from '@/stores/pdmStore'
import { getOutdatedFilesFromSelection } from '@/lib/commands/handlers/getLatest'
import type { SelectionCounts, SelectionState } from '../actions/types'

/**
 * Threshold for showing "More Actions" expandable section.
 * If total items <= this value, all items are shown directly.
 * If total items > this value, collaboration items are hidden behind "More Actions".
 */
export const CONTEXT_MENU_ITEMS_THRESHOLD = 15

/**
 * Props needed to count menu items - subset of what action components receive
 */
export interface MenuItemCountProps {
  contextFiles: LocalFile[]
  multiSelect: boolean
  firstFile: LocalFile
  counts: SelectionCounts
  state: SelectionState
  userId?: string
  isAdmin?: boolean
  solidworksEnabled?: boolean
  allFiles: LocalFile[]
}

/**
 * Count items from OpenActions component
 */
export function countOpenActions(props: MenuItemCountProps): number {
  const { contextFiles, multiSelect, firstFile } = props
  const allFiles = contextFiles.every((f) => !f.isDirectory)
  const allCloudOnly = contextFiles.every((f) => f.diffStatus === 'cloud')
  const isFolder = firstFile.isDirectory

  // Single file - not cloud only
  if (!multiSelect && !isFolder && !allCloudOnly) return 1

  // Multiple files - all are files, not cloud only
  if (multiSelect && allFiles && !allCloudOnly) return 1

  // Single folder - not cloud only
  if (!multiSelect && isFolder && !allCloudOnly) return 1

  return 0
}

/**
 * Count items from AssemblyActions component
 */
export function countAssemblyActions(props: MenuItemCountProps): number {
  const { multiSelect, firstFile, solidworksEnabled } = props

  const isSolidWorksInsertable = (ext: string | undefined) => {
    const lowerExt = ext?.toLowerCase()
    return lowerExt === '.sldprt' || lowerExt === '.sldasm'
  }

  const canInsert =
    !multiSelect &&
    isSolidWorksInsertable(firstFile.extension) &&
    firstFile.diffStatus !== 'cloud' &&
    solidworksEnabled

  return canInsert ? 1 : 0
}

/**
 * Count items from SyncActions component
 */
export function countSyncActions(props: MenuItemCountProps): number {
  const { contextFiles, counts, state, allFiles } = props
  let count = 0

  const anyCloudOnly =
    counts.cloudOnlyCount > 0 || contextFiles.some((f) => f.diffStatus === 'cloud')

  // Download cloud-only files
  if (anyCloudOnly) count++

  // Get Latest for outdated files - never mixed with the Download item above.
  // Same predicate as the Download item's `anyCloudOnly` above, and the same one
  // SyncActions.tsx / PDMItems.tsx use to show the item: at least one outdated file
  // in the selection, including files inside selected folders.
  const outdatedFilesInSelection = getOutdatedFilesFromSelection(allFiles, contextFiles)
  const anyOutdated =
    outdatedFilesInSelection.length > 0 || contextFiles.some((f) => f.diffStatus === 'outdated')
  if (anyOutdated) count++

  // Keep Local Only (Ignore) submenu
  if (state.anyUnsynced && !state.allCloudOnly) count++

  // First Check In
  if (state.anyUnsynced) count++

  return count
}

/**
 * Count items from CheckoutActions component
 */
export function countCheckoutActions(props: MenuItemCountProps): number {
  const { counts, state, isAdmin } = props
  let count = 0

  // Check Out - always shown (even if disabled)
  count++

  // Check In - only for synced files
  if (state.anySynced) count++

  // Discard Checkout - for files checked out by current user
  if (counts.checkinableCount > 0) count++

  // Admin: Force Release - for files checked out by others
  if (isAdmin && counts.checkedOutByOthersCount > 0) count++

  // Change State submenu - for synced files
  if (state.anySynced) count++

  return count
}

/**
 * Count items from DeleteActions component
 */
export function countDeleteActions(props: MenuItemCountProps): number {
  const { contextFiles, state, allFiles } = props
  let count = 0

  // Helper to get all files including those inside folders
  const getAllFilesFromSelection = () => {
    const result: LocalFile[] = []
    for (const item of contextFiles) {
      if (item.isDirectory) {
        const folderPath = item.relativePath.replace(/\\/g, '/')
        const filesInFolder = allFiles.filter((f) => {
          if (f.isDirectory) return false
          const filePath = f.relativePath.replace(/\\/g, '/')
          return filePath.startsWith(folderPath + '/')
        })
        result.push(...filesInFolder)
      } else {
        result.push(item)
      }
    }
    return [...new Map(result.map((f) => [f.path, f])).values()]
  }

  const allFilesInSelection = getAllFilesFromSelection()
  // Mirrors the 'moved_away' exclusion in DeleteActions.tsx - keeps this count in sync with
  // what that component actually renders.
  const syncedFilesInDelete = allFilesInSelection.filter(
    (f) =>
      f.pdmData &&
      f.diffStatus !== 'cloud' &&
      f.diffStatus !== 'added' &&
      f.diffStatus !== 'deleted_remote' &&
      f.diffStatus !== 'moved_away',
  )
  const unsyncedFilesInDelete = allFilesInSelection.filter(
    (f) => !f.pdmData || f.diffStatus === 'added' || f.diffStatus === 'deleted_remote',
  )

  const hasLocalFiles = contextFiles.some((f) => f.diffStatus !== 'cloud')
  const hasSyncedFiles =
    syncedFilesInDelete.length > 0 ||
    contextFiles.some(
      (f) => f.pdmData && f.diffStatus !== 'cloud' && f.diffStatus !== 'moved_away',
    )
  const hasUnsyncedLocalFiles =
    unsyncedFilesInDelete.length > 0 ||
    contextFiles.some(
      (f) =>
        (!f.pdmData || f.diffStatus === 'added' || f.diffStatus === 'deleted_remote') &&
        f.diffStatus !== 'cloud',
    )

  // Remove Local Copy
  if (hasLocalFiles && hasSyncedFiles) count++

  // Delete Locally
  if (hasUnsyncedLocalFiles && !hasSyncedFiles && !state.allCloudOnly) count++

  // Delete from Server (Keep Local)
  if (hasSyncedFiles && !state.allCloudOnly) count++

  // Delete Local & Server / Delete from Server
  if (hasSyncedFiles || state.allCloudOnly) count++

  // Undo - always shown
  count++

  return count
}

/**
 * Count items from CollaborationActions component (the "More Actions" content)
 */
export function countCollaborationActions(props: MenuItemCountProps): number {
  const { contextFiles, multiSelect, firstFile, state, userId, allFiles } = props
  const isFolder = firstFile.isDirectory
  let count = 0

  // SolidWorks extensions
  const swExtensions = ['.sldprt', '.sldasm', '.slddrw']
  const assemblyExtensions = ['.sldasm']
  const isSWFile =
    !isFolder && state.isSynced && swExtensions.includes(firstFile.extension?.toLowerCase() || '')
  const isAssemblyFile =
    !isFolder &&
    state.isSynced &&
    assemblyExtensions.includes(firstFile.extension?.toLowerCase() || '')

  // For folders, check for SW files inside
  const getSwFilesInFolder = () => {
    if (!isFolder || multiSelect) return []
    const folderPath = firstFile.relativePath
    return allFiles.filter(
      (f) =>
        !f.isDirectory &&
        f.relativePath.startsWith(folderPath + '/') &&
        swExtensions.includes(f.extension?.toLowerCase() || '') &&
        f.pdmData?.id,
    )
  }
  const swFilesInFolder = getSwFilesInFolder()

  // Get assembly files in folder
  const getAssemblyFilesInFolder = () => {
    if (!isFolder || multiSelect) return []
    const folderPath = firstFile.relativePath
    return allFiles.filter(
      (f) =>
        !f.isDirectory &&
        f.relativePath.startsWith(folderPath + '/') &&
        assemblyExtensions.includes(f.extension?.toLowerCase() || '') &&
        f.pdmData?.id,
    )
  }
  const assemblyFilesInFolder = getAssemblyFilesInFolder()

  // Get synced assembly files from selection (for multi-select)
  const getAssemblyFilesInSelection = () => {
    if (!multiSelect) return []
    return contextFiles.filter(
      (f) =>
        !f.isDirectory &&
        assemblyExtensions.includes(f.extension?.toLowerCase() || '') &&
        f.pdmData?.id,
    )
  }
  const assemblyFilesInSelection = getAssemblyFilesInSelection()

  // Where Used - for synced files
  if (!isFolder && state.isSynced) count++

  // Properties - always shown
  count++

  // Refresh Metadata - for synced SW files
  if (isSWFile) count++

  // Refresh Metadata - for folders containing SW files
  if (isFolder && !multiSelect && swFilesInFolder.length > 0) count++

  // Extract References - for synced assembly files
  if (isAssemblyFile) count++

  // Extract References - for multi-select with assemblies
  if (multiSelect && assemblyFilesInSelection.length > 0) count++

  // Extract References - for folders containing assemblies
  if (isFolder && !multiSelect && assemblyFilesInFolder.length > 0) count++

  // Request Review - for synced files
  if (!multiSelect && !isFolder && state.isSynced && firstFile.pdmData?.id) count++

  // View Reviews - for synced files (same condition as Request Review)
  if (!multiSelect && !isFolder && state.isSynced && firstFile.pdmData?.id) count++

  // Request Checkout - for files checked out by others
  if (
    !multiSelect &&
    !isFolder &&
    state.isSynced &&
    firstFile.pdmData?.checked_out_by &&
    firstFile.pdmData.checked_out_by !== userId
  )
    count++

  // Notify Someone - for synced files
  if (!multiSelect && !isFolder && state.isSynced && firstFile.pdmData?.id) count++

  // Watch/Unwatch File - for synced files
  if (!multiSelect && !isFolder && state.isSynced && firstFile.pdmData?.id) count++

  // Copy Share Link - for synced files and folders
  if (!multiSelect && (state.isSynced || isFolder)) count++

  // Add to ECO - for synced files
  if (!multiSelect && !isFolder && state.isSynced && firstFile.pdmData?.id) count++

  return count
}

/**
 * Count total visible menu items (excluding collaboration actions which go in "More Actions")
 */
export function countPrimaryMenuItems(props: MenuItemCountProps): number {
  return (
    countOpenActions(props) +
    countAssemblyActions(props) +
    countSyncActions(props) +
    countCheckoutActions(props) +
    3 + // File Actions, Edit, Export submenus (always shown as groups)
    countDeleteActions(props)
  )
}

/**
 * Determine whether to show the expandable "More Actions" section
 * Returns true if total items (primary + collaboration) exceeds threshold
 */
export function shouldShowExpandableSection(props: MenuItemCountProps): boolean {
  const primaryCount = countPrimaryMenuItems(props)
  const collaborationCount = countCollaborationActions(props)
  const total = primaryCount + collaborationCount

  return total > CONTEXT_MENU_ITEMS_THRESHOLD
}
