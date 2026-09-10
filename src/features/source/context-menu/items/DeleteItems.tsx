// src/features/source/context-menu/items/DeleteItems.tsx
import { useRef, useLayoutEffect, useState, type ReactNode } from 'react'
import { Trash2, EyeOff, FileX, FolderX, CloudOff, UserX } from 'lucide-react'
import type { LocalFile } from '@/stores/pdmStore'
import { usePDMStore } from '@/stores/pdmStore'
import {
  executeCommand,
  getServerDeletionTargets,
  getSyncedFilesFromSelection,
  getOrphanedFilesFromSelection,
  type ServerDeletionTarget,
} from '@/lib/commands'
import { checkOperationPermission, getPermissionRequirement } from '@/lib/permissions'
import type { DialogName } from '../types'
import type { ToastType } from '@/stores/types'

/**
 * Viewport-aware submenu component that adjusts position to stay within screen bounds
 */
function ViewportAwareSubmenu({
  children,
  position,
  onMouseEnter,
  onMouseLeave,
}: {
  children: ReactNode
  position: 'right' | 'left'
  onMouseEnter: () => void
  onMouseLeave: () => void
}) {
  const submenuRef = useRef<HTMLDivElement>(null)
  const [verticalOffset, setVerticalOffset] = useState(-4)

  useLayoutEffect(() => {
    if (!submenuRef.current) return

    const submenu = submenuRef.current
    const rect = submenu.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    const padding = 16

    const bottomOverflow = rect.bottom - (viewportHeight - padding)

    if (bottomOverflow > 0) {
      const maxShift = rect.top - padding
      const actualShift = Math.min(bottomOverflow, maxShift)
      setVerticalOffset(-4 - actualShift)
    }
  }, [])

  return (
    <div
      ref={submenuRef}
      className={`absolute top-0 min-w-[200px] bg-plm-bg-lighter border border-plm-border rounded-md py-1 shadow-lg z-[100] ${
        position === 'right' ? 'left-full ml-1' : 'right-full mr-1'
      }`}
      style={{ marginTop: verticalOffset }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  )
}

interface DeleteItemsProps {
  files: LocalFile[]
  contextFiles: LocalFile[]
  syncedFilesInSelection: LocalFile[]
  unsyncedFilesInSelection: LocalFile[]
  cloudOnlyFilesInSelection: LocalFile[]
  anySynced: boolean
  anyUnsynced: boolean
  allCloudOnly: boolean
  isFolder: boolean
  multiSelect: boolean
  folderCount: number
  hasLocalFolders: boolean
  hasFoldersOnServer: boolean
  activeVaultId: string | null | undefined
  userId: string | undefined
  showIgnoreSubmenu: boolean
  submenuPosition: 'right' | 'left'
  handleIgnoreSubmenuEnter: () => void
  handleIgnoreSubmenuLeave: () => void
  onClose: () => void
  onRefresh: (silent?: boolean) => void
  openDialog: (name: DialogName) => void
  setDeleteConfirmFiles: (targets: ServerDeletionTarget[]) => void
  setDeleteServerKeepLocal: (value: boolean) => void
  setDeleteLocalCheckedOutFiles: (files: LocalFile[]) => void
  addIgnorePattern: (vaultId: string, pattern: string) => void
  getIgnorePatterns: (vaultId: string) => string[]
  addToast: (type: ToastType, message: string, duration?: number) => void
  firstFile: LocalFile
}

export function DeleteItems({
  files,
  contextFiles,
  syncedFilesInSelection,
  unsyncedFilesInSelection,
  cloudOnlyFilesInSelection,
  anySynced,
  anyUnsynced,
  allCloudOnly,
  isFolder,
  multiSelect,
  folderCount,
  hasLocalFolders,
  hasFoldersOnServer,
  activeVaultId,
  userId,
  showIgnoreSubmenu,
  submenuPosition,
  handleIgnoreSubmenuEnter,
  handleIgnoreSubmenuLeave,
  onClose,
  onRefresh,
  openDialog,
  setDeleteConfirmFiles,
  setDeleteServerKeepLocal,
  setDeleteLocalCheckedOutFiles,
  addIgnorePattern,
  getIgnorePatterns,
  addToast,
  firstFile,
}: DeleteItemsProps) {
  const { hasPermission } = usePDMStore()
  const serverFiles = usePDMStore((s) => s.serverFiles)
  const vaultPath = usePDMStore((s) => s.vaultPath)

  // Permission checks
  const canDeleteLocal = checkOperationPermission('delete-local', hasPermission)
  const canDeleteServer = checkOperationPermission('delete-server', hasPermission)

  // Check for files checked out by others (cannot be deleted)
  const filesCheckedOutByOthers = syncedFilesInSelection.filter(
    (f) => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== userId,
  )
  const hasFilesCheckedOutByOthers = filesCheckedOutByOthers.length > 0

  const hasUnsyncedLocalFiles = unsyncedFilesInSelection.length > 0

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

  // Get orphaned files (deleted_remote) from selection
  const orphanedFilesInSelection = getOrphanedFilesFromSelection(files, contextFiles)
  const hasOrphanedFiles = orphanedFilesInSelection.length > 0

  const handleDeleteLocal = () => {
    if (!canDeleteLocal.allowed) {
      addToast('error', canDeleteLocal.reason || getPermissionRequirement('delete-local'))
      return
    }
    // Get all synced files that will be affected (including from folders)
    const syncedFiles = getSyncedFilesFromSelection(files, contextFiles)

    // Check for files checked out by current user
    const checkedOutByMe = syncedFiles.filter((f) => f.pdmData?.checked_out_by === userId)

    // If there are checked out files, show confirmation dialog
    if (checkedOutByMe.length > 0) {
      setDeleteLocalCheckedOutFiles(checkedOutByMe)
      openDialog('deleteLocalConfirm')
      return
    }

    // No checked out files - proceed directly
    onClose()
    executeCommand('delete-local', { files: contextFiles }, { onRefresh })
  }

  const handleDeleteFromServer = (keepLocal: boolean = false) => {
    if (!canDeleteServer.allowed) {
      addToast('error', canDeleteServer.reason || getPermissionRequirement('delete-server'))
      return
    }
    // Enumerated exactly as the command will, so the dialog counts the records that are
    // actually about to be deleted rather than the subset with a local row.
    const uniqueFiles = getServerDeletionTargets(files, serverFiles, contextFiles, vaultPath)

    // Check for local-only folders
    const hasLocalFoldersInContext = contextFiles.some(
      (f) => f.isDirectory && f.diffStatus !== 'cloud',
    )
    const hasCloudOnlyFolders = contextFiles.some((f) => f.isDirectory && f.diffStatus === 'cloud')

    if (uniqueFiles.length === 0 && !hasLocalFoldersInContext) {
      if (hasCloudOnlyFolders) {
        // Empty cloud-only folders - delete directly without confirmation
        onClose()
        executeCommand(
          'delete-server',
          { files: contextFiles, deleteLocal: !keepLocal },
          { onRefresh },
        )
      } else {
        addToast('warning', 'No files to delete from server')
        onClose()
      }
      return
    }

    // If only local folders with no server files, delete without confirmation
    if (uniqueFiles.length === 0 && hasLocalFoldersInContext) {
      onClose()
      executeCommand(
        'delete-server',
        { files: contextFiles, deleteLocal: !keepLocal },
        { onRefresh },
      )
      return
    }

    // Show confirmation dialog for server files
    setDeleteConfirmFiles(uniqueFiles)
    setDeleteServerKeepLocal(keepLocal)
    openDialog('deleteConfirm')
  }

  // Toggle submenu on click (for touch/trackpad users)
  const handleIgnoreSubmenuClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Toggle handled by parent
  }

  return (
    <>
      <div className="context-menu-separator" />

      {/* Keep Local Only (Ignore) - for unsynced files and folders */}
      {anyUnsynced && !allCloudOnly && activeVaultId && (
        <div
          className="context-menu-item relative"
          onMouseEnter={handleIgnoreSubmenuEnter}
          onMouseLeave={handleIgnoreSubmenuLeave}
          onClick={handleIgnoreSubmenuClick}
        >
          <EyeOff size={14} />
          Keep Local Only
          <span className="text-xs text-plm-fg-muted ml-auto">
            {submenuPosition === 'right' ? '▶' : '◀'}
          </span>
          {/* Submenu */}
          {showIgnoreSubmenu && (
            <ViewportAwareSubmenu
              position={submenuPosition}
              onMouseEnter={handleIgnoreSubmenuEnter}
              onMouseLeave={handleIgnoreSubmenuLeave}
            >
              {/* Ignore this specific file/folder */}
              <div
                className="context-menu-item"
                onClick={(e) => {
                  e.stopPropagation()
                  for (const file of contextFiles) {
                    if (file.isDirectory) {
                      addIgnorePattern(activeVaultId, file.relativePath + '/')
                    } else {
                      addIgnorePattern(activeVaultId, file.relativePath)
                    }
                  }
                  addToast(
                    'success',
                    `Added ${contextFiles.length > 1 ? `${contextFiles.length} items` : contextFiles[0].name} to ignore list`,
                  )
                  onRefresh(true)
                  onClose()
                }}
              >
                {isFolder ? <FolderX size={14} /> : <FileX size={14} />}
                This {isFolder ? 'folder' : 'file'}
                {multiSelect ? ` (${contextFiles.length})` : ''}
              </div>

              {/* Ignore all files with this extension */}
              {!isFolder && !multiSelect && firstFile.extension && (
                <div
                  className="context-menu-item"
                  onClick={(e) => {
                    e.stopPropagation()
                    const pattern = `*${firstFile.extension}`
                    addIgnorePattern(activeVaultId, pattern)
                    addToast('success', `Now ignoring all ${firstFile.extension} files`)
                    onRefresh(true)
                    onClose()
                  }}
                >
                  <FileX size={14} />
                  All *{firstFile.extension} files
                </div>
              )}

              {/* Show current patterns count */}
              {(() => {
                const currentPatterns = getIgnorePatterns(activeVaultId)
                if (currentPatterns.length > 0) {
                  return (
                    <>
                      <div className="context-menu-separator" />
                      <div className="px-3 py-1.5 text-xs text-plm-fg-muted">
                        {currentPatterns.length} pattern{currentPatterns.length > 1 ? 's' : ''}{' '}
                        configured
                      </div>
                    </>
                  )
                }
                return null
              })()}
            </ViewportAwareSubmenu>
          )}
        </div>
      )}

      {/* Remove Local Copy - for synced files (not for empty folder-only selections) */}
      {anySynced && !allCloudOnly && !isEmptyFolderSelection && (
        <div
          className={`context-menu-item ${!canDeleteLocal.allowed || hasFilesCheckedOutByOthers ? 'disabled' : ''}`}
          onClick={hasFilesCheckedOutByOthers ? undefined : handleDeleteLocal}
          title={
            hasFilesCheckedOutByOthers
              ? `Cannot delete: ${filesCheckedOutByOthers.length} file(s) checked out by others`
              : !canDeleteLocal.allowed
                ? `Requires ${getPermissionRequirement('delete-local')}`
                : ''
          }
        >
          <Trash2 size={14} />
          Remove Local Copy ({syncedFilesInSelection.length} file
          {syncedFilesInSelection.length !== 1 ? 's' : ''})
          {hasFilesCheckedOutByOthers && (
            <span className="text-xs text-plm-fg-muted ml-auto">(locked)</span>
          )}
          {!hasFilesCheckedOutByOthers && !canDeleteLocal.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}

      {/* Delete Locally - for local files/folders that aren't synced */}
      {/* For empty folder-only selections, simplify label to just "Delete" */}
      {(hasUnsyncedLocalFiles || hasLocalFolders) && !allCloudOnly && !anySynced && (
        <div
          className={`context-menu-item ${canDeleteLocal.allowed ? 'danger' : 'disabled'}`}
          onClick={handleDeleteLocal}
          title={
            !canDeleteLocal.allowed ? `Requires ${getPermissionRequirement('delete-local')}` : ''
          }
        >
          <Trash2 size={14} />
          {isEmptyFolderSelection
            ? `Delete${folderCount > 0 ? ` (${folderCount} folder${folderCount !== 1 ? 's' : ''})` : ''}`
            : `Delete (${unsyncedFilesInSelection.length} file${unsyncedFilesInSelection.length !== 1 ? 's' : ''}${folderCount > 0 ? `, ${folderCount} folder${folderCount !== 1 ? 's' : ''}` : ''})`}
          {!canDeleteLocal.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}

      {/* Delete from Server (Keep Local) - for synced files that have local copies (not for empty folder-only selections) */}
      {anySynced && !allCloudOnly && !isEmptyFolderSelection && (
        <div
          className={`context-menu-item ${!canDeleteServer.allowed || hasFilesCheckedOutByOthers ? 'disabled' : ''}`}
          onClick={hasFilesCheckedOutByOthers ? undefined : () => handleDeleteFromServer(true)}
          title={
            hasFilesCheckedOutByOthers
              ? `Cannot delete: ${filesCheckedOutByOthers.length} file(s) checked out by others`
              : !canDeleteServer.allowed
                ? `Requires ${getPermissionRequirement('delete-server')}`
                : ''
          }
        >
          <CloudOff size={14} />
          Delete from Server ({syncedFilesInSelection.length} file
          {syncedFilesInSelection.length !== 1 ? 's' : ''})
          {hasFilesCheckedOutByOthers && (
            <span className="text-xs text-plm-fg-muted ml-auto">(locked)</span>
          )}
          {!hasFilesCheckedOutByOthers && !canDeleteServer.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}

      {/* Delete Local & Server - show if any content exists on server (synced, cloud-only, or folder exists on server) */}
      {/* For empty folder-only selections, simplify to just "Delete" since folders are always synced */}
      {(anySynced ||
        allCloudOnly ||
        contextFiles.some((f) => f.diffStatus === 'cloud') ||
        hasFoldersOnServer ||
        (isOnlyFolders && hasSyncedFolders)) && (
        <div
          className={`context-menu-item ${canDeleteServer.allowed && !hasFilesCheckedOutByOthers ? 'danger' : 'disabled'}`}
          onClick={hasFilesCheckedOutByOthers ? undefined : () => handleDeleteFromServer(false)}
          title={
            hasFilesCheckedOutByOthers
              ? `Cannot delete: ${filesCheckedOutByOthers.length} file(s) checked out by others`
              : !canDeleteServer.allowed
                ? `Requires ${getPermissionRequirement('delete-server')}`
                : ''
          }
        >
          <Trash2 size={14} />
          {isEmptyFolderSelection
            ? `Delete${folderCount > 0 ? ` (${folderCount} folder${folderCount !== 1 ? 's' : ''})` : ''}`
            : `${allCloudOnly ? 'Delete from Server' : 'Delete Local & Server'} (${syncedFilesInSelection.length + cloudOnlyFilesInSelection.length} file${syncedFilesInSelection.length + cloudOnlyFilesInSelection.length !== 1 ? 's' : ''}${folderCount > 0 ? `, ${folderCount} folder${folderCount !== 1 ? 's' : ''}` : ''})`}
          {hasFilesCheckedOutByOthers && (
            <span className="text-xs text-plm-fg-muted ml-auto">(locked)</span>
          )}
          {!hasFilesCheckedOutByOthers && !canDeleteServer.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}

      {/* Discard Orphaned Files - for files deleted from server by another user */}
      {hasOrphanedFiles && (
        <div
          className={`context-menu-item ${canDeleteLocal.allowed ? 'danger' : 'disabled'}`}
          onClick={() => {
            if (!canDeleteLocal.allowed) {
              addToast('error', canDeleteLocal.reason || getPermissionRequirement('delete-local'))
              return
            }
            onClose()
            executeCommand('discard-orphaned', { files: contextFiles }, { onRefresh })
          }}
          title={
            !canDeleteLocal.allowed
              ? `Requires ${getPermissionRequirement('delete-local')}`
              : 'Delete local files that no longer exist on the server'
          }
        >
          <UserX size={14} />
          Discard Orphaned ({orphanedFilesInSelection.length} file
          {orphanedFilesInSelection.length !== 1 ? 's' : ''})
          {!canDeleteLocal.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}
    </>
  )
}
