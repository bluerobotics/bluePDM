import { Lock, User, File } from 'lucide-react'
import { usePDMStore } from '../../stores/pdmStore'

export function CheckoutView() {
  const { files, user } = usePDMStore()
  
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

  return (
    <div className="p-4 space-y-6">
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
              <div
                key={file.path}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-pdm-highlight text-sm"
              >
                <Lock size={14} className="text-pdm-error flex-shrink-0" />
                <File size={14} className="text-pdm-fg-muted flex-shrink-0" />
                <span className="truncate flex-1" title={file.relativePath}>
                  {file.name}
                </span>
              </div>
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
            {othersCheckedOutFiles.map(file => {
              const checkedOutUser = (file.pdmData as any)?.checked_out_user
              const userName = checkedOutUser?.full_name || checkedOutUser?.email || 'Unknown'
              
              return (
                <div
                  key={file.path}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-pdm-highlight text-sm"
                >
                  <Lock size={14} className="text-pdm-warning flex-shrink-0" />
                  <File size={14} className="text-pdm-fg-muted flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate" title={file.relativePath}>
                      {file.name}
                    </div>
                    <div className="text-xs text-pdm-fg-muted flex items-center gap-1">
                      <User size={10} />
                      {userName}
                    </div>
                  </div>
                </div>
              )
            })}
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
  )
}

