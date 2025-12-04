import { useState } from 'react'
import { Lock, User, File, ArrowUp, Undo2, CheckSquare, Square } from 'lucide-react'
import { usePDMStore, LocalFile } from '../../stores/pdmStore'
import { checkinFile } from '../../lib/supabase'
import { downloadFile } from '../../lib/storage'

export function CheckoutView() {
  const { files, user, organization, vaultPath, addToast } = usePDMStore()
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [isProcessing, setIsProcessing] = useState(false)
  
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
  
  // Check in selected files
  const handleCheckin = async () => {
    if (!organization || !user || selectedCount === 0) return
    
    setIsProcessing(true)
    let succeeded = 0
    let failed = 0
    
    const api = (window as any).electronAPI
    if (!api) {
      addToast('error', 'Electron API not available')
      setIsProcessing(false)
      return
    }
    
    try {
      for (const path of selectedFiles) {
        const file = myCheckedOutFiles.find(f => f.path === path)
        if (!file || !file.pdmData) continue
        
        try {
          // Read file to get current hash
          const readResult = await api.readFile(file.path)
          
          if (readResult?.success && readResult.hash) {
            const result = await checkinFile(file.pdmData.id, user.id, {
              newContentHash: readResult.hash,
              newFileSize: file.size
            })
            
            if (result.success) {
              // Make file read-only after check-in
              await api.setReadonly(file.path, true)
              succeeded++
            } else {
              console.error('Check in failed:', result.error)
              failed++
            }
          } else {
            // Just release checkout without updating content
            const result = await checkinFile(file.pdmData.id, user.id)
            if (result.success) {
              await api.setReadonly(file.path, true)
              succeeded++
            } else {
              console.error('Check in failed:', result.error)
              failed++
            }
          }
        } catch (err) {
          console.error('Check in error:', err)
          failed++
        }
      }
      
      if (failed > 0) {
        addToast('warning', `Checked in ${succeeded}/${selectedCount} files (${failed} failed)`)
      } else {
        addToast('success', `Checked in ${succeeded} file${succeeded > 1 ? 's' : ''}`)
      }
      
      setSelectedFiles(new Set())
    } finally {
      setIsProcessing(false)
    }
  }
  
  // Discard changes (revert to server version)
  const handleDiscardChanges = async () => {
    if (!organization || !user || !vaultPath || selectedCount === 0) return
    
    setIsProcessing(true)
    let succeeded = 0
    let failed = 0
    
    const api = (window as any).electronAPI
    if (!api) {
      addToast('error', 'Electron API not available')
      setIsProcessing(false)
      return
    }
    
    try {
      for (const path of selectedFiles) {
        const file = myCheckedOutFiles.find(f => f.path === path)
        if (!file || !file.pdmData) continue
        
        try {
          // Get the server version content hash
          const contentHash = file.pdmData.content_hash
          if (!contentHash) {
            failed++
            continue
          }
          
          // Download the server version
          const { data, error: downloadError } = await downloadFile(organization.id, contentHash)
          if (downloadError || !data) {
            console.error('Download failed:', downloadError)
            failed++
            continue
          }
          
          // Make writable first
          await api.setReadonly(file.path, false)
          
          // Write file
          const writeResult = await api.writeFile(file.path, data)
          if (!writeResult?.success) {
            failed++
            continue
          }
          
          // Release checkout without updating content (we reverted to server version)
          const result = await checkinFile(file.pdmData.id, user.id)
          
          if (!result.success) {
            console.error('Release checkout failed:', result.error)
            failed++
            continue
          }
          
          // Make read-only
          await api.setReadonly(file.path, true)
          succeeded++
        } catch (err) {
          console.error('Discard changes error:', err)
          failed++
        }
      }
      
      if (failed > 0) {
        addToast('warning', `Discarded ${succeeded}/${selectedCount} files (${failed} failed)`)
      } else {
        addToast('success', `Discarded changes for ${succeeded} file${succeeded > 1 ? 's' : ''}`)
      }
      
      setSelectedFiles(new Set())
    } finally {
      setIsProcessing(false)
    }
  }
  
  const FileRow = ({ file, isOwn }: { file: LocalFile; isOwn: boolean }) => {
    const isSelected = selectedFiles.has(file.path)
    const checkedOutUser = (file.pdmData as any)?.checked_out_user
    const userName = checkedOutUser?.full_name || checkedOutUser?.email || 'Unknown'
    
    return (
      <div
        className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors ${
          isSelected ? 'bg-pdm-highlight' : 'hover:bg-pdm-highlight/50'
        }`}
        onClick={() => isOwn && toggleSelect(file.path)}
      >
        {isOwn && (
          <button 
            className="flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation()
              toggleSelect(file.path)
            }}
          >
            {isSelected ? (
              <CheckSquare size={16} className="text-pdm-accent" />
            ) : (
              <Square size={16} className="text-pdm-fg-muted" />
            )}
          </button>
        )}
        <Lock size={14} className={`flex-shrink-0 ${isOwn ? 'text-pdm-error' : 'text-pdm-warning'}`} />
        <File size={14} className="text-pdm-fg-muted flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate" title={file.relativePath}>
            {file.name}
          </div>
          {!isOwn && (
            <div className="text-xs text-pdm-fg-muted flex items-center gap-1">
              <User size={10} />
              {userName}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Action bar for my files */}
      {myCheckedOutFiles.length > 0 && (
        <div className="p-2 border-b border-pdm-border flex items-center gap-2 flex-wrap">
          <button
            onClick={allSelected ? selectNone : selectAll}
            className="btn btn-ghost btn-sm text-xs flex items-center gap-1"
          >
            {allSelected ? (
              <>
                <Square size={12} />
                Deselect All
              </>
            ) : (
              <>
                <CheckSquare size={12} />
                Select All
              </>
            )}
          </button>
          
          {selectedCount > 0 && (
            <>
              <span className="text-xs text-pdm-fg-muted">
                {selectedCount} selected
              </span>
              <div className="flex-1" />
              <button
                onClick={handleCheckin}
                disabled={isProcessing}
                className="btn btn-primary btn-sm text-xs flex items-center gap-1"
              >
                <ArrowUp size={12} />
                Check In
              </button>
              <button
                onClick={handleDiscardChanges}
                disabled={isProcessing}
                className="btn btn-ghost btn-sm text-xs flex items-center gap-1 text-pdm-warning"
              >
                <Undo2 size={12} />
                Discard
              </button>
            </>
          )}
        </div>
      )}
      
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* My checked out files */}
        <div>
          <div className="text-xs text-pdm-fg-muted uppercase tracking-wide mb-3">
            My Checked Out Files ({myCheckedOutFiles.length})
          </div>
          
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
            <div className="text-xs text-pdm-fg-muted uppercase tracking-wide mb-3">
              Checked Out by Others ({othersCheckedOutFiles.length})
            </div>
            
            <div className="space-y-1">
              {othersCheckedOutFiles.map(file => (
                <FileRow key={file.path} file={file} isOwn={false} />
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
          <div className="flex justify-between">
            <span>Total checked out:</span>
            <span>{checkedOutFiles.length}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
