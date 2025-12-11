import { useState, useEffect } from 'react'
import { 
  User, 
  Building2, 
  FolderCog, 
  ChevronRight,
  Users,
  Mail,
  Shield,
  LogOut,
  Loader2,
  Settings,
  Image,
  ExternalLink,
  RefreshCw,
  Download,
  CheckCircle
} from 'lucide-react'
import { usePDMStore } from '../../stores/pdmStore'
import { supabase, signOut } from '../../lib/supabase'
import { getInitials } from '../../types/pdm'

type SettingsTab = 'account' | 'vault' | 'organization' | 'preferences'

interface OrgUser {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  role: string
  last_sign_in: string | null
}

export function SettingsView() {
  const { 
    user, 
    organization, 
    vaultPath, 
    vaultName, 
    setVaultName,
    setUser,
    setOrganization,
    cadPreviewMode,
    setCadPreviewMode
  } = usePDMStore()
  
  const [activeTab, setActiveTab] = useState<SettingsTab>('account')
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([])
  const [isLoadingUsers, setIsLoadingUsers] = useState(false)
  const [editingVaultName, setEditingVaultName] = useState(false)
  const [vaultNameInput, setVaultNameInput] = useState('')
  const [appVersion, setAppVersion] = useState<string>('')
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [updateCheckResult, setUpdateCheckResult] = useState<'none' | 'available' | 'error' | null>(null)
  
  const displayName = vaultName || vaultPath?.split(/[/\\]/).pop() || 'vault'
  
  // Load org users when organization tab is selected
  useEffect(() => {
    if (activeTab === 'organization' && organization) {
      loadOrgUsers()
    }
  }, [activeTab, organization])
  
  // Get app version on mount
  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.getVersion().then(setAppVersion)
    }
  }, [])
  
  // Handle manual update check
  const handleCheckForUpdates = async () => {
    if (!window.electronAPI || isCheckingUpdate) return
    
    setIsCheckingUpdate(true)
    setUpdateCheckResult(null)
    
    try {
      const result = await window.electronAPI.checkForUpdates()
      if (result.success && result.updateInfo) {
        setUpdateCheckResult('available')
      } else if (result.success) {
        setUpdateCheckResult('none')
      } else {
        setUpdateCheckResult('error')
      }
    } catch (err) {
      console.error('Update check error:', err)
      setUpdateCheckResult('error')
    } finally {
      setIsCheckingUpdate(false)
      // Clear result after 5 seconds
      setTimeout(() => setUpdateCheckResult(null), 5000)
    }
  }
  
  const loadOrgUsers = async () => {
    if (!organization) return
    
    setIsLoadingUsers(true)
    try {
      const { data, error } = await supabase
        .from('users')
        .select('id, email, full_name, avatar_url, role, last_sign_in')
        .eq('org_id', organization.id)
        .order('full_name')
      
      if (error) {
        console.error('Failed to load org users:', error)
      } else {
        setOrgUsers(data || [])
      }
    } catch (err) {
      console.error('Failed to load org users:', err)
    } finally {
      setIsLoadingUsers(false)
    }
  }
  
  const handleSignOut = async () => {
    await signOut()
    setUser(null)
    setOrganization(null)
  }
  
  const handleSaveVaultName = () => {
    if (vaultNameInput.trim()) {
      setVaultName(vaultNameInput.trim())
    }
    setEditingVaultName(false)
  }
  
  const tabs = [
    { id: 'account' as SettingsTab, icon: User, label: 'Account' },
    { id: 'vault' as SettingsTab, icon: FolderCog, label: 'Vault' },
    { id: 'organization' as SettingsTab, icon: Building2, label: 'Organization' },
    { id: 'preferences' as SettingsTab, icon: Settings, label: 'Preferences' },
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-pdm-border">
        <h2 className="text-sm font-semibold text-pdm-fg">Settings</h2>
      </div>
      
      {/* Tabs */}
      <div className="flex flex-col border-b border-pdm-border">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
              activeTab === tab.id
                ? 'bg-pdm-highlight text-pdm-fg border-l-2 border-pdm-accent'
                : 'text-pdm-fg-muted hover:text-pdm-fg hover:bg-pdm-highlight/50'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
            <ChevronRight size={14} className="ml-auto opacity-50" />
          </button>
        ))}
      </div>
      
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'account' && (
          <div className="space-y-4">
            {user ? (
              <>
                {/* User profile */}
                <div className="flex items-center gap-3 p-3 bg-pdm-bg rounded-lg border border-pdm-border">
                  {user.avatar_url ? (
                    <>
                      <img 
                        src={user.avatar_url} 
                        alt={user.full_name || user.email}
                        className="w-12 h-12 rounded-full"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement
                          target.style.display = 'none'
                          target.nextElementSibling?.classList.remove('hidden')
                        }}
                      />
                      <div className="w-12 h-12 rounded-full bg-pdm-accent flex items-center justify-center text-lg text-white font-semibold hidden">
                        {getInitials(user.full_name || user.email)}
                      </div>
                    </>
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-pdm-accent flex items-center justify-center text-lg text-white font-semibold">
                      {getInitials(user.full_name || user.email)}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-pdm-fg truncate">
                      {user.full_name || 'No name'}
                    </div>
                    <div className="text-xs text-pdm-fg-muted truncate flex items-center gap-1">
                      <Mail size={12} />
                      {user.email}
                    </div>
                  </div>
                </div>
                
                {/* Sign out */}
                <button
                  onClick={handleSignOut}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-pdm-error hover:bg-pdm-error/10 rounded-lg transition-colors"
                >
                  <LogOut size={16} />
                  Sign Out
                </button>
              </>
            ) : (
              <div className="text-center py-8 text-pdm-fg-muted text-sm">
                Not signed in
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'vault' && (
          <div className="space-y-4">
            {vaultPath ? (
              <>
                {/* Vault name */}
                <div className="space-y-2">
                  <label className="text-xs text-pdm-fg-muted uppercase tracking-wide">
                    Vault Name
                  </label>
                  {editingVaultName ? (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={vaultNameInput}
                        onChange={(e) => setVaultNameInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveVaultName()
                          if (e.key === 'Escape') setEditingVaultName(false)
                        }}
                        className="flex-1 bg-pdm-bg border border-pdm-border rounded px-2 py-1 text-sm"
                        autoFocus
                      />
                      <button
                        onClick={handleSaveVaultName}
                        className="btn btn-primary btn-sm"
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <div 
                      className="p-2 bg-pdm-bg rounded border border-pdm-border cursor-pointer hover:border-pdm-accent transition-colors"
                      onClick={() => {
                        setVaultNameInput(displayName)
                        setEditingVaultName(true)
                      }}
                    >
                      <span className="text-sm text-pdm-fg">{displayName}</span>
                    </div>
                  )}
                </div>
                
                {/* Vault path */}
                <div className="space-y-2">
                  <label className="text-xs text-pdm-fg-muted uppercase tracking-wide">
                    Vault Path
                  </label>
                  <div className="p-2 bg-pdm-bg rounded border border-pdm-border">
                    <span className="text-sm text-pdm-fg-dim font-mono break-all">
                      {vaultPath}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center py-8 text-pdm-fg-muted text-sm">
                No vault connected
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'organization' && (
          <div className="space-y-4">
            {organization ? (
              <>
                {/* Org info */}
                <div className="p-3 bg-pdm-bg rounded-lg border border-pdm-border">
                  <div className="flex items-center gap-2 mb-2">
                    <Building2 size={16} className="text-pdm-accent" />
                    <span className="font-medium text-pdm-fg">{organization.name}</span>
                  </div>
                  <div className="text-xs text-pdm-fg-muted">
                    {organization.email_domains?.join(', ')}
                  </div>
                </div>
                
                {/* Users */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-pdm-fg-muted uppercase tracking-wide">
                    <Users size={14} />
                    Members ({orgUsers.length})
                  </div>
                  
                  {isLoadingUsers ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="animate-spin text-pdm-fg-muted" size={20} />
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {orgUsers.map(orgUser => (
                        <div 
                          key={orgUser.id}
                          className="flex items-center gap-2 p-2 rounded hover:bg-pdm-highlight transition-colors"
                        >
                          {orgUser.avatar_url ? (
                            <img 
                              src={orgUser.avatar_url} 
                              alt={orgUser.full_name || orgUser.email}
                              className="w-8 h-8 rounded-full"
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-pdm-fg-muted/20 flex items-center justify-center text-xs font-medium">
                              {(orgUser.full_name || orgUser.email)[0].toUpperCase()}
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-pdm-fg truncate">
                              {orgUser.full_name || orgUser.email}
                            </div>
                            <div className="text-xs text-pdm-fg-muted truncate">
                              {orgUser.email}
                            </div>
                          </div>
                          {orgUser.role === 'admin' && (
                            <span title="Admin"><Shield size={14} className="text-pdm-accent flex-shrink-0" /></span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="text-center py-8 text-pdm-fg-muted text-sm">
                No organization connected
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'preferences' && (
          <div className="space-y-4">
            {/* App Updates */}
            <div className="space-y-2">
              <label className="text-xs text-pdm-fg-muted uppercase tracking-wide">
                Application Updates
              </label>
              <div className="p-3 bg-pdm-bg rounded-lg border border-pdm-border">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-pdm-fg">
                      BluePDM {appVersion || '...'}
                    </div>
                    <div className="text-xs text-pdm-fg-muted">
                      {updateCheckResult === 'none' && 'You have the latest version'}
                      {updateCheckResult === 'available' && 'Update available! Check the notification.'}
                      {updateCheckResult === 'error' && 'Could not check for updates'}
                      {updateCheckResult === null && !isCheckingUpdate && 'Check for new versions'}
                    </div>
                  </div>
                  <button
                    onClick={handleCheckForUpdates}
                    disabled={isCheckingUpdate}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      updateCheckResult === 'none'
                        ? 'bg-green-600/20 text-green-400 border border-green-600/30'
                        : updateCheckResult === 'available'
                        ? 'bg-pdm-accent/20 text-pdm-accent border border-pdm-accent/30'
                        : 'bg-pdm-highlight text-pdm-fg-muted hover:text-pdm-fg hover:bg-pdm-highlight/80'
                    }`}
                  >
                    {isCheckingUpdate ? (
                      <>
                        <Loader2 size={12} className="animate-spin" />
                        Checking...
                      </>
                    ) : updateCheckResult === 'none' ? (
                      <>
                        <CheckCircle size={12} />
                        Up to date
                      </>
                    ) : updateCheckResult === 'available' ? (
                      <>
                        <Download size={12} />
                        Available
                      </>
                    ) : (
                      <>
                        <RefreshCw size={12} />
                        Check for Updates
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
            
            {/* CAD Preview Mode */}
            <div className="space-y-2">
              <label className="text-xs text-pdm-fg-muted uppercase tracking-wide">
                SolidWorks Preview
              </label>
              <div className="space-y-2">
                <button
                  onClick={() => setCadPreviewMode('thumbnail')}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                    cadPreviewMode === 'thumbnail'
                      ? 'bg-pdm-accent/10 border-pdm-accent text-pdm-fg'
                      : 'bg-pdm-bg border-pdm-border text-pdm-fg-muted hover:border-pdm-fg-muted'
                  }`}
                >
                  <Image size={20} className={cadPreviewMode === 'thumbnail' ? 'text-pdm-accent' : ''} />
                  <div className="text-left">
                    <div className="text-sm font-medium">Embedded Thumbnail</div>
                    <div className="text-xs opacity-70">
                      Extract and show preview image from SW file
                    </div>
                  </div>
                </button>
                
                <button
                  onClick={() => setCadPreviewMode('edrawings')}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                    cadPreviewMode === 'edrawings'
                      ? 'bg-pdm-accent/10 border-pdm-accent text-pdm-fg'
                      : 'bg-pdm-bg border-pdm-border text-pdm-fg-muted hover:border-pdm-fg-muted'
                  }`}
                >
                  <ExternalLink size={20} className={cadPreviewMode === 'edrawings' ? 'text-pdm-accent' : ''} />
                  <div className="text-left">
                    <div className="text-sm font-medium">eDrawings (External)</div>
                    <div className="text-xs opacity-70">
                      Open files in external eDrawings app
                    </div>
                  </div>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

