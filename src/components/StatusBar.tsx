import { useState } from 'react'
import { usePDMStore } from '../stores/pdmStore'
import { Cloud, CloudOff, Wifi, WifiOff, Lock, X, AlertTriangle } from 'lucide-react'

export function StatusBar() {
  const { 
    vaultPath, 
    isVaultConnected, 
    connectedVaults,
    files, 
    selectedFiles,
    statusMessage,
    isLoading,
    user,
    organization,
    syncProgress,
    requestCancelSync,
    vaultName
  } = usePDMStore()

  const [showCancelDialog, setShowCancelDialog] = useState(false)
  
  // Check if any vault is connected (legacy or multi-vault)
  const hasVaultConnected = isVaultConnected || connectedVaults.length > 0
  
  // Get display name from connected vaults or legacy
  const displayName = connectedVaults.length > 0 
    ? (connectedVaults.length === 1 ? connectedVaults[0].name : `${connectedVaults.length} vaults`)
    : (vaultName || vaultPath?.split(/[/\\]/).pop() || 'vault')

  const fileCount = files.filter(f => !f.isDirectory).length
  const folderCount = files.filter(f => f.isDirectory).length
  const checkedOutCount = files.filter(f => f.pdmData?.checked_out_by).length
  const syncedCount = files.filter(f => !f.isDirectory && f.pdmData).length

  const handleStopClick = () => {
    setShowCancelDialog(true)
  }

  const handleCancelConfirm = (keepFiles: boolean) => {
    // Store the choice in a way the sync loop can access
    requestCancelSync()
    // The sync loop will handle cleanup based on keepFiles
    // For now we just signal cancellation - the actual cleanup happens in FileBrowser
    setShowCancelDialog(false)
  }

  return (
    <>
      <div className="bg-pdm-activitybar border-t border-pdm-border flex items-center justify-between px-3 py-[2px] text-xs text-pdm-fg-dim select-none flex-shrink-0">
        <div className="flex items-center gap-4 flex-1 min-w-0">
          {/* Vault status */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {hasVaultConnected ? (
              <>
                <Wifi size={12} className="text-pdm-success" />
                <span className="text-pdm-fg-dim">
                  Connected to {displayName}
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
          {hasVaultConnected && checkedOutCount > 0 && (
            <div className="flex items-center gap-1.5 text-pdm-warning flex-shrink-0">
              <Lock size={12} />
              <span>{checkedOutCount} checked out</span>
            </div>
          )}

          {/* Sync Progress Bar */}
          {syncProgress.isActive && (
            <div className="flex items-center gap-2 flex-1 min-w-0 max-w-md">
              <div className="flex-1 h-2 bg-pdm-bg-dark rounded-full overflow-hidden min-w-[100px]">
                <div 
                  className="h-full bg-pdm-accent transition-all duration-200 ease-out"
                  style={{ width: `${syncProgress.percent}%` }}
                />
              </div>
              <span className="flex-shrink-0 tabular-nums">
                {syncProgress.current}/{syncProgress.total}
              </span>
              {syncProgress.speed && (
                <span className="flex-shrink-0 text-pdm-fg-muted">
                  {syncProgress.speed}
                </span>
              )}
              <button
                onClick={handleStopClick}
                className="flex-shrink-0 p-0.5 hover:bg-pdm-error/20 rounded transition-colors"
                title="Stop sync"
              >
                <X size={14} className="text-pdm-error" />
              </button>
            </div>
          )}

          {/* Status message (when not syncing) */}
          {!syncProgress.isActive && statusMessage && (
            <span className={`truncate ${isLoading ? 'animate-pulse' : ''}`}>
              {statusMessage}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4 flex-shrink-0">
          {/* File count */}
          {hasVaultConnected && (
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

      {/* Cancel Sync Dialog */}
      {showCancelDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-pdm-panel border border-pdm-border rounded-lg shadow-xl max-w-md w-full mx-4">
            <div className="p-4 border-b border-pdm-border flex items-center gap-3">
              <AlertTriangle size={20} className="text-pdm-warning" />
              <h3 className="font-semibold">
                Stop {syncProgress.operation === 'download' ? 'Download' : 'Sync'}?
              </h3>
            </div>
            <div className="p-4">
              {syncProgress.operation === 'download' ? (
                // Download: simple stop, keep what's downloaded
                <>
                  <p className="text-sm text-pdm-fg-dim mb-4">
                    {syncProgress.current} of {syncProgress.total} files have been downloaded.
                    Already downloaded files will be kept.
                  </p>
                  <button
                    onClick={() => handleCancelConfirm(true)}
                    className="btn btn-secondary w-full justify-start"
                  >
                    <X size={16} className="text-pdm-warning" />
                    Stop Download
                  </button>
                </>
              ) : (
                // Upload: offer keep or discard options
                <>
                  <p className="text-sm text-pdm-fg-dim mb-4">
                    {syncProgress.current} of {syncProgress.total} files have been uploaded. 
                    What would you like to do with the already uploaded files?
                  </p>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => handleCancelConfirm(true)}
                      className="btn btn-secondary w-full justify-start"
                    >
                      <Cloud size={16} className="text-pdm-success" />
                      Keep uploaded files on server
                    </button>
                    <button
                      onClick={() => handleCancelConfirm(false)}
                      className="btn btn-secondary w-full justify-start text-pdm-error"
                    >
                      <X size={16} />
                      Delete uploaded files from server
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="p-4 border-t border-pdm-border flex justify-end">
              <button
                onClick={() => setShowCancelDialog(false)}
                className="btn btn-ghost"
              >
                Continue {syncProgress.operation === 'download' ? 'Downloading' : 'Syncing'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
