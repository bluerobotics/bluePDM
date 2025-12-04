import { usePDMStore } from '../stores/pdmStore'
import { Cloud, CloudOff, Wifi, WifiOff, Lock } from 'lucide-react'

export function StatusBar() {
  const { 
    vaultPath, 
    isVaultConnected, 
    files, 
    selectedFiles,
    statusMessage,
    isLoading,
    user,
    organization
  } = usePDMStore()

  const fileCount = files.filter(f => !f.isDirectory).length
  const folderCount = files.filter(f => f.isDirectory).length
  const checkedOutCount = files.filter(f => f.pdmData?.checked_out_by).length
  const syncedCount = files.filter(f => !f.isDirectory && f.pdmData).length

  return (
    <div className="h-6 bg-pdm-activitybar border-t border-pdm-border flex items-center justify-between px-3 text-xs text-pdm-fg-dim select-none flex-shrink-0">
      <div className="flex items-center gap-4">
        {/* Vault status */}
        <div className="flex items-center gap-1.5">
          {isVaultConnected ? (
            <>
              <Wifi size={12} className="text-pdm-success" />
              <span className="text-pdm-fg-dim">
                {vaultPath?.split(/[/\\]/).pop()}
              </span>
            </>
          ) : (
            <>
              <WifiOff size={12} className="text-pdm-fg-muted" />
              <span>No vault</span>
            </>
          )}
        </div>

        {/* Checked out status */}
        {isVaultConnected && checkedOutCount > 0 && (
          <div className="flex items-center gap-1.5 text-pdm-warning">
            <Lock size={12} />
            <span>{checkedOutCount} checked out</span>
          </div>
        )}

        {/* Status message */}
        {statusMessage && (
          <span className={isLoading ? 'animate-pulse' : ''}>
            {statusMessage}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {/* File count */}
        {isVaultConnected && (
          <span>
            {fileCount} files, {folderCount} folders
            {syncedCount > 0 && ` • ${syncedCount} synced`}
            {selectedFiles.length > 0 && ` • ${selectedFiles.length} selected`}
          </span>
        )}

        {/* Cloud status */}
        <div className="flex items-center gap-1.5">
          {user ? (
            <>
              <Cloud size={12} className="text-pdm-success" />
              <span>{organization?.name || user.email}</span>
            </>
          ) : (
            <>
              <CloudOff size={12} className="text-pdm-fg-muted" />
              <span>Offline</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
