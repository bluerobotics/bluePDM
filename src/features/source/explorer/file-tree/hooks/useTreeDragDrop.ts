import { useState, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { log } from '@/lib/logger'
import { usePDMStore, LocalFile } from '@/stores/pdmStore'
import { buildFullPath } from '@/lib/utils'
import { executeCommand } from '@/lib/commands'
import { PDM_FILES_DATA_TYPE, MIME_TYPES } from '../constants'

/**
 * Interface for collected entries from DataTransfer
 * Includes both files and folders (including empty ones)
 */
interface CollectedEntry {
  path: string
  isDirectory: boolean
  relativePath: string // Path relative to the dropped root for nested items
}

/**
 * Extract all file and folder paths from a DataTransfer, including empty folders.
 * Uses webkitGetAsEntry() API which properly handles directory structures.
 *
 * IMPORTANT: webkitGetAsEntry gives virtual paths (like /filename.txt), NOT real file system paths.
 * We must use getPathForFile() on the File objects from dataTransfer.files to get real paths,
 * then pass those real paths through the recursive directory traversal.
 */
async function collectEntriesFromDataTransfer(
  dataTransfer: DataTransfer,
  getPathForFile: (file: File) => string,
): Promise<CollectedEntry[]> {
  const entries: CollectedEntry[] = []
  const items = dataTransfer.items
  const files = Array.from(dataTransfer.files)

  // Try to use webkitGetAsEntry for proper directory support
  if (items && items.length > 0) {
    const itemsArray = Array.from(items)

    for (let i = 0; i < itemsArray.length; i++) {
      const item = itemsArray[i]
      if (item.kind !== 'file') continue

      // Get the actual file system path from the File object at the same index
      // dataTransfer.files[i] corresponds to dataTransfer.items[i]
      const file = files[i]
      const rootPath = file ? getPathForFile(file) : null

      if (!rootPath) continue

      // Try webkitGetAsEntry for directory support
      const entry = item.webkitGetAsEntry?.()
      if (entry) {
        await collectFromEntry(entry, '', entries, rootPath)
      } else {
        // Fallback: get as regular file
        entries.push({ path: rootPath, isDirectory: false, relativePath: file.name })
      }
    }
  }

  // If no entries collected via webkitGetAsEntry, fall back to files array
  if (entries.length === 0) {
    for (const file of files) {
      const path = getPathForFile(file)
      if (path) {
        entries.push({ path, isDirectory: false, relativePath: file.name })
      }
    }
  }

  return entries
}

/**
 * Recursively collect entries from a FileSystemEntry
 *
 * @param entry - The FileSystemEntry to process
 * @param parentRelativePath - The relative path of the parent (empty string for root items)
 * @param entries - Array to collect results into
 * @param rootPath - The actual file system path of the current item (NOT the virtual web path)
 */
async function collectFromEntry(
  entry: FileSystemEntry,
  parentRelativePath: string,
  entries: CollectedEntry[],
  rootPath: string,
): Promise<void> {
  const relativePath = parentRelativePath ? `${parentRelativePath}/${entry.name}` : entry.name

  // Construct the actual file system path
  // For root items (parentRelativePath is empty): use rootPath directly
  // For nested items: append the entry name to rootPath
  const actualPath = !parentRelativePath
    ? rootPath
    : rootPath + (rootPath.includes('\\') ? '\\' : '/') + entry.name

  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry
    // Always add the directory entry (even if empty)
    entries.push({
      path: actualPath,
      isDirectory: true,
      relativePath,
    })

    // Read directory contents
    const reader = dirEntry.createReader()
    const children = await readAllDirectoryEntries(reader)

    for (const child of children) {
      // Pass actualPath as the new rootPath for children
      await collectFromEntry(child, relativePath, entries, actualPath)
    }
  } else {
    // It's a file
    entries.push({
      path: actualPath,
      isDirectory: false,
      relativePath,
    })
  }
}

/**
 * Read all entries from a directory reader (handles batching)
 */
function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: FileSystemEntry[] = []

    function readBatch() {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(entries)
          } else {
            entries.push(...batch)
            readBatch() // Continue reading
          }
        },
        (error) => reject(error),
      )
    }

    readBatch()
  })
}

interface DragDropHandlers {
  // State
  draggedFilesRef: React.MutableRefObject<LocalFile[]>
  dragOverFolder: string | null

  // Setters
  setDragOverFolder: (folder: string | null) => void

  // Handlers
  handleDragStart: (e: React.DragEvent, file: LocalFile) => void
  handleDragEnd: () => void
  handleFolderDragOver: (e: React.DragEvent, file: LocalFile, filesToCheck: LocalFile[]) => void
  handleFolderDragLeave: (e: React.DragEvent) => void
  handleDropOnFolder: (
    e: React.DragEvent,
    targetFolder: LocalFile,
    onRefresh?: (silent?: boolean) => void,
  ) => Promise<void>
  handleVaultRootDrop: (e: React.DragEvent, onRefresh?: (silent?: boolean) => void) => Promise<void>
  canMoveFiles: (filesToCheck: LocalFile[]) => boolean
}

/**
 * Hook for managing drag and drop operations in the explorer tree
 */
export function useTreeDragDrop(): DragDropHandlers {
  // Selective state selectors - each subscription only triggers on its own changes
  const files = usePDMStore((s) => s.files)
  const vaultPath = usePDMStore((s) => s.vaultPath)

  // Actions grouped with useShallow - toast actions (still needed for external file drop handling)
  const { addToast, addProgressToast, updateProgressToast, removeToast } = usePDMStore(
    useShallow((s) => ({
      addToast: s.addToast,
      addProgressToast: s.addProgressToast,
      updateProgressToast: s.updateProgressToast,
      removeToast: s.removeToast,
    })),
  )

  // State for drag over highlighting
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null)

  // Ref for tracking dragged files synchronously
  const draggedFilesRef = useRef<LocalFile[]>([])

  // Check if files can be moved (block if any file is checked out by others)
  const canMoveFiles = useCallback((filesToCheck: LocalFile[]): boolean => {
    const userId = usePDMStore.getState().user?.id
    // Block if any file is checked out by others
    return !filesToCheck.some(
      (f) => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== userId,
    )
  }, [])

  // Handle drag start
  const handleDragStart = useCallback(
    (e: React.DragEvent, file: LocalFile) => {
      // Can't drag cloud-only files, or a moved_away stub - neither has a local file at this
      // row's path to drag.
      if (file.diffStatus === 'cloud' || file.diffStatus === 'moved_away') {
        e.preventDefault()
        return
      }

      // Get fresh selection from store (not from potentially stale props)
      const selectedFiles = usePDMStore.getState().selectedFiles

      // Determine files to drag based on current selection
      let filesToDrag: LocalFile[]
      if (selectedFiles.includes(file.path) && selectedFiles.length > 1) {
        // Multi-select: drag all selected files (except cloud-only and moved-away stubs)
        filesToDrag = files.filter(
          (f) =>
            selectedFiles.includes(f.path) &&
            f.diffStatus !== 'cloud' &&
            f.diffStatus !== 'moved_away',
        )
      } else {
        // Single file drag
        filesToDrag = [file]
      }

      if (filesToDrag.length === 0) {
        e.preventDefault()
        return
      }

      // Track dragged files for internal moves
      draggedFilesRef.current = filesToDrag

      const filePaths = filesToDrag.map((f) => f.path)

      // Set up HTML5 drag data
      e.dataTransfer.effectAllowed = 'copyMove'
      e.dataTransfer.setData('text/plain', filePaths.join('\n'))
      // Set PDM-specific data for cross-view drag
      e.dataTransfer.setData(
        PDM_FILES_DATA_TYPE,
        JSON.stringify(filesToDrag.map((f) => f.relativePath)),
      )

      // Use DownloadURL format for single non-folder file
      if (filesToDrag.length === 1 && !filesToDrag[0].isDirectory) {
        const filePath = filesToDrag[0].path
        const fileName = filesToDrag[0].name
        const ext = filesToDrag[0].extension?.toLowerCase() || ''
        const mime = MIME_TYPES[ext] || 'application/octet-stream'
        const fileUrl = `file:///${filePath.replace(/\\/g, '/')}`
        e.dataTransfer.setData('DownloadURL', `${mime}:${fileName}:${fileUrl}`)
      }

      // Create a custom drag image
      const dragPreview = document.createElement('div')
      dragPreview.style.cssText =
        'position:absolute;left:-1000px;padding:8px 12px;background:#1e293b;border:1px solid #3b82f6;border-radius:6px;color:white;font-size:13px;display:flex;align-items:center;gap:6px;'
      const iconSvg = file.isDirectory
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>'
      const label = filesToDrag.length > 1 ? `${filesToDrag.length} items` : file.name
      dragPreview.innerHTML = iconSvg
      dragPreview.appendChild(document.createTextNode(label))
      document.body.appendChild(dragPreview)
      e.dataTransfer.setDragImage(dragPreview, 20, 20)
      setTimeout(() => dragPreview.remove(), 0)
    },
    [files],
  )

  // Handle drag end
  const handleDragEnd = useCallback(() => {
    draggedFilesRef.current = []
    setDragOverFolder(null)
  }, [])

  // Handle drag over folder
  const handleFolderDragOver = useCallback(
    (e: React.DragEvent, file: LocalFile, filesToCheck: LocalFile[]) => {
      e.preventDefault()
      e.stopPropagation()

      const hasPdmFiles = e.dataTransfer.types.includes(PDM_FILES_DATA_TYPE)
      const hasExternalFiles = e.dataTransfer.types.includes('Files') && !hasPdmFiles
      const currentDraggedFiles = draggedFilesRef.current

      if (!hasPdmFiles && !hasExternalFiles && currentDraggedFiles.length === 0) return

      if (file.isDirectory) {
        if (hasExternalFiles) {
          e.dataTransfer.dropEffect = 'copy'
          setDragOverFolder(file.relativePath)
          return
        }

        const actualFilesToCheck = filesToCheck.length > 0 ? filesToCheck : currentDraggedFiles

        // Don't allow dropping a folder into itself or its children
        const isDroppingIntoSelf = actualFilesToCheck.some(
          (f) =>
            f.isDirectory &&
            (file.relativePath === f.relativePath ||
              file.relativePath.startsWith(f.relativePath + '/')),
        )
        if (isDroppingIntoSelf) return

        // Don't allow dropping if the target is the current parent
        const wouldStayInPlace =
          actualFilesToCheck.length > 0 &&
          actualFilesToCheck.every((f) => {
            const parentPath = f.relativePath.includes('/')
              ? f.relativePath.substring(0, f.relativePath.lastIndexOf('/'))
              : ''
            return parentPath === file.relativePath
          })
        if (wouldStayInPlace) return

        // Check if all files can be moved
        if (actualFilesToCheck.length > 0 && !canMoveFiles(actualFilesToCheck)) {
          e.dataTransfer.dropEffect = 'none'
          return
        }

        e.dataTransfer.dropEffect = 'move'
        setDragOverFolder(file.relativePath)
      }
    },
    [canMoveFiles],
  )

  // Handle drag leave
  const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolder(null)
  }, [])

  // Handle drop on folder
  const handleDropOnFolder = useCallback(
    async (e: React.DragEvent, targetFolder: LocalFile, onRefresh?: (silent?: boolean) => void) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOverFolder(null)

      if (!window.electronAPI || !vaultPath) return

      // Check for external files first
      const hasPdmFiles = e.dataTransfer.types.includes(PDM_FILES_DATA_TYPE)
      const droppedExternalFiles = Array.from(e.dataTransfer.files)

      if ((droppedExternalFiles.length > 0 || e.dataTransfer.items.length > 0) && !hasPdmFiles) {
        // Handle external file/folder drop - use webkitGetAsEntry for proper folder support
        const entries = await collectEntriesFromDataTransfer(
          e.dataTransfer,
          (file) => window.electronAPI?.getPathForFile(file) || '',
        )

        // If no entries from webkitGetAsEntry, fall back to traditional file handling
        if (entries.length === 0) {
          for (const file of droppedExternalFiles) {
            try {
              const filePath = window.electronAPI.getPathForFile(file)
              if (filePath) {
                // Check if it's a directory
                const dirCheck = await window.electronAPI.isDirectory(filePath)
                entries.push({
                  path: filePath,
                  isDirectory: dirCheck.success && dirCheck.isDirectory === true,
                  relativePath: file.name,
                })
              }
            } catch (error) {
              log.error('[TreeDragDrop]', 'Error getting file path', { error: error })
            }
          }
        }

        if (entries.length === 0) {
          addToast('error', 'Could not get file paths')
          return
        }

        // Separate directories and files - process directories first
        const directories = entries.filter((e) => e.isDirectory)
        const fileEntries = entries.filter((e) => !e.isDirectory)

        const totalItems = entries.length
        const toastId = `drop-files-${Date.now()}`
        addProgressToast(
          toastId,
          `Adding ${totalItems} item${totalItems > 1 ? 's' : ''} to ${targetFolder.name}...`,
          totalItems,
        )

        try {
          let successCount = 0
          let errorCount = 0
          let processed = 0

          // First create all directories (including empty ones)
          for (const dir of directories) {
            const destPath = buildFullPath(
              vaultPath,
              targetFolder.relativePath + '/' + dir.relativePath,
            )

            // First try to copy the directory (handles non-empty directories)
            const copyResult = await window.electronAPI.copyFile(dir.path, destPath)
            if (copyResult.success) {
              successCount++
            } else {
              // If copy failed, try creating the folder directly (for empty folders)
              const createResult = await window.electronAPI.createFolder(destPath)
              if (createResult.success) {
                successCount++
              } else {
                errorCount++
                log.error('[TreeDragDrop]', `Failed to create directory ${dir.relativePath}`, {
                  error: createResult.error,
                })
              }
            }

            processed++
            const percent = Math.round((processed / totalItems) * 100)
            updateProgressToast(toastId, processed, percent)
          }

          // Then copy all files
          for (const file of fileEntries) {
            const destPath = buildFullPath(
              vaultPath,
              targetFolder.relativePath + '/' + file.relativePath,
            )

            const result = await window.electronAPI.copyFile(file.path, destPath)
            if (result.success) {
              successCount++
            } else {
              errorCount++
            }

            processed++
            const percent = Math.round((processed / totalItems) * 100)
            updateProgressToast(toastId, processed, percent)
          }

          removeToast(toastId)

          if (errorCount === 0) {
            addToast(
              'success',
              `Added ${successCount} item${successCount > 1 ? 's' : ''} to ${targetFolder.name}`,
            )
          } else {
            addToast('warning', `Added ${successCount}, failed ${errorCount}`)
          }

          setTimeout(() => onRefresh?.(), 100)
        } catch (error) {
          log.error('[TreeDragDrop]', 'Error adding files', { error: error })
          removeToast(toastId)
          addToast('error', 'Failed to add files')
        }
        return
      }

      // Get files from data transfer or local state
      let filesToMove: LocalFile[] = []
      const currentDraggedFiles = draggedFilesRef.current

      if (currentDraggedFiles.length > 0) {
        filesToMove = currentDraggedFiles
        draggedFilesRef.current = []
      } else {
        const pdmFilesData = e.dataTransfer.getData(PDM_FILES_DATA_TYPE)
        if (pdmFilesData) {
          try {
            const relativePaths: string[] = JSON.parse(pdmFilesData)
            filesToMove = files.filter((f) => relativePaths.includes(f.relativePath))
          } catch (error) {
            log.error('[TreeDragDrop]', 'Failed to parse drag data', { error: error })
            return
          }
        }
      }

      if (filesToMove.length === 0) return

      // Validate the drop
      const isDroppingIntoSelf = filesToMove.some(
        (f) =>
          f.isDirectory &&
          (targetFolder.relativePath === f.relativePath ||
            targetFolder.relativePath.startsWith(f.relativePath + '/')),
      )
      if (isDroppingIntoSelf) {
        addToast('error', 'Cannot move a folder into itself')
        return
      }

      // Use the command system for consistent move behavior
      // This handles: addExpectedFileChanges, server sync, optimistic UI updates, toasts
      await executeCommand('move', {
        files: filesToMove,
        targetFolder: targetFolder.relativePath,
      })
      // No onRefresh needed - command handles store updates via renameFileInStore
    },
    [files, vaultPath, addToast, addProgressToast, updateProgressToast, removeToast],
  )

  // Handle drop on vault root
  const handleVaultRootDrop = useCallback(
    async (e: React.DragEvent, onRefresh?: (silent?: boolean) => void) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOverFolder(null)

      if (!window.electronAPI || !vaultPath) return

      // Check for external files first
      const hasPdmFiles = e.dataTransfer.types.includes(PDM_FILES_DATA_TYPE)
      const droppedExternalFiles = Array.from(e.dataTransfer.files)

      if ((droppedExternalFiles.length > 0 || e.dataTransfer.items.length > 0) && !hasPdmFiles) {
        // Handle external file/folder drop to vault root
        const entries = await collectEntriesFromDataTransfer(
          e.dataTransfer,
          (file) => window.electronAPI?.getPathForFile(file) || '',
        )

        // If no entries from webkitGetAsEntry, fall back to traditional file handling
        if (entries.length === 0) {
          for (const file of droppedExternalFiles) {
            try {
              const filePath = window.electronAPI.getPathForFile(file)
              if (filePath) {
                // Check if it's a directory
                const dirCheck = await window.electronAPI.isDirectory(filePath)
                entries.push({
                  path: filePath,
                  isDirectory: dirCheck.success && dirCheck.isDirectory === true,
                  relativePath: file.name,
                })
              }
            } catch (error) {
              log.error('[TreeDragDrop]', 'Error getting file path', { error: error })
            }
          }
        }

        if (entries.length === 0) {
          addToast('error', 'Could not get file paths')
          return
        }

        // Separate directories and files - process directories first
        const directories = entries.filter((e) => e.isDirectory)
        const fileEntries = entries.filter((e) => !e.isDirectory)

        const totalItems = entries.length
        const toastId = `drop-files-root-${Date.now()}`
        addProgressToast(
          toastId,
          `Adding ${totalItems} item${totalItems > 1 ? 's' : ''} to vault root...`,
          totalItems,
        )

        try {
          let successCount = 0
          let errorCount = 0
          let processed = 0

          // First create all directories (including empty ones)
          for (const dir of directories) {
            const destPath = buildFullPath(vaultPath, dir.relativePath)

            // First try to copy the directory (handles non-empty directories)
            const copyResult = await window.electronAPI.copyFile(dir.path, destPath)
            if (copyResult.success) {
              successCount++
            } else {
              // If copy failed, try creating the folder directly (for empty folders)
              const createResult = await window.electronAPI.createFolder(destPath)
              if (createResult.success) {
                successCount++
              } else {
                errorCount++
                log.error('[TreeDragDrop]', `Failed to create directory ${dir.relativePath}`, {
                  error: createResult.error,
                })
              }
            }

            processed++
            const percent = Math.round((processed / totalItems) * 100)
            updateProgressToast(toastId, processed, percent)
          }

          // Then copy all files
          for (const file of fileEntries) {
            const destPath = buildFullPath(vaultPath, file.relativePath)

            const result = await window.electronAPI.copyFile(file.path, destPath)
            if (result.success) {
              successCount++
            } else {
              errorCount++
            }

            processed++
            const percent = Math.round((processed / totalItems) * 100)
            updateProgressToast(toastId, processed, percent)
          }

          removeToast(toastId)

          if (errorCount === 0) {
            addToast(
              'success',
              `Added ${successCount} item${successCount > 1 ? 's' : ''} to vault root`,
            )
          } else {
            addToast('warning', `Added ${successCount}, failed ${errorCount}`)
          }

          setTimeout(() => onRefresh?.(), 100)
        } catch (error) {
          log.error('[TreeDragDrop]', 'Error adding files', { error: error })
          removeToast(toastId)
          addToast('error', 'Failed to add files')
        }
        return
      }

      // Get files from data transfer or local state
      let filesToMove: LocalFile[] = []
      const currentDraggedFiles = draggedFilesRef.current

      if (currentDraggedFiles.length > 0) {
        filesToMove = currentDraggedFiles
        draggedFilesRef.current = []
      } else {
        const pdmFilesData = e.dataTransfer.getData(PDM_FILES_DATA_TYPE)
        if (pdmFilesData) {
          try {
            const relativePaths: string[] = JSON.parse(pdmFilesData)
            filesToMove = files.filter((f) => relativePaths.includes(f.relativePath))
          } catch (error) {
            log.error('[TreeDragDrop]', 'Failed to parse drag data', { error: error })
            return
          }
        }
      }

      if (filesToMove.length === 0) return

      // Don't move if already in root
      const allInRoot = filesToMove.every((f) => !f.relativePath.includes('/'))
      if (allInRoot) return

      // Use the command system for consistent move behavior
      // targetFolder: '' means vault root
      // This handles: addExpectedFileChanges, server sync, optimistic UI updates, toasts
      await executeCommand('move', {
        files: filesToMove,
        targetFolder: '',
      })
      // No onRefresh needed - command handles store updates via renameFileInStore
    },
    [files, vaultPath, addToast, addProgressToast, updateProgressToast, removeToast],
  )

  return {
    draggedFilesRef,
    dragOverFolder,
    setDragOverFolder,
    handleDragStart,
    handleDragEnd,
    handleFolderDragOver,
    handleFolderDragLeave,
    handleDropOnFolder,
    handleVaultRootDrop,
    canMoveFiles,
  }
}
