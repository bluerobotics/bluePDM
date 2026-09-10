/**
 * Open file/folder actions for context menu
 */
import type { LocalFile } from '@/stores/pdmStore'
import { usePDMStore } from '@/stores/pdmStore'
import { buildFullPath } from '@/lib/utils/path'
import type { ActionComponentProps } from './types'
import { getCountLabel } from '@/lib/utils'

interface OpenActionsProps extends ActionComponentProps {
  navigateToFolder: (path: string) => void
}

export function OpenActions({
  contextFiles,
  multiSelect,
  firstFile,
  onClose,
  navigateToFolder,
}: OpenActionsProps) {
  const vaultPath = usePDMStore((s) => s.vaultPath)

  // A 'moved_away' stub has nothing on disk at its own path - open its real, current
  // location instead of failing on a path that no longer exists.
  const openFile = (file: LocalFile) => {
    if (file.diffStatus === 'moved_away') {
      if (file.movedToRelativePath && vaultPath) {
        window.electronAPI?.openFile(buildFullPath(vaultPath, file.movedToRelativePath))
      }
      return
    }
    window.electronAPI?.openFile(file.path)
  }

  const allFiles = contextFiles.every((f) => !f.isDirectory)
  const allCloudOnly = contextFiles.every((f) => f.diffStatus === 'cloud')
  const isFolder = firstFile.isDirectory
  const fileCount = contextFiles.filter((f) => !f.isDirectory).length
  const folderCount = contextFiles.filter((f) => f.isDirectory).length
  const countLabel = getCountLabel(fileCount, folderCount)

  // Single file - not cloud only
  if (!multiSelect && !isFolder && !allCloudOnly) {
    return (
      <div
        className="context-menu-item"
        onClick={() => {
          openFile(firstFile)
          onClose()
        }}
      >
        Open
      </div>
    )
  }

  // Multiple files - all are files, not cloud only
  if (multiSelect && allFiles && !allCloudOnly) {
    return (
      <div
        className="context-menu-item"
        onClick={async () => {
          for (const file of contextFiles) {
            openFile(file)
          }
          onClose()
        }}
      >
        Open All {countLabel}
      </div>
    )
  }

  // Single folder - not cloud only
  if (!multiSelect && isFolder && !allCloudOnly) {
    return (
      <div
        className="context-menu-item"
        onClick={() => {
          navigateToFolder(firstFile.relativePath)
          onClose()
        }}
      >
        Open Folder
      </div>
    )
  }

  return null
}
