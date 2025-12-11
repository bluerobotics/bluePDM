import { useState } from 'react'
import { Lock, File, ArrowUp, Undo2, CheckSquare, Square, Plus, Trash2, Upload, X, AlertTriangle, Shield, Unlock, FolderOpen } from 'lucide-react'
import { usePDMStore, LocalFile } from '../../stores/pdmStore'
import { getInitials } from '../../types/pdm'
import { checkinFile, syncFile, adminForceDiscardCheckout } from '../../lib/supabase'
import { getDownloadUrl } from '../../lib/storage'

interface CheckoutViewProps {
  onRefresh: (silent?: boolean) => void
}

export function CheckoutView({ onRefresh }: CheckoutViewProps) {
  const { files, user, organization, vaultPath, addToast, activeVaultId, connectedVaults, addProcessingFolder, removeProcessingFolder, updateFileInStore, addProgressToast, updateProgressToast, removeToast, isProgressToastCancelled, setActiveView, setCurrentFolder, toggleFolder, expandedFolders } = usePDMStore()
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [selectedAddedFiles, setSelectedAddedFiles] = useState<Set<string>>(new Set())
  const [selectedOthersFiles, setSelectedOthersFiles] = useState<Set<string>>(new Set())  // Admin: files checked out by others
  // Separate processing states so operations can run simultaneously
  const [isProcessingCheckedOut, setIsProcessingCheckedOut] = useState(false)
  const [isProcessingAdded, setIsProcessingAdded] = useState(false)
  const [isProcessingOthers, setIsProcessingOthers] = useState(false)  // Admin processing state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  // Track which specific files are being processed to prevent re-selection
  const [processingPaths, setProcessingPaths] = useState<Set<string>>(new Set())
  
  // Get current vault ID
  const currentVaultId = activeVaultId || connectedVaults[0]?.id
  
  // Get files that are checked out by anyone
  const checkedOutFiles = files.filter(f => 
    !f.isDirectory && f.pdmData?.checked_out_by
  )
  
  // Get files checked out by current user
  const myCheckedOutFiles = checkedOutFiles.filter(f => 
    f.pdmData?.checked_out_by === user?.id
  )
  
  // Get files checked out by others
  const othersCheckedOutFiles = checkedOutFiles.filter(f => 
    f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== user?.id
  )
  
  // Get added files (local files not yet synced to cloud)
  const addedFiles = files.filter(f => 
    !f.isDirectory && f.diffStatus === 'added'
  )
  
  const toggleSelect = (path: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }
  
  const selectAll = () => {
    setSelectedFiles(new Set(myCheckedOutFiles.map(f => f.path)))
  }
  
  const selectNone = () => {
    setSelectedFiles(new Set())
  }
  
  const selectedCount = selectedFiles.size
  const allSelected = myCheckedOutFiles.length > 0 && selectedCount === myCheckedOutFiles.length
  
  // Added files selection
  const toggleSelectAdded = (path: string) => {
    setSelectedAddedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }
  
  const selectAllAdded = () => {
    setSelectedAddedFiles(new Set(addedFiles.map(f => f.path)))
  }
  
  const selectNoneAdded = () => {
    setSelectedAddedFiles(new Set())
  }
  
  const selectedAddedCount = selectedAddedFiles.size
  const allAddedSelected = addedFiles.length > 0 && selectedAddedCount === addedFiles.length
  
  // Admin: Selection for files checked out by others
  const isAdmin = user?.role === 'admin'
  
  const toggleSelectOthers = (path: string) => {
    setSelectedOthersFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }
  
  const selectAllOthers = () => {
    setSelectedOthersFiles(new Set(othersCheckedOutFiles.map(f => f.path)))
  }
  
  const selectNoneOthers = () => {
    setSelectedOthersFiles(new Set())
  }
  
  const selectedOthersCount = selectedOthersFiles.size
  const allOthersSelected = othersCheckedOutFiles.length > 0 && selectedOthersCount === othersCheckedOutFiles.length
  
  // Check in checked-out files (modified files)
  const handleCheckin = async () => {
    if (!organization || !user || selectedCount === 0) return
    
    setIsProcessingCheckedOut(true)
    
    const filesToCheckin = Array.from(selectedFiles)
    const total = filesToCheckin.length
    const toastId = `checkin-${Date.now()}`
    
    // Track which files are being processed to prevent re-selection
    setProcessingPaths(prev => new Set([...prev, ...filesToCheckin]))
    // Clear selection immediately so user can't re-select
    setSelectedFiles(new Set())
    
    // Add spinners for all files being processed
    const processedPaths: string[] = []
    filesToCheckin.forEach(path => {
      const file = myCheckedOutFiles.find(f => f.path === path)
      if (file) {
        addProcessingFolder(file.relativePath)
        processedPaths.push(file.relativePath)
      }
    })
    
    // Calculate total bytes for progress tracking
    const fileObjects = filesToCheckin.map(path => myCheckedOutFiles.find(f => f.path === path)).filter(Boolean)
    const totalBytes = fileObjects.reduce((sum, f) => sum + (f?.size || f?.pdmData?.file_size || 0), 0)
    
    addProgressToast(toastId, `Checking in ${total} file${total > 1 ? 's' : ''}...`, totalBytes)
    
    const startTime = Date.now()
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
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
    
    try {
      // Process files in parallel for better performance (same logic as FileBrowser inline checkin)
      const results = await Promise.all(fileObjects.map(async (file) => {
        if (!file || !file.pdmData) {
          return false
        }
        
        const fileSize = file.size || file.pdmData?.file_size || 0
        
        try {
          const result = await checkinFile(file.pdmData.id, user.id, {
            pendingMetadata: file.pendingMetadata
          })
          
          if (result.success && result.file) {
            await window.electronAPI?.setReadonly(file.path, true)
            updateFileInStore(file.path, {
              pdmData: { ...file.pdmData, checked_out_by: null, checked_out_user: null, ...result.file },
              localActiveVersion: undefined
            })
            removeProcessingFolder(file.relativePath)
            completedBytes += fileSize
            updateProgress()
            return true
          } else if (result.success) {
            await window.electronAPI?.setReadonly(file.path, true)
            updateFileInStore(file.path, {
              pdmData: { ...file.pdmData, checked_out_by: null, checked_out_user: null },
              localActiveVersion: undefined
            })
            removeProcessingFolder(file.relativePath)
            completedBytes += fileSize
            updateProgress()
            return true
          }
          
          removeProcessingFolder(file.relativePath)
          completedBytes += fileSize
          updateProgress()
          return false
        } catch (err) {
          console.error('Check in error:', err)
          removeProcessingFolder(file.relativePath)
          completedBytes += fileSize
          updateProgress()
          return false
        }
      }))
      
      const succeeded = results.filter(r => r).length
      const failed = results.filter(r => !r).length
      
      removeToast(toastId)
      
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
      const avgSpeed = formatSpeed(completedBytes / Math.max(parseFloat(totalTime), 0.001))
      
      if (failed > 0) {
        addToast('warning', `Checked in ${succeeded}/${total} files in ${totalTime}s (${avgSpeed})`)
      } else {
        addToast('success', `Checked in ${succeeded} file${succeeded > 1 ? 's' : ''} in ${totalTime}s (${avgSpeed})`)
      }
    } finally {
      // Clean up any remaining spinners
      processedPaths.forEach(p => removeProcessingFolder(p))
      // Remove from processing paths
      setProcessingPaths(prev => {
        const next = new Set(prev)
        filesToCheckin.forEach(p => next.delete(p))
        return next
      })
      setIsProcessingCheckedOut(false)
    }
  }
  
  // Check in new files (sync to cloud)
  const handleCheckinAddedFiles = async () => {
    if (!organization || !user || !currentVaultId || selectedAddedCount === 0) return
    
    setIsProcessingAdded(true)
    const filesToSync = Array.from(selectedAddedFiles)
    const total = filesToSync.length
    
    const api = (window as any).electronAPI
    if (!api) {
      addToast('error', 'Electron API not available')
      setIsProcessingAdded(false)
      return
    }
    
    // Track which files are being processed to prevent re-selection
    setProcessingPaths(prev => new Set([...prev, ...filesToSync]))
    // Clear selection immediately so user can't re-select
    setSelectedAddedFiles(new Set())
    
    // Add spinners for all files being processed
    const processedPaths: string[] = []
    filesToSync.forEach(path => {
      const file = addedFiles.find(f => f.path === path)
      if (file) {
        addProcessingFolder(file.relativePath)
        processedPaths.push(file.relativePath)
      }
    })
    
    // Calculate total bytes for progress tracking
    const fileObjects = filesToSync.map(path => addedFiles.find(f => f.path === path)).filter(Boolean)
    const totalBytes = fileObjects.reduce((sum, f) => sum + (f?.size || 0), 0)
    
    const toastId = `sync-${Date.now()}`
    addProgressToast(toastId, `Checking in ${total} new file${total > 1 ? 's' : ''}...`, totalBytes)
    
    const startTime = Date.now()
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
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
    
    try {
      // Process files in parallel for better performance
      const results = await Promise.all(filesToSync.map(async (path) => {
        const file = addedFiles.find(f => f.path === path)
        const fileSize = file?.size || 0
        
        if (!file) {
          completedBytes += fileSize
          updateProgress()
          return false
        }
        
        try {
          const readResult = await api.readFile(file.path)
          if (!readResult?.success || !readResult.data || !readResult.hash) {
            console.error('Failed to read file:', file.name)
            removeProcessingFolder(file.relativePath)
            completedBytes += fileSize
            updateProgress()
            return false
          }
          
          const { file: syncedFile, error } = await syncFile(
            organization.id,
            currentVaultId,
            user.id,
            file.relativePath,
            file.name,
            file.extension,
            file.size,
            readResult.hash,
            readResult.data
          )
          
          if (error) {
            console.error('Sync failed:', error)
            removeProcessingFolder(file.relativePath)
            completedBytes += fileSize
            updateProgress()
            return false
          }
          
          await api.setReadonly(file.path, true)
          if (syncedFile) {
            updateFileInStore(file.path, {
              pdmData: syncedFile,
              localHash: readResult.hash,
              diffStatus: undefined
            })
          }
          removeProcessingFolder(file.relativePath)
          completedBytes += fileSize
          updateProgress()
          return true
        } catch (err) {
          console.error('Check in error:', err)
          removeProcessingFolder(file.relativePath)
          completedBytes += fileSize
          updateProgress()
          return false
        }
      }))
      
      const succeeded = results.filter(r => r).length
      const failed = results.filter(r => !r).length
      
      removeToast(toastId)
      
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
      const avgSpeed = formatSpeed(completedBytes / Math.max(parseFloat(totalTime), 0.001))
      
      if (failed > 0) {
        addToast('warning', `Checked in ${succeeded}/${total} files in ${totalTime}s (${avgSpeed})`)
      } else {
        addToast('success', `Checked in ${succeeded} new file${succeeded > 1 ? 's' : ''} in ${totalTime}s (${avgSpeed})`)
      }
    } finally {
      // Clean up any remaining spinners
      processedPaths.forEach(p => removeProcessingFolder(p))
      // Remove from processing paths
      setProcessingPaths(prev => {
        const next = new Set(prev)
        filesToSync.forEach(p => next.delete(p))
        return next
      })
      setIsProcessingAdded(false)
    }
  }
  
  // Show delete confirmation dialog
  const handleDeleteClick = () => {
    if (selectedAddedCount === 0) return
    setShowDeleteConfirm(true)
  }
  
  // Discard added files (delete local files)
  const handleDiscardAddedFiles = async () => {
    if (!vaultPath || selectedAddedCount === 0) return
    
    setShowDeleteConfirm(false)
    setIsProcessingAdded(true)
    
    const filesToDelete = Array.from(selectedAddedFiles)
    const total = filesToDelete.length
    
    // Track which files are being processed to prevent re-selection
    setProcessingPaths(prev => new Set([...prev, ...filesToDelete]))
    // Clear selection immediately
    setSelectedAddedFiles(new Set())
    
    // Track files being deleted for spinner display
    const fileObjects = filesToDelete.map(path => addedFiles.find(f => f.path === path)).filter(Boolean) as typeof addedFiles
    const pathsBeingDeleted = fileObjects.map(f => f.relativePath)
    pathsBeingDeleted.forEach(p => addProcessingFolder(p))
    
    let succeeded = 0
    let failed = 0
    
    const api = (window as any).electronAPI
    if (!api) {
      addToast('error', 'Electron API not available')
      pathsBeingDeleted.forEach(p => removeProcessingFolder(p))
      setIsProcessingAdded(false)
      return
    }
    
    const totalBytes = fileObjects.reduce((sum, f) => sum + (f?.size || f?.pdmData?.file_size || 0), 0)
    const toastId = `delete-${Date.now()}`
    addProgressToast(toastId, `Deleting ${total} file${total > 1 ? 's' : ''}...`, totalBytes)
    
    const startTime = Date.now()
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
    
    try {
      // Process files in parallel for better performance
      const results = await Promise.all(fileObjects.map(async (file) => {
        if (!file) {
          return false
        }
        
        const fileSize = file.size || file.pdmData?.file_size || 0
        
        try {
          console.log('Deleting file:', file.path)
          const result = await api.deleteItem(file.path)
          completedBytes += fileSize
          updateProgress()
          
          if (result?.success) {
            console.log('Delete succeeded:', file.path)
            return true
          } else {
            console.error('Delete failed:', file.path, result?.error)
            return false
          }
        } catch (err) {
          console.error('Delete error:', file.path, err)
          completedBytes += fileSize
          updateProgress()
          return false
        }
      }))
      
      succeeded = results.filter(r => r).length
      failed = results.filter(r => !r).length
      
      removeToast(toastId)
      
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
      const avgSpeed = formatSpeed(completedBytes / Math.max(parseFloat(totalTime), 0.001))
      
      if (failed > 0) {
        addToast('warning', `Deleted ${succeeded}/${total} files in ${totalTime}s (${avgSpeed})`)
      } else {
        addToast('success', `Deleted ${succeeded} file${succeeded > 1 ? 's' : ''} in ${totalTime}s (${avgSpeed})`)
      }
      
      // Refresh file list to update the UI
      onRefresh(true)
    } finally {
      // Clean up spinners
      pathsBeingDeleted.forEach(p => removeProcessingFolder(p))
      // Remove from processing paths
      setProcessingPaths(prev => {
        const next = new Set(prev)
        filesToDelete.forEach(p => next.delete(p))
        return next
      })
      setIsProcessingAdded(false)
    }
  }
  
  // Discard changes (revert to server version)
  const handleDiscardChanges = async () => {
    if (!organization || !user || !vaultPath || selectedCount === 0) return
    
    setIsProcessingCheckedOut(true)
    
    const api = (window as any).electronAPI
    if (!api) {
      addToast('error', 'Electron API not available')
      setIsProcessingCheckedOut(false)
      return
    }
    
    const filesToDiscard = Array.from(selectedFiles)
    const total = filesToDiscard.length
    
    // Track which files are being processed to prevent re-selection
    setProcessingPaths(prev => new Set([...prev, ...filesToDiscard]))
    // Clear selection immediately
    setSelectedFiles(new Set())
    
    // Add spinners for all files being processed
    const processedPaths: string[] = []
    filesToDiscard.forEach(path => {
      const file = myCheckedOutFiles.find(f => f.path === path)
      if (file) {
        addProcessingFolder(file.relativePath)
        processedPaths.push(file.relativePath)
      }
    })
    
    // Calculate total bytes for progress tracking
    const fileObjects = filesToDiscard.map(path => myCheckedOutFiles.find(f => f.path === path)).filter(Boolean)
    const totalBytes = fileObjects.reduce((sum, f) => sum + (f?.size || f?.pdmData?.file_size || 0), 0)
    
    const toastId = `discard-${Date.now()}`
    addProgressToast(toastId, `Discarding changes for ${total} file${total > 1 ? 's' : ''}...`, totalBytes)
    
    const startTime = Date.now()
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
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
    
    try {
      // Process files in parallel for better performance
      const results = await Promise.all(filesToDiscard.map(async (path) => {
        const file = myCheckedOutFiles.find(f => f.path === path)
        const fileSize = file?.size || file?.pdmData?.file_size || 0
        
        if (!file || !file.pdmData) {
          completedBytes += fileSize
          updateProgress()
          return false
        }
        
        try {
          const contentHash = file.pdmData.content_hash
          if (!contentHash) {
            removeProcessingFolder(file.relativePath)
            completedBytes += fileSize
            updateProgress()
            return false
          }
          
          const { url, error: urlError } = await getDownloadUrl(organization.id, contentHash)
          if (urlError || !url) {
            console.error('Failed to get download URL:', urlError)
            removeProcessingFolder(file.relativePath)
            completedBytes += fileSize
            updateProgress()
            return false
          }
          
          await api.setReadonly(file.path, false)
          const writeResult = await api.downloadUrl(url, file.path)
          
          if (!writeResult?.success) {
            console.error('Download failed:', writeResult?.error)
            removeProcessingFolder(file.relativePath)
            completedBytes += fileSize
            updateProgress()
            return false
          }
          
          const result = await checkinFile(file.pdmData.id, user.id)
          if (!result.success) {
            console.error('Release checkout failed:', result.error)
            removeProcessingFolder(file.relativePath)
            completedBytes += fileSize
            updateProgress()
            return false
          }
          
          await api.setReadonly(file.path, true)
          removeProcessingFolder(file.relativePath)
          completedBytes += fileSize
          updateProgress()
          return true
        } catch (err) {
          console.error('Discard changes error:', err)
          removeProcessingFolder(file.relativePath)
          completedBytes += fileSize
          updateProgress()
          return false
        }
      }))
      
      const succeeded = results.filter(r => r).length
      const failed = results.filter(r => !r).length
      
      removeToast(toastId)
      
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
      const avgSpeed = formatSpeed(completedBytes / Math.max(parseFloat(totalTime), 0.001))
      
      if (failed > 0) {
        addToast('warning', `Discarded ${succeeded}/${total} files in ${totalTime}s (${avgSpeed})`)
      } else {
        addToast('success', `Discarded ${succeeded} file${succeeded > 1 ? 's' : ''} in ${totalTime}s (${avgSpeed})`)
      }
      
      // Refresh file list to update the UI
      onRefresh(true)
    } finally {
      // Clean up any remaining spinners
      processedPaths.forEach(p => removeProcessingFolder(p))
      // Remove from processing paths
      setProcessingPaths(prev => {
        const next = new Set(prev)
        filesToDiscard.forEach(p => next.delete(p))
        return next
      })
      setIsProcessingCheckedOut(false)
    }
  }
  
  // Admin: Force release checkout - immediately releases the checkout lock
  // The server version stays as-is, user's local changes are orphaned
  const handleAdminForceRelease = async () => {
    if (!isAdmin || !organization || selectedOthersCount === 0) return
    
    setIsProcessingOthers(true)
    let succeeded = 0
    let failed = 0
    
    const filesToProcess = Array.from(selectedOthersFiles)
    const total = filesToProcess.length
    
    // Track which files are being processed
    setProcessingPaths(prev => new Set([...prev, ...filesToProcess]))
    // Clear selection immediately
    setSelectedOthersFiles(new Set())
    
    const toastId = `force-release-${Date.now()}`
    addProgressToast(toastId, `Force releasing ${total} checkout${total > 1 ? 's' : ''}...`, total)
    
    try {
      const results = await Promise.all(filesToProcess.map(async (path) => {
        const file = othersCheckedOutFiles.find(f => f.path === path)
        if (!file || !file.pdmData) return false
        
        try {
          const result = await adminForceDiscardCheckout(file.pdmData.id, user!.id)
          if (result.success) {
            updateFileInStore(file.path, {
              pdmData: { ...file.pdmData, checked_out_by: null, checked_out_user: null }
            })
            return true
          }
          console.error('Force release failed:', result.error)
          return false
        } catch (err) {
          console.error('Force release error:', err)
          return false
        }
      }))
      
      succeeded = results.filter(Boolean).length
      failed = results.filter(r => !r).length
      
      removeToast(toastId)
      
      if (failed > 0) {
        addToast('warning', `Force released ${succeeded}/${total} checkouts (${failed} failed)`)
      } else {
        addToast('success', `Force released ${succeeded} checkout${succeeded > 1 ? 's' : ''}`)
      }
      
      onRefresh(true)
    } finally {
      setProcessingPaths(prev => {
        const next = new Set(prev)
        filesToProcess.forEach(p => next.delete(p))
        return next
      })
      setIsProcessingOthers(false)
    }
  }
  
  // Navigate to file location in explorer
  const navigateToFile = (file: LocalFile) => {
    // Get parent folder path
    const parts = file.relativePath.split('/')
    parts.pop() // Remove filename
    const parentPath = parts.join('/')
    
    // Expand all parent folders
    if (parentPath) {
      for (let i = 1; i <= parts.length; i++) {
        const ancestorPath = parts.slice(0, i).join('/')
        if (!expandedFolders.has(ancestorPath)) {
          toggleFolder(ancestorPath)
        }
      }
    }
    
    // Navigate to folder and switch to explorer view
    setCurrentFolder(parentPath)
    setActiveView('explorer')
  }

  const FileRow = ({ file, isOwn, showAdminSelect }: { file: LocalFile; isOwn: boolean; showAdminSelect?: boolean }) => {
    const isSelected = isOwn ? selectedFiles.has(file.path) : selectedOthersFiles.has(file.path)
    const isBeingProcessed = processingPaths.has(file.path)
    const checkedOutUser = (file.pdmData as any)?.checked_out_user
    const userName = checkedOutUser?.full_name || checkedOutUser?.email?.split('@')[0] || 'Unknown'
    const avatarUrl = checkedOutUser?.avatar_url
    const canSelect = isOwn || showAdminSelect
    
    // Don't render files that are being processed
    if (isBeingProcessed) {
      return (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded text-sm opacity-50 cursor-not-allowed">
          <div className="w-4 h-4 border-2 border-pdm-accent border-t-transparent rounded-full animate-spin flex-shrink-0" />
          <Lock size={14} className="flex-shrink-0 text-pdm-fg-muted" />
          <File size={14} className="text-pdm-fg-muted flex-shrink-0" />
          <span className="truncate text-pdm-fg-muted flex-1" title={file.relativePath}>
            {file.name}
          </span>
        </div>
      )
    }
    
    const handleClick = () => {
      if (isOwn) {
        toggleSelect(file.path)
      } else if (showAdminSelect) {
        toggleSelectOthers(file.path)
      }
    }
    
    return (
      <div
        className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
          canSelect ? 'cursor-pointer' : ''
        } ${isSelected ? 'bg-pdm-highlight' : canSelect ? 'hover:bg-pdm-highlight/50' : ''}`}
        onClick={handleClick}
      >
        {canSelect && (
          <button 
            className="flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation()
              handleClick()
            }}
          >
            {isSelected ? (
              <CheckSquare size={16} className={showAdminSelect ? 'text-pdm-error' : 'text-pdm-accent'} />
            ) : (
              <Square size={16} className="text-pdm-fg-muted" />
            )}
          </button>
        )}
        <Lock size={14} className={`flex-shrink-0 ${isOwn ? 'text-pdm-warning' : 'text-pdm-error'}`} />
        <File size={14} className="text-pdm-fg-muted flex-shrink-0" />
        <span className="truncate flex-1" title={file.relativePath}>
          {file.name}
        </span>
        {/* Avatar for files checked out by others */}
        {!isOwn && (
          <div 
            className="flex-shrink-0 relative" 
            title={userName}
          >
            {avatarUrl ? (
              <img 
                src={avatarUrl} 
                alt={userName}
                className="w-5 h-5 rounded-full ring-1 ring-pdm-error/50 bg-pdm-bg object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none'
                  const fallback = (e.target as HTMLImageElement).nextElementSibling as HTMLElement
                  if (fallback) fallback.classList.remove('hidden')
                }}
              />
            ) : null}
            <div 
              className={`w-5 h-5 rounded-full ring-1 ring-pdm-error/50 bg-pdm-error/20 text-pdm-error flex items-center justify-center text-[9px] font-medium ${avatarUrl ? 'hidden' : ''}`}
            >
              {getInitials(userName)}
            </div>
          </div>
        )}
        {/* Navigate to file location */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            navigateToFile(file)
          }}
          className="flex-shrink-0 p-0.5 rounded hover:bg-pdm-highlight text-pdm-fg-muted hover:text-pdm-fg transition-colors"
          title="Show in Explorer"
        >
          <FolderOpen size={14} />
        </button>
      </div>
    )
  }
  
  const AddedFileRow = ({ file }: { file: LocalFile }) => {
    const isSelected = selectedAddedFiles.has(file.path)
    const isBeingProcessed = processingPaths.has(file.path)
    
    // Show processing state for files being uploaded
    if (isBeingProcessed) {
      return (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded text-sm opacity-50 cursor-not-allowed">
          <div className="w-4 h-4 border-2 border-pdm-accent border-t-transparent rounded-full animate-spin flex-shrink-0" />
          <Plus size={14} className="flex-shrink-0 text-pdm-fg-muted" />
          <File size={14} className="text-pdm-fg-muted flex-shrink-0" />
          <span className="truncate text-pdm-fg-muted flex-1" title={file.relativePath}>
            {file.name}
          </span>
        </div>
      )
    }
    
    return (
      <div
        className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors ${
          isSelected ? 'bg-pdm-highlight' : 'hover:bg-pdm-highlight/50'
        }`}
        onClick={() => toggleSelectAdded(file.path)}
      >
        <button 
          className="flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            toggleSelectAdded(file.path)
          }}
        >
          {isSelected ? (
            <CheckSquare size={16} className="text-pdm-accent" />
          ) : (
            <Square size={16} className="text-pdm-fg-muted" />
          )}
        </button>
        <Plus size={14} className="flex-shrink-0 text-pdm-success" />
        <File size={14} className="text-pdm-fg-muted flex-shrink-0" />
        <span className="truncate flex-1" title={file.relativePath}>
          {file.name}
        </span>
        {/* Navigate to file location */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            navigateToFile(file)
          }}
          className="flex-shrink-0 p-0.5 rounded hover:bg-pdm-highlight text-pdm-fg-muted hover:text-pdm-fg transition-colors"
          title="Show in Explorer"
        >
          <FolderOpen size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* New files (not yet synced) - shown first */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-pdm-fg-muted uppercase tracking-wide flex items-center gap-2">
              <Plus size={12} className="text-pdm-success" />
              New Files ({addedFiles.length})
            </div>
            {addedFiles.length > 0 && (
              <button
                onClick={allAddedSelected ? selectNoneAdded : selectAllAdded}
                className="text-xs text-pdm-fg-muted hover:text-pdm-fg transition-colors"
              >
                {allAddedSelected ? 'Deselect All' : 'Select All'}
              </button>
            )}
          </div>
          
          {/* Actions for new files - at top */}
          {selectedAddedCount > 0 && (
            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-pdm-border">
              <span className="text-xs text-pdm-fg-muted">{selectedAddedCount} selected</span>
              <div className="flex-1" />
              <button
                onClick={handleCheckinAddedFiles}
                disabled={isProcessingAdded || !currentVaultId}
                className="btn btn-primary btn-sm text-xs flex items-center gap-1"
              >
                <Upload size={12} />
                Check In
              </button>
              <button
                onClick={handleDeleteClick}
                disabled={isProcessingAdded}
                className="btn btn-sm text-xs flex items-center gap-1 bg-pdm-error hover:bg-pdm-error/80 text-white"
              >
                <Trash2 size={12} />
                Delete
              </button>
            </div>
          )}
          
          {addedFiles.length === 0 ? (
            <div className="text-sm text-pdm-fg-muted py-4 text-center">
              No new files
            </div>
          ) : (
            <>
              <div className="space-y-1">
                {addedFiles.map(file => (
                  <AddedFileRow key={file.path} file={file} />
                ))}
              </div>
              {selectedAddedCount === 0 && (
                <div className="text-xs text-pdm-fg-muted mt-2 px-2">
                  These files exist locally but haven't been synced to the cloud yet.
                </div>
              )}
            </>
          )}
        </div>

        {/* Checked out files */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-pdm-fg-muted uppercase tracking-wide flex items-center gap-2">
              <Lock size={12} className="text-pdm-warning" />
              Checked Out Files ({myCheckedOutFiles.length})
            </div>
            {myCheckedOutFiles.length > 0 && (
              <button
                onClick={allSelected ? selectNone : selectAll}
                className="text-xs text-pdm-fg-muted hover:text-pdm-fg transition-colors"
              >
                {allSelected ? 'Deselect All' : 'Select All'}
              </button>
            )}
          </div>
          
          {/* Actions for checked out files - at top */}
          {selectedCount > 0 && (
            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-pdm-border">
              <span className="text-xs text-pdm-fg-muted">{selectedCount} selected</span>
              <div className="flex-1" />
              <button
                onClick={handleCheckin}
                disabled={isProcessingCheckedOut}
                className="btn btn-primary btn-sm text-xs flex items-center gap-1"
              >
                <ArrowUp size={12} />
                Check In
              </button>
              <button
                onClick={handleDiscardChanges}
                disabled={isProcessingCheckedOut}
                className="btn btn-ghost btn-sm text-xs flex items-center gap-1 text-pdm-warning"
              >
                <Undo2 size={12} />
                Discard
              </button>
            </div>
          )}
          
          {myCheckedOutFiles.length === 0 ? (
            <div className="text-sm text-pdm-fg-muted py-4 text-center">
              No files checked out
            </div>
          ) : (
            <div className="space-y-1">
              {myCheckedOutFiles.map(file => (
                <FileRow key={file.path} file={file} isOwn={true} />
              ))}
            </div>
          )}
        </div>

        {/* Files checked out by others */}
        {othersCheckedOutFiles.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-pdm-fg-muted uppercase tracking-wide flex items-center gap-2">
                <Lock size={12} className="text-pdm-error" />
                Checked Out by Others ({othersCheckedOutFiles.length})
              </div>
              {isAdmin && othersCheckedOutFiles.length > 0 && (
                <button
                  onClick={allOthersSelected ? selectNoneOthers : selectAllOthers}
                  className="text-xs text-pdm-fg-muted hover:text-pdm-fg transition-colors"
                >
                  {allOthersSelected ? 'Deselect All' : 'Select All'}
                </button>
              )}
            </div>
            
            {/* Admin: Actions for files checked out by others */}
            {isAdmin && selectedOthersCount > 0 && (
              <div className="flex items-center gap-2 mb-3 pb-2 border-b border-pdm-border">
                <span className="text-xs text-pdm-fg-muted flex items-center gap-1">
                  <Shield size={10} className="text-pdm-error" />
                  {selectedOthersCount} selected
                </span>
                <div className="flex-1" />
                <button
                  onClick={handleAdminForceRelease}
                  disabled={isProcessingOthers}
                  className="btn btn-sm text-xs flex items-center gap-1 bg-pdm-error hover:bg-pdm-error/80 text-white"
                  title="Immediately release the checkout. User's unsaved changes will be orphaned."
                >
                  <Unlock size={12} />
                  Force Release
                </button>
              </div>
            )}
            
            {/* Admin hint */}
            {isAdmin && selectedOthersCount === 0 && (
              <div className="text-xs text-pdm-fg-muted mb-2 px-2 py-1 bg-pdm-bg/50 rounded flex items-center gap-1">
                <Shield size={10} />
                Admin: Select files to force release checkout
              </div>
            )}
            
            <div className="space-y-1">
              {othersCheckedOutFiles.map(file => (
                <FileRow key={file.path} file={file} isOwn={false} showAdminSelect={isAdmin} />
              ))}
            </div>
          </div>
        )}

        {/* Summary */}
        <div className="text-xs text-pdm-fg-muted border-t border-pdm-border pt-4">
          <div className="flex justify-between mb-1">
            <span>Total synced files:</span>
            <span>{files.filter(f => !f.isDirectory && f.pdmData).length}</span>
          </div>
          <div className="flex justify-between mb-1">
            <span>Total checked out:</span>
            <span>{checkedOutFiles.length}</span>
          </div>
          <div className="flex justify-between">
            <span>New files to sync:</span>
            <span className={addedFiles.length > 0 ? 'text-pdm-success' : ''}>{addedFiles.length}</span>
          </div>
        </div>
      </div>
      
      {/* Delete Confirmation Dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-pdm-bg-light border border-pdm-border rounded-xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-pdm-border">
              <div className="flex items-center gap-2 text-pdm-error">
                <AlertTriangle size={18} />
                <span className="font-medium">Delete Files</span>
              </div>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="p-1 rounded hover:bg-pdm-bg transition-colors text-pdm-fg-muted hover:text-pdm-fg"
              >
                <X size={16} />
              </button>
            </div>
            
            {/* Content */}
            <div className="p-4">
              <p className="text-sm text-pdm-fg mb-3">
                Are you sure you want to delete <span className="font-semibold text-pdm-error">{selectedAddedCount}</span> file{selectedAddedCount > 1 ? 's' : ''} from your local vault?
              </p>
              <p className="text-xs text-pdm-fg-muted">
                This will move the files to your Recycle Bin.
              </p>
            </div>
            
            {/* Actions */}
            <div className="flex justify-end gap-2 px-4 py-3 bg-pdm-bg border-t border-pdm-border">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="btn btn-ghost btn-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleDiscardAddedFiles}
                className="btn btn-sm bg-pdm-error hover:bg-pdm-error/80 text-white flex items-center gap-1"
              >
                <Trash2 size={14} />
                Delete Files
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
