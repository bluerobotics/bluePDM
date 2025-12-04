import { useEffect, useState, useCallback } from 'react'
import { usePDMStore } from './stores/pdmStore'
import { supabase, getCurrentSession, getUserProfile, isSupabaseConfigured, getFiles, linkUserToOrganization, checkinFile } from './lib/supabase'
import { MenuBar } from './components/MenuBar'
import { ActivityBar } from './components/ActivityBar'
import { Sidebar } from './components/Sidebar'
import { FileBrowser } from './components/FileBrowser'
import { DetailsPanel } from './components/DetailsPanel'
import { StatusBar } from './components/StatusBar'
import { WelcomeScreen } from './components/WelcomeScreen'
import { Toast } from './components/Toast'

function App() {
  const {
    user,
    organization,
    isOfflineMode,
    vaultPath,
    isVaultConnected,
    connectedVaults,
    sidebarVisible,
    setSidebarWidth,
    toggleSidebar,
    detailsPanelVisible,
    toggleDetailsPanel,
    setVaultPath,
    setVaultConnected,
    setFiles,
    setServerFiles,
    setIsLoading,
    setStatusMessage,
    addRecentVault,
    setUser,
    setOrganization,
  } = usePDMStore()
  
  // Consider vault connected if either legacy or new multi-vault system is connected
  const hasVaultConnected = isVaultConnected || connectedVaults.length > 0

  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [isResizingDetails, setIsResizingDetails] = useState(false)

  // Initialize auth state (runs in background, doesn't block UI)
  useEffect(() => {
    if (!isSupabaseConfigured) {
      console.log('[Auth] Supabase not configured')
      return
    }

    console.log('[Auth] Checking for existing session...')

    // Check for existing session
    getCurrentSession().then(async ({ session }) => {
      if (session?.user) {
        console.log('[Auth] Found existing session:', session.user.email)
        
        // Set user from session data first (fast)
        const userData = {
          id: session.user.id,
          email: session.user.email || '',
          full_name: session.user.user_metadata?.full_name || session.user.user_metadata?.name || null,
          avatar_url: session.user.user_metadata?.avatar_url || null,
          org_id: null,
          role: 'engineer' as const,
          created_at: session.user.created_at,
          last_sign_in: null
        }
        setUser(userData)
        
        // Then load organization using the working linkUserToOrganization function
        console.log('[Auth] Loading organization for:', session.user.email)
        linkUserToOrganization(session.user.id, session.user.email || '').then(({ org, error }) => {
          if (org) {
            console.log('[Auth] Organization loaded:', org.name)
            setOrganization(org)
          } else if (error) {
            console.log('[Auth] No organization found:', error)
          }
        })
      } else {
        console.log('[Auth] No existing session')
      }
    }).catch(err => {
      console.error('[Auth] Error checking session:', err)
    })

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log('[Auth] Auth state changed:', event)
        
        if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session?.user) {
          // Set user from session
          setUser({
            id: session.user.id,
            email: session.user.email || '',
            full_name: session.user.user_metadata?.full_name || session.user.user_metadata?.name || null,
            avatar_url: session.user.user_metadata?.avatar_url || null,
            org_id: null,
            role: 'engineer',
            created_at: session.user.created_at,
            last_sign_in: null
          })
          
          if (event === 'SIGNED_IN') {
            setStatusMessage(`Welcome, ${session.user.user_metadata?.full_name || session.user.email}!`)
            setTimeout(() => setStatusMessage(''), 3000)
          }
          
          // Load organization
          linkUserToOrganization(session.user.id, session.user.email || '').then(({ org }) => {
            if (org) {
              console.log('[Auth] Organization loaded on state change:', org.name)
              setOrganization(org)
            }
          })
        } else if (event === 'SIGNED_OUT') {
          console.log('[Auth] Signed out')
          setUser(null)
          setOrganization(null)
          setVaultConnected(false)
          setStatusMessage('Signed out')
          setTimeout(() => setStatusMessage(''), 3000)
        }
      }
    )

    return () => {
      subscription.unsubscribe()
    }
  }, [setUser, setOrganization, setStatusMessage, setVaultConnected])

  // Load files from working directory and merge with PDM data
  // silent = true means no loading spinner (for background refreshes after downloads/uploads)
  const loadFiles = useCallback(async (silent: boolean = false) => {
    if (!window.electronAPI || !vaultPath) return
    
    if (!silent) {
      setIsLoading(true)
      setStatusMessage('Loading files...')
    }
    
    try {
      // 1. Load local files
      const result = await window.electronAPI.listWorkingFiles()
      if (!result.success || !result.files) {
        setStatusMessage(result.error || 'Failed to load files')
        return
      }
      
      // Map hash to localHash for comparison
      let localFiles = result.files.map(f => ({
        ...f,
        localHash: f.hash
      }))
      
      // 2. If connected to Supabase, fetch PDM data and merge
      if (organization && !isOfflineMode) {
        const { files: pdmFiles, error: pdmError } = await getFiles(organization.id)
        
        if (pdmError) {
          console.warn('Failed to fetch PDM data:', pdmError)
        } else if (pdmFiles) {
          // Create a map of pdm data by file path
          const pdmMap = new Map(pdmFiles.map(f => [f.file_path, f]))
          
          // Store server files for tracking deletions
          const serverFilesList = pdmFiles.map(f => ({
            id: f.id,
            file_path: f.file_path,
            name: f.name,
            extension: f.extension,
            content_hash: f.content_hash || ''
          }))
          setServerFiles(serverFilesList)
          
          // Create set of local file paths for deletion detection
          const localPathSet = new Set(localFiles.map(f => f.relativePath))
          
          // Merge PDM data into local files and compute diff status
          localFiles = localFiles.map(localFile => {
            if (localFile.isDirectory) return localFile
            
            const pdmData = pdmMap.get(localFile.relativePath)
            
            // Determine diff status
            let diffStatus: 'added' | 'modified' | 'outdated' | undefined
            if (!pdmData) {
              // File exists locally but not on server = added
              diffStatus = 'added'
            } else if (pdmData.content_hash && localFile.localHash) {
              // File exists both places - check if modified or outdated
              if (pdmData.content_hash !== localFile.localHash) {
                // Hashes differ - determine if local is newer or cloud is newer
                const localModTime = new Date(localFile.modifiedTime).getTime()
                const cloudUpdateTime = pdmData.updated_at ? new Date(pdmData.updated_at).getTime() : 0
                
                if (localModTime > cloudUpdateTime) {
                  // Local file was modified more recently - local changes
                  diffStatus = 'modified'
                } else {
                  // Cloud was updated more recently - need to pull
                  diffStatus = 'outdated'
                }
              }
            } else if (pdmData.content_hash && !localFile.localHash) {
              // Cloud has content but we couldn't hash local file - might be outdated
              diffStatus = 'outdated'
            }
            
            return {
              ...localFile,
              pdmData: pdmData || undefined,
              isSynced: !!pdmData,
              diffStatus
            }
          })
          
          // Add cloud-only files (exist on server but not locally) as "cloud" entries
          // These appear faded/greyed to indicate they're available but not downloaded
          const cloudFolders = new Set<string>()
          
          for (const pdmFile of pdmFiles) {
            if (!localPathSet.has(pdmFile.file_path)) {
              // If file is checked out by current user but doesn't exist locally,
              // auto-release the checkout (user deleted it externally)
              if (pdmFile.checked_out_by === user?.id) {
                console.log('[Auto-release] File deleted externally, releasing checkout:', pdmFile.file_name)
                checkinFile(pdmFile.id, user.id).then(result => {
                  if (result.success) {
                    console.log('[Auto-release] Released checkout for:', pdmFile.file_name)
                  } else {
                    console.error('[Auto-release] Failed to release:', result.error)
                  }
                })
                // Clear the checkout info for display (optimistic update)
                pdmFile.checked_out_by = null
                pdmFile.checked_out_at = null
                pdmFile.checked_out_user = null
              }
              
              // Add cloud parent folders for this file
              const pathParts = pdmFile.file_path.split('/')
              let currentPath = ''
              for (let i = 0; i < pathParts.length - 1; i++) {
                currentPath = currentPath ? `${currentPath}/${pathParts[i]}` : pathParts[i]
                if (!localPathSet.has(currentPath) && !cloudFolders.has(currentPath)) {
                  cloudFolders.add(currentPath)
                }
              }
              
              // Add the cloud-only file (not synced locally)
              localFiles.push({
                name: pdmFile.file_name,
                path: `${vaultPath}\\${pdmFile.file_path.replace(/\//g, '\\')}`,
                relativePath: pdmFile.file_path,
                isDirectory: false,
                extension: pdmFile.extension,
                size: pdmFile.file_size || 0,
                modifiedTime: pdmFile.updated_at || '',
                pdmData: pdmFile,
                isSynced: false, // Not synced locally
                diffStatus: 'cloud' // Cloud-only, available for download
              })
            }
          }
          
          // Add cloud folders (folders that exist on server but not locally)
          for (const folderPath of cloudFolders) {
            const folderName = folderPath.split('/').pop() || folderPath
            localFiles.push({
              name: folderName,
              path: `${vaultPath}\\${folderPath.replace(/\//g, '\\')}`,
              relativePath: folderPath,
              isDirectory: true,
              extension: '',
              size: 0,
              modifiedTime: '',
              diffStatus: 'cloud'
            })
          }
        }
      } else {
        // Offline mode or no org - all local files are "added"
        localFiles = localFiles.map(f => ({
          ...f,
          diffStatus: f.isDirectory ? undefined : 'added' as const
        }))
      }
      
      // Update folder diffStatus based on contents
      // A folder should be 'cloud' if all its contents are cloud-only
      // Process folders bottom-up (deepest first) so parent folders see updated child statuses
      const folders = localFiles.filter(f => f.isDirectory)
      const fileMap = new Map(localFiles.map(f => [f.relativePath.replace(/\\/g, '/'), f]))
      
      // Sort folders by depth (deepest first)
      folders.sort((a, b) => {
        const depthA = a.relativePath.split(/[/\\]/).length
        const depthB = b.relativePath.split(/[/\\]/).length
        return depthB - depthA
      })
      
      // Check each folder from deepest to shallowest
      for (const folder of folders) {
        const normalizedFolder = folder.relativePath.replace(/\\/g, '/')
        
        // Get direct children of this folder
        const hasLocalContent = localFiles.some(f => {
          if (f.relativePath === folder.relativePath) return false // Skip self
          const normalizedPath = f.relativePath.replace(/\\/g, '/')
          
          // Check if it's a direct child (not nested deeper)
          if (!normalizedPath.startsWith(normalizedFolder + '/')) return false
          const remainder = normalizedPath.slice(normalizedFolder.length + 1)
          if (remainder.includes('/')) return false // It's nested deeper, not direct child
          
          // Check if this item is local (not cloud-only)
          return f.diffStatus !== 'cloud'
        })
        
        if (!hasLocalContent) {
          // Update this folder to cloud status
          const folderInList = localFiles.find(f => f.relativePath === folder.relativePath)
          if (folderInList) {
            folderInList.diffStatus = 'cloud'
          }
        }
      }
      
      setFiles(localFiles)
      const syncedCount = localFiles.filter(f => f.pdmData).length
      const totalFiles = localFiles.filter(f => !f.isDirectory).length
      setStatusMessage(`Loaded ${localFiles.length} items (${syncedCount}/${totalFiles} synced)`)
      
      // Set read-only status on synced files
      // Files should be read-only unless checked out by current user
      if (user && window.electronAPI) {
        for (const file of localFiles) {
          if (file.isDirectory || !file.pdmData) continue
          
          const isCheckedOutByMe = file.pdmData.checked_out_by === user.id
          // Make file writable if checked out by me, read-only otherwise
          window.electronAPI.setReadonly(file.path, !isCheckedOutByMe)
        }
      }
    } catch (err) {
      if (!silent) {
        setStatusMessage('Error loading files')
      }
      console.error(err)
    } finally {
      if (!silent) {
        setIsLoading(false)
        setTimeout(() => setStatusMessage(''), 3000)
      }
    }
  }, [vaultPath, organization, isOfflineMode, setFiles, setIsLoading, setStatusMessage])

  // Open working directory
  const handleOpenVault = useCallback(async () => {
    if (!window.electronAPI) return
    
    const result = await window.electronAPI.selectWorkingDir()
    if (result.success && result.path) {
      setVaultPath(result.path)
      setVaultConnected(true)
      addRecentVault(result.path)
      setStatusMessage(`Opened: ${result.path}`)
      setTimeout(() => setStatusMessage(''), 3000)
    }
  }, [setVaultPath, setVaultConnected, addRecentVault, setStatusMessage])

  // Open recent vault
  const handleOpenRecentVault = useCallback(async (path: string) => {
    if (!window.electronAPI) return
    
    const result = await window.electronAPI.setWorkingDir(path)
    if (result.success) {
      setVaultPath(path)
      setVaultConnected(true)
      addRecentVault(path)
      setStatusMessage(`Opened: ${path}`)
      setTimeout(() => setStatusMessage(''), 3000)
    } else {
      setStatusMessage(result.error || 'Failed to open folder')
      setTimeout(() => setStatusMessage(''), 3000)
    }
  }, [setVaultPath, setVaultConnected, addRecentVault, setStatusMessage])

  // Initialize working directory on startup (only if authenticated or offline)
  useEffect(() => {
    const initWorkingDir = async () => {
      if (!window.electronAPI || !vaultPath) return
      if (!user && !isOfflineMode) return
      
      const result = await window.electronAPI.setWorkingDir(vaultPath)
      if (result.success) {
        setVaultConnected(true)
      } else {
        setVaultPath(null)
        setVaultConnected(false)
      }
    }
    
    initWorkingDir()
  }, [user, isOfflineMode, vaultPath, setVaultPath, setVaultConnected])

  // Load files when working directory changes
  useEffect(() => {
    if (isVaultConnected && vaultPath) {
      loadFiles()
    }
  }, [isVaultConnected, vaultPath, loadFiles])

  // Handle sidebar resize
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingSidebar) {
        const newWidth = e.clientX - 48
        setSidebarWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      setIsResizingSidebar(false)
      setIsResizingDetails(false)
    }

    if (isResizingSidebar || isResizingDetails) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = isResizingSidebar ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizingSidebar, isResizingDetails, setSidebarWidth])

  // Menu event handlers
  useEffect(() => {
    if (!window.electronAPI) return

    const cleanup = window.electronAPI.onMenuEvent((event) => {
      switch (event) {
        case 'menu:set-working-dir':
          handleOpenVault()
          break
        case 'menu:toggle-sidebar':
          toggleSidebar()
          break
        case 'menu:toggle-details':
          toggleDetailsPanel()
          break
        case 'menu:refresh':
          loadFiles()
          break
      }
    })

    return cleanup
  }, [handleOpenVault, toggleSidebar, toggleDetailsPanel, loadFiles])

  // File change watcher - auto-refresh when files change externally
  // Completely disabled during sync operations for smooth performance
  useEffect(() => {
    if (!window.electronAPI || !vaultPath) return
    
    let refreshTimeout: NodeJS.Timeout | null = null
    
    const cleanup = window.electronAPI.onFilesChanged((changedFiles) => {
      // Completely skip ALL updates during sync operations
      const { syncProgress } = usePDMStore.getState()
      if (syncProgress.isActive) {
        return // Silent skip - no logging, no processing
      }
      
      console.log('[FileWatcher] Files changed:', changedFiles.length, 'files')
      
      // Debounce - wait for changes to settle
      if (refreshTimeout) {
        clearTimeout(refreshTimeout)
      }
      
      refreshTimeout = setTimeout(() => {
        loadFiles(true) // Silent refresh
        refreshTimeout = null
      }, 1000) // Wait 1 second after last change
    })
    
    return cleanup
  }, [vaultPath, loadFiles])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'o':
            if (e.shiftKey) {
              e.preventDefault()
              handleOpenVault()
            }
            break
          case 'b':
            e.preventDefault()
            toggleSidebar()
            break
          case 'd':
            e.preventDefault()
            toggleDetailsPanel()
            break
        }
      }
      
      if (e.key === 'F5') {
        e.preventDefault()
        loadFiles()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleOpenVault, toggleSidebar, toggleDetailsPanel, loadFiles])

  // Determine if we should show the welcome screen
  const showWelcome = (!user && !isOfflineMode) || !hasVaultConnected

  return (
    <div className="h-screen flex flex-col bg-pdm-bg overflow-hidden">
      <MenuBar
        onOpenVault={handleOpenVault}
        onRefresh={loadFiles}
      />

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        <ActivityBar />

        {sidebarVisible && !showWelcome && (
          <>
            <Sidebar 
              onOpenVault={handleOpenVault}
              onOpenRecentVault={handleOpenRecentVault}
            />
            <div
              className="w-1 bg-pdm-border hover:bg-pdm-accent cursor-col-resize transition-colors flex-shrink-0"
              onMouseDown={() => setIsResizingSidebar(true)}
            />
          </>
        )}

        {/* Main Content */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {showWelcome ? (
            <WelcomeScreen 
              onOpenVault={handleOpenVault}
              onOpenRecentVault={handleOpenRecentVault}
            />
          ) : (
            <>
              {/* File Browser */}
              <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                <FileBrowser onRefresh={loadFiles} />
          </div>

              {/* Details Panel */}
              {detailsPanelVisible && (
                <>
                  <div
                    className="h-1 bg-pdm-border hover:bg-pdm-accent cursor-row-resize transition-colors flex-shrink-0"
                    onMouseDown={() => setIsResizingDetails(true)}
                  />
          <DetailsPanel />
                </>
              )}
            </>
          )}
        </div>
      </div>

      <StatusBar />
      <Toast />
    </div>
  )
}

export default App
