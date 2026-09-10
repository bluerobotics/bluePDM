import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Trash2,
  RefreshCw,
  RotateCcw,
  FileText,
  AlertTriangle,
  Loader2,
  FileBox,
  FolderOpen,
  Folder,
  X,
  Search,
  Filter,
  List,
  Network,
  Database,
  User,
} from 'lucide-react'
import { log } from '@/lib/logger'
import { t } from '@/lib/i18n'
import { usePDMStore } from '@/stores/pdmStore'
import { useShallow } from 'zustand/react/shallow'
import {
  getDeletedFiles,
  restoreFile,
  permanentlyDeleteFiles,
  emptyTrash,
  updateFilePath,
  syncFolder,
} from '@/lib/supabase'
import { clearVaultCache } from '@/lib/cache/vaultFileCache'
import type { DeletedFile, PDMFile } from '@/types/pdm'
import { useFlattenedTrash } from './hooks'
import { VirtualizedTrashRow } from './VirtualizedTrashRow'
import { FolderPickerDialog } from './FolderPickerDialog'

export function TrashView() {
  const {
    organization,
    isVaultConnected,
    activeVaultId,
    user,
    addToast,
    addProgressToast,
    updateProgressToast,
    removeToast,
    isProgressToastCancelled,
    connectedVaults,
    trashFolderFilter,
    setTrashFolderFilter,
    addCloudFile,
    addCloudFiles,
  } = usePDMStore(
    useShallow((s) => ({
      organization: s.organization,
      isVaultConnected: s.isVaultConnected,
      activeVaultId: s.activeVaultId,
      user: s.user,
      addToast: s.addToast,
      addProgressToast: s.addProgressToast,
      updateProgressToast: s.updateProgressToast,
      removeToast: s.removeToast,
      isProgressToastCancelled: s.isProgressToastCancelled,
      connectedVaults: s.connectedVaults,
      trashFolderFilter: s.trashFolderFilter,
      setTrashFolderFilter: s.setTrashFolderFilter,
      addCloudFile: s.addCloudFile,
      addCloudFiles: s.addCloudFiles,
    })),
  )
  const [deletedFiles, setDeletedFiles] = useState<DeletedFile[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [isRestoring, setIsRestoring] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showEmptyConfirm, setShowEmptyConfirm] = useState(false)
  const [folderPickerState, setFolderPickerState] = useState<{
    files: Array<{ id: string; fileName: string; oldPath: string; fullFileData: PDMFile }>
    onSelect: (folder: string) => Promise<void>
  } | null>(null)
  const [isEmptying, setIsEmptying] = useState(false)

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [deletedByFilter, setDeletedByFilter] = useState<string | null>(null)
  const [folderFilter, setFolderFilter] = useState<string | null>(null)
  const [vaultFilter, setVaultFilter] = useState<string | null>(null) // null = current vault only, 'all' = all vaults
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [showFilters, setShowFilters] = useState(false)
  const [viewMode, setViewMode] = useState<'files' | 'folders' | 'nested'>('files') // files = only files, folders = only folders, nested = full hierarchy

  // Ref for the scrollable container (virtualization)
  const scrollContainerRef = useRef<HTMLDivElement>(null!)

  // Get current vault name
  const currentVault = connectedVaults.find((v) => v.id === activeVaultId)

  // Get unique deleted-by users from the files
  const deletedByUsers = useMemo(() => {
    const users = new Map<string, { id: string; name: string }>()
    deletedFiles.forEach((file) => {
      if (file.deleted_by && file.deleted_by_user) {
        users.set(file.deleted_by, {
          id: file.deleted_by,
          name: file.deleted_by_user.full_name || file.deleted_by_user.email.split('@')[0],
        })
      }
    })
    return Array.from(users.values())
  }, [deletedFiles])

  // Get unique folder paths from deleted files
  const folderPaths = useMemo(() => {
    const folders = new Set<string>()
    deletedFiles.forEach((file) => {
      // Get parent folder path
      const lastSlash = file.file_path.lastIndexOf('/')
      if (lastSlash > 0) {
        const folder = file.file_path.substring(0, lastSlash)
        folders.add(folder)
      }
    })
    return Array.from(folders).sort()
  }, [deletedFiles])

  // Filter and search files
  const filteredFiles = useMemo(() => {
    return deletedFiles.filter((file) => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        const matchesName = file.file_name.toLowerCase().includes(query)
        const matchesPath = file.file_path.toLowerCase().includes(query)
        if (!matchesName && !matchesPath) return false
      }

      // Deleted-by filter
      if (deletedByFilter && file.deleted_by !== deletedByFilter) {
        return false
      }

      // Folder filter
      if (folderFilter) {
        const fileFolderPath = file.file_path.substring(0, file.file_path.lastIndexOf('/'))
        if (!fileFolderPath.startsWith(folderFilter)) {
          return false
        }
      }

      return true
    })
  }, [deletedFiles, searchQuery, deletedByFilter, folderFilter])

  // Separate actual file records from folder records
  // Also extract top-level deleted folders from file paths
  const { deletedFilesOnly, deletedFoldersOnly, topLevelFolders } = useMemo(() => {
    const filesOnly: DeletedFile[] = []
    const foldersOnly: DeletedFile[] = []

    filteredFiles.forEach((file) => {
      // Check if it's a folder record - extension is empty and name has no extension
      const isFolder = file.extension === '' && !file.file_name.includes('.')

      if (isFolder) {
        foldersOnly.push(file)
      } else {
        filesOnly.push(file)
      }
    })

    // Extract top-level folders from file paths
    // A top-level folder is the first folder segment in a deleted file's path
    const topLevelSet = new Map<
      string,
      {
        name: string
        path: string
        count: number
        latestDelete: string
        deletedBy?: DeletedFile['deleted_by_user']
      }
    >()

    filesOnly.forEach((file) => {
      const firstSlash = file.file_path.indexOf('/')
      if (firstSlash > 0) {
        const topFolder = file.file_path.substring(0, firstSlash)
        const existing = topLevelSet.get(topFolder)
        if (existing) {
          existing.count++
          if (new Date(file.deleted_at) > new Date(existing.latestDelete)) {
            existing.latestDelete = file.deleted_at
            existing.deletedBy = file.deleted_by_user
          }
        } else {
          topLevelSet.set(topFolder, {
            name: topFolder,
            path: topFolder,
            count: 1,
            latestDelete: file.deleted_at,
            deletedBy: file.deleted_by_user,
          })
        }
      }
    })

    return {
      deletedFilesOnly: filesOnly,
      deletedFoldersOnly: foldersOnly,
      topLevelFolders: Array.from(topLevelSet.values()).sort(
        (a, b) => new Date(b.latestDelete).getTime() - new Date(a.latestDelete).getTime(),
      ),
    }
  }, [filteredFiles])

  // Group files by folder for nested display - build full folder hierarchy
  const groupedByFolder = useMemo(() => {
    const groups = new Map<string, DeletedFile[]>()
    const allFolderPaths = new Set<string>()

    // Only use actual files (not folders) for nested view
    deletedFilesOnly.forEach((file) => {
      const lastSlash = file.file_path.lastIndexOf('/')
      const folder = lastSlash > 0 ? file.file_path.substring(0, lastSlash) : '/'

      if (!groups.has(folder)) {
        groups.set(folder, [])
      }
      groups.get(folder)!.push(file)

      // Also track all parent folders in the hierarchy
      if (lastSlash > 0) {
        const parts = file.file_path.substring(0, lastSlash).split('/')
        let currentPath = ''
        for (const part of parts) {
          currentPath = currentPath ? `${currentPath}/${part}` : part
          allFolderPaths.add(currentPath)
        }
      }
    })

    // Add empty folder entries for any parent folders not already in groups
    allFolderPaths.forEach((folderPath) => {
      if (!groups.has(folderPath)) {
        groups.set(folderPath, [])
      }
    })

    // Sort folders alphabetically
    return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])))
  }, [deletedFilesOnly])

  // Files sorted by deletion time (most recent first) - for file view
  const filesSortedByTime = useMemo(() => {
    return [...deletedFilesOnly].sort(
      (a, b) => new Date(b.deleted_at).getTime() - new Date(a.deleted_at).getTime(),
    )
  }, [deletedFilesOnly])

  // Note: foldersSortedByTime computed but kept for potential future folder view

  // Toggle folder expansion
  const toggleFolderExpand = (folder: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) {
        next.delete(folder)
      } else {
        next.add(folder)
      }
      return next
    })
  }

  // Get all files recursively in a folder (including subfolders)
  const getFilesInFolderRecursive = (folderPath: string): DeletedFile[] => {
    return deletedFilesOnly.filter(
      (f) =>
        f.file_path.startsWith(folderPath + '/') ||
        f.file_path.substring(0, f.file_path.lastIndexOf('/')) === folderPath,
    )
  }

  // Select all files in a folder (recursively including subfolders)
  const selectFolder = (folder: string) => {
    const folderFiles = getFilesInFolderRecursive(folder)
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      const allSelected = folderFiles.length > 0 && folderFiles.every((f) => prev.has(f.id))

      if (allSelected) {
        // Deselect all in folder
        folderFiles.forEach((f) => next.delete(f.id))
      } else {
        // Select all in folder
        folderFiles.forEach((f) => next.add(f.id))
      }
      return next
    })
  }

  // Check if all files in folder are selected (recursively)
  const isFolderSelected = (folder: string) => {
    const folderFiles = getFilesInFolderRecursive(folder)
    return folderFiles.length > 0 && folderFiles.every((f) => selectedFiles.has(f.id))
  }

  // Check if some (but not all) files in folder are selected (recursively)
  const isFolderPartiallySelected = (folder: string) => {
    const folderFiles = getFilesInFolderRecursive(folder)
    const selectedCount = folderFiles.filter((f) => selectedFiles.has(f.id)).length
    return selectedCount > 0 && selectedCount < folderFiles.length
  }

  // Get recursive file count for a folder
  const getRecursiveFileCount = useCallback(
    (folder: string) => {
      return getFilesInFolderRecursive(folder).length
    },
    [deletedFilesOnly],
  )

  // Get files in a specific folder (for folder view selection)
  const getFilesInFolder = useCallback(
    (folderPath: string): DeletedFile[] => {
      return deletedFilesOnly.filter((f) => f.file_path.startsWith(folderPath + '/'))
    },
    [deletedFilesOnly],
  )

  // Handle folder view click (select/deselect all files in folder)
  const handleFolderViewClick = useCallback(
    (folderPath: string, allFilesSelected: boolean) => {
      const filesInFolder = getFilesInFolder(folderPath)
      if (allFilesSelected) {
        // Deselect all files in folder
        setSelectedFiles((prev) => {
          const next = new Set(prev)
          filesInFolder.forEach((f) => next.delete(f.id))
          return next
        })
      } else {
        // Select all files in folder
        setSelectedFiles((prev) => {
          const next = new Set(prev)
          filesInFolder.forEach((f) => next.add(f.id))
          return next
        })
      }
    },
    [getFilesInFolder],
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // VIRTUALIZATION SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  // Flatten trash items for virtualization
  const { flattenedItems, totalCount, getItemSize } = useFlattenedTrash({
    viewMode,
    filesSortedByTime,
    deletedFoldersOnly,
    topLevelFolders,
    groupedByFolder,
    expandedFolders,
    getRecursiveFileCount,
  })

  // Virtualizer setup
  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: getItemSize,
    overscan: 15, // Render 15 extra items above/below viewport for smooth scrolling
  })

  // Clear all filters
  const clearFilters = () => {
    setSearchQuery('')
    setDeletedByFilter(null)
    setFolderFilter(null)
    setVaultFilter(null)
  }

  const hasActiveFilters = searchQuery || deletedByFilter || folderFilter || vaultFilter

  // Get the current view items (files, folders, or all files in nested view)
  // Note: For folder view, we select/deselect files within folders, not folder records themselves
  const currentViewItems = useMemo(() => {
    if (viewMode === 'files') return deletedFilesOnly
    if (viewMode === 'folders') {
      // In folder view, selecting folders selects all files within them
      // So currentViewItems should still be files for selection purposes
      return deletedFilesOnly
    }
    return deletedFilesOnly // nested view shows files within folder groups
  }, [viewMode, deletedFilesOnly])

  // Select all items in current view
  const selectAll = () => {
    if (selectedFiles.size === currentViewItems.length && currentViewItems.length > 0) {
      // All selected, deselect all
      setSelectedFiles(new Set())
    } else {
      // Select all items in current view
      setSelectedFiles(new Set(currentViewItems.map((f) => f.id)))
    }
  }

  const allSelected = currentViewItems.length > 0 && selectedFiles.size === currentViewItems.length
  const someSelected = selectedFiles.size > 0 && selectedFiles.size < currentViewItems.length

  // Load deleted files
  const loadDeletedFiles = async () => {
    if (!isVaultConnected || !organization) {
      setDeletedFiles([])
      return
    }

    setIsLoading(true)

    try {
      const { files, error } = await getDeletedFiles(organization.id, {
        vaultId: vaultFilter === 'all' ? undefined : activeVaultId || undefined,
        folderPath: trashFolderFilter || undefined,
      })
      if (!error && files) {
        setDeletedFiles(files as DeletedFile[])
      }
    } catch (error) {
      log.error('[Trash]', 'Failed to load deleted files', { error: error })
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadDeletedFiles()
  }, [isVaultConnected, organization, activeVaultId, trashFolderFilter, vaultFilter])

  // Auto-expand folders when there are few of them
  useEffect(() => {
    if (groupedByFolder.size <= 5) {
      setExpandedFolders(new Set(groupedByFolder.keys()))
    }
  }, [deletedFiles])

  // Clear selection when switching view modes
  useEffect(() => {
    setSelectedFiles(new Set())
  }, [viewMode])

  // Handle file selection
  const toggleFileSelection = (fileId: string, isShiftClick: boolean, isCtrlClick: boolean) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (isCtrlClick) {
        // Toggle individual file
        if (next.has(fileId)) {
          next.delete(fileId)
        } else {
          next.add(fileId)
        }
      } else if (isShiftClick && prev.size > 0) {
        // Range select (simplified - just add this one)
        next.add(fileId)
      } else {
        // Single select
        return new Set([fileId])
      }
      return next
    })
  }

  // Invalidate the vault cache after a successful restore so the next load rebuilds
  // without the stale trashed entry, mirroring what delete.ts does after a server
  // delete. Without this, restored files linger out of the IndexedDB cache until it
  // naturally expires. Non-fatal: a failure here just delays the cache refresh.
  const clearVaultCacheAfterRestore = useCallback(() => {
    if (!activeVaultId) return
    clearVaultCache(activeVaultId).catch((error) => {
      log.warn('[Trash]', 'Failed to clear vault cache after restore', {
        error: String(error),
      })
    })
  }, [activeVaultId])

  // Restore selected files
  const handleRestore = async () => {
    if (selectedFiles.size === 0 || !user) return

    setIsRestoring(true)
    const fileIds = Array.from(selectedFiles)
    const total = fileIds.length

    // For single file, just restore directly
    if (total === 1) {
      try {
        const result = await restoreFile(fileIds[0], user.id)
        if (result.success) {
          clearVaultCacheAfterRestore()
          if (result.file) {
            const parentPath = result.file.file_path.substring(
              0,
              result.file.file_path.lastIndexOf('/'),
            )
            let parentExistsLocally = true
            if (parentPath) {
              const preRestoreFiles = usePDMStore.getState().files
              parentExistsLocally = preRestoreFiles.some(
                (f) =>
                  f.isDirectory &&
                  f.diffStatus !== 'cloud' &&
                  f.relativePath.toLowerCase() === parentPath.toLowerCase(),
              )
            }

            if (!parentExistsLocally && parentPath) {
              // Stale path: show folder picker so user can choose a new location
              const restoredFile = result.file
              setFolderPickerState({
                files: [
                  {
                    id: restoredFile.id,
                    fileName: restoredFile.file_name,
                    oldPath: restoredFile.file_path,
                    fullFileData: restoredFile,
                  },
                ],
                onSelect: async (folder: string) => {
                  const newFilePath = folder
                    ? `${folder}/${restoredFile.file_name}`
                    : restoredFile.file_name
                  const updateResult = await updateFilePath(restoredFile.id, newFilePath)
                  if (updateResult.success && updateResult.file) {
                    addCloudFile(updateResult.file)
                    const wasAdded = usePDMStore
                      .getState()
                      .files.some((f) => f.pdmData?.id === restoredFile.id)
                    if (wasAdded) {
                      addToast('success', `File restored to "${folder || 'Vault Root'}"`)
                    } else {
                      addToast(
                        'warning',
                        `"${restoredFile.file_name}" was restored but could not be added to the file browser. Try refreshing.`,
                      )
                    }
                  } else {
                    addCloudFile(restoredFile)
                    addToast(
                      'warning',
                      `File restored but failed to move to new folder: ${updateResult.error || 'Unknown error'}`,
                    )
                  }
                  setFolderPickerState(null)
                  loadDeletedFiles()
                },
              })
            } else {
              addCloudFile(result.file)
              const storeFiles = usePDMStore.getState().files
              const wasAdded = storeFiles.some((f) => f.pdmData?.id === result.file!.id)
              if (!wasAdded) {
                addToast(
                  'warning',
                  `"${result.file.file_name}" was restored in the database but could not be added to the file browser. Try refreshing.`,
                )
              } else {
                addToast('success', 'File restored successfully')
              }
            }
          } else {
            addToast('success', 'File restored successfully')
          }
        } else {
          addToast('error', result.error || 'Failed to restore file')
        }
        setSelectedFiles(new Set())
        loadDeletedFiles()
      } catch (error) {
        addToast('error', 'Failed to restore file')
      } finally {
        setIsRestoring(false)
      }
      return
    }

    // For multiple files, show progress toast
    const toastId = `restore-${Date.now()}`
    addProgressToast(toastId, `Restoring ${total} files...`, total)

    let restored = 0
    let failed = 0
    const errorMessages: string[] = []
    const stalePathFiles: Array<{
      id: string
      fileName: string
      oldPath: string
      fullFileData: PDMFile
    }> = []
    // Successfully restored files whose parent still exists locally - added to the
    // store in a single batched commit after the loop instead of one commit per file.
    const restoredFiles: PDMFile[] = []

    // Build the parent-directory lookup ONCE before the loop. Re-scanning
    // usePDMStore.getState().files (tens of thousands of entries) per restored file
    // was the dominant cost of this loop at scale (443 files x ~28k entries x 2
    // scans), and directly preceded renderer OOM crashes.
    const parentDirLower = new Set(
      usePDMStore
        .getState()
        .files.filter((f) => f.isDirectory && f.diffStatus !== 'cloud')
        .map((f) => f.relativePath.toLowerCase()),
    )

    // Throttle progress-toast store writes to once per displayed percentage point
    // instead of once per file.
    let lastReportedPercent = -1

    try {
      for (let i = 0; i < fileIds.length; i++) {
        if (isProgressToastCancelled(toastId)) {
          break
        }

        const fileId = fileIds[i]
        try {
          const result = await restoreFile(fileId, user.id)
          if (result.success) {
            if (result.file) {
              const parentPath = result.file.file_path.substring(
                0,
                result.file.file_path.lastIndexOf('/'),
              )
              const parentExistsLocally = parentPath
                ? parentDirLower.has(parentPath.toLowerCase())
                : true

              if (!parentExistsLocally && parentPath) {
                // Defer adding stale-path files until user picks a destination
                stalePathFiles.push({
                  id: result.file.id,
                  fileName: result.file.file_name,
                  oldPath: result.file.file_path,
                  fullFileData: result.file,
                })
              } else {
                restoredFiles.push(result.file)
              }
            }
            restored++
          } else {
            failed++
            errorMessages.push(
              `${result.file?.file_name || fileId}: ${result.error || 'Unknown error'}`,
            )
          }
        } catch (error) {
          failed++
          errorMessages.push(
            `File ${fileId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          )
        }

        const percent = Math.round(((i + 1) / total) * 100)
        if (percent !== lastReportedPercent) {
          lastReportedPercent = percent
          updateProgressToast(toastId, i + 1, percent)
        }
      }

      // Single batched store commit instead of one addCloudFile call (and one
      // verification scan) per file.
      if (restoredFiles.length > 0) {
        addCloudFiles(restoredFiles)

        const storeFileIds = new Set(
          usePDMStore
            .getState()
            .files.map((f) => f.pdmData?.id)
            .filter((id): id is string => id !== undefined),
        )
        const notAdded = restoredFiles.filter((f) => !storeFileIds.has(f.id))
        if (notAdded.length > 0) {
          log.warn('[Restore]', 'Some files restored in DB but not added to store', {
            count: notAdded.length,
            fileIds: notAdded.slice(0, 10).map((f) => f.id),
          })
        }
      }

      if (restored > 0) {
        clearVaultCacheAfterRestore()
      }

      removeToast(toastId)

      if (restored > 0 && failed === 0) {
        addToast('success', `Restored ${restored} file${restored > 1 ? 's' : ''}`)
      } else if (restored > 0) {
        addToast('warning', `Restored ${restored}/${total} files (${failed} failed)`)
      } else {
        addToast('error', 'Failed to restore files')
      }

      if (failed > 0 && errorMessages.length > 0) {
        const summary =
          errorMessages.length <= 3
            ? errorMessages.join('; ')
            : `${errorMessages.slice(0, 3).join('; ')} and ${errorMessages.length - 3} more`
        addToast('warning', `${failed} file(s) failed to restore: ${summary}`)
      }

      if (stalePathFiles.length > 0) {
        setFolderPickerState({
          files: stalePathFiles,
          onSelect: async (folder: string) => {
            let moved = 0
            // A bulk restore where the rows share a missing parent routes every file
            // through here, so the commit is batched for the same reason the loop above
            // is: one addCloudFile per file rebuilds the folder tree and re-renders the
            // pane each time, work proportional to vault size repeated per file.
            const filesToCommit: PDMFile[] = []

            for (const file of stalePathFiles) {
              const newFilePath = folder ? `${folder}/${file.fileName}` : file.fileName
              // updateFilePath writes one row per call and has no batched counterpart,
              // so these stay serial rather than opening a request per file at once.
              const updateResult = await updateFilePath(file.id, newFilePath)
              if (updateResult.success && updateResult.file) {
                filesToCommit.push(updateResult.file)
                moved++
              } else {
                filesToCommit.push(file.fullFileData)
              }
            }

            if (filesToCommit.length > 0) {
              addCloudFiles(filesToCommit)
            }

            const storeFileIds = new Set(
              usePDMStore
                .getState()
                .files.map((f) => f.pdmData?.id)
                .filter((id): id is string => id !== undefined),
            )
            const notAdded = stalePathFiles.filter((file) => !storeFileIds.has(file.id)).length

            if (moved > 0) {
              addToast('success', `Moved ${moved} file(s) to "${folder || 'Vault Root'}"`)
            }
            if (notAdded > 0) {
              addToast(
                'warning',
                `${notAdded} file(s) were restored but could not be added to the file browser. Try refreshing.`,
              )
            }
            setFolderPickerState(null)
            loadDeletedFiles()
          },
        })
      }

      setSelectedFiles(new Set())
      loadDeletedFiles()
    } catch (error) {
      removeToast(toastId)
      addToast('error', 'Failed to restore files')
    } finally {
      setIsRestoring(false)
    }
  }

  // Permanently delete selected files
  const handlePermanentDelete = async () => {
    if (selectedFiles.size === 0 || !user) return

    setIsDeleting(true)
    const fileIds = Array.from(selectedFiles)
    const total = fileIds.length

    // Show progress toast for any number of files
    const toastId = `delete-permanent-${Date.now()}`
    addProgressToast(toastId, `Permanently deleting ${total} file${total > 1 ? 's' : ''}...`, total)

    try {
      // Use batch deletion for much better performance
      const result = await permanentlyDeleteFiles(fileIds, user.id, (completed, totalFiles) => {
        // Check for cancellation
        if (isProgressToastCancelled(toastId)) {
          return
        }
        const percent = Math.round((completed / totalFiles) * 100)
        updateProgressToast(toastId, completed, percent)
      })

      removeToast(toastId)

      if (result.deleted > 0 && result.failed === 0) {
        addToast(
          'success',
          `Permanently deleted ${result.deleted} file${result.deleted > 1 ? 's' : ''}`,
        )
      } else if (result.deleted > 0) {
        addToast('warning', `Deleted ${result.deleted}/${total} files (${result.failed} failed)`)
      } else {
        addToast('error', result.errors[0] || 'Failed to delete files')
      }

      setSelectedFiles(new Set())
      loadDeletedFiles()
    } catch (error) {
      removeToast(toastId)
      addToast('error', 'Failed to delete files')
    } finally {
      setIsDeleting(false)
    }
  }

  // Empty entire trash
  const handleEmptyTrash = async () => {
    if (!organization || !user) return

    setIsEmptying(true)

    try {
      const result = await emptyTrash(organization.id, user.id, activeVaultId || undefined)
      if (result.success) {
        addToast('success', `Permanently deleted ${result.deleted} files from trash`)
        setShowEmptyConfirm(false)
        loadDeletedFiles()
      } else {
        addToast('error', result.error || 'Failed to empty trash')
      }
    } catch (error) {
      addToast('error', 'Failed to empty trash')
    } finally {
      setIsEmptying(false)
    }
  }

  if (!isVaultConnected) {
    return (
      <div className="p-4 text-sm text-plm-fg-muted text-center">{t('trash.openVaultToView')}</div>
    )
  }

  if (!organization) {
    return <div className="p-4 text-sm text-plm-fg-muted text-center">{t('trash.signInToView')}</div>
  }

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="p-3 border-b border-plm-border space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-plm-fg-muted">
              <Trash2 size={16} />
              <span>
                {viewMode === 'files' ? (
                  <>
                    {deletedFilesOnly.length} file{deletedFilesOnly.length !== 1 ? 's' : ''}
                  </>
                ) : viewMode === 'folders' ? (
                  <>
                    {deletedFoldersOnly.length + topLevelFolders.length} folder
                    {deletedFoldersOnly.length + topLevelFolders.length !== 1 ? 's' : ''}
                  </>
                ) : (
                  <>
                    {deletedFilesOnly.length} file{deletedFilesOnly.length !== 1 ? 's' : ''} in{' '}
                    {groupedByFolder.size} folder{groupedByFolder.size !== 1 ? 's' : ''}
                  </>
                )}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {/* View mode toggle - three options */}
              <div className="flex items-center bg-plm-bg rounded border border-plm-border">
                <button
                  onClick={() => setViewMode('files')}
                  className={`p-1 rounded-l transition-colors ${
                    viewMode === 'files'
                      ? 'bg-plm-accent/20 text-plm-accent'
                      : 'hover:bg-plm-bg-light text-plm-fg-muted hover:text-plm-fg'
                  }`}
                  title={t('trash.fileViewTitle')}
                >
                  <List size={14} />
                </button>
                <button
                  onClick={() => setViewMode('folders')}
                  className={`p-1 border-x border-plm-border transition-colors ${
                    viewMode === 'folders'
                      ? 'bg-plm-accent/20 text-plm-accent'
                      : 'hover:bg-plm-bg-light text-plm-fg-muted hover:text-plm-fg'
                  }`}
                  title={t('trash.folderViewTitle')}
                >
                  <Folder size={14} />
                </button>
                <button
                  onClick={() => setViewMode('nested')}
                  className={`p-1 rounded-r transition-colors ${
                    viewMode === 'nested'
                      ? 'bg-plm-accent/20 text-plm-accent'
                      : 'hover:bg-plm-bg-light text-plm-fg-muted hover:text-plm-fg'
                  }`}
                  title={t('trash.nestedViewTitle')}
                >
                  <Network size={14} />
                </button>
              </div>
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={`p-1 rounded transition-colors ${
                  showFilters || hasActiveFilters
                    ? 'bg-plm-accent/20 text-plm-accent'
                    : 'hover:bg-plm-bg-light text-plm-fg-muted hover:text-plm-fg'
                }`}
                title={t('trash.filters')}
              >
                <Filter size={14} />
              </button>
              <button
                onClick={loadDeletedFiles}
                className="p-1 hover:bg-plm-bg-light rounded text-plm-fg-muted hover:text-plm-fg"
                title={t('trash.refresh')}
              >
                <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          {/* Search input */}
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-plm-fg-muted"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('trash.searchPlaceholder')}
              className="w-full pl-8 pr-8 py-1.5 text-sm bg-plm-bg border border-plm-border rounded focus:outline-none focus:border-plm-accent"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-plm-fg-muted hover:text-plm-fg"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Filters panel */}
          {showFilters && (
            <div className="space-y-2 pt-1">
              {/* Deleted by filter */}
              {deletedByUsers.length > 0 && (
                <div>
                  <label className="text-xs text-plm-fg-muted mb-1 block">{t('trash.deletedBy')}</label>
                  <select
                    value={deletedByFilter || ''}
                    onChange={(e) => setDeletedByFilter(e.target.value || null)}
                    className="w-full px-2 py-1.5 text-sm bg-plm-bg border border-plm-border rounded focus:outline-none focus:border-plm-accent"
                  >
                    <option value="">{t('trash.allUsers')}</option>
                    {deletedByUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Folder filter */}
              {folderPaths.length > 0 && (
                <div>
                  <label className="text-xs text-plm-fg-muted mb-1 block">{t('trash.folder')}</label>
                  <select
                    value={folderFilter || ''}
                    onChange={(e) => setFolderFilter(e.target.value || null)}
                    className="w-full px-2 py-1.5 text-sm bg-plm-bg border border-plm-border rounded focus:outline-none focus:border-plm-accent"
                  >
                    <option value="">{t('trash.allFolders')}</option>
                    {folderPaths.map((path) => (
                      <option key={path} value={path}>
                        {path}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Vault filter */}
              {connectedVaults.length > 1 && (
                <div>
                  <label className="text-xs text-plm-fg-muted mb-1 block">{t('trash.vault')}</label>
                  <select
                    value={vaultFilter || ''}
                    onChange={(e) => setVaultFilter(e.target.value || null)}
                    className="w-full px-2 py-1.5 text-sm bg-plm-bg border border-plm-border rounded focus:outline-none focus:border-plm-accent"
                  >
                    <option value="">Current vault ({currentVault?.name || 'None'})</option>
                    <option value="all">{t('trash.allVaults')}</option>
                    {connectedVaults.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Clear filters button */}
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="text-xs text-plm-accent hover:text-plm-accent/80"
                >
                  {t('trash.clearAllFilters')}
                </button>
              )}
            </div>
          )}

          {/* Active filter badges */}
          {hasActiveFilters && !showFilters && (
            <div className="flex flex-wrap gap-1.5">
              {deletedByFilter && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-plm-accent/20 text-plm-accent rounded">
                  <User size={10} />
                  {deletedByUsers.find((u) => u.id === deletedByFilter)?.name}
                  <button onClick={() => setDeletedByFilter(null)} className="hover:text-plm-fg">
                    <X size={10} />
                  </button>
                </span>
              )}
              {folderFilter && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-plm-accent/20 text-plm-accent rounded">
                  <FolderOpen size={10} />
                  {folderFilter.split('/').pop()}
                  <button onClick={() => setFolderFilter(null)} className="hover:text-plm-fg">
                    <X size={10} />
                  </button>
                </span>
              )}
              {vaultFilter && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-plm-accent/20 text-plm-accent rounded">
                  <Database size={10} />
                  {vaultFilter === 'all'
                    ? t('trash.allVaults')
                    : connectedVaults.find((v) => v.id === vaultFilter)?.name}
                  <button onClick={() => setVaultFilter(null)} className="hover:text-plm-fg">
                    <X size={10} />
                  </button>
                </span>
              )}
            </div>
          )}

          {currentVault && !trashFolderFilter && !hasActiveFilters && (
            <div className="flex items-center gap-1.5 text-xs text-plm-fg-muted">
              <FolderOpen size={12} />
              <span className="truncate">{currentVault.name}</span>
            </div>
          )}

          {/* External folder filter indicator (from file browser) */}
          {trashFolderFilter && (
            <div className="flex items-center gap-2 p-2 bg-plm-bg-light rounded border border-plm-border">
              <FolderOpen size={14} className="text-plm-accent flex-shrink-0" />
              <span className="text-sm truncate flex-1" title={trashFolderFilter}>
                {trashFolderFilter.split('/').pop() || trashFolderFilter}
              </span>
              <button
                onClick={() => setTrashFolderFilter(null)}
                className="p-0.5 hover:bg-plm-bg rounded text-plm-fg-muted hover:text-plm-fg"
                title={t('trash.showAllDeletedFiles')}
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Action buttons */}
        {currentViewItems.length > 0 && (
          <div className="p-2 border-b border-plm-border space-y-2">
            {/* Select All row */}
            <div className="flex items-center gap-2">
              <button
                onClick={selectAll}
                className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
                  allSelected
                    ? 'bg-plm-accent/20 text-plm-accent'
                    : 'hover:bg-plm-bg-light text-plm-fg-muted hover:text-plm-fg'
                }`}
              >
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected
                  }}
                  onChange={selectAll}
                  className="w-3.5 h-3.5 rounded border-plm-border text-plm-accent focus:ring-plm-accent focus:ring-offset-0 cursor-pointer"
                />
                <span>{t('trash.selectAll')} ({currentViewItems.length})</span>
              </button>
              {selectedFiles.size > 0 && (
                <button
                  onClick={() => setSelectedFiles(new Set())}
                  className="text-xs text-plm-fg-muted hover:text-plm-fg"
                >
                  {t('trash.clear')}
                </button>
              )}
            </div>

            {/* Action buttons row */}
            <div className="flex gap-2">
              <button
                onClick={handleRestore}
                disabled={selectedFiles.size === 0 || isRestoring}
                className={`flex-1 text-xs py-2 px-3 rounded-md flex items-center justify-center gap-1.5 font-medium transition-colors ${
                  selectedFiles.size === 0
                    ? 'bg-plm-bg-light text-plm-fg-muted cursor-not-allowed opacity-50'
                    : 'bg-green-600 hover:bg-green-700 text-white'
                } disabled:opacity-50`}
              >
                {isRestoring ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <RotateCcw size={14} />
                )}
                {t('trash.restore')}{selectedFiles.size > 0 ? ` (${selectedFiles.size})` : ''}
              </button>
              <button
                onClick={handlePermanentDelete}
                disabled={selectedFiles.size === 0 || isDeleting}
                className={`flex-1 text-xs py-2 px-3 rounded-md flex items-center justify-center gap-1.5 font-medium transition-colors ${
                  selectedFiles.size === 0
                    ? 'bg-plm-bg-light text-plm-fg-muted cursor-not-allowed opacity-50'
                    : 'bg-plm-error hover:bg-plm-error/80 text-white'
                } disabled:opacity-50`}
              >
                {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {t('common.delete')}{selectedFiles.size > 0 ? ` (${selectedFiles.size})` : ''}
              </button>
            </div>
          </div>
        )}

        {/* File list - VIRTUALIZED */}
        <div ref={scrollContainerRef} className="flex-1 overflow-auto">
          {isLoading && deletedFiles.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="spinner" />
            </div>
          ) : deletedFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-plm-fg-muted">
              <FileBox size={48} className="opacity-30 mb-3" />
              <p className="text-sm">{t('trash.trashIsEmpty')}</p>
              <p className="text-xs mt-1 opacity-70">{t('trash.deletedFilesAppearHere')}</p>
            </div>
          ) : filteredFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-plm-fg-muted">
              <Search size={48} className="opacity-30 mb-3" />
              <p className="text-sm">{t('trash.noMatchingFiles')}</p>
              <p className="text-xs mt-1 opacity-70">{t('trash.tryAdjustingSearch')}</p>
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="mt-2 text-xs text-plm-accent hover:text-plm-accent/80"
                >
                  {t('trash.clearFilters')}
                </button>
              )}
            </div>
          ) : totalCount === 0 ? (
            /* Empty state for current view mode */
            <div className="flex flex-col items-center justify-center py-12 text-plm-fg-muted">
              {viewMode === 'files' ? (
                <>
                  <FileText size={48} className="opacity-30 mb-3" />
                  <p className="text-sm">{t('trash.noDeletedFiles')}</p>
                  <p className="text-xs mt-1 opacity-70">{t('trash.onlyFoldersInTrash')}</p>
                </>
              ) : viewMode === 'folders' ? (
                <>
                  <Folder size={48} className="opacity-30 mb-3" />
                  <p className="text-sm">{t('trash.noDeletedFolders')}</p>
                  <p className="text-xs mt-1 opacity-70">{t('trash.onlyRootLevelFiles')}</p>
                </>
              ) : (
                <>
                  <Network size={48} className="opacity-30 mb-3" />
                  <p className="text-sm">{t('trash.noDeletedFilesToOrganize')}</p>
                  <p className="text-xs mt-1 opacity-70">
                    {t('trash.filesAppearInHierarchy')}
                  </p>
                </>
              )}
            </div>
          ) : (
            /* Virtualized list */
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = flattenedItems[virtualRow.index]
                if (!item) return null

                const isSelected = item.file ? selectedFiles.has(item.file.id) : false

                return (
                  <VirtualizedTrashRow
                    key={item.key}
                    item={item}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    isSelected={isSelected}
                    selectedFiles={selectedFiles}
                    onToggleSelection={toggleFileSelection}
                    onToggleFolderExpand={toggleFolderExpand}
                    onSelectFolder={selectFolder}
                    isFolderSelected={isFolderSelected}
                    isFolderPartiallySelected={isFolderPartiallySelected}
                    isFolderExpanded={
                      item.nestedFolder ? expandedFolders.has(item.nestedFolder.path) : undefined
                    }
                    onFolderViewClick={handleFolderViewClick}
                    getFilesInFolder={getFilesInFolder}
                    viewMode={viewMode}
                  />
                )
              })}
            </div>
          )}
        </div>

        {/* Footer - Empty Trash */}
        {deletedFiles.length > 0 && (
          <div className="p-2 border-t border-plm-border">
            <button
              onClick={() => setShowEmptyConfirm(true)}
              className="w-full btn text-xs py-1.5 bg-plm-error/10 text-plm-error hover:bg-plm-error/20 flex items-center justify-center gap-1.5"
            >
              <Trash2 size={12} />
              {t('trash.emptyTrash')}
            </button>
            <p className="text-[10px] text-plm-fg-muted text-center mt-1.5">
              {t('trash.autoDeleteNotice')}
            </p>
          </div>
        )}

        {/* Empty Trash Confirmation Modal */}
        {showEmptyConfirm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center">
            <div
              className="fixed inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setShowEmptyConfirm(false)}
            />
            <div className="relative bg-plm-bg-light border border-plm-error/50 rounded-xl shadow-2xl w-[400px] overflow-hidden">
              {/* Header */}
              <div className="p-4 border-b border-plm-border bg-plm-error/10">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-plm-error/20 rounded-full">
                    <AlertTriangle size={24} className="text-plm-error" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-plm-fg">{t('trash.emptyTrash')}</h3>
                    <p className="text-sm text-plm-fg-muted">
                      {deletedFiles.length} file{deletedFiles.length !== 1 ? 's' : ''} will be
                      permanently deleted
                    </p>
                  </div>
                </div>
              </div>

              {/* Content */}
              <div className="p-6">
                <div className="p-4 bg-plm-error/10 border border-plm-error/30 rounded-lg">
                  <p className="text-sm text-plm-fg">
                    <strong>{t('trash.warning')}</strong> {t('trash.emptyTrashWarningMessage')}
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="p-4 border-t border-plm-border bg-plm-bg flex justify-end gap-3">
                <button
                  onClick={() => setShowEmptyConfirm(false)}
                  className="btn btn-ghost"
                  disabled={isEmptying}
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleEmptyTrash}
                  disabled={isEmptying}
                  className="btn bg-plm-error hover:bg-plm-error/80 text-white disabled:opacity-50 flex items-center gap-2"
                >
                  {isEmptying ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      {t('trash.emptying')}
                    </>
                  ) : (
                    <>
                      <Trash2 size={16} />
                      {t('trash.emptyTrash')}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {folderPickerState &&
        (() => {
          const missingPaths = [
            ...new Set(
              folderPickerState.files
                .map((f) => f.oldPath.substring(0, f.oldPath.lastIndexOf('/')))
                .filter(Boolean),
            ),
          ]

          const handleRecreateFolders = async () => {
            const vaultId = activeVaultId
            const orgId = organization?.id
            const userId = user?.id
            if (!vaultId || !orgId || !userId) return

            let foldersCreated = 0
            for (const folderPath of missingPaths) {
              const result = await syncFolder(orgId, vaultId, userId, folderPath)
              if (result.folder) foldersCreated++
            }

            const currentVaultData = connectedVaults.find((v) => v.id === vaultId)
            if (currentVaultData?.localPath && window.electronAPI?.createFolder) {
              for (const folderPath of missingPaths) {
                const fullPath = `${currentVaultData.localPath}/${folderPath}`
                await window.electronAPI.createFolder(fullPath)
              }
            }

            addCloudFiles(folderPickerState.files.map((f) => f.fullFileData))

            const fileCount = folderPickerState.files.length
            addToast(
              'success',
              `Recreated ${foldersCreated} folder(s), restored ${fileCount} file(s) to original location${fileCount > 1 ? 's' : ''}`,
            )
            setFolderPickerState(null)
            loadDeletedFiles()
          }

          return (
            <FolderPickerDialog
              isOpen={true}
              onClose={() => {
                addCloudFiles(folderPickerState.files.map((f) => f.fullFileData))
                addToast(
                  'info',
                  `${folderPickerState.files.length} restored file(s) kept at their original paths.`,
                )
                setFolderPickerState(null)
              }}
              title="Choose Destination Folder"
              message={
                folderPickerState.files.length === 1
                  ? `"${folderPickerState.files[0].fileName}" was in a folder that no longer exists. Pick a new location or recreate the original folder.`
                  : `${folderPickerState.files.length} restored file(s) were in folders that no longer exist. Choose a destination or recreate the original folders.`
              }
              onSelect={folderPickerState.onSelect}
              defaultPath=""
              missingPaths={missingPaths}
              onRecreateFolders={handleRecreateFolders}
            />
          )
        })()}
    </>
  )
}
