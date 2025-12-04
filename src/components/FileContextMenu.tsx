import { 
  Trash2, 
  Copy, 
  Scissors, 
  ClipboardPaste,
  FolderOpen,
  ExternalLink,
  ArrowDown,
  ArrowUp,
  Cloud,
  Download,
  CloudOff,
  Edit,
  FolderPlus,
  Star
} from 'lucide-react'
import { usePDMStore, LocalFile } from '../stores/pdmStore'
import { checkoutFile, checkinFile, syncFile } from '../lib/supabase'
import { downloadFile } from '../lib/storage'

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
  onDelete?: (file: LocalFile) => void
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
  onNewFolder,
  onDelete
}: FileContextMenuProps) {
  const { user, organization, vaultPath, activeVaultId, addToast, startSync, updateSyncProgress, endSync, pinnedFolders, pinFolder, unpinFolder, connectedVaults } = usePDMStore()
  
  if (contextFiles.length === 0) return null
  
  // Get current vault name for pinning
  const currentVault = connectedVaults.find(v => v.id === activeVaultId)
  const currentVaultName = currentVault?.name || 'Vault'
  
  const multiSelect = contextFiles.length > 1
  const firstFile = contextFiles[0]
  const isFolder = firstFile.isDirectory
  const allFolders = contextFiles.every(f => f.isDirectory)
  const allFiles = contextFiles.every(f => !f.isDirectory)
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
  
  // Get all synced files in selection
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
      } else if (item.pdmData && item.diffStatus !== 'cloud') {
        result.push(item)
      }
    }
    return result
  }
  const syncedFilesInSelection = getSyncedFilesInSelection()
  
  // Get unsynced files in selection
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
      } else if (!item.pdmData || item.diffStatus === 'added') {
        result.push(item)
      }
    }
    return result
  }
  const unsyncedFilesInSelection = getUnsyncedFilesInSelection()
  
  // Check out/in status
  const allCheckedOut = syncedFilesInSelection.length > 0 && syncedFilesInSelection.every(f => f.pdmData?.checked_out_by)
  const allCheckedIn = syncedFilesInSelection.length > 0 && syncedFilesInSelection.every(f => !f.pdmData?.checked_out_by)
  
  // Count files that can be checked out (synced but not checked out)
  const checkoutableCount = syncedFilesInSelection.filter(f => !f.pdmData?.checked_out_by).length
  // Count files that can be checked in (checked out by current user)
  const checkinableCount = syncedFilesInSelection.filter(f => f.pdmData?.checked_out_by === user?.id).length
  
  const countLabel = multiSelect 
    ? `(${fileCount > 0 ? `${fileCount} file${fileCount > 1 ? 's' : ''}` : ''}${fileCount > 0 && folderCount > 0 ? ', ' : ''}${folderCount > 0 ? `${folderCount} folder${folderCount > 1 ? 's' : ''}` : ''})`
    : ''
  
  // Check for cloud-only files
  const allCloudOnly = contextFiles.every(f => f.diffStatus === 'cloud')
  const hasLocalFiles = contextFiles.some(f => f.diffStatus !== 'cloud')
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
      // Could navigate to folder
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
    
    let succeeded = 0
    let failed = 0
    
    for (const file of filesToCheckout) {
      try {
        const result = await checkoutFile(file.pdmData!.id, user.id)
        if (result.success) {
          await window.electronAPI?.setReadonly(file.path, false)
          succeeded++
        } else {
          failed++
        }
      } catch {
        failed++
      }
    }
    
    if (failed > 0) {
      addToast('warning', `Checked out ${succeeded}/${filesToCheckout.length} files`)
    } else {
      addToast('success', `Checked out ${succeeded} file${succeeded > 1 ? 's' : ''}`)
    }
    onRefresh(true)
  }
  
  const handleCheckin = async () => {
    if (!user) return
    onClose()
    
    const filesToCheckin = syncedFilesInSelection.filter(f => f.pdmData?.checked_out_by === user.id)
    if (filesToCheckin.length === 0) {
      addToast('info', 'No files are checked out by you')
      return
    }
    
    let succeeded = 0
    let failed = 0
    
    for (const file of filesToCheckin) {
      try {
        const readResult = await window.electronAPI?.readFile(file.path)
        if (readResult?.success && readResult.hash) {
          const result = await checkinFile(file.pdmData!.id, user.id, {
            newContentHash: readResult.hash,
            newFileSize: file.size
          })
          if (result.success) {
            await window.electronAPI?.setReadonly(file.path, true)
            succeeded++
          } else {
            failed++
          }
        } else {
          const result = await checkinFile(file.pdmData!.id, user.id)
          if (result.success) {
            await window.electronAPI?.setReadonly(file.path, true)
            succeeded++
          } else {
            failed++
          }
        }
      } catch {
        failed++
      }
    }
    
    if (failed > 0) {
      addToast('warning', `Checked in ${succeeded}/${filesToCheckin.length} files`)
    } else {
      addToast('success', `Checked in ${succeeded} file${succeeded > 1 ? 's' : ''}`)
    }
    onRefresh(true)
  }
  
  const handleFirstCheckin = async () => {
    if (!user || !organization || !activeVaultId) return
    onClose()
    
    const filesToSync = unsyncedFilesInSelection
    if (filesToSync.length === 0) {
      addToast('info', 'No unsynced files to check in')
      return
    }
    
    startSync(filesToSync.length)
    let succeeded = 0
    let failed = 0
    
    for (let i = 0; i < filesToSync.length; i++) {
      const file = filesToSync[i]
      try {
        const readResult = await window.electronAPI?.readFile(file.path)
        if (readResult?.success && readResult.data && readResult.hash) {
          const { error } = await syncFile(
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
          if (!error) {
            await window.electronAPI?.setReadonly(file.path, true)
            succeeded++
          } else {
            failed++
          }
        } else {
          failed++
        }
      } catch {
        failed++
      }
      updateSyncProgress(i + 1, Math.round(((i + 1) / filesToSync.length) * 100), '')
    }
    
    endSync()
    
    if (failed > 0) {
      addToast('warning', `Synced ${succeeded}/${filesToSync.length} files`)
    } else {
      addToast('success', `Synced ${succeeded} file${succeeded > 1 ? 's' : ''} to cloud`)
    }
    onRefresh(true)
  }
  
  const handleDownload = async () => {
    if (!organization || !vaultPath) return
    onClose()
    
    // Get cloud-only files
    const cloudFiles: LocalFile[] = []
    for (const item of contextFiles) {
      if (item.isDirectory) {
        const folderPrefix = item.relativePath + '/'
        const filesInFolder = files.filter(f => 
          !f.isDirectory && 
          f.diffStatus === 'cloud' &&
          f.relativePath.startsWith(folderPrefix)
        )
        cloudFiles.push(...filesInFolder)
      } else if (item.diffStatus === 'cloud' && item.pdmData) {
        cloudFiles.push(item)
      }
    }
    
    if (cloudFiles.length === 0) {
      addToast('info', 'No cloud files to download')
      return
    }
    
    startSync(cloudFiles.length, 'download')
    let succeeded = 0
    let failed = 0
    
    for (let i = 0; i < cloudFiles.length; i++) {
      const file = cloudFiles[i]
      if (!file.pdmData?.content_hash) {
        failed++
        continue
      }
      
      try {
        const { data, error } = await downloadFile(organization.id, file.pdmData.content_hash)
        if (!error && data) {
          const fullPath = `${vaultPath}/${file.relativePath}`
          await window.electronAPI?.ensureDir(fullPath.substring(0, fullPath.lastIndexOf('/')))
          const result = await window.electronAPI?.writeFile(fullPath, data)
          if (result?.success) {
            await window.electronAPI?.setReadonly(fullPath, true)
            succeeded++
          } else {
            failed++
          }
        } else {
          failed++
        }
      } catch {
        failed++
      }
      updateSyncProgress(i + 1, Math.round(((i + 1) / cloudFiles.length) * 100), '')
    }
    
    endSync()
    
    if (failed > 0) {
      addToast('warning', `Downloaded ${succeeded}/${cloudFiles.length} files`)
    } else {
      addToast('success', `Downloaded ${succeeded} file${succeeded > 1 ? 's' : ''}`)
    }
    onRefresh(true)
  }
  
  const handleDeleteLocal = () => {
    onClose()
    if (onDelete) {
      onDelete(firstFile)
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
        className="context-menu"
        style={{ left: x, top: y }}
      >
        {/* Open */}
        {!multiSelect && (
          <div className="context-menu-item" onClick={handleOpen}>
            <ExternalLink size={14} />
            {isFolder ? 'Open Folder' : 'Open'}
          </div>
        )}
        
        {/* Show in Explorer */}
        {!allCloudOnly && (
          <div className="context-menu-item" onClick={handleShowInExplorer}>
            <FolderOpen size={14} />
            Show in Explorer
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
                <Star size={14} className={isPinned ? 'fill-pdm-warning text-pdm-warning' : ''} />
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
            {onCut && (
              <div className="context-menu-item" onClick={() => { onCut(); onClose(); }}>
                <Scissors size={14} />
                Cut
                <span className="text-xs text-pdm-fg-muted ml-auto">Ctrl+X</span>
              </div>
            )}
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
        
        <div className="context-menu-separator" />
        
        {/* First Check In - for unsynced files */}
        {anyUnsynced && !anySynced && !allCloudOnly && (
          <div className="context-menu-item" onClick={handleFirstCheckin}>
            <Cloud size={14} />
            First Check In {countLabel}
          </div>
        )}
        
        {/* Download - for cloud-only files */}
        {anyCloudOnly && (
          <div className="context-menu-item" onClick={handleDownload}>
            <Download size={14} />
            Download {cloudOnlyCount > 0 ? `${cloudOnlyCount} files` : countLabel}
          </div>
        )}
        
        {/* Check Out */}
        <div 
          className={`context-menu-item ${!anySynced || allCheckedOut ? 'disabled' : ''}`}
          onClick={() => {
            if (!anySynced || allCheckedOut) return
            handleCheckout()
          }}
          title={!anySynced ? 'Check in files first to enable checkout' : allCheckedOut ? 'Already checked out' : ''}
        >
          <ArrowDown size={14} className={!anySynced ? 'text-pdm-fg-muted' : 'text-pdm-warning'} />
          Check Out {allFolders && !multiSelect && checkoutableCount > 0 ? `${checkoutableCount} files` : countLabel}
          {!anySynced && <span className="text-xs text-pdm-fg-muted ml-auto">(check in first)</span>}
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
        
        <div className="context-menu-separator" />
        
        {/* New Folder */}
        {onNewFolder && isFolder && !multiSelect && !allCloudOnly && (
          <div className="context-menu-item" onClick={() => { onNewFolder(); onClose(); }}>
            <FolderPlus size={14} />
            New Folder
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
        
        {/* Delete from Server / Delete Everywhere */}
        {(anySynced || allCloudOnly) && (
          <div className="context-menu-item danger" onClick={handleDeleteLocal}>
            <CloudOff size={14} />
            {allCloudOnly ? 'Delete from Server' : 'Delete Everywhere'} {countLabel}
          </div>
        )}
      </div>
    </>
  )
}

