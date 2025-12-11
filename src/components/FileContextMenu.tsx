import { 
  Trash2, 
  Copy, 
  Scissors, 
  ClipboardPaste,
  FolderOpen,
  ExternalLink,
  ArrowDown,
  ArrowUp,
  Edit,
  FolderPlus,
  Pin,
  History,
  Info,
  Loader2,
  EyeOff,
  FileX,
  FolderX,
  Unlock,
  AlertTriangle,
  File
} from 'lucide-react'
import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import { usePDMStore, LocalFile } from '../stores/pdmStore'
import { checkoutFile, checkinFile, syncFile, softDeleteFile, adminForceDiscardCheckout } from '../lib/supabase'
import { getDownloadUrl } from '../lib/storage'

// Build full path using the correct separator for the platform
function buildFullPath(vaultPath: string, relativePath: string): string {
  // Detect platform from vaultPath - macOS/Linux use /, Windows uses \
  const isWindows = vaultPath.includes('\\')
  const sep = isWindows ? '\\' : '/'
  const normalizedRelative = relativePath.replace(/[/\\]/g, sep)
  return `${vaultPath}${sep}${normalizedRelative}`
}

// Get parent directory from a path
function getParentDir(fullPath: string): string {
  const lastSlash = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'))
  return lastSlash > 0 ? fullPath.substring(0, lastSlash) : fullPath
}

interface FileContextMenuProps {
  x: number
  y: number
  files: LocalFile[]  // All files in the vault
  contextFiles: LocalFile[]  // Files being right-clicked
  onClose: () => void
  onRefresh: (silent?: boolean) => void
  // Optional handlers for clipboard operations
  clipboard?: { files: LocalFile[]; operation: 'copy' | 'cut' } | null
  onCopy?: () => void
  onCut?: () => void
  onPaste?: () => void
  onRename?: (file: LocalFile) => void
  onNewFolder?: () => void
}

export function FileContextMenu({
  x,
  y,
  files,
  contextFiles,
  onClose,
  onRefresh,
  clipboard,
  onCopy,
  onCut,
  onPaste,
  onRename,
  onNewFolder
}: FileContextMenuProps) {
  const { user, organization, vaultPath, activeVaultId, addToast, addProgressToast, updateProgressToast, removeToast, isProgressToastCancelled, pinnedFolders, pinFolder, unpinFolder, connectedVaults, addProcessingFolder, removeProcessingFolder, updateFileInStore, removeFilesFromStore, addIgnorePattern, getIgnorePatterns } = usePDMStore()
  
  const [showProperties, setShowProperties] = useState(false)
  const [folderSize, setFolderSize] = useState<{ size: number; fileCount: number; folderCount: number } | null>(null)
  const [isCalculatingSize, setIsCalculatingSize] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteConfirmFiles, setDeleteConfirmFiles] = useState<LocalFile[]>([])
  const [platform, setPlatform] = useState<string>('win32')
  const [showIgnoreSubmenu, setShowIgnoreSubmenu] = useState(false)
  const ignoreSubmenuTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  
  // For positioning the menu within viewport bounds
  const menuRef = useRef<HTMLDivElement>(null)
  const [adjustedPosition, setAdjustedPosition] = useState({ x, y })
  const [submenuPosition, setSubmenuPosition] = useState<'right' | 'left'>('right')
  
  // Handle submenu hover with delay to prevent accidental closing
  const handleIgnoreSubmenuEnter = () => {
    if (ignoreSubmenuTimeoutRef.current) {
      clearTimeout(ignoreSubmenuTimeoutRef.current)
      ignoreSubmenuTimeoutRef.current = null
    }
    setShowIgnoreSubmenu(true)
  }
  
  const handleIgnoreSubmenuLeave = () => {
    ignoreSubmenuTimeoutRef.current = setTimeout(() => {
      setShowIgnoreSubmenu(false)
    }, 150) // Small delay to allow moving to submenu
  }
  
  // Toggle submenu on click (for touch/trackpad users)
  const handleIgnoreSubmenuClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowIgnoreSubmenu(prev => !prev)
  }
  
  // Get platform for UI text
  useEffect(() => {
    window.electronAPI?.getPlatform().then(setPlatform)
  }, [])
  
  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (ignoreSubmenuTimeoutRef.current) {
        clearTimeout(ignoreSubmenuTimeoutRef.current)
      }
    }
  }, [])
  
  // Adjust menu position to stay within viewport
  useLayoutEffect(() => {
    if (!menuRef.current) return
    
    const menu = menuRef.current
    const rect = menu.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    
    let newX = x
    let newY = y
    
    // Check right overflow
    if (x + rect.width > viewportWidth - 10) {
      newX = viewportWidth - rect.width - 10
    }
    
    // Check bottom overflow
    if (y + rect.height > viewportHeight - 10) {
      newY = viewportHeight - rect.height - 10
    }
    
    // Ensure minimum position
    newX = Math.max(10, newX)
    newY = Math.max(10, newY)
    
    setAdjustedPosition({ x: newX, y: newY })
    
    // Determine submenu position based on available space
    const spaceOnRight = viewportWidth - (newX + rect.width)
    const submenuWidth = 220 // approximate submenu width
    setSubmenuPosition(spaceOnRight >= submenuWidth ? 'right' : 'left')
  }, [x, y])
  
  if (contextFiles.length === 0) return null
  
  // Get current vault name for pinning
  const currentVault = connectedVaults.find(v => v.id === activeVaultId)
  const currentVaultName = currentVault?.name || 'Vault'
  
  const multiSelect = contextFiles.length > 1
  const firstFile = contextFiles[0]
  const isFolder = firstFile.isDirectory
  const allFolders = contextFiles.every(f => f.isDirectory)
  const fileCount = contextFiles.filter(f => !f.isDirectory).length
  const folderCount = contextFiles.filter(f => f.isDirectory).length
  
  // Check for synced content - either direct files or files inside selected folders
  const hasSyncedContent = () => {
    for (const item of contextFiles) {
      if (item.isDirectory) {
        const folderPrefix = item.relativePath + '/'
        const hasSyncedInFolder = files.some(f => 
          !f.isDirectory && 
          f.pdmData &&
          f.diffStatus !== 'cloud' &&
          (f.relativePath.startsWith(folderPrefix) || 
           f.relativePath.substring(0, f.relativePath.lastIndexOf('/')) === item.relativePath)
        )
        if (hasSyncedInFolder) return true
      } else if (item.pdmData && item.diffStatus !== 'cloud') {
        return true
      }
    }
    return false
  }
  const anySynced = hasSyncedContent()
  
  // Check for unsynced content
  const hasUnsyncedContent = () => {
    for (const item of contextFiles) {
      if (item.isDirectory) {
        const folderPrefix = item.relativePath + '/'
        const hasUnsyncedInFolder = files.some(f => 
          !f.isDirectory && 
          !f.pdmData &&
          (f.relativePath.startsWith(folderPrefix) || 
           f.relativePath.substring(0, f.relativePath.lastIndexOf('/')) === item.relativePath)
        )
        if (hasUnsyncedInFolder) return true
      } else if (!item.pdmData) {
        return true
      }
    }
    return false
  }
  const anyUnsynced = hasUnsyncedContent()
  
  // Get all synced files in selection (deduplicated by path)
  const getSyncedFilesInSelection = (): LocalFile[] => {
    const result: LocalFile[] = []
    for (const item of contextFiles) {
      if (item.isDirectory) {
        const folderPrefix = item.relativePath + '/'
        const filesInFolder = files.filter(f => 
          !f.isDirectory && 
          f.pdmData &&
          f.diffStatus !== 'cloud' &&
          (f.relativePath.startsWith(folderPrefix) || 
           f.relativePath.substring(0, f.relativePath.lastIndexOf('/')) === item.relativePath)
        )
        result.push(...filesInFolder)
      } else if (!item.isDirectory && item.pdmData && item.diffStatus !== 'cloud') {
        result.push(item)
      }
    }
    // Deduplicate by path to avoid counting files multiple times
    return [...new Map(result.map(f => [f.path, f])).values()]
  }
  const syncedFilesInSelection = getSyncedFilesInSelection()
  
  // Get unsynced files in selection (deduplicated by path)
  const getUnsyncedFilesInSelection = (): LocalFile[] => {
    const result: LocalFile[] = []
    for (const item of contextFiles) {
      if (item.isDirectory) {
        const folderPrefix = item.relativePath + '/'
        const filesInFolder = files.filter(f => 
          !f.isDirectory && 
          (!f.pdmData || f.diffStatus === 'added') &&
          (f.relativePath.startsWith(folderPrefix) || 
           f.relativePath.substring(0, f.relativePath.lastIndexOf('/')) === item.relativePath)
        )
        result.push(...filesInFolder)
      } else if (!item.isDirectory && (!item.pdmData || item.diffStatus === 'added')) {
        result.push(item)
      }
    }
    // Deduplicate by path to avoid syncing same file multiple times
    return [...new Map(result.map(f => [f.path, f])).values()]
  }
  const unsyncedFilesInSelection = getUnsyncedFilesInSelection()
  
  // Check out/in status
  const allCheckedOut = syncedFilesInSelection.length > 0 && syncedFilesInSelection.every(f => f.pdmData?.checked_out_by)
  const allCheckedIn = syncedFilesInSelection.length > 0 && syncedFilesInSelection.every(f => !f.pdmData?.checked_out_by)
  
  // Count files that can be checked out (synced but not checked out)
  const checkoutableCount = syncedFilesInSelection.filter(f => !f.pdmData?.checked_out_by).length
  // Count files that can be checked in (checked out by current user)
  const checkinableCount = syncedFilesInSelection.filter(f => f.pdmData?.checked_out_by === user?.id).length
  // Count files checked out by others (for admin force release)
  const checkedOutByOthersCount = syncedFilesInSelection.filter(f => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== user?.id).length
  const isAdmin = user?.role === 'admin'
  
  const countLabel = multiSelect 
    ? `(${fileCount > 0 ? `${fileCount} file${fileCount > 1 ? 's' : ''}` : ''}${fileCount > 0 && folderCount > 0 ? ', ' : ''}${folderCount > 0 ? `${folderCount} folder${folderCount > 1 ? 's' : ''}` : ''})`
    : ''
  
  // Check for cloud-only files
  const allCloudOnly = contextFiles.every(f => f.diffStatus === 'cloud')
  const hasUnsyncedLocalFiles = unsyncedFilesInSelection.length > 0
  
  // Count cloud-only files (for download count) - includes files inside folders
  const getCloudOnlyFilesCount = (): number => {
    let count = 0
    for (const item of contextFiles) {
      if (item.isDirectory) {
        const folderPrefix = item.relativePath + '/'
        count += files.filter(f => 
          !f.isDirectory && 
          f.diffStatus === 'cloud' &&
          f.relativePath.startsWith(folderPrefix)
        ).length
      } else if (item.diffStatus === 'cloud') {
        count++
      }
    }
    return count
  }
  const cloudOnlyCount = getCloudOnlyFilesCount()
  const anyCloudOnly = cloudOnlyCount > 0 || contextFiles.some(f => f.diffStatus === 'cloud')
  
  // Handlers
  const handleOpen = () => {
    if (firstFile.isDirectory) {
      // Open folder in Windows Explorer
      window.electronAPI?.showInExplorer(firstFile.path)
    } else {
      window.electronAPI?.openFile(firstFile.path)
    }
    onClose()
  }
  
  const handleShowInExplorer = () => {
    window.electronAPI?.showInExplorer(firstFile.path)
    onClose()
  }
  
  const handleCheckout = async () => {
    if (!user) return
    onClose()
    
    const filesToCheckout = syncedFilesInSelection.filter(f => !f.pdmData?.checked_out_by)
    if (filesToCheckout.length === 0) {
      addToast('info', 'All files are already checked out')
      return
    }
    
    // Add folder spinners for folders being processed
    const foldersBeingProcessed = contextFiles.filter(f => f.isDirectory).map(f => f.relativePath)
    foldersBeingProcessed.forEach(p => addProcessingFolder(p))
    
    // Show progress toast
    const toastId = `checkout-${Date.now()}`
    const total = filesToCheckout.length
    addProgressToast(toastId, `Checking out ${total} file${total > 1 ? 's' : ''}...`, total)
    
    let succeeded = 0
    let failed = 0
    let completedCount = 0
    
    const results = await Promise.all(filesToCheckout.map(async (file) => {
      try {
        const result = await checkoutFile(file.pdmData!.id, user.id)
        if (result.success) {
          await window.electronAPI?.setReadonly(file.path, false)
          updateFileInStore(file.path, {
            pdmData: { 
              ...file.pdmData!, 
              checked_out_by: user.id,
              checked_out_user: { 
                full_name: user.full_name, 
                email: user.email, 
                avatar_url: user.avatar_url 
              }
            }
          })
          completedCount++
          const percent = Math.round((completedCount / total) * 100)
          updateProgressToast(toastId, completedCount, percent, undefined, `${completedCount}/${total} files`)
          return true
        }
        completedCount++
        const percent = Math.round((completedCount / total) * 100)
        updateProgressToast(toastId, completedCount, percent, undefined, `${completedCount}/${total} files`)
        return false
      } catch {
        completedCount++
        const percent = Math.round((completedCount / total) * 100)
        updateProgressToast(toastId, completedCount, percent, undefined, `${completedCount}/${total} files`)
        return false
      }
    }))
    
    for (const success of results) {
      if (success) succeeded++
      else failed++
    }
    
    // Clean up
    foldersBeingProcessed.forEach(p => removeProcessingFolder(p))
    removeToast(toastId)
    
    if (failed > 0) {
      addToast('warning', `Checked out ${succeeded}/${filesToCheckout.length} files`)
    } else {
      addToast('success', `Checked out ${succeeded} file${succeeded > 1 ? 's' : ''}`)
    }
  }
  
  const handleCheckin = async () => {
    if (!user) return
    onClose()
    
    const filesToCheckin = syncedFilesInSelection.filter(f => f.pdmData?.checked_out_by === user.id)
    if (filesToCheckin.length === 0) {
      addToast('info', 'No files are checked out by you')
      return
    }
    
    // Add folder spinners for folders being processed
    const foldersBeingProcessed = contextFiles.filter(f => f.isDirectory).map(f => f.relativePath)
    foldersBeingProcessed.forEach(p => addProcessingFolder(p))
    
    // Show progress toast
    const toastId = `checkin-${Date.now()}`
    const total = filesToCheckin.length
    addProgressToast(toastId, `Checking in ${total} file${total > 1 ? 's' : ''}...`, total)
    
    let completedCount = 0
    
    const results = await Promise.all(filesToCheckin.map(async (file) => {
      try {
        // Check if file was moved (local path differs from server path)
        const wasFileMoved = file.pdmData?.file_path && file.relativePath !== file.pdmData.file_path
        const wasFileRenamed = file.pdmData?.file_name && file.name !== file.pdmData.file_name
        
        const readResult = await window.electronAPI?.readFile(file.path)
        if (readResult?.success && readResult.hash) {
          const result = await checkinFile(file.pdmData!.id, user.id, {
            newContentHash: readResult.hash,
            newFileSize: file.size,
            newFilePath: wasFileMoved ? file.relativePath : undefined,
            newFileName: wasFileRenamed ? file.name : undefined
          })
          if (result.success && result.file) {
            await window.electronAPI?.setReadonly(file.path, true)
            updateFileInStore(file.path, {
              pdmData: { ...file.pdmData!, ...result.file, checked_out_by: null, checked_out_user: null },
              localHash: readResult.hash,
              diffStatus: undefined,
              localActiveVersion: undefined
            })
            completedCount++
            const percent = Math.round((completedCount / total) * 100)
            updateProgressToast(toastId, completedCount, percent, undefined, `${completedCount}/${total} files`)
            return true
          }
          completedCount++
          const percent = Math.round((completedCount / total) * 100)
          updateProgressToast(toastId, completedCount, percent, undefined, `${completedCount}/${total} files`)
          return false
        } else {
          const result = await checkinFile(file.pdmData!.id, user.id, {
            newFilePath: wasFileMoved ? file.relativePath : undefined,
            newFileName: wasFileRenamed ? file.name : undefined
          })
          if (result.success && result.file) {
            await window.electronAPI?.setReadonly(file.path, true)
            updateFileInStore(file.path, {
              pdmData: { ...file.pdmData!, ...result.file, checked_out_by: null, checked_out_user: null },
              localHash: result.file.content_hash,
              diffStatus: undefined,
              localActiveVersion: undefined
            })
            completedCount++
            const percent = Math.round((completedCount / total) * 100)
            updateProgressToast(toastId, completedCount, percent, undefined, `${completedCount}/${total} files`)
            return true
          }
          completedCount++
          const percent = Math.round((completedCount / total) * 100)
          updateProgressToast(toastId, completedCount, percent, undefined, `${completedCount}/${total} files`)
          return false
        }
      } catch {
        completedCount++
        const percent = Math.round((completedCount / total) * 100)
        updateProgressToast(toastId, completedCount, percent, undefined, `${completedCount}/${total} files`)
        return false
      }
    }))
    
    const succeeded = results.filter(Boolean).length
    const failed = results.length - succeeded
    
    // Clean up
    foldersBeingProcessed.forEach(p => removeProcessingFolder(p))
    removeToast(toastId)
    
    if (failed > 0) {
      addToast('warning', `Checked in ${succeeded}/${filesToCheckin.length} files`)
    } else {
      addToast('success', `Checked in ${succeeded} file${succeeded > 1 ? 's' : ''}`)
    }
  }
  
  const handleFirstCheckin = async () => {
    if (!user || !organization || !activeVaultId) return
    onClose()
    
    const filesToSync = unsyncedFilesInSelection
    if (filesToSync.length === 0) {
      addToast('info', 'No unsynced files to check in')
      return
    }
    
    // Add folder spinners for folders being processed
    const foldersBeingProcessed = contextFiles.filter(f => f.isDirectory).map(f => f.relativePath)
    foldersBeingProcessed.forEach(p => addProcessingFolder(p))
    
    // Show progress toast
    const toastId = `first-checkin-${Date.now()}`
    const total = filesToSync.length
    const totalBytes = filesToSync.reduce((sum, f) => sum + f.size, 0)
    const startTime = Date.now()
    addProgressToast(toastId, `Uploading ${total} file${total > 1 ? 's' : ''}...`, totalBytes)
    
    // Progress tracking for parallel uploads
    let completedBytes = 0
    let lastUpdateTime = startTime
    let lastUpdateBytes = 0
    
    const formatSpeed = (bytesPerSec: number) => {
      if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
      if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
      return `${bytesPerSec.toFixed(0)} B/s`
    }
    
    const formatBytes = (bytes: number) => {
      if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${bytes} B`
    }
    
    const updateProgress = () => {
      const now = Date.now()
      const elapsedSinceLastUpdate = (now - lastUpdateTime) / 1000
      const bytesSinceLastUpdate = completedBytes - lastUpdateBytes
      
      // Calculate speed based on recent progress (smoother display)
      const recentSpeed = elapsedSinceLastUpdate > 0 ? bytesSinceLastUpdate / elapsedSinceLastUpdate : 0
      // Also calculate overall speed as fallback
      const overallElapsed = (now - startTime) / 1000
      const overallSpeed = overallElapsed > 0 ? completedBytes / overallElapsed : 0
      // Use recent speed if we have meaningful data, otherwise overall
      const displaySpeed = recentSpeed > 0 ? recentSpeed : overallSpeed
      
      // Percent based on bytes uploaded
      const percent = totalBytes > 0 ? Math.round((completedBytes / totalBytes) * 100) : 0
      // Label shows "214/398 MB" format
      const label = `${formatBytes(completedBytes)}/${formatBytes(totalBytes)}`
      updateProgressToast(toastId, completedBytes, percent, formatSpeed(displaySpeed), label)
      
      lastUpdateTime = now
      lastUpdateBytes = completedBytes
    }
    
    const results = await Promise.all(filesToSync.map(async (file) => {
      try {
        const readResult = await window.electronAPI?.readFile(file.path)
        if (readResult?.success && readResult.data && readResult.hash) {
          const { error, file: syncedFile } = await syncFile(
            organization.id,
            activeVaultId,
            user.id,
            file.relativePath,
            file.name,
            file.extension,
            file.size,
            readResult.hash,
            readResult.data
          )
          if (!error && syncedFile) {
            await window.electronAPI?.setReadonly(file.path, true)
            updateFileInStore(file.path, {
              pdmData: syncedFile,
              localHash: readResult.hash,
              diffStatus: undefined
            })
            completedBytes += file.size
            updateProgress()
            return true
          }
        }
        completedBytes += file.size
        updateProgress()
        return false
      } catch {
        completedBytes += file.size
        updateProgress()
        return false
      }
    }))
    
    const succeeded = results.filter(Boolean).length
    const failed = results.length - succeeded
    
    // Clean up
    foldersBeingProcessed.forEach(p => removeProcessingFolder(p))
    removeToast(toastId)
    
    if (failed > 0) {
      addToast('warning', `Synced ${succeeded}/${filesToSync.length} files`)
    } else {
      addToast('success', `Synced ${succeeded} file${succeeded > 1 ? 's' : ''} to cloud`)
    }
  }
  
  const handleDownload = async () => {
    if (!organization || !vaultPath) return
    onClose()
    
    // Get folder paths being operated on
    const foldersBeingProcessed = contextFiles.filter(f => f.isDirectory).map(f => f.relativePath)
    
    // Define the download operation
    const executeDownload = async () => {
      // Get cloud-only files and track which folders actually have files to download
      const cloudFiles: LocalFile[] = []
      const foldersWithCloudFiles: string[] = []
      
      for (const item of contextFiles) {
        if (item.isDirectory) {
          const folderPrefix = item.relativePath + '/'
          const filesInFolder = files.filter(f => 
            !f.isDirectory && 
            f.diffStatus === 'cloud' &&
            f.relativePath.startsWith(folderPrefix)
          )
          if (filesInFolder.length > 0) {
            cloudFiles.push(...filesInFolder)
            foldersWithCloudFiles.push(item.relativePath)
          }
        } else if (item.diffStatus === 'cloud' && item.pdmData) {
          cloudFiles.push(item)
        }
      }
      
      if (cloudFiles.length === 0) {
        addToast('info', 'No cloud files to download')
        return
      }
      
      // Only track folders that actually have files to download
      foldersWithCloudFiles.forEach(p => addProcessingFolder(p))
      
      // Create a unique toast ID for this download operation
      const toastId = `download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      const folderName = foldersWithCloudFiles.length > 0 
        ? foldersWithCloudFiles[0].split('/').pop() 
        : 'files'
      
    let succeeded = 0
    let failed = 0
    let downloadedBytes = 0
    const startTime = Date.now()
    const total = cloudFiles.length
    const totalBytes = cloudFiles.reduce((sum, f) => sum + (f.pdmData?.file_size || 0), 0)
    
    addProgressToast(toastId, `Downloading ${folderName}...`, totalBytes)
    
    // Progress tracking for parallel downloads
    let completedCount = 0
    let completedBytes = 0
    let lastUpdateTime = startTime
    let lastUpdateBytes = 0
    
    const formatSpeed = (bytesPerSec: number) => {
      if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
      if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
      return `${bytesPerSec.toFixed(0)} B/s`
    }
    
    const formatBytes = (bytes: number) => {
      if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${bytes} B`
    }
    
    const updateProgress = () => {
      const now = Date.now()
      const elapsedSinceLastUpdate = (now - lastUpdateTime) / 1000
      const bytesSinceLastUpdate = completedBytes - lastUpdateBytes
      
      // Calculate speed based on recent progress (smoother display)
      const recentSpeed = elapsedSinceLastUpdate > 0 ? bytesSinceLastUpdate / elapsedSinceLastUpdate : 0
      // Also calculate overall speed as fallback
      const overallElapsed = (now - startTime) / 1000
      const overallSpeed = overallElapsed > 0 ? completedBytes / overallElapsed : 0
      // Use recent speed if we have meaningful data, otherwise overall
      const displaySpeed = recentSpeed > 0 ? recentSpeed : overallSpeed
      
      // Percent based on bytes downloaded
      const percent = totalBytes > 0 ? Math.round((completedBytes / totalBytes) * 100) : 0
      // Label shows "214/398 MB" format
      const label = `${formatBytes(completedBytes)}/${formatBytes(totalBytes)}`
      updateProgressToast(toastId, completedBytes, percent, formatSpeed(displaySpeed), label)
      
      lastUpdateTime = now
      lastUpdateBytes = completedBytes
    }
    
    // Check for cancellation before starting
    let wasCancelled = false
    if (isProgressToastCancelled(toastId)) {
      wasCancelled = true
    } else {
      const results = await Promise.all(cloudFiles.map(async (file) => {
        if (!file.pdmData?.content_hash) return { success: false, size: 0 }
        
        const fullPath = buildFullPath(vaultPath, file.relativePath)
        const parentDir = getParentDir(fullPath)
        await window.electronAPI?.createFolder(parentDir)
        
        let result: { success: boolean; size: number } = { success: false, size: 0 }
        
        try {
          const { url, error: urlError } = await getDownloadUrl(organization.id, file.pdmData.content_hash)
          if (urlError || !url) {
            console.error('Failed to get download URL for', file.name, ':', urlError)
          } else {
            const downloadResult = await window.electronAPI?.downloadUrl(url, fullPath)
            if (downloadResult?.success) {
              await window.electronAPI?.setReadonly(fullPath, true)
              result = { success: true, size: downloadResult.size || file.pdmData?.file_size || 0 }
            }
          }
        } catch (err) {
          console.error('Download exception for', file.name, ':', err)
        }
        
        // Update counters and progress after each file completes
        completedCount++
        if (result.success) {
          completedBytes += result.size
        }
        updateProgress()
        
        return result
      }))
      
      for (const result of results) {
        if (result.success) {
          succeeded++
          downloadedBytes += result.size
        } else {
          failed++
        }
      }
    }
    
    // Remove progress toast
    removeToast(toastId)
    foldersWithCloudFiles.forEach(p => removeProcessingFolder(p))
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
    const avgSpeed = formatSpeed(downloadedBytes / Math.max(parseFloat(totalTime), 0.001))
    
    if (wasCancelled) {
      addToast('warning', `Download stopped. ${succeeded} files downloaded.`)
    } else if (failed > 0) {
      addToast('warning', `Downloaded ${succeeded}/${cloudFiles.length} files in ${totalTime}s (${avgSpeed})`)
    } else {
      addToast('success', `Downloaded ${succeeded} file${succeeded > 1 ? 's' : ''} in ${totalTime}s (${avgSpeed})`)
    }
    onRefresh(true)
    }
    
    // Execute immediately
    executeDownload()
  }
  
  const handleDeleteLocal = async () => {
    onClose()
    
    // Get folder paths being operated on
    const foldersBeingProcessed = contextFiles.filter(f => f.isDirectory).map(f => f.relativePath)
    // Also include individual files for spinner display
    const filesBeingProcessed = contextFiles.filter(f => !f.isDirectory).map(f => f.relativePath)
    const allPathsBeingProcessed = [...foldersBeingProcessed, ...filesBeingProcessed]
    
    // Define the delete operation
    const executeDelete = async () => {
      // Track folders AND files being processed for spinner display
      allPathsBeingProcessed.forEach(p => addProcessingFolder(p))
      
      // Get files to remove - both synced files that exist locally AND unsynced local files
      const syncedLocalFiles = syncedFilesInSelection.filter(f => f.diffStatus !== 'cloud')
      const unsyncedLocalFiles = unsyncedFilesInSelection.filter(f => !f.isDirectory)
      const filesToRemove = [...syncedLocalFiles, ...unsyncedLocalFiles]
      
      if (filesToRemove.length === 0) {
        allPathsBeingProcessed.forEach(p => removeProcessingFolder(p))
        addToast('info', 'No local files to remove')
        return
      }
      
      // Create a unique toast ID for this delete operation
      const toastId = `delete-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      const folderName = foldersBeingProcessed.length > 0 
        ? foldersBeingProcessed[0].split('/').pop() 
        : 'files'
      
    const totalBytes = filesToRemove.reduce((sum, f) => sum + (f.size || f.pdmData?.file_size || 0), 0)
    addProgressToast(toastId, `Removing ${folderName}...`, totalBytes)
      
    let removed = 0
    let failed = 0
    const startTime = Date.now()
    
    // Progress tracking for parallel deletes
    let completedBytes = 0
    let lastUpdateTime = startTime
    let lastUpdateBytes = 0
    
    const formatSpeed = (bytesPerSec: number) => {
      if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
      if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
      return `${bytesPerSec.toFixed(0)} B/s`
    }
    
    const formatBytes = (bytes: number) => {
      if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${bytes} B`
    }
    
    const updateProgress = () => {
      const now = Date.now()
      const elapsedSinceLastUpdate = (now - lastUpdateTime) / 1000
      const bytesSinceLastUpdate = completedBytes - lastUpdateBytes
      const recentSpeed = elapsedSinceLastUpdate > 0 ? bytesSinceLastUpdate / elapsedSinceLastUpdate : 0
      const overallElapsed = (now - startTime) / 1000
      const overallSpeed = overallElapsed > 0 ? completedBytes / overallElapsed : 0
      const displaySpeed = recentSpeed > 0 ? recentSpeed : overallSpeed
      
      const percent = totalBytes > 0 ? Math.round((completedBytes / totalBytes) * 100) : 0
      const label = `${formatBytes(completedBytes)}/${formatBytes(totalBytes)}`
      updateProgressToast(toastId, completedBytes, percent, formatSpeed(displaySpeed), label)
      
      lastUpdateTime = now
      lastUpdateBytes = completedBytes
    }
    
    // Process all files in parallel
    const results = await Promise.all(filesToRemove.map(async (file) => {
      const fileSize = file.size || file.pdmData?.file_size || 0
      
      try {
        // If checked out by me, release the checkout first
        if (file.pdmData?.checked_out_by === user?.id && file.pdmData?.id) {
          await checkinFile(file.pdmData.id, user!.id)
        }
        
        const result = await window.electronAPI?.deleteItem(file.path)
        completedBytes += fileSize
        updateProgress()
        
        if (result?.success) {
          return { success: true, size: fileSize }
        } else {
          console.error('Failed to delete file:', file.name, result?.error)
          return { success: false, size: fileSize }
        }
      } catch (err) {
        console.error('Failed to remove file:', file.name, err)
        completedBytes += fileSize
        updateProgress()
        return { success: false, size: fileSize }
      }
    }))
    
    for (const result of results) {
      if (result.success) {
        removed++
      } else {
        failed++
      }
    }
    
    // Clean up empty parent directories
    if (vaultPath) {
      const parentDirs = new Set<string>()
      for (const file of filesToRemove) {
        let dir = file.path.substring(0, file.path.lastIndexOf('\\'))
        while (dir && dir.length > vaultPath.length) {
          parentDirs.add(dir)
          const lastSlash = dir.lastIndexOf('\\')
          if (lastSlash <= 0) break
          dir = dir.substring(0, lastSlash)
        }
      }
      
      // Also include folders that were selected
      for (const item of contextFiles) {
        if (item.isDirectory && item.diffStatus !== 'cloud') {
          parentDirs.add(item.path)
        }
      }
      
      // Sort by depth (deepest first)
      const sortedDirs = Array.from(parentDirs).sort((a, b) => {
        return b.split('\\').length - a.split('\\').length
      })
      
      for (const dir of sortedDirs) {
        try {
          await window.electronAPI?.deleteItem(dir)
        } catch {
          // Folder might not be empty - expected
        }
      }
    }
    
    // Remove progress toast
    removeToast(toastId)
    allPathsBeingProcessed.forEach(p => removeProcessingFolder(p))
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
    const avgSpeed = formatSpeed(completedBytes / Math.max(parseFloat(totalTime), 0.001))
    
    if (failed > 0) {
      addToast('warning', `Removed ${removed}/${filesToRemove.length} files in ${totalTime}s (${avgSpeed})`)
    } else if (removed > 0) {
      addToast('success', `Removed ${removed} file${removed > 1 ? 's' : ''} in ${totalTime}s (${avgSpeed})`)
    }
    
    onRefresh(true)
    }
    
    // Execute immediately
    executeDelete()
  }
  
  // Handle delete from server (for cloud-only files or synced files)
  const handleDeleteFromServer = () => {
    // Get all synced files to delete from server (including files inside folders)
    const allFilesToDelete: LocalFile[] = []
    
    for (const item of contextFiles) {
      if (item.isDirectory) {
        // Get all synced files inside the folder
        const folderPath = item.relativePath.replace(/\\/g, '/')
        const filesInFolder = files.filter(f => {
          if (f.isDirectory) return false
          if (!f.pdmData?.id) return false
          const filePath = f.relativePath.replace(/\\/g, '/')
          return filePath.startsWith(folderPath + '/')
        })
        allFilesToDelete.push(...filesInFolder)
      } else if (item.pdmData?.id) {
        // Single synced file
        allFilesToDelete.push(item)
      }
    }
    
    // Remove duplicates
    const uniqueFiles = [...new Map(allFilesToDelete.map(f => [f.path, f])).values()]
    
    // Check if we have local folders to delete even if no server files
    const hasLocalFolders = contextFiles.some(f => f.isDirectory && f.diffStatus !== 'cloud')
    
    // Check if we have cloud-only empty folders (nothing to actually delete)
    const hasCloudOnlyFolders = contextFiles.some(f => f.isDirectory && f.diffStatus === 'cloud')
    
    if (uniqueFiles.length === 0 && !hasLocalFolders) {
      if (hasCloudOnlyFolders) {
        // Empty cloud-only folders - remove them from the store directly
        const emptyFolders = contextFiles.filter(f => f.isDirectory && f.diffStatus === 'cloud')
        const pathsToRemove = emptyFolders.map(f => f.path)
        removeFilesFromStore(pathsToRemove)
        addToast('success', `Removed ${emptyFolders.length} empty folder${emptyFolders.length !== 1 ? 's' : ''}`)
        onClose()
      } else {
        addToast('warning', 'No files to delete from server')
        onClose()
      }
      return
    }
    
    // If we have local folders but no server files, skip confirmation and just delete locally
    if (uniqueFiles.length === 0 && hasLocalFolders) {
      // Delete local folders directly
      (async () => {
        onClose()
        const foldersToDelete = contextFiles.filter(f => f.isDirectory && f.diffStatus !== 'cloud')
        foldersToDelete.forEach(f => addProcessingFolder(f.relativePath))
        
        let deleted = 0
        for (const folder of foldersToDelete) {
          try {
            const result = await window.electronAPI?.deleteItem(folder.path)
            if (result?.success) deleted++
          } catch (err) {
            console.error('Failed to delete folder:', folder.path, err)
          }
        }
        
        foldersToDelete.forEach(f => removeProcessingFolder(f.relativePath))
        
        if (deleted > 0) {
          addToast('success', `Deleted ${deleted} folder${deleted !== 1 ? 's' : ''} locally`)
          onRefresh(true)
        }
      })()
      return
    }
    
    setDeleteConfirmFiles(uniqueFiles)
    setShowDeleteConfirm(true)
  }
  
  // Execute server delete after confirmation (soft delete - moves to trash)
  const executeDeleteFromServer = async () => {
    if (!user) return
    
    // Copy state before closing dialog - non-blocking
    const filesToDelete = [...deleteConfirmFiles]
    const foldersToDelete = contextFiles.filter(f => f.isDirectory)
    const foldersSelected = foldersToDelete.map(f => f.relativePath)
    
    // Close dialog immediately
    setShowDeleteConfirm(false)
    setDeleteConfirmFiles([])
    onClose()
    
    // Track files and folders being processed for spinner display
    const pathsBeingProcessed = filesToDelete.map(f => f.relativePath)
    const allPathsBeingProcessed = [...new Set([...pathsBeingProcessed, ...foldersSelected])]
    allPathsBeingProcessed.forEach(p => addProcessingFolder(p))
    
    const toastId = `delete-server-${Date.now()}`
    addProgressToast(toastId, `Deleting...`, 2)
    
    let deletedLocal = 0
    let deletedServer = 0
    
    // STEP 1: Delete ALL local items first in parallel (folders will recursively delete contents)
    // Don't filter by diffStatus - we want to try deleting everything that might exist locally
    const localItemsToDelete = [...contextFiles]
    if (localItemsToDelete.length > 0) {
      const localResults = await Promise.all(localItemsToDelete.map(async (item) => {
        try {
          // Release checkout if needed
          if (item.pdmData?.checked_out_by === user?.id && item.pdmData?.id) {
            await checkinFile(item.pdmData.id, user!.id).catch(() => {})
          }
          const result = await window.electronAPI?.deleteItem(item.path)
          return result?.success || false
        } catch {
          return false
        }
      }))
      deletedLocal = localResults.filter(r => r).length
    }
    
    updateProgressToast(toastId, 1, 50)
    
    // STEP 2: Delete from server in parallel
    if (filesToDelete.length > 0) {
      const serverResults = await Promise.all(filesToDelete.map(async (file) => {
        if (!file.pdmData?.id) return false
        try {
          const result = await softDeleteFile(file.pdmData.id, user.id)
          return result.success
        } catch {
          return false
        }
      }))
      deletedServer = serverResults.filter(r => r).length
    }
    
    updateProgressToast(toastId, 2, 100)
    
    // Clean up spinners
    allPathsBeingProcessed.forEach(p => removeProcessingFolder(p))
    removeToast(toastId)
    
    if (deletedLocal > 0 || deletedServer > 0) {
      // Use server count as the meaningful count (folders count as 1 locally but contain many files)
      const displayCount = deletedServer > 0 ? deletedServer : deletedLocal
      addToast('success', `Deleted ${displayCount} item${displayCount !== 1 ? 's' : ''}`)
      onRefresh(true)
    }
  }

  return (
    <>
      <div 
        className="fixed inset-0 z-50" 
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div 
        ref={menuRef}
        className="context-menu z-[60]"
        style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
      >
        {/* Download - for cloud-only files - show at TOP for cloud folders */}
        {anyCloudOnly && (
          <div className="context-menu-item" onClick={handleDownload}>
            <ArrowDown size={14} className="text-pdm-success" />
            Download {cloudOnlyCount > 0 ? `${cloudOnlyCount} files` : countLabel}
          </div>
        )}
        
        {/* Open - only for local files/folders (not cloud-only) */}
        {!multiSelect && !allCloudOnly && (
          <div className="context-menu-item" onClick={handleOpen}>
            <ExternalLink size={14} />
            {isFolder ? 'Open Folder' : 'Open'}
          </div>
        )}
        
        {/* Show in Explorer/Finder */}
        {!allCloudOnly && (
          <div className="context-menu-item" onClick={handleShowInExplorer}>
            <FolderOpen size={14} />
            {platform === 'darwin' ? 'Reveal in Finder' : 'Show in Explorer'}
          </div>
        )}
        
        {/* Pin/Unpin - for files and folders */}
        {!multiSelect && activeVaultId && (
          (() => {
            const isPinned = pinnedFolders.some(p => p.path === firstFile.relativePath && p.vaultId === activeVaultId)
            return (
              <div 
                className="context-menu-item"
                onClick={() => {
                  if (isPinned) {
                    unpinFolder(firstFile.relativePath)
                    addToast('info', `Unpinned ${firstFile.name}`)
                  } else {
                    pinFolder(firstFile.relativePath, activeVaultId, currentVaultName, firstFile.isDirectory)
                    addToast('success', `Pinned ${firstFile.name}`)
                  }
                  onClose()
                }}
              >
                <Pin size={14} className={isPinned ? 'fill-pdm-accent text-pdm-accent' : ''} />
                {isPinned ? 'Unpin' : `Pin ${isFolder ? 'Folder' : 'File'}`}
              </div>
            )
          })()
        )}
        
        {/* Rename - right after pin */}
        {onRename && !multiSelect && !allCloudOnly && (
          (() => {
            // Synced files require checkout to rename
            const isSynced = !!firstFile.pdmData
            const isCheckedOutByMe = firstFile.pdmData?.checked_out_by === user?.id
            const canRename = !isSynced || isCheckedOutByMe
            
            return (
              <div 
                className={`context-menu-item ${!canRename ? 'disabled' : ''}`}
                onClick={() => { 
                  if (canRename) {
                    onRename(firstFile)
                    onClose()
                  }
                }}
                title={!canRename ? 'Check out file first to rename' : ''}
              >
                <Edit size={14} />
                Rename
                <span className="text-xs text-pdm-fg-muted ml-auto">
                  {!canRename ? '(checkout required)' : 'F2'}
                </span>
              </div>
            )
          })()
        )}
        
        {/* Clipboard operations */}
        {(onCopy || onCut || onPaste) && (
          <>
            <div className="context-menu-separator" />
            {onCopy && (
              <div className="context-menu-item" onClick={() => { onCopy(); onClose(); }}>
                <Copy size={14} />
                Copy
                <span className="text-xs text-pdm-fg-muted ml-auto">Ctrl+C</span>
              </div>
            )}
            {onCut && (() => {
              // Check if files can be cut - need checkout for synced files
              const canCut = contextFiles.every(f => 
                f.isDirectory || 
                !f.pdmData || 
                f.pdmData.checked_out_by === user?.id
              )
              return (
                <div 
                  className={`context-menu-item ${!canCut ? 'disabled' : ''}`}
                  onClick={() => { if (canCut) { onCut(); onClose(); } }}
                  title={!canCut ? 'Check out files first to move them' : undefined}
                >
                  <Scissors size={14} />
                  Cut
                  <span className="text-xs text-pdm-fg-muted ml-auto">Ctrl+X</span>
                </div>
              )
            })()}
            {onPaste && (
              <div 
                className={`context-menu-item ${!clipboard ? 'disabled' : ''}`}
                onClick={() => { if (clipboard) { onPaste(); onClose(); } }}
              >
                <ClipboardPaste size={14} />
                Paste
                <span className="text-xs text-pdm-fg-muted ml-auto">Ctrl+V</span>
              </div>
            )}
          </>
        )}
        
        {/* New Folder */}
        {onNewFolder && isFolder && !multiSelect && !allCloudOnly && (
          <>
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={() => { onNewFolder(); onClose(); }}>
              <FolderPlus size={14} />
              New Folder
            </div>
          </>
        )}
        
        <div className="context-menu-separator" />
        
        {/* First Check In - for unsynced files (show even in mixed selections) */}
        {anyUnsynced && !allCloudOnly && (
          <div className="context-menu-item" onClick={handleFirstCheckin}>
            <ArrowUp size={14} className="text-pdm-success" />
            First Check In {unsyncedFilesInSelection.length > 0 ? `${unsyncedFilesInSelection.length} file${unsyncedFilesInSelection.length !== 1 ? 's' : ''}` : countLabel}
          </div>
        )}
        
        {/* Check Out */}
        <div 
          className={`context-menu-item ${!anySynced || allCheckedOut ? 'disabled' : ''}`}
          onClick={() => {
            if (!anySynced || allCheckedOut) return
            handleCheckout()
          }}
          title={!anySynced ? 'Download files first to enable checkout' : allCheckedOut ? 'Already checked out' : ''}
        >
          <ArrowDown size={14} className={!anySynced ? 'text-pdm-fg-muted' : 'text-pdm-warning'} />
          Check Out {allFolders && !multiSelect && checkoutableCount > 0 ? `${checkoutableCount} files` : countLabel}
          {!anySynced && <span className="text-xs text-pdm-fg-muted ml-auto">(download first)</span>}
          {anySynced && allCheckedOut && <span className="text-xs text-pdm-fg-muted ml-auto">(already out)</span>}
        </div>
        
        {/* Check In */}
        {anySynced && (
          <div 
            className={`context-menu-item ${allCheckedIn || checkinableCount === 0 ? 'disabled' : ''}`}
            onClick={() => {
              if (allCheckedIn || checkinableCount === 0) return
              handleCheckin()
            }}
            title={allCheckedIn ? 'Already checked in' : checkinableCount === 0 ? 'No files checked out by you' : ''}
          >
            <ArrowUp size={14} className={allCheckedIn || checkinableCount === 0 ? 'text-pdm-fg-muted' : 'text-pdm-success'} />
            Check In {allFolders && !multiSelect && checkinableCount > 0 ? `${checkinableCount} files` : countLabel}
            {allCheckedIn && <span className="text-xs text-pdm-fg-muted ml-auto">(already in)</span>}
          </div>
        )}
        
        {/* Admin: Force Release - for files checked out by others */}
        {isAdmin && checkedOutByOthersCount > 0 && (
          <div 
            className="context-menu-item text-pdm-error"
            onClick={async () => {
              onClose()
              
              // Get files checked out by others
              const filesToRelease = syncedFilesInSelection.filter(f => 
                f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== user?.id
              )
              
              if (filesToRelease.length === 0) return
              
              const total = filesToRelease.length
              const toastId = `force-release-${Date.now()}`
              let succeeded = 0
              let failed = 0
              
              addProgressToast(toastId, `Force releasing ${total} checkout${total > 1 ? 's' : ''}...`, total)
              
              for (let i = 0; i < filesToRelease.length; i++) {
                const file = filesToRelease[i]
                if (!file.pdmData) continue
                
                try {
                  const result = await adminForceDiscardCheckout(file.pdmData.id, user!.id)
                  if (result.success) {
                    updateFileInStore(file.path, {
                      pdmData: { ...file.pdmData, checked_out_by: null, checked_out_user: null }
                    })
                    succeeded++
                  } else {
                    failed++
                  }
                } catch (err) {
                  console.error('Force release error:', err)
                  failed++
                }
                
                updateProgressToast(toastId, i + 1, Math.round(((i + 1) / total) * 100))
              }
              
              removeToast(toastId)
              
              if (failed > 0) {
                addToast('warning', `Force released ${succeeded}/${total} checkouts (${failed} failed)`)
              } else {
                addToast('success', `Force released ${succeeded} checkout${succeeded > 1 ? 's' : ''}`)
              }
              
              onRefresh(true)
            }}
            title="Admin: Immediately release checkout. User's unsaved changes will be orphaned."
          >
            <Unlock size={14} />
            Force Release {checkedOutByOthersCount > 1 ? `(${checkedOutByOthersCount})` : ''}
          </div>
        )}
        
        <div className="context-menu-separator" />
        
        {/* Show History - for folders, opens in details panel */}
        {!multiSelect && isFolder && (
          <div 
            className="context-menu-item"
            onClick={() => {
              // Open history tab in details panel - it will show folder activity
              const { setDetailsPanelTab, detailsPanelVisible, toggleDetailsPanel } = usePDMStore.getState()
              setDetailsPanelTab('history')
              if (!detailsPanelVisible) toggleDetailsPanel()
              onClose()
            }}
          >
            <History size={14} />
            Show History
          </div>
        )}
        
        {/* Show Deleted Files - for folders, opens trash view with folder filter */}
        {!multiSelect && isFolder && (
          <div 
            className="context-menu-item"
            onClick={() => {
              // Open trash view in sidebar with folder filter
              const { setActiveView, setTrashFolderFilter } = usePDMStore.getState()
              setTrashFolderFilter(firstFile.relativePath)
              setActiveView('trash')
              onClose()
            }}
          >
            <Trash2 size={14} />
            Show Deleted Files
          </div>
        )}
        
        {/* Properties */}
        <div 
          className="context-menu-item"
          onClick={async () => {
            if (isFolder && !multiSelect) {
              setIsCalculatingSize(true)
              setShowProperties(true)
              // Calculate folder size
              const filesInFolder = files.filter(f => 
                !f.isDirectory && f.relativePath.startsWith(firstFile.relativePath + '/')
              )
              const foldersInFolder = files.filter(f => 
                f.isDirectory && f.relativePath.startsWith(firstFile.relativePath + '/') && f.relativePath !== firstFile.relativePath
              )
              let totalSize = 0
              for (const f of filesInFolder) {
                totalSize += f.size || 0
              }
              setFolderSize({
                size: totalSize,
                fileCount: filesInFolder.length,
                folderCount: foldersInFolder.length
              })
              setIsCalculatingSize(false)
            } else {
              setShowProperties(true)
            }
          }}
        >
          <Info size={14} />
          Properties
        </div>
        
        <div className="context-menu-separator" />
        
        {/* Keep Local Only (Ignore) - for unsynced files and folders */}
        {anyUnsynced && !allCloudOnly && activeVaultId && (
          <div 
            className="context-menu-item relative"
            onMouseEnter={handleIgnoreSubmenuEnter}
            onMouseLeave={handleIgnoreSubmenuLeave}
            onClick={handleIgnoreSubmenuClick}
          >
            <EyeOff size={14} />
            Keep Local Only
            <span className="text-xs text-pdm-fg-muted ml-auto">{submenuPosition === 'right' ? '▶' : '◀'}</span>
            
            {/* Submenu */}
            {showIgnoreSubmenu && (
              <div 
                className={`absolute top-0 min-w-[200px] bg-pdm-bg-lighter border border-pdm-border rounded-md py-1 shadow-lg z-[100] ${
                  submenuPosition === 'right' ? 'left-full ml-1' : 'right-full mr-1'
                }`}
                style={{ marginTop: '-4px' }}
                onMouseEnter={handleIgnoreSubmenuEnter}
                onMouseLeave={handleIgnoreSubmenuLeave}
              >
                {/* Ignore this specific file/folder */}
                <div 
                  className="context-menu-item"
                  onClick={(e) => {
                    e.stopPropagation()
                    // For single selection, add exact path pattern
                    for (const file of contextFiles) {
                      if (file.isDirectory) {
                        addIgnorePattern(activeVaultId, file.relativePath + '/')
                      } else {
                        addIgnorePattern(activeVaultId, file.relativePath)
                      }
                    }
                    addToast('success', `Added ${contextFiles.length > 1 ? `${contextFiles.length} items` : contextFiles[0].name} to ignore list`)
                    onRefresh(true)
                    onClose()
                  }}
                >
                  {isFolder ? <FolderX size={14} /> : <FileX size={14} />}
                  This {isFolder ? 'folder' : 'file'}{multiSelect ? ` (${contextFiles.length})` : ''}
                </div>
                
                {/* Ignore all files with this extension - only for files */}
                {!isFolder && !multiSelect && firstFile.extension && (
                  <div 
                    className="context-menu-item"
                    onClick={(e) => {
                      e.stopPropagation()
                      const pattern = `*${firstFile.extension}`
                      addIgnorePattern(activeVaultId, pattern)
                      addToast('success', `Now ignoring all ${firstFile.extension} files`)
                      onRefresh(true)
                      onClose()
                    }}
                  >
                    <FileX size={14} />
                    All *{firstFile.extension} files
                  </div>
                )}
                
                {/* Show current patterns count */}
                {(() => {
                  const currentPatterns = getIgnorePatterns(activeVaultId)
                  if (currentPatterns.length > 0) {
                    return (
                      <>
                        <div className="context-menu-separator" />
                        <div className="px-3 py-1.5 text-xs text-pdm-fg-muted">
                          {currentPatterns.length} pattern{currentPatterns.length > 1 ? 's' : ''} configured
                        </div>
                      </>
                    )
                  }
                  return null
                })()}
              </div>
            )}
          </div>
        )}
        
        {/* Remove Local Copy - for synced files, removes local but keeps server */}
        {anySynced && !allCloudOnly && (
          <div className="context-menu-item" onClick={handleDeleteLocal}>
            <Trash2 size={14} />
            Remove Local Copy {countLabel}
          </div>
        )}
        
        {/* Delete Locally - for unsynced local files only */}
        {hasUnsyncedLocalFiles && !anySynced && !allCloudOnly && (
          <div className="context-menu-item danger" onClick={handleDeleteLocal}>
            <Trash2 size={14} />
            Delete Locally {countLabel}
          </div>
        )}
        
        {/* Delete from Server - soft deletes from server (moves to trash) */}
        {(anySynced || allCloudOnly) && (
          <div className="context-menu-item danger" onClick={handleDeleteFromServer}>
            <Trash2 size={14} />
            {allCloudOnly ? 'Delete from Server' : 'Delete Local & Server'} {countLabel}
          </div>
        )}
      </div>
      
      {/* Properties Modal */}
      {showProperties && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => { setShowProperties(false); onClose(); }} />
          <div className="relative bg-pdm-panel border border-pdm-border rounded-lg shadow-xl w-[400px] max-h-[80vh] overflow-auto">
            <div className="p-4 border-b border-pdm-border flex items-center gap-3">
              <Info size={20} className="text-pdm-accent" />
              <h3 className="font-semibold">Properties</h3>
            </div>
            <div className="p-4 space-y-3">
              {/* Name */}
              <div>
                <div className="text-xs text-pdm-fg-muted uppercase tracking-wide mb-1">Name</div>
                <div className="text-sm">{firstFile.name}</div>
              </div>
              
              {/* Type */}
              <div>
                <div className="text-xs text-pdm-fg-muted uppercase tracking-wide mb-1">Type</div>
                <div className="text-sm">
                  {isFolder ? 'Folder' : (firstFile.extension ? firstFile.extension.toUpperCase() + ' File' : 'File')}
                </div>
              </div>
              
              {/* Location */}
              <div>
                <div className="text-xs text-pdm-fg-muted uppercase tracking-wide mb-1">Location</div>
                <div className="text-sm break-all text-pdm-fg-dim">
                  {firstFile.relativePath.includes('/') 
                    ? firstFile.relativePath.substring(0, firstFile.relativePath.lastIndexOf('/'))
                    : '/'}
                </div>
              </div>
              
              {/* Size */}
              <div>
                <div className="text-xs text-pdm-fg-muted uppercase tracking-wide mb-1">Size</div>
                <div className="text-sm">
                  {isFolder && !multiSelect ? (
                    isCalculatingSize ? (
                      <span className="text-pdm-fg-muted">Calculating...</span>
                    ) : folderSize ? (
                      <span>
                        {formatSize(folderSize.size)}
                        <span className="text-pdm-fg-muted ml-2">
                          ({folderSize.fileCount} file{folderSize.fileCount !== 1 ? 's' : ''}, {folderSize.folderCount} folder{folderSize.folderCount !== 1 ? 's' : ''})
                        </span>
                      </span>
                    ) : '—'
                  ) : multiSelect ? (
                    formatSize(contextFiles.reduce((sum, f) => sum + (f.size || 0), 0))
                  ) : (
                    formatSize(firstFile.size || 0)
                  )}
                </div>
              </div>
              
              {/* Status */}
              {firstFile.pdmData && (
                <div>
                  <div className="text-xs text-pdm-fg-muted uppercase tracking-wide mb-1">Status</div>
                  <div className="text-sm">
                    {firstFile.pdmData.checked_out_by 
                      ? firstFile.pdmData.checked_out_by === user?.id 
                        ? 'Checked out by you'
                        : 'Checked out'
                      : 'Available'}
                  </div>
                </div>
              )}
              
              {/* Sync Status */}
              <div>
                <div className="text-xs text-pdm-fg-muted uppercase tracking-wide mb-1">Sync Status</div>
                <div className="text-sm">
                  {firstFile.diffStatus === 'cloud' ? 'Cloud only (not downloaded)' 
                    : firstFile.diffStatus === 'added' ? 'Local only (not synced)'
                    : firstFile.diffStatus === 'ignored' ? 'Local only (ignored from sync)'
                    : firstFile.diffStatus === 'modified' ? 'Modified locally'
                    : firstFile.diffStatus === 'moved' ? 'Moved (path changed)'
                    : firstFile.diffStatus === 'outdated' ? 'Outdated (newer version on server)'
                    : firstFile.pdmData ? 'Synced' : 'Not synced'}
                </div>
              </div>
              
              {/* Modified Date */}
              {firstFile.modifiedTime && (
                <div>
                  <div className="text-xs text-pdm-fg-muted uppercase tracking-wide mb-1">Modified</div>
                  <div className="text-sm">{new Date(firstFile.modifiedTime).toLocaleString()}</div>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-pdm-border flex justify-end">
              <button
                onClick={() => { setShowProperties(false); onClose(); }}
                className="btn btn-ghost"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Delete from Server Confirmation Dialog */}
      {showDeleteConfirm && (
        <div 
          className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center"
          onClick={() => { setShowDeleteConfirm(false); onClose(); }}
        >
          <div 
            className="bg-pdm-bg-light border border-pdm-border rounded-lg p-6 max-w-md shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-pdm-error/20 flex items-center justify-center">
                <AlertTriangle size={20} className="text-pdm-error" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-pdm-fg">
                  Delete {deleteConfirmFiles.length > 1 ? `${deleteConfirmFiles.length} Files` : 'File'} from Server?
                </h3>
                <p className="text-sm text-pdm-fg-muted">
                  Items will be deleted locally AND from the server.
                </p>
              </div>
            </div>
            
            <div className="bg-pdm-bg rounded border border-pdm-border p-3 mb-4 max-h-40 overflow-y-auto">
              {deleteConfirmFiles.length === 1 ? (
                <div className="flex items-center gap-2">
                  <File size={16} className="text-pdm-fg-muted" />
                  <span className="text-pdm-fg font-medium truncate">{deleteConfirmFiles[0]?.name}</span>
                </div>
              ) : (
                <>
                  <div className="text-sm text-pdm-fg mb-2">
                    {deleteConfirmFiles.length} file{deleteConfirmFiles.length > 1 ? 's' : ''}
                  </div>
                  <div className="space-y-1">
                    {deleteConfirmFiles.slice(0, 5).map((f, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <File size={14} className="text-pdm-fg-muted" />
                        <span className="text-pdm-fg-dim truncate">{f.name}</span>
                      </div>
                    ))}
                    {deleteConfirmFiles.length > 5 && (
                      <div className="text-xs text-pdm-fg-muted">
                        ...and {deleteConfirmFiles.length - 5} more
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            
            {/* Warning */}
            <div className="bg-pdm-warning/10 border border-pdm-warning/30 rounded p-3 mb-4">
              <p className="text-sm text-pdm-warning font-medium">
                ⚠️ {deleteConfirmFiles.length} synced file{deleteConfirmFiles.length > 1 ? 's' : ''} will be deleted from the server.
              </p>
              <p className="text-xs text-pdm-fg-muted mt-1">Files can be recovered from trash within 30 days.</p>
            </div>
            
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowDeleteConfirm(false); onClose(); }}
                className="btn btn-ghost"
              >
                Cancel
              </button>
              <button
                onClick={executeDeleteFromServer}
                className="btn bg-pdm-error hover:bg-pdm-error/80 text-white"
              >
                <Trash2 size={14} />
                Delete from Server {deleteConfirmFiles.length > 1 ? `(${deleteConfirmFiles.length})` : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Helper function to format file size
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

