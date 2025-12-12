import { usePDMStore } from '../stores/pdmStore'
import { ExplorerView } from './sidebar/ExplorerView'
import { PendingView } from './sidebar/PendingView'
import { HistoryView } from './sidebar/HistoryView'
import { SearchView } from './sidebar/SearchView'
import { TrashView } from './sidebar/TrashView'
import { SettingsView } from './sidebar/SettingsView'
import { TerminalView } from './sidebar/TerminalView'
import { WorkflowsView } from './sidebar/WorkflowsView'
import { ECOView } from './sidebar/ECOView'
import { ReviewsView } from './sidebar/ReviewsView'
import { GoogleDriveView } from './sidebar/GoogleDriveView'

interface SidebarProps {
  onOpenVault: () => void
  onOpenRecentVault: (path: string) => void
  onRefresh: (silent?: boolean) => void
}

export function Sidebar({ onOpenVault, onOpenRecentVault, onRefresh }: SidebarProps) {
  const { activeView, sidebarWidth, connectedVaults, setGdriveNavigation, gdriveCurrentFolderId } = usePDMStore()

  const handleGdriveNavigate = (folderId: string | null, folderName?: string, isSharedDrive?: boolean, driveId?: string) => {
    setGdriveNavigation(folderId, folderName, isSharedDrive, driveId)
  }

  const renderView = () => {
    switch (activeView) {
      case 'explorer':
        return <ExplorerView onOpenVault={onOpenVault} onOpenRecentVault={onOpenRecentVault} onRefresh={onRefresh} />
      case 'pending':
        return <PendingView onRefresh={onRefresh} />
      case 'history':
        return <HistoryView />
      case 'eco':
        return <ECOView />
      case 'reviews':
        return <ReviewsView />
      case 'search':
        return <SearchView />
      case 'trash':
        return <TrashView />
      case 'settings':
        return <SettingsView />
      case 'terminal':
        return <TerminalView onRefresh={onRefresh} />
      case 'workflows':
        return <WorkflowsView />
      case 'google-drive':
        return <GoogleDriveView onNavigate={handleGdriveNavigate} currentFolderId={gdriveCurrentFolderId} />
      default:
        return <ExplorerView onOpenVault={onOpenVault} onOpenRecentVault={onOpenRecentVault} />
    }
  }

  const getTitle = () => {
    switch (activeView) {
      case 'explorer':
        return 'EXPLORER'
      case 'pending':
        return 'PENDING'
      case 'history':
        return 'HISTORY'
      case 'eco':
        return 'ECO MANAGER'
      case 'reviews':
        return 'REVIEWS'
      case 'search':
        return 'SEARCH'
      case 'trash':
        return 'TRASH'
      case 'settings':
        return 'SETTINGS'
      case 'terminal':
        return 'TERMINAL'
      case 'workflows':
        return 'WORKFLOWS'
      case 'google-drive':
        return 'GOOGLE DRIVE'
      default:
        return ''
    }
  }

  return (
    <div
      className="bg-pdm-sidebar flex flex-col overflow-hidden"
      style={{ width: sidebarWidth }}
    >
      <div className="h-9 flex items-center justify-between px-4 text-[11px] font-semibold text-pdm-fg-dim tracking-wide border-b border-pdm-border">
        <span>{getTitle()}</span>
        {activeView === 'explorer' && connectedVaults.length > 0 && (
          <span className="text-pdm-fg-muted font-normal">
            {connectedVaults.length} vault{connectedVaults.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {renderView()}
      </div>
    </div>
  )
}
