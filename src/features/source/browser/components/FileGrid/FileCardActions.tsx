import { Cloud, HardDrive, ArrowDown, ArrowUp, Loader2 } from 'lucide-react'
import type { LocalFile } from '@/stores/pdmStore'
import type { OperationType } from '@/stores/types'
import { InlineCheckinButton, FolderCheckinButton } from '@/components/shared/InlineActions'
import type { FolderCheckoutInfo } from './hooks/useFileCardStatus'

export interface FileCardActionsProps {
  file: LocalFile
  operationType: OperationType | null
  cloudFilesCount: number
  folderCheckoutInfo: FolderCheckoutInfo | null
  buttonIconSize: number
  spacing: number
  userId: string | undefined
  userAvatarUrl: string | undefined
  userFullName: string | undefined
  userEmail: string | undefined
  onDownload?: (e: React.MouseEvent, file: LocalFile) => void
  onCheckout?: (e: React.MouseEvent, file: LocalFile) => void
  onCheckin?: (e: React.MouseEvent, file: LocalFile) => void
  onUpload?: (e: React.MouseEvent, file: LocalFile) => void
}

/**
 * Action buttons for file cards (download, checkout, checkin, upload)
 * Each button shows independently - only the active operation shows a spinner
 */
export function FileCardActions({
  file,
  operationType,
  cloudFilesCount,
  folderCheckoutInfo,
  buttonIconSize,
  spacing,
  userId,
  userAvatarUrl,
  userFullName,
  userEmail,
  onDownload,
  onCheckout,
  onCheckin,
  onUpload,
}: FileCardActionsProps) {
  const isDownloading = operationType === 'download'
  const isCheckingOut = operationType === 'checkout'
  const isCheckingIn = operationType === 'checkin'
  const isUploading = operationType === 'upload'
  const isSyncing = operationType === 'sync'
  const isDeleting = operationType === 'delete'

  return (
    <div className="absolute top-1 left-1 flex items-center z-10" style={{ gap: spacing }}>
      {/* Delete spinner */}
      {isDeleting && <Loader2 size={16} className="text-red-400 animate-spin" />}

      {/* Download for cloud files */}
      {!isDeleting &&
        file.diffStatus === 'cloud' &&
        !file.isDirectory &&
        onDownload &&
        (isDownloading ? (
          <Loader2 size={16} className="text-sky-400 animate-spin" />
        ) : (
          <button
            className="group/download flex items-center gap-px p-0.5 rounded hover:bg-plm-info/30 transition-colors cursor-pointer"
            onClick={(e) => onDownload(e, file)}
            title="Download"
          >
            <Cloud
              size={buttonIconSize}
              className="text-plm-info group-hover/download:text-plm-info transition-colors duration-200"
            />
            <ArrowDown
              size={buttonIconSize}
              className="text-plm-info opacity-0 group-hover/download:opacity-100 -ml-1 group-hover/download:ml-0 transition-all duration-200"
            />
          </button>
        ))}

      {/* Folder download button */}
      {!isDeleting &&
        file.isDirectory &&
        (cloudFilesCount > 0 || file.diffStatus === 'cloud') &&
        onDownload &&
        (isDownloading || isSyncing ? (
          <Loader2 size={16} className="text-sky-400 animate-spin" />
        ) : (
          <button
            className="group/folderdownload flex items-center gap-px p-0.5 rounded hover:bg-plm-info/30 transition-colors cursor-pointer"
            onClick={(e) => onDownload(e, file)}
            title={
              cloudFilesCount > 0 ? `Download ${cloudFilesCount} files` : 'Create folder locally'
            }
          >
            <Cloud size={buttonIconSize} className="text-plm-info" />
            {cloudFilesCount > 0 && (
              <span className="text-[10px] font-medium text-plm-info opacity-0 group-hover/folderdownload:opacity-100 transition-opacity">
                {cloudFilesCount}
              </span>
            )}
            <ArrowDown
              size={buttonIconSize}
              className="text-plm-info opacity-0 group-hover/folderdownload:opacity-100 transition-opacity"
            />
          </button>
        ))}

      {/* File check-in button. Excludes 'moved_away': the stub carries the real file's
          checkout state, but there is nothing at the stub's own path to check in. */}
      {!isDeleting &&
        !file.isDirectory &&
        file.pdmData?.checked_out_by === userId &&
        file.diffStatus !== 'deleted' &&
        file.diffStatus !== 'moved_away' &&
        onCheckin && (
          <InlineCheckinButton
            onClick={(e) => onCheckin(e, file)}
            isProcessing={isCheckingIn}
            userAvatarUrl={userAvatarUrl}
            userFullName={userFullName}
            userEmail={userEmail}
            title={isCheckingIn ? 'Checking in...' : 'Click to check in'}
          />
        )}

      {/* Folder check-in button */}
      {!isDeleting &&
        file.isDirectory &&
        folderCheckoutInfo &&
        folderCheckoutInfo.checkedOutByMe > 0 &&
        onCheckin && (
          <FolderCheckinButton
            onClick={(e) => onCheckin(e, file)}
            isProcessing={isCheckingIn}
            users={[
              {
                id: userId || '',
                name: userFullName || userEmail || '',
                avatar_url: userAvatarUrl,
                isMe: true,
                count: folderCheckoutInfo.checkedOutByMe,
              },
            ]}
            myCheckedOutCount={folderCheckoutInfo.checkedOutByMe}
            totalCheckouts={folderCheckoutInfo.checkedOutByMe}
            title={
              isCheckingIn
                ? 'Checking in...'
                : `Click to check in ${folderCheckoutInfo.checkedOutByMe} file${folderCheckoutInfo.checkedOutByMe > 1 ? 's' : ''}`
            }
          />
        )}

      {/* File checkout button. Excludes 'moved_away': the stub carries the real file's
          pdmData, but there is nothing at the stub's own path to check out. */}
      {!isDeleting &&
        !file.isDirectory &&
        file.pdmData &&
        !file.pdmData.checked_out_by &&
        file.diffStatus !== 'cloud' &&
        file.diffStatus !== 'deleted' &&
        file.diffStatus !== 'moved_away' &&
        onCheckout &&
        (isCheckingOut ? (
          <Loader2 size={16} className="text-sky-400 animate-spin" />
        ) : (
          <button
            className="group/checkout flex items-center gap-px p-0.5 rounded hover:bg-plm-warning/20 transition-colors cursor-pointer"
            title="Click to check out"
            onClick={(e) => onCheckout(e, file)}
          >
            <Cloud
              size={buttonIconSize}
              className="text-plm-success group-hover/checkout:text-plm-warning transition-colors duration-200"
            />
            <ArrowDown
              size={buttonIconSize}
              className="text-plm-warning opacity-0 group-hover/checkout:opacity-100 transition-opacity"
            />
          </button>
        ))}

      {/* File upload button */}
      {!isDeleting &&
        !file.isDirectory &&
        !file.pdmData &&
        file.diffStatus !== 'cloud' &&
        file.diffStatus !== 'ignored' &&
        onUpload &&
        (isUploading ? (
          <Loader2 size={16} className="text-sky-400 animate-spin" />
        ) : (
          <button
            className="group/fileupload flex items-center gap-px p-0.5 rounded hover:bg-plm-info/30 transition-colors cursor-pointer"
            title="First Check In"
            onClick={(e) => onUpload(e, file)}
          >
            <HardDrive
              size={buttonIconSize}
              className="text-plm-fg-muted group-hover/fileupload:text-plm-info transition-colors duration-200"
            />
            <ArrowUp
              size={buttonIconSize}
              className="text-plm-info opacity-0 group-hover/fileupload:opacity-100 transition-opacity"
            />
          </button>
        ))}
    </div>
  )
}
