// src/features/source/context-menu/items/PDMItems.tsx
import { ArrowDown, ArrowUp, Undo2, RefreshCw, Network, FileSearch, Package2 } from 'lucide-react'
import { t } from '@/lib/i18n'
import type { LocalFile } from '@/stores/pdmStore'
import { usePDMStore } from '@/stores/pdmStore'
import {
  executeCommand,
  getSyncedFilesFromSelection,
  getGhostFilesFromSelection,
  getCloudOnlyFilesFromSelection,
} from '@/lib/commands'
import { getOutdatedFilesFromSelection } from '@/lib/commands/handlers/getLatest'
import { checkOperationPermission, getPermissionRequirement } from '@/lib/permissions'
import { SW_EXTENSIONS, ASSEMBLY_EXTENSIONS } from '../constants'
import type { DialogName } from '../types'

interface PDMItemsProps {
  files: LocalFile[]
  contextFiles: LocalFile[]
  syncedFilesInSelection: LocalFile[]
  unsyncedFilesInSelection: LocalFile[]
  anySynced: boolean
  anyUnsynced: boolean
  anyCloudOnly: boolean
  allCloudOnly: boolean
  allCheckedOut: boolean
  allCheckedIn: boolean
  checkoutableCount: number
  checkinableCount: number
  discardableCount: number
  allFolders: boolean
  multiSelect: boolean
  countLabel: string
  cloudOnlyCount: number
  userId: string | undefined
  checkForDifferentMachineCheckout: (files: LocalFile[]) => Promise<boolean>
  openDialog: (name: DialogName) => void
  setMatchGhostFile: (file: LocalFile | null) => void
  setMatchGhostCandidates: (files: LocalFile[]) => void
  onClose: () => void
  onRefresh: (silent?: boolean) => void
}

export function PDMItems({
  files,
  contextFiles,
  syncedFilesInSelection,
  unsyncedFilesInSelection,
  anySynced,
  anyUnsynced,
  anyCloudOnly,
  allCloudOnly,
  allCheckedOut,
  allCheckedIn,
  checkoutableCount,
  checkinableCount,
  discardableCount,
  allFolders,
  multiSelect,
  countLabel,
  cloudOnlyCount,
  userId,
  checkForDifferentMachineCheckout,
  openDialog,
  setMatchGhostFile,
  setMatchGhostCandidates,
  onClose,
  onRefresh,
}: PDMItemsProps) {
  const { hasPermission, addToast } = usePDMStore()

  // Permission checks for operations
  const canCheckout = checkOperationPermission('checkout', hasPermission)
  const canCheckin = checkOperationPermission('checkin', hasPermission)
  const canSync = checkOperationPermission('sync', hasPermission)
  const canDownload = checkOperationPermission('download', hasPermission)
  const canGetLatest = checkOperationPermission('get-latest', hasPermission)
  const canDiscard = checkOperationPermission('discard', hasPermission)
  const canSyncMetadata = checkOperationPermission('sync-metadata', hasPermission)
  const canExtractRefs = checkOperationPermission('extract-references', hasPermission)

  // Cloud-only files drive the Download item; outdated files drive the Get Latest item below.
  // The two sets never overlap - each file is either 'cloud' or 'outdated', never both.
  const cloudOnlyFilesInSelection = getCloudOnlyFilesFromSelection(files, contextFiles)
  const outdatedFilesInSelection = getOutdatedFilesFromSelection(files, contextFiles)
  const anyOutdated =
    outdatedFilesInSelection.length > 0 || contextFiles.some((f) => f.diffStatus === 'outdated')

  const handleCheckout = () => {
    if (!canCheckout.allowed) {
      addToast('error', canCheckout.reason || getPermissionRequirement('checkout'))
      return
    }
    onClose()
    executeCommand('checkout', { files: contextFiles }, { onRefresh })
  }

  const handleCheckin = async () => {
    if (!canCheckin.allowed) {
      addToast('error', canCheckin.reason || getPermissionRequirement('checkin'))
      return
    }
    // Get files that would be checked in
    const syncedFiles = getSyncedFilesFromSelection(files, contextFiles)
    const filesToCheckin = syncedFiles.filter((f) => f.pdmData?.checked_out_by === userId)

    // Check if any files are checked out on a different machine
    const hasDifferentMachineCheckout = await checkForDifferentMachineCheckout(filesToCheckin)
    if (hasDifferentMachineCheckout) return

    onClose()
    executeCommand('checkin', { files: contextFiles }, { onRefresh })
  }

  const handleFirstCheckin = () => {
    if (!canSync.allowed) {
      addToast('error', canSync.reason || getPermissionRequirement('sync'))
      return
    }
    onClose()
    executeCommand('sync', { files: contextFiles }, { onRefresh })
  }

  // Downloads cloud-only files. Never touches outdated files - see `handleGetLatest`.
  const handleDownload = () => {
    if (!canDownload.allowed) {
      addToast('error', canDownload.reason || getPermissionRequirement('download'))
      return
    }
    onClose()
    executeCommand('download', { files: cloudOnlyFilesInSelection }, { onRefresh })
  }

  // Updates outdated files to the latest server version. Never touches cloud-only files.
  const handleGetLatest = () => {
    if (!canGetLatest.allowed) {
      addToast('error', canGetLatest.reason || getPermissionRequirement('get-latest'))
      return
    }
    onClose()
    executeCommand('get-latest', { files: outdatedFilesInSelection }, { onRefresh })
  }

  const handleDiscardCheckout = () => {
    if (!canDiscard.allowed) {
      addToast('error', canDiscard.reason || getPermissionRequirement('discard'))
      return
    }
    onClose()
    executeCommand('discard', { files: contextFiles }, { onRefresh })
  }

  const handleSyncMetadata = () => {
    if (!canSyncMetadata.allowed) {
      addToast('error', canSyncMetadata.reason || getPermissionRequirement('sync-metadata'))
      return
    }
    onClose()
    executeCommand('sync-metadata', { files: contextFiles }, { onRefresh })
  }

  const handleExtractReferences = () => {
    if (!canExtractRefs.allowed) {
      addToast('error', canExtractRefs.reason || getPermissionRequirement('extract-references'))
      return
    }
    onClose()
    executeCommand('extract-references', { files: contextFiles }, { onRefresh })
  }

  const handleDownloadReferencedFiles = () => {
    if (!canDownload.allowed) {
      addToast('error', canDownload.reason || getPermissionRequirement('download'))
      return
    }
    const firstFile = contextFiles[0]
    if (!firstFile?.pdmData?.id) return
    onClose()
    executeCommand('bulk-download-assembly', {
      files: contextFiles,
      rootFileId: firstFile.pdmData.id,
    })
  }

  // Get SolidWorks files checked out by current user (sync-metadata requires checkout)
  const checkedOutSwFiles = syncedFilesInSelection.filter(
    (f) =>
      SW_EXTENSIONS.includes(f.extension.toLowerCase()) && f.pdmData?.checked_out_by === userId,
  )

  // Get synced assembly files (for BOM/reference extraction)
  const syncedAssemblyFiles = syncedFilesInSelection.filter((f) =>
    ASSEMBLY_EXTENSIONS.includes(f.extension.toLowerCase()),
  )

  // Single assembly file with database entry (for "Download Referenced Files")
  const isSingleAssembly =
    !multiSelect &&
    contextFiles.length === 1 &&
    ASSEMBLY_EXTENSIONS.includes(contextFiles[0].extension?.toLowerCase()) &&
    !!contextFiles[0].pdmData?.id

  // Determine disabled state and reason for each operation
  const checkoutDisabled = !canCheckout.allowed || !anySynced || allCheckedOut
  const checkoutReason = !canCheckout.allowed
    ? `Requires ${getPermissionRequirement('checkout')}`
    : !anySynced
      ? 'Download files first to enable checkout'
      : allCheckedOut
        ? 'Already checked out'
        : ''

  const checkinDisabled = !canCheckin.allowed || allCheckedIn || checkinableCount === 0
  const checkinReason = !canCheckin.allowed
    ? `Requires ${getPermissionRequirement('checkin')}`
    : allCheckedIn
      ? 'Already checked in'
      : checkinableCount === 0
        ? 'No files checked out by you'
        : ''

  const syncDisabled = !canSync.allowed
  const syncReason = !canSync.allowed ? `Requires ${getPermissionRequirement('sync')}` : ''

  const discardDisabled = !canDiscard.allowed
  const discardReason = !canDiscard.allowed ? `Requires ${getPermissionRequirement('discard')}` : ''

  // Ghost files: server records checked out by current user but missing locally
  const ghostFilesInSelection = getGhostFilesFromSelection(files, contextFiles, userId)
  const singleGhostFile = ghostFilesInSelection.length === 1 ? ghostFilesInSelection[0] : null

  const handleMatchGhostFile = () => {
    if (!singleGhostFile) return
    const ghostDir = singleGhostFile.relativePath
      .replace(/\\/g, '/')
      .split('/')
      .slice(0, -1)
      .join('/')
    const ghostExt = singleGhostFile.extension?.toLowerCase()
    const candidates = files.filter((f) => {
      if (f.isDirectory || f.diffStatus !== 'added') return false
      const fileDir = f.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
      return fileDir === ghostDir && f.extension?.toLowerCase() === ghostExt
    })
    setMatchGhostFile(singleGhostFile)
    setMatchGhostCandidates(candidates)
    openDialog('matchGhostFile')
  }

  return (
    <>
      {/* Download - for cloud-only files - show at TOP for cloud folders */}
      {anyCloudOnly && (
        <div
          className={`context-menu-item ${!canDownload.allowed ? 'disabled' : ''}`}
          onClick={handleDownload}
          title={!canDownload.allowed ? `Requires ${getPermissionRequirement('download')}` : ''}
        >
          <ArrowDown
            size={14}
            className={canDownload.allowed ? 'text-plm-success' : 'text-plm-fg-muted'}
          />
          Download {cloudOnlyCount > 0 ? `${cloudOnlyCount} files` : countLabel}
          {!canDownload.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}

      {/* Get Latest - for outdated files (never mixed with cloud-only Download above) */}
      {anyOutdated && (
        <div
          className={`context-menu-item ${!canGetLatest.allowed ? 'disabled' : ''}`}
          onClick={handleGetLatest}
          title={
            !canGetLatest.allowed ? `Requires ${getPermissionRequirement('get-latest')}` : ''
          }
        >
          <RefreshCw
            size={14}
            className={canGetLatest.allowed ? 'text-purple-400' : 'text-plm-fg-muted'}
          />
          {t('fileOps.getLatest', 'Get Latest')}{' '}
          {outdatedFilesInSelection.length > 0 ? `(${outdatedFilesInSelection.length})` : ''}
          {!canGetLatest.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}

      {/* Download Referenced Files - for single assembly files */}
      {isSingleAssembly && (
        <div
          className={`context-menu-item ${!canDownload.allowed ? 'disabled' : ''}`}
          onClick={handleDownloadReferencedFiles}
          title={
            !canDownload.allowed
              ? `Requires ${getPermissionRequirement('download')}`
              : 'Download this assembly and all its referenced parts, sub-assemblies, and drawings'
          }
        >
          <Package2
            size={14}
            className={canDownload.allowed ? 'text-plm-success' : 'text-plm-fg-muted'}
          />
          Download Referenced Files
          {!canDownload.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}

      <div className="context-menu-separator" />

      {/* First Check In - for unsynced files */}
      {anyUnsynced && !allCloudOnly && (
        <div
          className={`context-menu-item ${syncDisabled ? 'disabled' : ''}`}
          onClick={handleFirstCheckin}
          title={syncReason}
        >
          <ArrowUp size={14} className={syncDisabled ? 'text-plm-fg-muted' : 'text-plm-info'} />
          First Check In{' '}
          {unsyncedFilesInSelection.length > 0
            ? `${unsyncedFilesInSelection.length} file${unsyncedFilesInSelection.length !== 1 ? 's' : ''}`
            : countLabel}
          {!canSync.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}

      {/* Check Out */}
      <div
        className={`context-menu-item ${checkoutDisabled ? 'disabled' : ''}`}
        onClick={() => {
          if (checkoutDisabled) return
          handleCheckout()
        }}
        title={checkoutReason}
      >
        <ArrowDown
          size={14}
          className={checkoutDisabled ? 'text-plm-fg-muted' : 'text-plm-warning'}
        />
        Check Out{' '}
        {allFolders && !multiSelect && checkoutableCount > 0
          ? `${checkoutableCount} files`
          : countLabel}
        {!canCheckout.allowed && (
          <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
        )}
        {canCheckout.allowed && !anySynced && (
          <span className="text-xs text-plm-fg-muted ml-auto">(download first)</span>
        )}
        {canCheckout.allowed && anySynced && allCheckedOut && (
          <span className="text-xs text-plm-fg-muted ml-auto">(already out)</span>
        )}
      </div>

      {/* Check In - only for synced files that exist locally (not 'deleted') */}
      {anySynced && (
        <div
          className={`context-menu-item ${checkinDisabled ? 'disabled' : ''}`}
          onClick={() => {
            if (checkinDisabled) return
            handleCheckin()
          }}
          title={checkinReason}
        >
          <ArrowUp
            size={14}
            className={checkinDisabled ? 'text-plm-fg-muted' : 'text-plm-success'}
          />
          Check In{' '}
          {allFolders && !multiSelect && checkinableCount > 0
            ? `${checkinableCount} files`
            : countLabel}
          {!canCheckin.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
          {canCheckin.allowed && allCheckedIn && (
            <span className="text-xs text-plm-fg-muted ml-auto">(already in)</span>
          )}
        </div>
      )}

      {/* Discard Checkout - for files checked out by current user */}
      {discardableCount > 0 && (
        <div
          className={`context-menu-item ${discardDisabled ? '' : 'text-plm-warning'} ${discardDisabled ? 'disabled' : ''}`}
          onClick={handleDiscardCheckout}
          title={
            discardDisabled ? discardReason : 'Discard local changes and revert to server version'
          }
        >
          <Undo2 size={14} />
          Discard Checkout {discardableCount > 1 ? `(${discardableCount})` : ''}
          {!canDiscard.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}

      {/* Match Ghost File - for single ghost file (deleted, checked out by me) */}
      {singleGhostFile && (
        <div
          className="context-menu-item text-plm-info"
          onClick={handleMatchGhostFile}
          title="Match this missing server file to a renamed local file"
        >
          <FileSearch size={14} />
          Match to Local File...
        </div>
      )}

      {/* Sync Metadata - for SW files checked out by current user */}
      {checkedOutSwFiles.length > 0 && (
        <div
          className={`context-menu-item ${!canSyncMetadata.allowed ? 'disabled' : ''}`}
          onClick={handleSyncMetadata}
          title={
            !canSyncMetadata.allowed
              ? `Requires ${getPermissionRequirement('sync-metadata')}`
              : 'Sync metadata between BluePLM and SolidWorks files'
          }
        >
          <RefreshCw
            size={14}
            className={canSyncMetadata.allowed ? 'text-plm-accent' : 'text-plm-fg-muted'}
          />
          Sync Metadata {checkedOutSwFiles.length > 1 ? `(${checkedOutSwFiles.length} files)` : ''}
          {!canSyncMetadata.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}

      {/* Extract Assembly References - for synced assembly files */}
      {syncedAssemblyFiles.length > 0 && (
        <div
          className={`context-menu-item ${!canExtractRefs.allowed ? 'disabled' : ''}`}
          onClick={handleExtractReferences}
          title={
            !canExtractRefs.allowed
              ? `Requires ${getPermissionRequirement('extract-references')}`
              : 'Extract and store assembly component references to enable Contains/Where-Used queries'
          }
        >
          <Network
            size={14}
            className={canExtractRefs.allowed ? 'text-plm-accent' : 'text-plm-fg-muted'}
          />
          Extract References{' '}
          {syncedAssemblyFiles.length > 1 ? `(${syncedAssemblyFiles.length} assemblies)` : ''}
          {!canExtractRefs.allowed && (
            <span className="text-xs text-plm-fg-muted ml-auto">(no permission)</span>
          )}
        </div>
      )}
    </>
  )
}
