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
  CheckCircle,
  Key,
  Copy,
  Check,
  Eye,
  EyeOff,
  Plug,
  Circle,
  Clock,
  Trash2,
  Activity,
  Wrench,
  FolderOpen,
  Info,
  Puzzle,
  HardDrive
} from 'lucide-react'
import { usePDMStore } from '../../stores/pdmStore'
import { supabase, signOut, getCurrentConfig } from '../../lib/supabase'
import { generateOrgCode } from '../../lib/supabaseConfig'
import { getInitials } from '../../types/pdm'

type SettingsTab = 'account' | 'vault' | 'organization' | 'solidworks' | 'api' | 'integrations' | 'preferences'

interface OrgUser {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  role: string
  last_sign_in: string | null
}

interface ApiCallRecord {
  id: string
  timestamp: Date
  method: string
  endpoint: string
  status: number
  duration: number
}

const API_URL_KEY = 'bluepdm_api_url'
const API_HISTORY_KEY = 'bluepdm_api_history'
const DEFAULT_API_URL = 'http://127.0.0.1:3001'

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
    setCadPreviewMode,
    solidworksPath,
    setSolidworksPath
  } = usePDMStore()
  
  const [activeTab, setActiveTab] = useState<SettingsTab>('account')
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([])
  const [isLoadingUsers, setIsLoadingUsers] = useState(false)
  const [editingVaultName, setEditingVaultName] = useState(false)
  const [vaultNameInput, setVaultNameInput] = useState('')
  const [appVersion, setAppVersion] = useState<string>('')
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [updateCheckResult, setUpdateCheckResult] = useState<'none' | 'available' | 'error' | null>(null)
  const [apiToken, setApiToken] = useState<string | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [tokenCopied, setTokenCopied] = useState(false)
  const [apiUrl, setApiUrl] = useState(() => {
    // Prefer org setting, fall back to localStorage, then default
    return organization?.settings?.api_url || localStorage.getItem(API_URL_KEY) || DEFAULT_API_URL
  })
  const [editingApiUrl, setEditingApiUrl] = useState(false)
  const [apiUrlInput, setApiUrlInput] = useState('')
  const [apiStatus, setApiStatus] = useState<'unknown' | 'online' | 'offline' | 'checking'>('unknown')
  const [apiVersion, setApiVersion] = useState<string | null>(null)
  const [apiHistory, setApiHistory] = useState<ApiCallRecord[]>(() => {
    try {
      const stored = localStorage.getItem(API_HISTORY_KEY)
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  })
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const [orgCode, setOrgCode] = useState<string | null>(null)
  const [showOrgCode, setShowOrgCode] = useState(false)
  const [codeCopied, setCodeCopied] = useState(false)
  
  // Google Drive settings state
  const [gdriveClientId, setGdriveClientId] = useState('')
  const [gdriveClientSecret, setGdriveClientSecret] = useState('')
  const [gdriveEnabled, setGdriveEnabled] = useState(false)
  const [isLoadingGdrive, setIsLoadingGdrive] = useState(false)
  const [isSavingGdrive, setIsSavingGdrive] = useState(false)
  const [showGdriveSecret, setShowGdriveSecret] = useState(false)
  
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
  
  // Get API token from Supabase session
  useEffect(() => {
    const getToken = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        setApiToken(session.access_token)
      }
    }
    getToken()
    
    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setApiToken(session?.access_token || null)
    })
    
    return () => subscription.unsubscribe()
  }, [])
  
  // Sync API URL from org settings when organization loads
  useEffect(() => {
    if (organization?.settings?.api_url) {
      setApiUrl(organization.settings.api_url)
      localStorage.setItem(API_URL_KEY, organization.settings.api_url)
    }
  }, [organization?.settings?.api_url])
  
  // Check API status when tab is selected
  useEffect(() => {
    if (activeTab === 'api') {
      checkApiStatus()
    }
  }, [activeTab])
  
  // Load Google Drive settings when integrations tab is selected
  useEffect(() => {
    if (activeTab === 'integrations') {
      loadGdriveSettings()
    }
  }, [activeTab])
  
  // Load Google Drive settings from organization
  const loadGdriveSettings = async () => {
    if (!organization?.id || user?.role !== 'admin') return
    
    setIsLoadingGdrive(true)
    try {
      // Use type assertion - RPC function types not generated yet
      const { data, error } = await (supabase.rpc as any)('get_google_drive_settings', {
        p_org_id: organization.id
      })
      
      if (error) {
        console.error('Error loading Google Drive settings:', error)
        return
      }
      
      if (data && Array.isArray(data) && data.length > 0) {
        const settings = data[0] as { client_id?: string; client_secret?: string; enabled?: boolean }
        setGdriveClientId(settings.client_id || '')
        setGdriveClientSecret(settings.client_secret || '')
        setGdriveEnabled(settings.enabled || false)
      }
    } catch (err) {
      console.error('Error loading Google Drive settings:', err)
    } finally {
      setIsLoadingGdrive(false)
    }
  }
  
  // Save Google Drive settings to organization
  const saveGdriveSettings = async () => {
    if (!organization?.id || user?.role !== 'admin') return
    
    setIsSavingGdrive(true)
    try {
      // Use type assertion - RPC function types not generated yet
      const { error } = await (supabase.rpc as any)('update_google_drive_settings', {
        p_org_id: organization.id,
        p_client_id: gdriveClientId || null,
        p_client_secret: gdriveClientSecret || null,
        p_enabled: gdriveEnabled
      })
      
      if (error) {
        console.error('Error saving Google Drive settings:', error)
        usePDMStore.getState().addToast('error', 'Failed to save: ' + error.message)
        return
      }
      
      // Show success toast
      usePDMStore.getState().addToast('success', 'Google Drive settings saved')
    } catch (err) {
      console.error('Error saving Google Drive settings:', err)
      usePDMStore.getState().addToast('error', 'Failed to save Google Drive settings')
    } finally {
      setIsSavingGdrive(false)
    }
  }
  
  const checkApiStatus = async () => {
    setApiStatus('checking')
    const start = Date.now()
    try {
      const response = await fetch(`${apiUrl}/health`, { 
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })
      const duration = Date.now() - start
      
      if (response.ok) {
        const data = await response.json()
        setApiStatus('online')
        setApiVersion(data.version || null)
        addApiCall('GET', '/health', response.status, duration)
      } else {
        setApiStatus('offline')
        addApiCall('GET', '/health', response.status, duration)
      }
    } catch (err) {
      setApiStatus('offline')
      addApiCall('GET', '/health', 0, Date.now() - start)
    }
    setLastChecked(new Date())
  }
  
  const addApiCall = (method: string, endpoint: string, status: number, duration: number) => {
    const newCall: ApiCallRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      method,
      endpoint,
      status,
      duration
    }
    setApiHistory(prev => {
      const updated = [newCall, ...prev].slice(0, 50) // Keep last 50 calls
      localStorage.setItem(API_HISTORY_KEY, JSON.stringify(updated))
      return updated
    })
  }
  
  const clearApiHistory = () => {
    setApiHistory([])
    localStorage.removeItem(API_HISTORY_KEY)
  }
  
  const handleSaveApiUrl = async () => {
    let url = apiUrlInput.trim()
    if (url) {
      // Auto-add https:// if missing
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url
      }
      // Remove trailing slash
      url = url.replace(/\/+$/, '')
      setApiUrl(url)
      localStorage.setItem(API_URL_KEY, url)
      // Save external URLs separately so we can toggle back to them
      if (url !== 'http://127.0.0.1:3001') {
        localStorage.setItem('bluepdm_external_api_url', url)
        // Save to org settings (syncs to all org members)
        if (organization && user?.role === 'admin') {
          try {
            const newSettings = { ...organization.settings, api_url: url }
            const { error } = await (supabase as any)
              .from('organizations')
              .update({ settings: newSettings })
              .eq('id', organization.id)
            if (!error) {
              setOrganization({
                ...organization,
                settings: { ...organization.settings, api_url: url }
              })
            }
          } catch (err) {
            console.error('Failed to save API URL to org:', err)
          }
        }
      }
    }
    setEditingApiUrl(false)
    // Re-check status with new URL
    setTimeout(checkApiStatus, 100)
  }
  
  const testApiEndpoint = async (endpoint: string) => {
    if (!apiToken) return
    
    const start = Date.now()
    try {
      const response = await fetch(`${apiUrl}${endpoint}`, {
        headers: { 'Authorization': `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(10000)
      })
      addApiCall('GET', endpoint, response.status, Date.now() - start)
    } catch {
      addApiCall('GET', endpoint, 0, Date.now() - start)
    }
  }
  
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
  
  const handleCopyToken = async () => {
    if (!apiToken) return
    try {
      await navigator.clipboard.writeText(apiToken)
      setTokenCopied(true)
      setTimeout(() => setTokenCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy token:', err)
    }
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
    { id: 'solidworks' as SettingsTab, icon: Wrench, label: 'SolidWorks' },
    { id: 'integrations' as SettingsTab, icon: Puzzle, label: 'Integrations' },
    { id: 'api' as SettingsTab, icon: Plug, label: 'REST API' },
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
                  <div className="text-xs text-pdm-fg-muted mb-3">
                    {organization.email_domains?.join(', ')}
                  </div>
                  
                  {/* Organization Code (Admin only) */}
                  {user?.role === 'admin' && (
                    <div className="pt-2 border-t border-pdm-border">
                      {showOrgCode && orgCode ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-pdm-fg-muted">Organization Code</span>
                            <button
                              onClick={() => setShowOrgCode(false)}
                              className="text-xs text-pdm-fg-muted hover:text-pdm-fg"
                            >
                              Hide
                            </button>
                          </div>
                          <div className="relative">
                            <div className="font-mono text-xs bg-pdm-bg-secondary border border-pdm-border rounded p-2 pr-8 break-all text-pdm-fg max-h-20 overflow-y-auto">
                              {orgCode}
                            </div>
                            <button
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(orgCode)
                                  setCodeCopied(true)
                                  setTimeout(() => setCodeCopied(false), 2000)
                                } catch (err) {
                                  console.error('Failed to copy:', err)
                                }
                              }}
                              className="absolute top-1.5 right-1.5 p-1 hover:bg-pdm-highlight rounded transition-colors"
                              title="Copy to clipboard"
                            >
                              {codeCopied ? (
                                <Check size={12} className="text-green-500" />
                              ) : (
                                <Copy size={12} className="text-pdm-fg-muted" />
                              )}
                            </button>
                          </div>
                          <p className="text-xs text-pdm-fg-dim">
                            Share with team members to connect.
                          </p>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            const config = getCurrentConfig()
                            if (config) {
                              const code = generateOrgCode(config)
                              setOrgCode(code)
                              setShowOrgCode(true)
                            }
                          }}
                          className="flex items-center gap-1.5 text-xs text-pdm-fg-muted hover:text-pdm-fg transition-colors"
                        >
                          <Key size={12} />
                          Show Organization Code
                        </button>
                      )}
                    </div>
                  )}
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
        
        {activeTab === 'solidworks' && (
          <div className="space-y-4">
            {/* Preview Mode */}
            <div className="space-y-2">
              <label className="text-xs text-pdm-fg-muted uppercase tracking-wide">
                Preview Mode
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
            
            {/* Installation Path */}
            <div className="space-y-2">
              <label className="text-xs text-pdm-fg-muted uppercase tracking-wide">
                Installation Path
              </label>
              <div className="p-3 bg-pdm-bg rounded-lg border border-pdm-border space-y-2">
                <div className="flex items-start gap-2">
                  <FolderOpen size={16} className="text-pdm-fg-muted mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      value={solidworksPath || ''}
                      onChange={(e) => setSolidworksPath(e.target.value || null)}
                      placeholder="C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS"
                      className="w-full bg-pdm-bg-secondary border border-pdm-border rounded px-2 py-1.5 text-sm font-mono text-pdm-fg placeholder:text-pdm-fg-dim"
                    />
                  </div>
                </div>
                <div className="flex items-start gap-1.5 text-xs text-pdm-fg-muted">
                  <Info size={12} className="mt-0.5 flex-shrink-0" />
                  <span>Only needed if SolidWorks is installed in a non-default location.</span>
                </div>
              </div>
            </div>
            
            {/* Document Manager License */}
            <div className="space-y-2">
              <label className="text-xs text-pdm-fg-muted uppercase tracking-wide">
                Document Manager License
              </label>
              <div className="p-3 bg-pdm-bg rounded-lg border border-pdm-border">
                <div className="flex items-center gap-2 mb-2">
                  <Key size={16} className={organization?.settings?.solidworks_dm_license_key ? 'text-green-400' : 'text-pdm-fg-muted'} />
                  <span className="text-sm text-pdm-fg">
                    {organization?.settings?.solidworks_dm_license_key ? (
                      <span className="text-green-400">Configured</span>
                    ) : (
                      <span className="text-pdm-fg-muted">Not configured</span>
                    )}
                  </span>
                </div>
                <div className="text-xs text-pdm-fg-muted space-y-1">
                  {organization?.settings?.solidworks_dm_license_key ? (
                    <p>Using fast Document Manager API for file reading.</p>
                  ) : (
                    <p>Using SolidWorks API (slower, launches SW in background).</p>
                  )}
                  <p className="pt-1">
                    DM license key is configured at the organization level.{' '}
                    <a
                      href="https://customerportal.solidworks.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-pdm-accent hover:underline"
                      onClick={(e) => {
                        e.preventDefault()
                        window.electronAPI?.openFile('https://customerportal.solidworks.com/')
                      }}
                    >
                      Get key from SOLIDWORKS Customer Portal
                    </a>
                  </p>
                </div>
              </div>
            </div>
            
            {/* eDrawings link */}
            <div className="pt-2">
              <a
                href="https://www.solidworks.com/support/free-downloads"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-pdm-accent hover:underline"
                onClick={(e) => {
                  e.preventDefault()
                  window.electronAPI?.openFile('https://www.solidworks.com/support/free-downloads')
                }}
              >
                <Download size={14} />
                Download eDrawings Viewer (Free)
              </a>
            </div>
          </div>
        )}
        
        {activeTab === 'api' && (
          <div className="space-y-4">
            {user?.role !== 'admin' ? (
              <div className="text-center py-8">
                <Shield size={32} className="mx-auto text-pdm-fg-muted mb-2" />
                <div className="text-sm font-medium text-pdm-fg">Admin Only</div>
                <p className="text-xs text-pdm-fg-muted mt-1">
                  API settings require admin access.
                </p>
              </div>
            ) : (
              <>
            {/* Environment Toggle */}
            <div className="flex gap-1">
              <button
                onClick={() => {
                  setApiUrl('http://127.0.0.1:3001')
                  localStorage.setItem(API_URL_KEY, 'http://127.0.0.1:3001')
                  setTimeout(checkApiStatus, 100)
                }}
                className={`flex-1 px-2 py-1.5 text-xs rounded border transition-colors ${
                  apiUrl === 'http://127.0.0.1:3001'
                    ? 'bg-pdm-accent/20 border-pdm-accent text-pdm-fg'
                    : 'bg-pdm-bg border-pdm-border text-pdm-fg-muted hover:border-pdm-fg-muted'
                }`}
              >
                🖥️ Local
              </button>
              <button
                onClick={() => {
                  // Prefer org setting, then localStorage
                  const externalUrl = organization?.settings?.api_url || localStorage.getItem('bluepdm_external_api_url') || ''
                  if (externalUrl) {
                    setApiUrl(externalUrl)
                    localStorage.setItem(API_URL_KEY, externalUrl)
                    setTimeout(checkApiStatus, 100)
                  } else {
                    setEditingApiUrl(true)
                    setApiUrlInput('https://')
                  }
                }}
                className={`flex-1 px-2 py-1.5 text-xs rounded border transition-colors ${
                  apiUrl !== 'http://127.0.0.1:3001'
                    ? 'bg-pdm-accent/20 border-pdm-accent text-pdm-fg'
                    : 'bg-pdm-bg border-pdm-border text-pdm-fg-muted hover:border-pdm-fg-muted'
                }`}
              >
                ☁️ External
              </button>
            </div>
            
            {/* Server Status */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs text-pdm-fg-muted uppercase tracking-wide">
                  Server Status
                </label>
                <button
                  onClick={checkApiStatus}
                  disabled={apiStatus === 'checking'}
                  className="text-xs text-pdm-fg-muted hover:text-pdm-fg flex items-center gap-1"
                >
                  <RefreshCw size={12} className={apiStatus === 'checking' ? 'animate-spin' : ''} />
                  Refresh
                </button>
              </div>
              <div className="p-3 bg-pdm-bg rounded-lg border border-pdm-border">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-full ${
                    apiStatus === 'online' ? 'bg-green-500/20' :
                    apiStatus === 'offline' ? 'bg-red-500/20' :
                    apiStatus === 'checking' ? 'bg-yellow-500/20' :
                    'bg-pdm-fg-muted/20'
                  }`}>
                    {apiStatus === 'checking' ? (
                      <Loader2 size={16} className="animate-spin text-yellow-400" />
                    ) : (
                      <Circle size={16} className={`${
                        apiStatus === 'online' ? 'text-green-400 fill-green-400' :
                        apiStatus === 'offline' ? 'text-red-400' :
                        'text-pdm-fg-muted'
                      }`} />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-pdm-fg">
                      {apiStatus === 'online' && 'API Server Online'}
                      {apiStatus === 'offline' && 'API Server Offline'}
                      {apiStatus === 'checking' && 'Checking...'}
                      {apiStatus === 'unknown' && 'Status Unknown'}
                    </div>
                    <div className="text-xs text-pdm-fg-muted">
                      {apiVersion && `v${apiVersion} • `}
                      {lastChecked && `Checked ${lastChecked.toLocaleTimeString()}`}
                    </div>
                  </div>
                </div>
                {(apiStatus === 'offline' || apiStatus === 'unknown') && (
                  <div className="mt-3 p-2 bg-pdm-bg-secondary rounded text-xs space-y-2">
                    <div className="font-medium text-pdm-fg">🚀 Need to deploy?</div>
                    <p className="text-pdm-fg-muted">
                      Each org hosts their own API. Deploy to Railway or Render in 5 min.
                    </p>
                    <div className="flex gap-2">
                      <a href="https://railway.app/new" target="_blank" rel="noopener noreferrer" className="text-pdm-accent hover:underline">Railway</a>
                      <span className="text-pdm-fg-muted">•</span>
                      <a href="https://render.com/deploy" target="_blank" rel="noopener noreferrer" className="text-pdm-accent hover:underline">Render</a>
                      <span className="text-pdm-fg-muted">•</span>
                      <a href="https://github.com/bluerobotics/blue-pdm/blob/main/api/README.md#deployment" target="_blank" rel="noopener noreferrer" className="text-pdm-accent hover:underline">Guide</a>
                    </div>
                    <div className="pt-1 text-pdm-fg-dim">
                      Local: <code className="bg-pdm-bg px-1 rounded">npm run api</code>
                    </div>
                  </div>
                )}
              </div>
            </div>
            
            {/* API URL */}
            <div className="space-y-2">
              <label className="text-xs text-pdm-fg-muted uppercase tracking-wide">
                API URL
              </label>
              {editingApiUrl ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={apiUrlInput}
                    onChange={(e) => setApiUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveApiUrl()
                      if (e.key === 'Escape') setEditingApiUrl(false)
                    }}
                    placeholder="http://127.0.0.1:3001"
                    className="flex-1 bg-pdm-bg border border-pdm-border rounded px-2 py-1 text-sm font-mono"
                    autoFocus
                  />
                  <button onClick={handleSaveApiUrl} className="btn btn-primary btn-sm">
                    Save
                  </button>
                </div>
              ) : (
                <div 
                  className="p-2 bg-pdm-bg rounded border border-pdm-border cursor-pointer hover:border-pdm-accent transition-colors"
                  onClick={() => {
                    setApiUrlInput(apiUrl)
                    setEditingApiUrl(true)
                  }}
                >
                  <code className="text-sm text-pdm-fg font-mono">{apiUrl}</code>
                </div>
              )}
            </div>
            
            {/* API Token */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-pdm-fg-muted uppercase tracking-wide">
                <Key size={12} />
                Access Token
              </div>
              {apiToken ? (
                <div className="p-3 bg-pdm-bg rounded-lg border border-pdm-border space-y-2">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono text-pdm-fg-muted overflow-hidden text-ellipsis">
                      {showToken 
                        ? apiToken 
                        : `${apiToken.substring(0, 20)}${'•'.repeat(30)}`
                      }
                    </code>
                    <button
                      onClick={() => setShowToken(!showToken)}
                      className="p-1.5 text-pdm-fg-muted hover:text-pdm-fg rounded transition-colors"
                      title={showToken ? 'Hide token' : 'Show token'}
                    >
                      {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <button
                      onClick={handleCopyToken}
                      className={`p-1.5 rounded transition-colors ${
                        tokenCopied 
                          ? 'text-green-400 bg-green-400/10' 
                          : 'text-pdm-fg-muted hover:text-pdm-fg hover:bg-pdm-highlight'
                      }`}
                      title="Copy token"
                    >
                      {tokenCopied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                  <div className="text-xs text-pdm-fg-muted">
                    <code className="block p-1.5 bg-pdm-bg-secondary rounded text-pdm-fg-dim">
                      curl -H "Authorization: Bearer $TOKEN" {apiUrl}/files
                    </code>
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-pdm-bg rounded-lg border border-pdm-border text-sm text-pdm-fg-muted">
                  Sign in to get an API token
                </div>
              )}
            </div>
            
            {/* Quick Test */}
            {apiToken && apiStatus === 'online' && (
              <div className="space-y-2">
                <label className="text-xs text-pdm-fg-muted uppercase tracking-wide">
                  Quick Test
                </label>
                <div className="flex flex-wrap gap-2">
                  {['/vaults', '/files?limit=5', '/checkouts', '/activity?limit=5'].map(endpoint => (
                    <button
                      key={endpoint}
                      onClick={() => testApiEndpoint(endpoint)}
                      className="px-2 py-1 text-xs bg-pdm-bg border border-pdm-border rounded hover:border-pdm-accent transition-colors font-mono"
                    >
                      GET {endpoint}
                    </button>
                  ))}
                </div>
              </div>
            )}
            
            {/* API Call History */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-pdm-fg-muted uppercase tracking-wide">
                  <Activity size={12} />
                  Recent API Calls
                </div>
                {apiHistory.length > 0 && (
                  <button
                    onClick={clearApiHistory}
                    className="text-xs text-pdm-fg-muted hover:text-pdm-error flex items-center gap-1"
                  >
                    <Trash2 size={12} />
                    Clear
                  </button>
                )}
              </div>
              <div className="bg-pdm-bg rounded-lg border border-pdm-border overflow-hidden">
                {apiHistory.length === 0 ? (
                  <div className="p-3 text-sm text-pdm-fg-muted text-center">
                    No API calls recorded
                  </div>
                ) : (
                  <div className="max-h-48 overflow-y-auto">
                    {apiHistory.slice(0, 20).map(call => (
                      <div 
                        key={call.id}
                        className="flex items-center gap-2 px-3 py-1.5 border-b border-pdm-border last:border-0 text-xs"
                      >
                        <span className={`px-1.5 py-0.5 rounded font-medium ${
                          call.status >= 200 && call.status < 300 
                            ? 'bg-green-500/20 text-green-400' 
                            : call.status === 0
                            ? 'bg-red-500/20 text-red-400'
                            : 'bg-yellow-500/20 text-yellow-400'
                        }`}>
                          {call.status || 'ERR'}
                        </span>
                        <span className="text-pdm-fg-muted">{call.method}</span>
                        <span className="text-pdm-fg font-mono flex-1 truncate">{call.endpoint}</span>
                        <span className="text-pdm-fg-muted flex items-center gap-1">
                          <Clock size={10} />
                          {call.duration}ms
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            
            {/* Documentation Link */}
            <div className="pt-2">
              <a
                href={`${apiUrl}/docs`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-pdm-accent hover:underline"
              >
                <ExternalLink size={14} />
                Open API Documentation (Swagger)
              </a>
            </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'integrations' && (
          <div className="space-y-4">
            {user?.role !== 'admin' ? (
              <div className="text-center py-8">
                <Puzzle size={32} className="mx-auto mb-3 text-pdm-fg-muted opacity-50" />
                <p className="text-sm text-pdm-fg-muted">
                  Only administrators can manage integrations.
                </p>
              </div>
            ) : (
              <>
                {/* Google Drive Integration */}
                <div className="space-y-3">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-lg bg-pdm-sidebar flex items-center justify-center">
                      <HardDrive size={20} className="text-pdm-accent" />
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-pdm-fg">Google Drive</h3>
                      <p className="text-xs text-pdm-fg-muted">
                        Allow org members to connect their Google Drive
                      </p>
                    </div>
                    {isLoadingGdrive && <Loader2 size={14} className="animate-spin text-pdm-fg-muted ml-auto" />}
                  </div>
                  
                  <div className="space-y-3 p-4 bg-pdm-bg rounded-lg border border-pdm-border">
                    {/* Enable toggle */}
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-pdm-fg">Enable Google Drive</span>
                      <button
                        onClick={() => setGdriveEnabled(!gdriveEnabled)}
                        className={`w-10 h-5 rounded-full transition-colors relative ${
                          gdriveEnabled ? 'bg-pdm-accent' : 'bg-pdm-border'
                        }`}
                      >
                        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          gdriveEnabled ? 'translate-x-5' : 'translate-x-0.5'
                        }`} />
                      </button>
                    </div>
                    
                    {gdriveEnabled && (
                      <>
                        {/* Client ID */}
                        <div className="space-y-1">
                          <label className="text-xs text-pdm-fg-muted">Client ID</label>
                          <input
                            type="text"
                            value={gdriveClientId}
                            onChange={(e) => setGdriveClientId(e.target.value)}
                            placeholder="xxxxxxx.apps.googleusercontent.com"
                            className="w-full px-2 py-1.5 text-xs bg-pdm-sidebar border border-pdm-border rounded focus:outline-none focus:border-pdm-accent font-mono"
                          />
                        </div>
                        
                        {/* Client Secret */}
                        <div className="space-y-1">
                          <label className="text-xs text-pdm-fg-muted">Client Secret</label>
                          <div className="relative">
                            <input
                              type={showGdriveSecret ? 'text' : 'password'}
                              value={gdriveClientSecret}
                              onChange={(e) => setGdriveClientSecret(e.target.value)}
                              placeholder="GOCSPX-xxxxxxxxxxxx"
                              className="w-full px-2 py-1.5 pr-8 text-xs bg-pdm-sidebar border border-pdm-border rounded focus:outline-none focus:border-pdm-accent font-mono"
                            />
                            <button
                              type="button"
                              onClick={() => setShowGdriveSecret(!showGdriveSecret)}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-pdm-fg-muted hover:text-pdm-fg"
                            >
                              {showGdriveSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          </div>
                        </div>
                        
                        {/* Help text */}
                        <div className="p-3 bg-pdm-sidebar rounded-lg">
                          <p className="text-xs text-pdm-fg-muted">
                            <strong>Setup instructions:</strong>
                          </p>
                          <ol className="text-xs text-pdm-fg-muted mt-1 space-y-1 list-decimal list-inside">
                            <li>Go to <a 
                              href="https://console.cloud.google.com/apis/credentials" 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="text-pdm-accent hover:underline"
                            >
                              Google Cloud Console
                            </a></li>
                            <li>Create or select a project</li>
                            <li>Enable the Google Drive API</li>
                            <li>Create OAuth 2.0 credentials (Desktop app type)</li>
                            <li>Copy the Client ID and Client Secret here</li>
                          </ol>
                        </div>
                        
                        {/* Save button */}
                        <button
                          onClick={saveGdriveSettings}
                          disabled={isSavingGdrive}
                          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm bg-pdm-accent text-white rounded hover:bg-pdm-accent/90 transition-colors disabled:opacity-50"
                        >
                          {isSavingGdrive ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Check size={14} />
                          )}
                          Save Google Drive Settings
                        </button>
                      </>
                    )}
                  </div>
                </div>
                
                {/* More integrations can be added here */}
                <div className="pt-4 border-t border-pdm-border">
                  <p className="text-xs text-pdm-fg-muted text-center">
                    More integrations coming soon...
                  </p>
                </div>
              </>
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
          </div>
        )}
      </div>
    </div>
  )
}

