// src/features/source/context-menu/items/FileOperationItems.tsx
import { ExternalLink, FolderOpen, Edit, FolderPlus } from 'lucide-react'
import type { LocalFile } from '@/stores/pdmStore'
import { usePDMStore } from '@/stores/pdmStore'
import { executeCommand } from '@/lib/commands'
import { buildFullPath } from '@/lib/utils/path'

interface FileOperationItemsProps {
  firstFile: LocalFile
  multiSelect: boolean
  isFolder: boolean
  platform: string
  userId: string | undefined
  onRename?: (file: LocalFile) => void
  onNewFolder?: () => void
  onClose: () => void
  onRefresh: (silent?: boolean) => void
}

export function FileOperationItems({
  firstFile,
  multiSelect,
  isFolder,
  platform,
  userId,
  onRename,
  onNewFolder,
  onClose,
  onRefresh,
}: FileOperationItemsProps) {
  const { files, vaultPath } = usePDMStore()

  // A 'moved_away' stub has nothing on disk at its own relativePath - the content lives at
  // movedToRelativePath now. Never true for folders (moves only produce file-level stubs).
  const isMovedAway = !isFolder && firstFile.diffStatus === 'moved_away'

  const handleOpen = () => {
    onClose()
    if (isMovedAway) {
      // Open the file's real, current location instead of failing on a path that no longer
      // exists. 'open' itself only special-cases 'cloud' in its validate(), so the redirect
      // happens here rather than by teaching the command about a status it doesn't need to know.
      if (firstFile.movedToRelativePath && vaultPath) {
        executeCommand(
          'open',
          { file: { ...firstFile, path: buildFullPath(vaultPath, firstFile.movedToRelativePath) } },
          { onRefresh },
        )
      }
      return
    }
    executeCommand('open', { file: firstFile }, { onRefresh })
  }

  const handleShowInExplorer = () => {
    onClose()
    const targetPath =
      isMovedAway && firstFile.movedToRelativePath && vaultPath
        ? buildFullPath(vaultPath, firstFile.movedToRelativePath)
        : firstFile.path
    executeCommand('show-in-explorer', { path: targetPath }, { onRefresh })
  }

  // Check rename permissions
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
    // nothing on disk at its own relativePath to rename - block unconditionally rather than
    // letting checked_out_by === userId (true of the real file, not this row) open a rename
    // box on a path that does not exist.
    if (isMovedAway) return false
    const isSynced = !!firstFile.pdmData
    const isCheckedOutByMe = firstFile.pdmData?.checked_out_by === userId
    return !isSynced || isCheckedOutByMe
  })()

  // Check if the specific file/folder exists locally (not cloud-only)
  // This is different from allCloudOnly which derives folder status from children,
  // causing empty local folders to be incorrectly treated as cloud-only
  const isLocalItem = firstFile.diffStatus !== 'cloud'

  return (
    <>
      {/* Open - only for local files/folders (not cloud-only) */}
      {!multiSelect && isLocalItem && (
        <div className="context-menu-item" onClick={handleOpen}>
          <ExternalLink size={14} />
          {isFolder ? 'Open Folder' : 'Open'}
        </div>
      )}

      {/* Show in Explorer/Finder */}
      {isLocalItem && (
        <div className="context-menu-item" onClick={handleShowInExplorer}>
          <FolderOpen size={14} />
          {platform === 'darwin' ? 'Reveal in Finder' : 'Show in Explorer'}
        </div>
      )}

      {/* Rename - right after pin */}
      {onRename && !multiSelect && (isLocalItem || isFolder) && (
        <div
          className={`context-menu-item ${!canRename ? 'disabled' : ''}`}
          onClick={() => {
            if (canRename) {
              onRename(firstFile)
              onClose()
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
          <Edit size={14} />
          Rename
          <span className="text-xs text-plm-fg-muted ml-auto">
            {!canRename
              ? isMovedAway
                ? '(moved)'
                : isFolder
                  ? '(has checkouts)'
                  : '(checkout required)'
              : 'F2'}
          </span>
        </div>
      )}

      {/* New Folder */}
      {onNewFolder && isFolder && !multiSelect && isLocalItem && (
        <>
          <div className="context-menu-separator" />
          <div
            className="context-menu-item"
            onClick={() => {
              onNewFolder()
              onClose()
            }}
          >
            <FolderPlus size={14} />
            New Folder
          </div>
        </>
      )}
    </>
  )
}
