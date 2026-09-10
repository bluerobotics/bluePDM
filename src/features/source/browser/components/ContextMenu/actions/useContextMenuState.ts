/**
 * Hook to compute context menu selection state and counts
 */
import { useMemo } from 'react'
import type { LocalFile } from '@/stores/pdmStore'
import { usePDMStore } from '@/stores/pdmStore'
import type { SelectionCounts, SelectionState } from './types'

interface UseContextMenuStateParams {
  contextFiles: LocalFile[]
  userId: string | undefined
}

interface UseContextMenuStateReturn {
  counts: SelectionCounts
  state: SelectionState
  syncedFilesInSelection: LocalFile[]
  unsyncedFilesInSelection: LocalFile[]
}

/**
 * Compute derived state from context menu file selection
 */
export function useContextMenuSelectionState({
  contextFiles,
  userId,
}: UseContextMenuStateParams): UseContextMenuStateReturn {
  const { files } = usePDMStore()

  // Get all synced files - either directly selected or inside selected folders.
  // Excludes 'cloud' (nothing downloaded to act on) and 'moved_away' (a stub sharing the
  // real file's pdmData/checkout state, but with no local file at its own path - the checkout
  // and checkin counts below must not count it as an actionable target).
  const syncedFilesInSelection = useMemo(() => {
    const result: LocalFile[] = []
    for (const item of contextFiles) {
      if (item.isDirectory) {
        const folderPrefix = item.relativePath + '/'
        const filesInFolder = files.filter(
          (f) =>
            !f.isDirectory &&
            f.pdmData &&
            f.diffStatus !== 'cloud' &&
            f.diffStatus !== 'moved_away' &&
            (f.relativePath.startsWith(folderPrefix) ||
              f.relativePath.substring(0, f.relativePath.lastIndexOf('/')) === item.relativePath),
        )
        result.push(...filesInFolder)
      } else if (item.pdmData && item.diffStatus !== 'cloud' && item.diffStatus !== 'moved_away') {
        result.push(item)
      }
    }
    return result
  }, [contextFiles, files])

  // Get all unsynced files - either directly selected or inside selected folders
  const unsyncedFilesInSelection = useMemo(() => {
    const result: LocalFile[] = []
    for (const item of contextFiles) {
      if (item.isDirectory) {
        const folderPrefix = item.relativePath + '/'
        const filesInFolder = files.filter(
          (f) =>
            !f.isDirectory &&
            (!f.pdmData || f.diffStatus === 'deleted_remote') &&
            f.diffStatus !== 'ignored' &&
            (f.relativePath.startsWith(folderPrefix) ||
              f.relativePath.substring(0, f.relativePath.lastIndexOf('/')) === item.relativePath),
        )
        result.push(...filesInFolder)
      } else if (
        (!item.pdmData || item.diffStatus === 'deleted_remote') &&
        item.diffStatus !== 'ignored'
      ) {
        result.push(item)
      }
    }
    return result
  }, [contextFiles, files])

  // Compute counts
  const counts = useMemo((): SelectionCounts => {
    const fileCount = contextFiles.filter((f) => !f.isDirectory).length
    const folderCount = contextFiles.filter((f) => f.isDirectory).length

    // Cloud-only count includes files inside folders
    let cloudOnlyCount = 0
    for (const item of contextFiles) {
      if (item.isDirectory) {
        const folderPrefix = item.relativePath + '/'
        cloudOnlyCount += files.filter(
          (f) =>
            !f.isDirectory && f.diffStatus === 'cloud' && f.relativePath.startsWith(folderPrefix),
        ).length
      } else if (item.diffStatus === 'cloud') {
        cloudOnlyCount++
      }
    }

    return {
      fileCount,
      folderCount,
      syncedFilesCount: syncedFilesInSelection.length,
      unsyncedFilesCount: unsyncedFilesInSelection.length,
      checkoutableCount: syncedFilesInSelection.filter((f) => !f.pdmData?.checked_out_by).length,
      checkinableCount: syncedFilesInSelection.filter((f) => f.pdmData?.checked_out_by === userId)
        .length,
      checkedOutByOthersCount: syncedFilesInSelection.filter(
        (f) => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== userId,
      ).length,
      cloudOnlyCount,
    }
  }, [contextFiles, files, syncedFilesInSelection, unsyncedFilesInSelection, userId])

  // Compute state flags
  const state = useMemo((): SelectionState => {
    const firstFile = contextFiles[0]
    const isFolder = firstFile?.isDirectory ?? false
    const allFolders = contextFiles.every((f) => f.isDirectory)
    const allFiles = contextFiles.every((f) => !f.isDirectory)
    const allCloudOnly = contextFiles.every((f) => f.diffStatus === 'cloud')
    const isSynced = contextFiles.every((f) => !!f.pdmData)

    // Check for synced content
    const hasSyncedContent = () => {
      for (const item of contextFiles) {
        if (item.isDirectory) {
          const folderPrefix = item.relativePath + '/'
          const hasSyncedInFolder = files.some(
            (f) =>
              !f.isDirectory &&
              f.pdmData &&
              f.diffStatus !== 'cloud' &&
              f.diffStatus !== 'moved_away' &&
              (f.relativePath.startsWith(folderPrefix) ||
                f.relativePath.substring(0, f.relativePath.lastIndexOf('/')) === item.relativePath),
          )
          if (hasSyncedInFolder) return true
        } else if (
          item.pdmData &&
          item.diffStatus !== 'cloud' &&
          item.diffStatus !== 'moved_away'
        ) {
          return true
        }
      }
      return false
    }

    // Check for unsynced content
    const hasUnsyncedContent = () => {
      for (const item of contextFiles) {
        if (item.isDirectory) {
          const folderPrefix = item.relativePath + '/'
          const hasUnsyncedInFolder = files.some(
            (f) =>
              !f.isDirectory &&
              !f.pdmData &&
              (f.relativePath.startsWith(folderPrefix) ||
                f.relativePath.substring(0, f.relativePath.lastIndexOf('/')) === item.relativePath),
          )
          if (hasUnsyncedInFolder) return true
        } else if (!item.pdmData) {
          return true
        }
      }
      return false
    }

    const anySynced = hasSyncedContent()
    const anyUnsynced = hasUnsyncedContent()

    const allCheckedOut =
      syncedFilesInSelection.length > 0 &&
      syncedFilesInSelection.every((f) => f.pdmData?.checked_out_by)
    const allCheckedIn =
      syncedFilesInSelection.length > 0 &&
      syncedFilesInSelection.every((f) => !f.pdmData?.checked_out_by)
    const allCheckedOutByOthers =
      syncedFilesInSelection.length > 0 &&
      syncedFilesInSelection.every(
        (f) => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== userId,
      )

    // Can always cut - checkout not required for moving files
    const canCut = true

    return {
      isFolder,
      allFolders,
      allFiles,
      allCloudOnly,
      isSynced,
      anySynced,
      anyUnsynced,
      allCheckedOut,
      allCheckedIn,
      allCheckedOutByOthers,
      canCut,
    }
  }, [contextFiles, files, syncedFilesInSelection, userId])

  return {
    counts,
    state,
    syncedFilesInSelection,
    unsyncedFilesInSelection,
  }
}
