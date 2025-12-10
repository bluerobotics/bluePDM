import { usePDMStore } from '../stores/pdmStore'
import { Cloud, CloudOff, Building2 } from 'lucide-react'
import { useEffect, useState } from 'react'

export function StatusBar() {
  const { 
    vaultPath, 
    isVaultConnected, 
    connectedVaults,
    statusMessage,
    isLoading,
    user,
    organization,
    vaultName
  } = usePDMStore()
  
  const [appVersion, setAppVersion] = useState('')
  
  useEffect(() => {
    window.electronAPI?.getVersion().then(v => setAppVersion(v))
  }, [])

  // Check if any vault is connected (legacy or multi-vault)
  const hasVaultConnected = isVaultConnected || connectedVaults.length > 0
  
  // Get display name from connected vaults or legacy
  const displayName = connectedVaults.length > 0 
    ? (connectedVaults.length === 1 ? connectedVaults[0].name : `${connectedVaults.length} vaults`)
    : (vaultName || vaultPath?.split(/[/\\]/).pop() || 'vault')

  // Show minimal status bar when no vault connected (splash screens)
  if (!hasVaultConnected) {
    return (
      <div className="bg-pdm-activitybar border-t border-pdm-border flex items-center justify-end px-3 py-[2px] text-xs text-pdm-fg-dim select-none flex-shrink-0">
        <span className="text-pdm-fg-muted">v{appVersion || '...'}</span>
      </div>
    )
  }

  return (
    <div className="bg-pdm-activitybar border-t border-pdm-border flex items-center justify-between px-3 py-[2px] text-xs text-pdm-fg-dim select-none flex-shrink-0">
      <div className="flex items-center gap-4 flex-1 min-w-0">
        {/* Vault status */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Cloud size={12} className="text-pdm-success" />
          <span className="text-pdm-fg-dim">
            Connected to {displayName}
          </span>
        </div>

        {/* Status message */}
        {statusMessage && (
          <span className={`truncate ${isLoading ? 'animate-pulse' : ''}`}>
            {statusMessage}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 flex-shrink-0">
        {/* Organization status */}
        <div className="flex items-center gap-1.5">
          {user ? (
            <>
              <Building2 size={12} className="text-pdm-success" />
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
