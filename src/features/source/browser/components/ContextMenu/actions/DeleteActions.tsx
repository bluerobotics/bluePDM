/**
 * Delete actions for context menu (delete local, delete server, delete both)
 */
import { useMemo } from 'react'
import { CloudOff, Trash2, Undo2 } from 'lucide-react'
import type { LocalFile } from '@/stores/pdmStore'
import { usePDMStore } from '@/stores/pdmStore'
import { executeCommand, getServerDeletionTargets } from '@/lib/commands'
import type { RefreshableActionProps, SelectionCounts, SelectionState } from './types'

interface DeleteActionsProps extends RefreshableActionProps {
  counts: SelectionCounts
  state: SelectionState
  setCustomConfirm: (
    state: {
      title: string
      message: string
      warning?: string
      confirmText: string
      confirmDanger?: boolean
      onConfirm: () => void
    } | null,
  ) => void
  setDeleteLocalCheckoutConfirm: (
    state: {
      checkedOutFiles: LocalFile[]
      allFilesToProcess: LocalFile[]
      contextFiles: LocalFile[]
    } | null,
  ) => void
  undoStack: Array<{ type: 'delete'; file: LocalFile; originalPath: string }>
  handleUndo: () => void
}

export function DeleteActions({
  contextFiles,
  firstFile: _firstFile,
  onClose,
  onRefresh,
  counts,
  state,
  setCustomConfirm,
  setDeleteLocalCheckoutConfirm,
  undoStack,
  handleUndo,
}: DeleteActionsProps) {
  const { files, user, addToast } = usePDMStore()
  const serverFiles = usePDMStore((s) => s.serverFiles)
  const vaultPath = usePDMStore((s) => s.vaultPath)

  // What delete-server will actually cover. Counted from the server list rather than the
  // local rows, so the confirmation cannot promise fewer deletions than it performs.
  const serverDeletionTargets = useMemo(
    () => getServerDeletionTargets(files, serverFiles, contextFiles, vaultPath),
    [files, serverFiles, contextFiles, vaultPath],
  )

  // Helper to get all files including those inside folders
  const getAllFilesFromSelection = () => {
    const allFilesResult: LocalFile[] = []
    for (const item of contextFiles) {
      if (item.isDirectory) {
        const folderPath = item.relativePath.replace(/\\/g, '/')
        const filesInFolder = files.filter((f) => {
          if (f.isDirectory) return false
          const filePath = f.relativePath.replace(/\\/g, '/')
          return filePath.startsWith(folderPath + '/')
        })
        allFilesResult.push(...filesInFolder)
      } else {
        allFilesResult.push(item)
      }
    }
    return [...new Map(allFilesResult.map((f) => [f.path, f])).values()]
  }

  const allFilesInSelection = getAllFilesFromSelection()
  // Excludes 'moved_away' - the actual local-delete/server-delete targets are re-derived
  // downstream via getLocalDeletionItems/getServerDeletionTargets (which already exclude the
  // stub), but these counts drive the menu labels directly, so they must not count a stub
  // that has no local file behind it and shares pdmData.id with its 'moved' partner.
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

  // Check if selection is ONLY folders (no files) - folders get simplified delete UX
  const isOnlyFolders = contextFiles.every((f) => f.isDirectory)
  // Check if any folders in selection are synced (have pdmData from folders table)
  const hasSyncedFolders = contextFiles.some((f) => f.isDirectory && f.pdmData?.id)

  // Check if any folder in selection has files inside
  // Used to determine if we should show simplified UX (empty folders) or full options (folders with content)
  const foldersHaveContent = contextFiles.some((item) => {
    if (!item.isDirectory) return false
    const folderPath = item.relativePath.replace(/\\/g, '/')
    return files.some((f) => {
      if (f.isDirectory) return false
      const filePath = f.relativePath.replace(/\\/g, '/')
      return filePath.startsWith(folderPath + '/')
    })
  })

  // Only use simplified folder UX when ALL folders are empty
  const isEmptyFolderSelection = isOnlyFolders && !foldersHaveContent

  return (
    <>
      <div className="context-menu-separator" />

      {/* Remove Local Copy - removes local copy of synced files, keeps server (not for empty folder-only selections) */}
      {hasLocalFiles && hasSyncedFiles && !isEmptyFolderSelection && (
        <div
          className="context-menu-item"
          onClick={async () => {
            onClose()

            const filesToProcess = syncedFilesInDelete

            if (filesToProcess.length === 0) {
              addToast('info', 'No synced files to remove locally')
              return
            }

            const checkedOutByMe = filesToProcess.filter(
              (f) => f.pdmData?.checked_out_by === user?.id,
            )

            if (checkedOutByMe.length > 0) {
              setDeleteLocalCheckoutConfirm({
                checkedOutFiles: checkedOutByMe,
                allFilesToProcess: filesToProcess,
                contextFiles: [...contextFiles],
              })
              return
            }

            executeCommand('delete-local', { files: contextFiles }, { onRefresh })
          }}
        >
          <Trash2 size={14} />
          Remove Local Copy ({syncedFilesInDelete.length} file
          {syncedFilesInDelete.length !== 1 ? 's' : ''})
        </div>
      )}

      {/* Delete Locally - for unsynced local files only (not for folder-only selections with synced folders) */}
      {hasUnsyncedLocalFiles &&
        !hasSyncedFiles &&
        !state.allCloudOnly &&
        !(isOnlyFolders && hasSyncedFolders) && (
          <div
            className="context-menu-item danger"
            onClick={async () => {
              onClose()

              const filesToDelete =
                unsyncedFilesInDelete.length > 0
                  ? unsyncedFilesInDelete
                  : contextFiles.filter(
                      (f) =>
                        !f.pdmData || f.diffStatus === 'added' || f.diffStatus === 'deleted_remote',
                    )

              if (filesToDelete.length === 0) {
                addToast('info', 'No local files to delete')
                return
              }

              // Use command system for delete
              executeCommand('delete-local', { files: contextFiles }, { onRefresh })
            }}
          >
            <Trash2 size={14} />
            {isEmptyFolderSelection
              ? `Delete${counts.folderCount > 0 ? ` (${counts.folderCount} folder${counts.folderCount !== 1 ? 's' : ''})` : ''}`
              : `Delete (${unsyncedFilesInDelete.length} file${unsyncedFilesInDelete.length !== 1 ? 's' : ''}${counts.folderCount > 0 ? `, ${counts.folderCount} folder${counts.folderCount !== 1 ? 's' : ''}` : ''})`}
          </div>
        )}

      {/* Delete from Server (Keep Local) - not for empty folder-only selections */}
      {hasSyncedFiles && !state.allCloudOnly && !isEmptyFolderSelection && (
        <div
          className="context-menu-item"
          onClick={() => {
            onClose()
            const serverCount = serverDeletionTargets.length

            setCustomConfirm({
              title: `Delete from Server ${serverCount > 1 ? `${serverCount} Items` : 'Item'}?`,
              message: `${serverCount} file${serverCount > 1 ? 's' : ''} will be removed from the server. Local copies will be kept.`,
              warning:
                'Local copies will become unsynced. Files can be recovered from server trash within 30 days.',
              confirmText: 'Delete from Server',
              confirmDanger: false,
              onConfirm: async () => {
                executeCommand(
                  'delete-server',
                  { files: contextFiles, deleteLocal: false },
                  { onRefresh },
                )
              },
            })
          }}
        >
          <CloudOff size={14} />
          Delete from Server ({syncedFilesInDelete.length} file
          {syncedFilesInDelete.length !== 1 ? 's' : ''})
        </div>
      )}

      {/* Delete Local & Server (or just "Delete" for folder-only selections) */}
      {(hasSyncedFiles || state.allCloudOnly || (isOnlyFolders && hasSyncedFolders)) && (
        <div
          className="context-menu-item danger"
          onClick={async () => {
            if (state.allCloudOnly) {
              onClose()

              const cloudFiles = contextFiles.filter((f) => f.diffStatus === 'cloud')
              const allCloudFiles: LocalFile[] = []
              for (const item of cloudFiles) {
                if (item.isDirectory) {
                  const folderPath = item.relativePath.replace(/\\/g, '/')
                  const filesInFolder = files.filter((f) => {
                    if (f.isDirectory) return false
                    if (f.diffStatus !== 'cloud') return false
                    const filePath = f.relativePath.replace(/\\/g, '/')
                    return filePath.startsWith(folderPath + '/')
                  })
                  allCloudFiles.push(...filesInFolder)
                } else if (item.pdmData?.id) {
                  allCloudFiles.push(item)
                }
              }
              const uniqueCloudFiles = [...new Map(allCloudFiles.map((f) => [f.path, f])).values()]

              if (uniqueCloudFiles.length === 0) {
                // Empty folders - delete directly
                executeCommand(
                  'delete-server',
                  { files: contextFiles, deleteLocal: true },
                  { onRefresh },
                )
                return
              }

              const storedCloudFiles = [...uniqueCloudFiles]

              setCustomConfirm({
                title: `Delete ${uniqueCloudFiles.length} Item${uniqueCloudFiles.length > 1 ? 's' : ''} from Server?`,
                message: `${uniqueCloudFiles.length} file${uniqueCloudFiles.length > 1 ? 's' : ''} will be deleted from the server.`,
                warning: 'Files can be recovered from trash within 30 days.',
                confirmText: 'Delete from Server',
                confirmDanger: true,
                onConfirm: async () => {
                  executeCommand(
                    'delete-server',
                    { files: storedCloudFiles, deleteLocal: false },
                    { onRefresh },
                  )
                },
              })
            } else if (isEmptyFolderSelection) {
              // For empty folder-only selections, delete directly without complex confirmation
              onClose()
              executeCommand('delete-local', { files: contextFiles }, { onRefresh })
            } else {
              // Delete local & server using command system
              onClose()
              executeCommand(
                'delete-server',
                { files: contextFiles, deleteLocal: true },
                { onRefresh },
              )
            }
          }}
        >
          <Trash2 size={14} />
          {isEmptyFolderSelection
            ? `Delete${counts.folderCount > 0 ? ` (${counts.folderCount} folder${counts.folderCount !== 1 ? 's' : ''})` : ''}`
            : `${state.allCloudOnly ? 'Delete from Server' : 'Delete Local & Server'} (${syncedFilesInDelete.length + counts.cloudOnlyCount} file${syncedFilesInDelete.length + counts.cloudOnlyCount !== 1 ? 's' : ''}${counts.folderCount > 0 ? `, ${counts.folderCount} folder${counts.folderCount !== 1 ? 's' : ''}` : ''})`}
        </div>
      )}

      <div className="context-menu-separator" />

      {/* Undo */}
      <div
        className={`context-menu-item ${undoStack.length === 0 ? 'disabled' : ''}`}
        onClick={() => {
          if (undoStack.length > 0) {
            handleUndo()
          }
          onClose()
        }}
      >
        <Undo2 size={14} />
        Undo
        <span className="text-xs text-plm-fg-muted ml-auto">Ctrl+Z</span>
      </div>
    </>
  )
}
