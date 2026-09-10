/**
 * File system actions for context menu (copy path, show in explorer, pin, rename)
 */
import { Copy, FolderOpen, Pencil, Star } from 'lucide-react'
import type { LocalFile } from '@/stores/pdmStore'
import { usePDMStore } from '@/stores/pdmStore'
import { copyToClipboard } from '@/lib/clipboard'
import { buildFullPath } from '@/lib/utils/path'
import type { ActionComponentProps } from './types'

interface FileSystemActionsProps extends ActionComponentProps {
  platform: string
  startRenaming: (file: LocalFile) => void
  userId: string | undefined
}

export function FileSystemActions({
  contextFiles,
  multiSelect,
  firstFile,
  onClose,
  platform,
  startRenaming,
  userId,
}: FileSystemActionsProps) {
  const {
    files,
    activeVaultId,
    connectedVaults,
    pinnedFolders,
    pinFolder,
    unpinFolder,
    addToast,
    vaultPath,
  } = usePDMStore()

  const allCloudOnly = contextFiles.every((f) => f.diffStatus === 'cloud')
  const isFolder = firstFile.isDirectory
  const isMovedAway = !isFolder && firstFile.diffStatus === 'moved_away'

  // Copy Name is always available regardless of file status
  const copyNameItem = (
    <div
      className="context-menu-item"
      onClick={async () => {
        const names = contextFiles.map((f) => f.name).join('\n')
        const result = await copyToClipboard(names)
        if (result.success) {
          addToast(
            'success',
            `Copied ${contextFiles.length > 1 ? contextFiles.length + ' names' : 'name'} to clipboard`,
          )
        }
        onClose()
      }}
    >
      <Copy size={14} />
      Copy Name{multiSelect ? 's' : ''}
    </div>
  )

  // For cloud-only files, only show Copy Name
  if (allCloudOnly) {
    return copyNameItem
  }

  // Check rename eligibility
  const canRename = (() => {
    if (isFolder) {
      // Folders: block only if another user has files checked out inside
      const folderPath = firstFile.relativePath.replace(/\\/g, '/')
      const nestedFiles = files.filter((f) => {
        if (f.isDirectory) return false
        return f.relativePath.replace(/\\/g, '/').startsWith(folderPath + '/')
      })
      return !nestedFiles.some(
        (f) => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== userId,
      )
    }
    // A 'moved_away' stub carries the real file's pdmData/checkout state, but there is
    // nothing on disk at its own relativePath to rename - block it unconditionally rather
    // than letting checked_out_by === userId (true of the real file, not this row) open a
    // rename box on a path that does not exist.
    if (isMovedAway) return false
    const isSyncedFile = !!firstFile.pdmData
    const isCheckedOutByMe = firstFile.pdmData?.checked_out_by === userId
    return !isSyncedFile || isCheckedOutByMe
  })()

  // Check pin status
  const isPinned = activeVaultId
    ? pinnedFolders.some((p) => p.path === firstFile.relativePath && p.vaultId === activeVaultId)
    : false
  const currentVault = activeVaultId ? connectedVaults.find((v) => v.id === activeVaultId) : null

  return (
    <>
      {/* Show in Explorer/Finder - a moved_away stub has nothing on disk at its own path,
          so reveal its real, current location instead. */}
      <div
        className="context-menu-item"
        onClick={() => {
          const targetPath =
            isMovedAway && firstFile.movedToRelativePath && vaultPath
              ? buildFullPath(vaultPath, firstFile.movedToRelativePath)
              : firstFile.path
          window.electronAPI?.openInExplorer(targetPath)
          onClose()
        }}
      >
        <FolderOpen size={14} />
        {platform === 'darwin' ? 'Reveal in Finder' : 'Show in Explorer'}
      </div>

      {/* Copy Name(s) - always available */}
      {copyNameItem}

      {/* Copy Path(s) */}
      <div
        className="context-menu-item"
        onClick={async () => {
          const paths = contextFiles.map((f) => f.path).join('\n')
          const result = await copyToClipboard(paths)
          if (result.success) {
            addToast(
              'success',
              `Copied ${contextFiles.length > 1 ? contextFiles.length + ' paths' : 'path'} to clipboard`,
            )
          }
          onClose()
        }}
      >
        <Copy size={14} />
        Copy Path{multiSelect ? 's' : ''}
      </div>

      {/* Copy Folder Path - for files only, copies the directory portion */}
      {!firstFile.isDirectory && !multiSelect && (
        <div
          className="context-menu-item"
          onClick={async () => {
            // Extract directory path by removing the filename
            const sep = platform === 'win32' ? '\\' : '/'
            const lastSepIndex = firstFile.path.lastIndexOf(sep)
            const folderPath =
              lastSepIndex > 0 ? firstFile.path.substring(0, lastSepIndex) : firstFile.path
            const result = await copyToClipboard(folderPath)
            if (result.success) {
              addToast('success', 'Copied folder path to clipboard')
            }
            onClose()
          }}
        >
          <Copy size={14} />
          Copy Folder Path
        </div>
      )}

      <div className="context-menu-separator" />

      {/* Pin/Unpin - single item only */}
      {!multiSelect && activeVaultId && (
        <div
          className="context-menu-item"
          onClick={() => {
            if (isPinned) {
              unpinFolder(firstFile.relativePath)
              addToast('info', `Unpinned ${firstFile.name}`)
            } else {
              pinFolder(
                firstFile.relativePath,
                activeVaultId,
                currentVault?.name || 'Vault',
                firstFile.isDirectory,
              )
              addToast('success', `Pinned ${firstFile.name}`)
            }
            onClose()
          }}
        >
          <Star size={14} className={isPinned ? 'fill-plm-warning text-plm-warning' : ''} />
          {isPinned ? 'Unpin' : `Pin ${isFolder ? 'Folder' : 'File'}`}
        </div>
      )}

      {/* Rename - single item, not cloud only */}
      {!multiSelect && (
        <div
          className={`context-menu-item ${!canRename ? 'disabled' : ''}`}
          onClick={() => {
            if (canRename) {
              startRenaming(firstFile)
            }
          }}
          title={
            !canRename
              ? isMovedAway
                ? 'File has moved - resolve the pending move first'
                : isFolder
                  ? 'Another user has files checked out in this folder'
                  : 'Check out file first to rename'
              : ''
          }
        >
          <Pencil size={14} />
          Rename
          {!canRename && (
            <span className="text-xs text-plm-fg-muted ml-auto">
              {isMovedAway ? '(moved)' : isFolder ? '(has checkouts)' : '(checkout required)'}
            </span>
          )}
        </div>
      )}
    </>
  )
}
