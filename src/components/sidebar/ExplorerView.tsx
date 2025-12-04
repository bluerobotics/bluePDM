import { 
  FolderOpen, 
  ChevronRight, 
  ChevronDown,
  File,
  FileBox,
  FileText,
  Layers
} from 'lucide-react'
import { usePDMStore, LocalFile } from '../../stores/pdmStore'
import { isCADFile, getFileType } from '../../types/pdm'

interface ExplorerViewProps {
  onOpenVault: () => void
  onOpenRecentVault: (path: string) => void
}

export function ExplorerView({ onOpenVault, onOpenRecentVault }: ExplorerViewProps) {
  const { 
    files, 
    expandedFolders, 
    toggleFolder, 
    vaultPath,
    isVaultConnected,
    recentVaults,
    currentFolder,
    setCurrentFolder,
    getFolderDiffCounts
  } = usePDMStore()

  // Build folder tree structure
  const buildTree = () => {
    const tree: { [key: string]: LocalFile[] } = { '': [] }
    
    // Filter out any undefined or invalid files
    const validFiles = files.filter(f => f && f.relativePath && f.name)
    
    validFiles.forEach(file => {
      const parts = file.relativePath.split('/')
      if (parts.length === 1) {
        tree[''].push(file)
      } else {
        const parentPath = parts.slice(0, -1).join('/')
        if (!tree[parentPath]) {
          tree[parentPath] = []
        }
        tree[parentPath].push(file)
      }
    })
    
    return tree
  }

  const tree = buildTree()

  // Check if all files in a folder are synced
  const isFolderSynced = (folderPath: string): boolean => {
    const folderFiles = files.filter(f => 
      !f.isDirectory && 
      f.relativePath.startsWith(folderPath + '/')
    )
    if (folderFiles.length === 0) return false
    return folderFiles.every(f => !!f.pdmData)
  }

  // Check if any files in a folder are checked out
  const hasFolderCheckedOutFiles = (folderPath: string): boolean => {
    const folderFiles = files.filter(f => 
      !f.isDirectory && 
      f.relativePath.startsWith(folderPath + '/')
    )
    return folderFiles.some(f => f.pdmData?.checked_out_by)
  }

  const getFileIcon = (file: LocalFile) => {
    if (file.isDirectory) {
      const hasCheckedOut = hasFolderCheckedOutFiles(file.relativePath)
      if (hasCheckedOut) {
        return <FolderOpen size={16} className="text-pdm-warning" />
      }
      const synced = isFolderSynced(file.relativePath)
      return <FolderOpen size={16} className={synced ? 'text-pdm-success' : 'text-pdm-fg-muted'} />
    }
    
    const fileType = getFileType(file.extension)
    switch (fileType) {
      case 'part':
        return <FileBox size={16} className="text-pdm-accent" />
      case 'assembly':
        return <Layers size={16} className="text-pdm-success" />
      case 'drawing':
        return <FileText size={16} className="text-pdm-info" />
      default:
        return <File size={16} className="text-pdm-fg-muted" />
    }
  }

  const renderTreeItem = (file: LocalFile, depth: number = 0) => {
    const isExpanded = expandedFolders.has(file.relativePath)
    const isCurrentFolder = file.isDirectory && file.relativePath === currentFolder
    const children = tree[file.relativePath] || []
    
    // Get diff counts for folders
    const diffCounts = file.isDirectory ? getFolderDiffCounts(file.relativePath) : null
    const hasDiffs = diffCounts && (diffCounts.added > 0 || diffCounts.modified > 0 || diffCounts.deleted > 0 || diffCounts.outdated > 0)
    
    // Diff class for files
    const diffClass = !file.isDirectory && file.diffStatus 
      ? `sidebar-diff-${file.diffStatus}` : ''

    return (
      <div key={file.path}>
        <div
          className={`tree-item ${isCurrentFolder ? 'current-folder' : ''} ${diffClass}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={(e) => {
            if (file.isDirectory) {
              // Navigate main pane to this folder
              setCurrentFolder(file.relativePath)
              // Expand the folder if not already expanded
              if (!expandedFolders.has(file.relativePath)) {
                toggleFolder(file.relativePath)
              }
            } else if (window.electronAPI) {
              // Single click on file opens it
              window.electronAPI.openFile(file.path)
            }
          }}
          onDoubleClick={() => {
            if (file.isDirectory) {
              // Toggle expand/collapse on double click
              toggleFolder(file.relativePath)
            }
          }}
        >
          {file.isDirectory && (
            <span 
              className="mr-1 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                toggleFolder(file.relativePath)
              }}
            >
              {isExpanded 
                ? <ChevronDown size={14} className="text-pdm-fg-muted" /> 
                : <ChevronRight size={14} className="text-pdm-fg-muted" />
              }
            </span>
          )}
          {!file.isDirectory && <span className="w-[14px] mr-1" />}
          <span className="tree-item-icon">{getFileIcon(file)}</span>
          <span className="truncate text-sm flex-1">{file.name}</span>
          
          {/* Diff counts for folders */}
          {file.isDirectory && hasDiffs && (
            <span className="flex items-center gap-1 ml-2 text-xs">
              {diffCounts.added > 0 && (
                <span className="text-pdm-success font-medium">+{diffCounts.added}</span>
              )}
              {diffCounts.modified > 0 && (
                <span className="text-pdm-warning font-medium">~{diffCounts.modified}</span>
              )}
              {diffCounts.deleted > 0 && (
                <span className="text-pdm-error font-medium">-{diffCounts.deleted}</span>
              )}
              {diffCounts.outdated > 0 && (
                <span className="text-purple-400 font-medium">↓{diffCounts.outdated}</span>
              )}
            </span>
          )}
          
        </div>
        {file.isDirectory && isExpanded && children
          .filter(child => child && child.name)
          .sort((a, b) => {
            // Folders first, then alphabetically
            if (a.isDirectory && !b.isDirectory) return -1
            if (!a.isDirectory && b.isDirectory) return 1
            return a.name.localeCompare(b.name)
          })
          .map(child => renderTreeItem(child, depth + 1))
        }
      </div>
    )
  }

  if (!isVaultConnected) {
    return (
      <div className="p-4">
        <div className="mb-6">
          <button
            onClick={onOpenVault}
            className="btn btn-primary w-full"
          >
            <FolderOpen size={16} />
            Open Vault
          </button>
        </div>
        
        {recentVaults.length > 0 && (
          <div>
            <div className="text-xs text-pdm-fg-muted uppercase tracking-wide mb-2">
              Recent Vaults
            </div>
            {recentVaults.map(vault => (
              <button
                key={vault}
                onClick={() => onOpenRecentVault(vault)}
                className="w-full text-left px-2 py-1.5 text-sm text-pdm-fg-dim hover:bg-pdm-highlight rounded truncate"
                title={vault}
              >
                {vault.split(/[/\\]/).pop()}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const rootItems = tree[''] || []

  return (
    <div className="py-2">
      {/* Vault name - click to go to root */}
      <div 
        className={`px-4 py-2 text-xs cursor-pointer transition-colors hover:text-pdm-fg ${
          currentFolder === '' ? 'text-pdm-accent font-medium' : 'text-pdm-fg-muted'
        }`}
        onClick={() => setCurrentFolder('')}
        title="Go to vault root"
      >
        {vaultPath?.split(/[/\\]/).pop()}
      </div>
      
      {/* Tree */}
      {rootItems
        .filter(item => item && item.name)
        .sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })
        .map(file => renderTreeItem(file))
      }
      
      {rootItems.length === 0 && (
        <div className="px-4 py-8 text-center text-pdm-fg-muted text-sm">
          No files in vault
        </div>
      )}
    </div>
  )
}

