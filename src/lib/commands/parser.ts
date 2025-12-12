// @ts-nocheck - Supabase type inference issues with Database generics
/**
 * Command Parser
 * 
 * Parses text commands into command calls.
 * 
 * Examples:
 *   checkout ./Parts/bracket.sldprt
 *   checkin ./Parts/*.sldprt
 *   download ./Assemblies --recursive
 *   sync .
 *   help
 *   history
 */

import { usePDMStore, LocalFile } from '../../stores/pdmStore'
import { executeCommand, getAllCommands, getCommandHistory, cancelAllOperations, hasActiveOperations, getActiveOperations } from './executor'
import type { CommandId, CommandResult } from './types'
import { 
  getFileVersions, 
  getDeletedFiles, 
  restoreFile, 
  emptyTrash,
  getRecentActivity,
  updateFileMetadata
} from '../supabase'
import { 
  getBackupConfig, 
  getBackupStatus, 
  requestBackup, 
  listSnapshots 
} from '../backup'
import { rollbackToVersion } from '../fileService'

export interface ParsedCommand {
  command: string
  args: string[]
  flags: Record<string, string | boolean>
}

export interface TerminalOutput {
  id: string
  type: 'input' | 'output' | 'error' | 'success' | 'info'
  content: string
  timestamp: Date
}

/**
 * Parse a command string into structured parts
 */
export function parseCommandString(input: string): ParsedCommand {
  const parts = input.trim().split(/\s+/)
  const command = parts[0]?.toLowerCase() || ''
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}
  
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    if (part.startsWith('--')) {
      // Long flag: --recursive or --message="hello"
      const [key, value] = part.slice(2).split('=')
      flags[key] = value || true
    } else if (part.startsWith('-')) {
      // Short flag: -r or -m "hello"
      const key = part.slice(1)
      // Check if next part is the value (not another flag)
      if (i + 1 < parts.length && !parts[i + 1].startsWith('-')) {
        flags[key] = parts[++i]
      } else {
        flags[key] = true
      }
    } else {
      args.push(part)
    }
  }
  
  return { command, args, flags }
}

/**
 * Resolve a path pattern to matching files
 */
function resolvePathPattern(pattern: string, files: LocalFile[]): LocalFile[] {
  // Normalize the pattern - remove leading ./, trailing slashes, and normalize slashes
  let normalizedPattern = pattern
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')  // Remove trailing slashes
  
  // Check for wildcards
  if (normalizedPattern.includes('*')) {
    // Convert glob to regex
    const regexPattern = normalizedPattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<DOUBLESTAR>>>/g, '.*')
    const regex = new RegExp(`^${regexPattern}$`)
    
    return files.filter(f => {
      const normalizedPath = f.relativePath.replace(/\\/g, '/')
      return regex.test(normalizedPath)
    })
  }
  
  // Check for exact match first (file or folder)
  const exactMatch = files.find(f => 
    f.relativePath.replace(/\\/g, '/').toLowerCase() === normalizedPattern.toLowerCase()
  )
  
  if (exactMatch) {
    // If it's a folder, return the folder (command handlers will expand it)
    // This allows commands like "checkout BALLAST" to check out all files in BALLAST/
    return [exactMatch]
  }
  
  // If no exact match, look for files that start with this path (folder contents)
  const matches = files.filter(f => {
    const normalizedPath = f.relativePath.replace(/\\/g, '/').toLowerCase()
    return normalizedPath.startsWith(normalizedPattern.toLowerCase() + '/')
  })
  
  return matches
}

/**
 * Execute a parsed command
 */
export async function executeTerminalCommand(
  input: string,
  onRefresh?: (silent?: boolean) => void
): Promise<TerminalOutput[]> {
  const outputs: TerminalOutput[] = []
  const addOutput = (type: TerminalOutput['type'], content: string) => {
    outputs.push({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      content,
      timestamp: new Date()
    })
  }
  
  const parsed = parseCommandString(input)
  const { files } = usePDMStore.getState()
  
  // Built-in commands
  switch (parsed.command) {
    case '':
      return outputs
      
    case 'help':
    case '?':
      addOutput('info', formatHelp(parsed.args[0]))
      return outputs
      
    case 'history':
    case 'h':
      const history = getCommandHistory()
      if (history.length === 0) {
        addOutput('info', 'No command history')
      } else {
        const lines = history.slice(0, 10).map((entry, i) => 
          `${i + 1}. ${entry.commandId} - ${entry.result.message} (${formatTimeAgo(entry.timestamp)})`
        )
        addOutput('info', lines.join('\n'))
      }
      return outputs
    
    case 'cancel':
    case 'stop':
    case 'abort':
      if (!hasActiveOperations()) {
        addOutput('info', 'No operations running')
      } else {
        const ops = getActiveOperations()
        const count = cancelAllOperations()
        addOutput('info', `⚠️ Cancelling ${count} operation${count > 1 ? 's' : ''}:`)
        ops.forEach(op => addOutput('info', `  • ${op.description}`))
      }
      return outputs
      
    case 'ls':
    case 'dir':
    case 'list': {
      const path = parsed.args[0] || ''
      const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '')
      
      const items = files.filter(f => {
        const parentPath = f.relativePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
        if (normalizedPath === '' || normalizedPath === '.') {
          return parentPath === ''
        }
        return parentPath === normalizedPath
      })
      
      if (items.length === 0) {
        addOutput('info', normalizedPath ? `No files in ${normalizedPath}` : 'No files in root')
      } else {
        const lines = items.map(f => {
          const icon = f.isDirectory ? '📁' : '📄'
          const status = f.pdmData?.checked_out_by ? '🔒' : f.diffStatus === 'cloud' ? '☁️' : f.diffStatus === 'added' ? '➕' : ''
          return `${icon} ${status} ${f.name}`
        })
        addOutput('info', lines.join('\n'))
      }
      return outputs
    }
      
    case 'pwd':
      const { currentFolder } = usePDMStore.getState()
      addOutput('info', currentFolder || '/')
      return outputs
      
    case 'cd': {
      const path = parsed.args[0] || ''
      const { setCurrentFolder, toggleFolder, expandedFolders } = usePDMStore.getState()
      
      if (path === '' || path === '/' || path === '.') {
        setCurrentFolder('')
        addOutput('success', 'Changed to root')
      } else if (path === '..') {
        const { currentFolder } = usePDMStore.getState()
        const parts = currentFolder.split('/')
        parts.pop()
        setCurrentFolder(parts.join('/'))
        addOutput('success', `Changed to ${parts.join('/') || '/'}`)
      } else {
        const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '')
        const folder = files.find(f => 
          f.isDirectory && f.relativePath.replace(/\\/g, '/') === normalizedPath
        )
        if (folder) {
          setCurrentFolder(normalizedPath)
          // Expand folder in sidebar
          if (!expandedFolders.has(normalizedPath)) {
            toggleFolder(normalizedPath)
          }
          addOutput('success', `Changed to ${normalizedPath}`)
        } else {
          addOutput('error', `Folder not found: ${path}`)
        }
      }
      return outputs
    }
      
    case 'clear':
    case 'cls':
      // Special case - return empty to signal clear
      return [{ id: 'clear', type: 'info', content: '__CLEAR__', timestamp: new Date() }]
      
    case 'status': {
      const path = parsed.args[0]
      if (!path) {
        // Show overall status
        const synced = files.filter(f => !f.isDirectory && f.pdmData).length
        const cloudOnly = files.filter(f => !f.isDirectory && f.diffStatus === 'cloud').length
        const local = files.filter(f => !f.isDirectory && f.diffStatus === 'added').length
        const checkedOut = files.filter(f => !f.isDirectory && f.pdmData?.checked_out_by).length
        
        addOutput('info', [
          `📊 Vault Status`,
          `   Synced files: ${synced}`,
          `   Cloud only: ${cloudOnly}`,
          `   Local only: ${local}`,
          `   Checked out: ${checkedOut}`
        ].join('\n'))
      } else {
        const matches = resolvePathPattern(path, files)
        if (matches.length === 0) {
          addOutput('error', `No files match: ${path}`)
        } else {
          const lines = matches.slice(0, 20).map(f => {
            const status = f.pdmData?.checked_out_by 
              ? '🔒 Checked out' 
              : f.diffStatus === 'cloud' 
                ? '☁️ Cloud only'
                : f.diffStatus === 'added'
                  ? '➕ Local only'
                  : f.pdmData
                    ? '✅ Synced'
                    : '❓ Unknown'
            return `${f.name}: ${status}`
          })
          if (matches.length > 20) {
            lines.push(`... and ${matches.length - 20} more`)
          }
          addOutput('info', lines.join('\n'))
        }
      }
      return outputs
    }
    
    // ============================================
    // TREE - Show directory tree
    // ============================================
    case 'tree': {
      const rootPath = parsed.args[0] || ''
      const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/^\.\//, '')
      const maxDepth = parsed.flags['depth'] ? parseInt(parsed.flags['depth'] as string) : 3
      
      // Build tree structure
      const buildTree = (parentPath: string, depth: number): string[] => {
        if (depth > maxDepth) return []
        
        const items = files.filter(f => {
          const normalizedPath = f.relativePath.replace(/\\/g, '/')
          const parts = normalizedPath.split('/')
          const parentParts = parentPath ? parentPath.split('/') : []
          
          // Direct children only
          if (parts.length !== parentParts.length + 1) return false
          if (parentPath && !normalizedPath.startsWith(parentPath + '/')) return false
          if (!parentPath && parts.length !== 1) return false
          
          return true
        })
        
        // Sort: folders first, then files
        items.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })
        
        const lines: string[] = []
        const indent = '  '.repeat(depth)
        
        for (const item of items) {
          const icon = item.isDirectory ? '📁' : '📄'
          const status = item.pdmData?.checked_out_by ? ' 🔒' : item.diffStatus === 'cloud' ? ' ☁️' : item.diffStatus === 'added' ? ' ➕' : ''
          lines.push(`${indent}${icon} ${item.name}${status}`)
          
          if (item.isDirectory) {
            const childPath = item.relativePath.replace(/\\/g, '/')
            lines.push(...buildTree(childPath, depth + 1))
          }
        }
        
        return lines
      }
      
      const treeLines = buildTree(normalizedRoot, 0)
      if (treeLines.length === 0) {
        addOutput('info', normalizedRoot ? `Empty directory: ${normalizedRoot}` : 'Empty vault')
      } else {
        addOutput('info', treeLines.join('\n'))
      }
      return outputs
    }
    
    // ============================================
    // SELECT - Select files for batch operations
    // ============================================
    case 'select':
    case 'sel': {
      const { setSelectedFiles, selectedFiles: currentSelection } = usePDMStore.getState()
      const action = parsed.args[0]
      
      if (action === 'clear' || action === 'none') {
        setSelectedFiles([])
        addOutput('success', 'Selection cleared')
      } else if (action === 'all') {
        const allPaths = files.filter(f => !f.isDirectory).map(f => f.path)
        setSelectedFiles(allPaths)
        addOutput('success', `Selected ${allPaths.length} files`)
      } else if (parsed.args.length > 0) {
        // Select specific files by pattern
        const pattern = parsed.args.join(' ')
        const matches = resolvePathPattern(pattern, files)
        
        // Expand folders to get files inside them
        let filesToSelect: LocalFile[] = []
        for (const match of matches) {
          if (match.isDirectory) {
            // Get all files inside this folder
            const folderPath = match.relativePath.replace(/\\/g, '/')
            const filesInFolder = files.filter(f => {
              if (f.isDirectory) return false
              const filePath = f.relativePath.replace(/\\/g, '/')
              return filePath.startsWith(folderPath + '/')
            })
            filesToSelect.push(...filesInFolder)
          } else {
            filesToSelect.push(match)
          }
        }
        
        // Deduplicate
        const uniquePaths = [...new Set(filesToSelect.map(f => f.path))]
        const paths = uniquePaths
        
        if (parsed.flags['add'] || parsed.flags['a']) {
          // Add to current selection
          const newSelection = [...new Set([...currentSelection, ...paths])]
          setSelectedFiles(newSelection)
          addOutput('success', `Added ${paths.length} files to selection (total: ${newSelection.length})`)
        } else {
          setSelectedFiles(paths)
          addOutput('success', `Selected ${paths.length} files`)
        }
      } else {
        // Show current selection
        if (currentSelection.length === 0) {
          addOutput('info', 'No files selected')
        } else {
          const selectedFiles = files.filter(f => currentSelection.includes(f.path))
          const lines = selectedFiles.slice(0, 10).map(f => `  ${f.relativePath}`)
          if (selectedFiles.length > 10) {
            lines.push(`  ... and ${selectedFiles.length - 10} more`)
          }
          addOutput('info', `Selected ${selectedFiles.length} files:\n${lines.join('\n')}`)
        }
      }
      return outputs
    }
    
    // ============================================
    // FIND/SEARCH - Search files
    // ============================================
    case 'find':
    case 'search':
    case 'grep': {
      const query = parsed.args.join(' ').toLowerCase()
      if (!query) {
        addOutput('error', 'Usage: find <query>')
        return outputs
      }
      
      const searchType = parsed.flags['type'] as string || 'all'
      
      const matches = files.filter(f => {
        if (searchType === 'files' && f.isDirectory) return false
        if (searchType === 'folders' && !f.isDirectory) return false
        
        return f.name.toLowerCase().includes(query) ||
               f.relativePath.toLowerCase().includes(query)
      })
      
      if (matches.length === 0) {
        addOutput('info', `No matches for: ${query}`)
      } else {
        const lines = matches.slice(0, 20).map(f => {
          const icon = f.isDirectory ? '📁' : '📄'
          return `${icon} ${f.relativePath}`
        })
        if (matches.length > 20) {
          lines.push(`... and ${matches.length - 20} more`)
        }
        addOutput('info', `Found ${matches.length} matches:\n${lines.join('\n')}`)
      }
      return outputs
    }
    
    // ============================================
    // INFO - Show file properties
    // ============================================
    case 'info':
    case 'props':
    case 'properties': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: info <path>')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      if (matches.length === 0) {
        addOutput('error', `File not found: ${path}`)
        return outputs
      }
      
      const file = matches[0]
      const lines = [
        `📋 ${file.name}`,
        `   Path: ${file.relativePath}`,
        `   Type: ${file.isDirectory ? 'Folder' : file.extension || 'File'}`,
      ]
      
      if (!file.isDirectory) {
        lines.push(`   Size: ${formatBytes(file.size || 0)}`)
        if (file.localModified) {
          lines.push(`   Modified: ${new Date(file.localModified).toLocaleString()}`)
        }
      }
      
      if (file.pdmData) {
        lines.push(`   Status: ${file.pdmData.checked_out_by ? '🔒 Checked Out' : '✅ Synced'}`)
        if (file.pdmData.checked_out_by) {
          const { user } = usePDMStore.getState()
          const isMe = file.pdmData.checked_out_by === user?.id
          lines.push(`   Checked out by: ${isMe ? 'You' : file.pdmData.checked_out_by_name || 'Unknown'}`)
        }
        if (file.pdmData.version) {
          lines.push(`   Version: ${file.pdmData.version}`)
        }
      } else if (file.diffStatus === 'cloud') {
        lines.push(`   Status: ☁️ Cloud only (not downloaded)`)
      } else if (file.diffStatus === 'added') {
        lines.push(`   Status: ➕ Local only (not synced)`)
      }
      
      addOutput('info', lines.join('\n'))
      return outputs
    }
    
    // ============================================
    // WHOAMI - Show current user
    // ============================================
    case 'whoami': {
      const { user, organization } = usePDMStore.getState()
      if (!user) {
        addOutput('info', 'Not signed in')
      } else {
        addOutput('info', [
          `👤 ${user.full_name || user.email}`,
          `   Email: ${user.email}`,
          organization ? `   Organization: ${organization.name}` : '',
          `   Role: ${user.is_admin ? 'Admin' : 'Member'}`
        ].filter(Boolean).join('\n'))
      }
      return outputs
    }
    
    // ============================================
    // VAULT - Show vault info
    // ============================================
    case 'vault':
    case 'vaults': {
      const { connectedVaults, activeVaultId, vaultPath, vaultName } = usePDMStore.getState()
      
      if (connectedVaults.length === 0) {
        addOutput('info', 'No vaults connected')
        return outputs
      }
      
      const lines = ['📦 Connected Vaults:']
      for (const vault of connectedVaults) {
        const isActive = vault.id === activeVaultId
        const marker = isActive ? '▶' : ' '
        lines.push(`${marker} ${vault.name}`)
        lines.push(`    Path: ${vault.localPath}`)
        if (vault.organization_name) {
          lines.push(`    Org: ${vault.organization_name}`)
        }
      }
      
      addOutput('info', lines.join('\n'))
      return outputs
    }
    
    // ============================================
    // REFRESH - Refresh file list
    // ============================================
    case 'refresh':
    case 'reload': {
      addOutput('info', 'Refreshing file list...')
      onRefresh?.(false)
      return outputs
    }
    
    // ============================================
    // CHECKOUTS - List checked out files
    // ============================================
    case 'checkouts':
    case 'locked': {
      const { user } = usePDMStore.getState()
      const showMine = parsed.flags['mine'] || parsed.flags['m']
      const showOthers = parsed.flags['others'] || parsed.flags['o']
      
      let checkedOutFiles = files.filter(f => !f.isDirectory && f.pdmData?.checked_out_by)
      
      if (showMine) {
        checkedOutFiles = checkedOutFiles.filter(f => f.pdmData?.checked_out_by === user?.id)
      } else if (showOthers) {
        checkedOutFiles = checkedOutFiles.filter(f => f.pdmData?.checked_out_by !== user?.id)
      }
      
      if (checkedOutFiles.length === 0) {
        addOutput('info', showMine ? 'You have no files checked out' : showOthers ? 'No files checked out by others' : 'No files checked out')
        return outputs
      }
      
      const lines = [`🔒 Checked Out Files (${checkedOutFiles.length}):`]
      for (const file of checkedOutFiles.slice(0, 20)) {
        const byMe = file.pdmData?.checked_out_by === user?.id
        const who = byMe ? 'you' : (file.pdmData?.checked_out_by_name || 'unknown')
        lines.push(`  ${file.relativePath} (${who})`)
      }
      if (checkedOutFiles.length > 20) {
        lines.push(`  ... and ${checkedOutFiles.length - 20} more`)
      }
      
      addOutput('info', lines.join('\n'))
      return outputs
    }
    
    // ============================================
    // MKDIR - Create new folder
    // ============================================
    case 'mkdir':
    case 'md':
    case 'new-folder': {
      const folderName = parsed.args[0]
      if (!folderName) {
        addOutput('error', 'Usage: mkdir <name>')
        return outputs
      }
      
      const { currentFolder } = usePDMStore.getState()
      
      try {
        const result = await executeCommand('new-folder', {
          parentPath: currentFolder,
          folderName: folderName
        }, { onRefresh })
        
        if (result.success) {
          addOutput('success', result.message)
        } else {
          addOutput('error', result.message)
        }
      } catch (err) {
        addOutput('error', `Failed to create folder: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // RENAME - Rename file or folder
    // ============================================
    case 'rename':
    case 'ren': {
      const sourcePath = parsed.args[0]
      const newName = parsed.args[1]
      
      if (!sourcePath || !newName) {
        addOutput('error', 'Usage: rename <path> <newname>')
        return outputs
      }
      
      const matches = resolvePathPattern(sourcePath, files)
      if (matches.length === 0) {
        addOutput('error', `File not found: ${sourcePath}`)
        return outputs
      }
      
      if (matches.length > 1) {
        addOutput('error', 'Can only rename one file at a time')
        return outputs
      }
      
      try {
        const result = await executeCommand('rename', {
          file: matches[0],
          newName: newName
        }, { onRefresh })
        
        if (result.success) {
          addOutput('success', result.message)
        } else {
          addOutput('error', result.message)
        }
      } catch (err) {
        addOutput('error', `Failed to rename: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // MOVE - Move files to new location
    // ============================================
    case 'move':
    case 'mv': {
      if (parsed.args.length < 2) {
        addOutput('error', 'Usage: move <source...> <destination>')
        return outputs
      }
      
      const destPath = parsed.args[parsed.args.length - 1].replace(/\\/g, '/').replace(/^\.\//, '')
      const sourcePatterns = parsed.args.slice(0, -1)
      
      // Resolve destination folder
      const destFolder = files.find(f => 
        f.isDirectory && f.relativePath.replace(/\\/g, '/') === destPath
      )
      
      if (!destFolder && destPath !== '' && destPath !== '.') {
        addOutput('error', `Destination folder not found: ${destPath}`)
        return outputs
      }
      
      // Resolve source files
      const sourceFiles: LocalFile[] = []
      for (const pattern of sourcePatterns) {
        const matches = resolvePathPattern(pattern, files)
        sourceFiles.push(...matches)
      }
      
      if (sourceFiles.length === 0) {
        addOutput('error', 'No source files matched')
        return outputs
      }
      
      try {
        const result = await executeCommand('move', {
          files: sourceFiles,
          targetFolder: destPath === '.' ? '' : destPath
        }, { onRefresh })
        
        if (result.success) {
          addOutput('success', result.message)
        } else {
          addOutput('error', result.message)
        }
      } catch (err) {
        addOutput('error', `Failed to move: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // COPY - Copy files to new location
    // ============================================
    case 'copy':
    case 'cp': {
      if (parsed.args.length < 2) {
        addOutput('error', 'Usage: copy <source...> <destination>')
        return outputs
      }
      
      const destPath = parsed.args[parsed.args.length - 1].replace(/\\/g, '/').replace(/^\.\//, '')
      const sourcePatterns = parsed.args.slice(0, -1)
      
      // Resolve destination folder
      const destFolder = files.find(f => 
        f.isDirectory && f.relativePath.replace(/\\/g, '/') === destPath
      )
      
      if (!destFolder && destPath !== '' && destPath !== '.') {
        addOutput('error', `Destination folder not found: ${destPath}`)
        return outputs
      }
      
      // Resolve source files
      const sourceFiles: LocalFile[] = []
      for (const pattern of sourcePatterns) {
        const matches = resolvePathPattern(pattern, files)
        sourceFiles.push(...matches)
      }
      
      if (sourceFiles.length === 0) {
        addOutput('error', 'No source files matched')
        return outputs
      }
      
      try {
        const result = await executeCommand('copy', {
          files: sourceFiles,
          targetFolder: destPath === '.' ? '' : destPath
        }, { onRefresh })
        
        if (result.success) {
          addOutput('success', result.message)
        } else {
          addOutput('error', result.message)
        }
      } catch (err) {
        addOutput('error', `Failed to copy: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // PIN/UNPIN - Pin or unpin files/folders
    // ============================================
    case 'pin': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: pin <path>')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      if (matches.length === 0) {
        addOutput('error', `Not found: ${path}`)
        return outputs
      }
      
      const { activeVaultId, connectedVaults } = usePDMStore.getState()
      const vault = connectedVaults.find(v => v.id === activeVaultId)
      
      if (!activeVaultId || !vault) {
        addOutput('error', 'No active vault')
        return outputs
      }
      
      try {
        const result = await executeCommand('pin', {
          file: matches[0],
          vaultId: activeVaultId,
          vaultName: vault.name
        }, { onRefresh })
        
        if (result.success) {
          addOutput('success', result.message)
        } else {
          addOutput('error', result.message)
        }
      } catch (err) {
        addOutput('error', `Failed to pin: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    case 'unpin': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: unpin <path>')
        return outputs
      }
      
      const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '')
      
      try {
        const result = await executeCommand('unpin', {
          path: normalizedPath
        }, { onRefresh })
        
        if (result.success) {
          addOutput('success', result.message)
        } else {
          addOutput('error', result.message)
        }
      } catch (err) {
        addOutput('error', `Failed to unpin: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // IGNORE - Add ignore pattern
    // ============================================
    case 'ignore': {
      const pattern = parsed.args[0]
      if (!pattern) {
        // Show current ignore patterns
        const { activeVaultId, getIgnorePatterns } = usePDMStore.getState()
        if (!activeVaultId) {
          addOutput('error', 'No active vault')
          return outputs
        }
        
        const patterns = getIgnorePatterns(activeVaultId)
        if (patterns.length === 0) {
          addOutput('info', 'No ignore patterns set')
        } else {
          addOutput('info', `Ignore patterns:\n${patterns.map(p => `  ${p}`).join('\n')}`)
        }
        return outputs
      }
      
      const { activeVaultId } = usePDMStore.getState()
      if (!activeVaultId) {
        addOutput('error', 'No active vault')
        return outputs
      }
      
      try {
        const result = await executeCommand('ignore', {
          vaultId: activeVaultId,
          pattern: pattern
        }, { onRefresh })
        
        if (result.success) {
          addOutput('success', result.message)
        } else {
          addOutput('error', result.message)
        }
      } catch (err) {
        addOutput('error', `Failed to add ignore pattern: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // TOUCH - Create empty file
    // ============================================
    case 'touch': {
      const fileName = parsed.args[0]
      if (!fileName) {
        addOutput('error', 'Usage: touch <filename>')
        return outputs
      }
      
      const { currentFolder, vaultPath } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const isWindows = vaultPath.includes('\\')
      const sep = isWindows ? '\\' : '/'
      const relativePath = currentFolder ? `${currentFolder}/${fileName}` : fileName
      const fullPath = `${vaultPath}${sep}${relativePath.replace(/\//g, sep)}`
      
      try {
        const result = await window.electronAPI?.writeFile(fullPath, '')
        if (result?.success) {
          addOutput('success', `Created ${fileName}`)
          onRefresh?.(true)
        } else {
          addOutput('error', result?.error || 'Failed to create file')
        }
      } catch (err) {
        addOutput('error', `Failed to create file: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // ECHO - Just echo text (useful for scripts)
    // ============================================
    case 'echo': {
      const text = parsed.args.join(' ')
      addOutput('info', text)
      return outputs
    }
    
    // ============================================
    // CAT - Display file contents
    // ============================================
    case 'cat':
    case 'type': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: cat <file-path>')
        return outputs
      }
      
      const { vaultPath } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      // Resolve to local file
      const matches = resolvePathPattern(path, files)
      let filePath: string
      
      if (matches.length > 0 && !matches[0].isDirectory) {
        filePath = matches[0].path
      } else {
        // Try direct path resolution
        const isWindows = vaultPath.includes('\\')
        const sep = isWindows ? '\\' : '/'
        const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '')
        filePath = `${vaultPath}${sep}${normalizedPath.replace(/\//g, sep)}`
      }
      
      try {
        const result = await window.electronAPI?.readFile(filePath)
        if (result?.success && result.data) {
          // Decode base64 to text
          try {
            const text = atob(result.data)
            // Check if it looks like binary
            if (/[\x00-\x08\x0E-\x1F]/.test(text.substring(0, 1000))) {
              addOutput('error', 'Binary file detected. Use a hex viewer for binary files.')
              return outputs
            }
            const maxLines = parseInt(parsed.flags['n'] as string) || 500
            const lines = text.split('\n')
            if (lines.length > maxLines) {
              addOutput('info', lines.slice(0, maxLines).join('\n'))
              addOutput('info', `... truncated (${lines.length - maxLines} more lines)`)
            } else {
              addOutput('info', text)
            }
          } catch {
            addOutput('error', 'Could not decode file (may be binary)')
          }
        } else {
          addOutput('error', result?.error || 'Failed to read file')
        }
      } catch (err) {
        addOutput('error', `Failed to read file: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // HEAD - Display first N lines
    // ============================================
    case 'head': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: head <file-path> [-n lines]')
        return outputs
      }
      
      const { vaultPath } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      let filePath: string
      
      if (matches.length > 0 && !matches[0].isDirectory) {
        filePath = matches[0].path
      } else {
        const isWindows = vaultPath.includes('\\')
        const sep = isWindows ? '\\' : '/'
        const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '')
        filePath = `${vaultPath}${sep}${normalizedPath.replace(/\//g, sep)}`
      }
      
      const numLines = parseInt(parsed.flags['n'] as string) || 10
      
      try {
        const result = await window.electronAPI?.readFile(filePath)
        if (result?.success && result.data) {
          try {
            const text = atob(result.data)
            const lines = text.split('\n').slice(0, numLines)
            addOutput('info', lines.join('\n'))
          } catch {
            addOutput('error', 'Could not decode file')
          }
        } else {
          addOutput('error', result?.error || 'Failed to read file')
        }
      } catch (err) {
        addOutput('error', `Failed to read file: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // TAIL - Display last N lines
    // ============================================
    case 'tail': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: tail <file-path> [-n lines]')
        return outputs
      }
      
      const { vaultPath } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      let filePath: string
      
      if (matches.length > 0 && !matches[0].isDirectory) {
        filePath = matches[0].path
      } else {
        const isWindows = vaultPath.includes('\\')
        const sep = isWindows ? '\\' : '/'
        const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '')
        filePath = `${vaultPath}${sep}${normalizedPath.replace(/\//g, sep)}`
      }
      
      const numLines = parseInt(parsed.flags['n'] as string) || 10
      
      try {
        const result = await window.electronAPI?.readFile(filePath)
        if (result?.success && result.data) {
          try {
            const text = atob(result.data)
            const lines = text.split('\n').slice(-numLines)
            addOutput('info', lines.join('\n'))
          } catch {
            addOutput('error', 'Could not decode file')
          }
        } else {
          addOutput('error', result?.error || 'Failed to read file')
        }
      } catch (err) {
        addOutput('error', `Failed to read file: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // WRITE - Write text to file (create/overwrite)
    // ============================================
    case 'write': {
      const path = parsed.args[0]
      const content = parsed.args.slice(1).join(' ')
      
      if (!path) {
        addOutput('error', 'Usage: write <file-path> <content>')
        addOutput('info', 'Use \\n for newlines, or write> for multi-line input')
        return outputs
      }
      
      const { vaultPath, currentFolder } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const isWindows = vaultPath.includes('\\')
      const sep = isWindows ? '\\' : '/'
      let filePath: string
      
      // Check if it's a relative path
      if (path.startsWith('./') || path.startsWith('.\\') || !path.includes('/') && !path.includes('\\')) {
        const relativePath = currentFolder 
          ? `${currentFolder}/${path.replace(/^\.\//, '')}`
          : path.replace(/^\.\//, '')
        filePath = `${vaultPath}${sep}${relativePath.replace(/\//g, sep)}`
      } else {
        filePath = `${vaultPath}${sep}${path.replace(/\//g, sep)}`
      }
      
      // Process escape sequences
      const processedContent = content
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
      
      try {
        const base64 = btoa(processedContent)
        const result = await window.electronAPI?.writeFile(filePath, base64)
        if (result?.success) {
          addOutput('success', `Written to ${path} (${result.size || processedContent.length} bytes)`)
          onRefresh?.(true)
        } else {
          addOutput('error', result?.error || 'Failed to write file')
        }
      } catch (err) {
        addOutput('error', `Failed to write file: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // APPEND - Append text to file
    // ============================================
    case 'append': {
      const path = parsed.args[0]
      const content = parsed.args.slice(1).join(' ')
      
      if (!path || !content) {
        addOutput('error', 'Usage: append <file-path> <content>')
        return outputs
      }
      
      const { vaultPath, currentFolder } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const isWindows = vaultPath.includes('\\')
      const sep = isWindows ? '\\' : '/'
      let filePath: string
      
      if (path.startsWith('./') || path.startsWith('.\\') || !path.includes('/') && !path.includes('\\')) {
        const relativePath = currentFolder 
          ? `${currentFolder}/${path.replace(/^\.\//, '')}`
          : path.replace(/^\.\//, '')
        filePath = `${vaultPath}${sep}${relativePath.replace(/\//g, sep)}`
      } else {
        filePath = `${vaultPath}${sep}${path.replace(/\//g, sep)}`
      }
      
      // Process escape sequences
      const processedContent = content
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
      
      try {
        // Read existing content first
        const readResult = await window.electronAPI?.readFile(filePath)
        let existingContent = ''
        if (readResult?.success && readResult.data) {
          existingContent = atob(readResult.data)
        }
        
        const newContent = existingContent + processedContent
        const base64 = btoa(newContent)
        const result = await window.electronAPI?.writeFile(filePath, base64)
        if (result?.success) {
          addOutput('success', `Appended to ${path}`)
          onRefresh?.(true)
        } else {
          addOutput('error', result?.error || 'Failed to append to file')
        }
      } catch (err) {
        addOutput('error', `Failed to append: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // JSON - Pretty print JSON file
    // ============================================
    case 'json': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: json <file-path>')
        return outputs
      }
      
      const { vaultPath } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      let filePath: string
      
      if (matches.length > 0 && !matches[0].isDirectory) {
        filePath = matches[0].path
      } else {
        const isWindows = vaultPath.includes('\\')
        const sep = isWindows ? '\\' : '/'
        const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '')
        filePath = `${vaultPath}${sep}${normalizedPath.replace(/\//g, sep)}`
      }
      
      try {
        const result = await window.electronAPI?.readFile(filePath)
        if (result?.success && result.data) {
          try {
            const text = atob(result.data)
            const json = JSON.parse(text)
            const pretty = JSON.stringify(json, null, 2)
            addOutput('info', pretty)
          } catch (parseErr) {
            addOutput('error', `Invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`)
          }
        } else {
          addOutput('error', result?.error || 'Failed to read file')
        }
      } catch (err) {
        addOutput('error', `Failed to read file: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // JSON-GET - Get value from JSON by key path
    // ============================================
    case 'json-get':
    case 'jq': {
      const path = parsed.args[0]
      const keyPath = parsed.args[1]
      
      if (!path) {
        addOutput('error', 'Usage: json-get <file-path> [key.path]')
        addOutput('info', 'Examples: json-get config.json name')
        addOutput('info', '          json-get data.json users.0.email')
        return outputs
      }
      
      const { vaultPath } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      let filePath: string
      
      if (matches.length > 0 && !matches[0].isDirectory) {
        filePath = matches[0].path
      } else {
        const isWindows = vaultPath.includes('\\')
        const sep = isWindows ? '\\' : '/'
        const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '')
        filePath = `${vaultPath}${sep}${normalizedPath.replace(/\//g, sep)}`
      }
      
      try {
        const result = await window.electronAPI?.readFile(filePath)
        if (result?.success && result.data) {
          try {
            const text = atob(result.data)
            let json = JSON.parse(text)
            
            // Navigate to key path if provided
            if (keyPath) {
              const keys = keyPath.split('.')
              for (const key of keys) {
                if (json === null || json === undefined) {
                  addOutput('error', `Key not found: ${keyPath}`)
                  return outputs
                }
                // Handle array index
                const arrayIndex = parseInt(key)
                if (!isNaN(arrayIndex) && Array.isArray(json)) {
                  json = json[arrayIndex]
                } else {
                  json = json[key]
                }
              }
            }
            
            if (typeof json === 'object') {
              addOutput('info', JSON.stringify(json, null, 2))
            } else {
              addOutput('info', String(json))
            }
          } catch (parseErr) {
            addOutput('error', `Invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`)
          }
        } else {
          addOutput('error', result?.error || 'Failed to read file')
        }
      } catch (err) {
        addOutput('error', `Failed to read file: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // JSON-SET - Set value in JSON file
    // ============================================
    case 'json-set': {
      const path = parsed.args[0]
      const keyPath = parsed.args[1]
      const value = parsed.args.slice(2).join(' ')
      
      if (!path || !keyPath) {
        addOutput('error', 'Usage: json-set <file-path> <key.path> <value>')
        addOutput('info', 'Examples: json-set config.json name "My App"')
        addOutput('info', '          json-set data.json settings.enabled true')
        return outputs
      }
      
      const { vaultPath, currentFolder } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const isWindows = vaultPath.includes('\\')
      const sep = isWindows ? '\\' : '/'
      let filePath: string
      
      const matches = resolvePathPattern(path, files)
      if (matches.length > 0 && !matches[0].isDirectory) {
        filePath = matches[0].path
      } else if (path.startsWith('./') || path.startsWith('.\\') || !path.includes('/') && !path.includes('\\')) {
        const relativePath = currentFolder 
          ? `${currentFolder}/${path.replace(/^\.\//, '')}`
          : path.replace(/^\.\//, '')
        filePath = `${vaultPath}${sep}${relativePath.replace(/\//g, sep)}`
      } else {
        filePath = `${vaultPath}${sep}${path.replace(/\//g, sep)}`
      }
      
      try {
        // Read existing JSON
        const readResult = await window.electronAPI?.readFile(filePath)
        let json: Record<string, unknown> = {}
        
        if (readResult?.success && readResult.data) {
          try {
            json = JSON.parse(atob(readResult.data))
          } catch {
            addOutput('error', 'File exists but is not valid JSON')
            return outputs
          }
        }
        
        // Parse the value
        let parsedValue: unknown
        try {
          // Try parsing as JSON first (for objects, arrays, booleans, numbers)
          parsedValue = JSON.parse(value)
        } catch {
          // If that fails, treat as string
          parsedValue = value
        }
        
        // Navigate and set the value
        const keys = keyPath.split('.')
        let current: Record<string, unknown> = json
        
        for (let i = 0; i < keys.length - 1; i++) {
          const key = keys[i]
          const arrayIndex = parseInt(key)
          
          if (!isNaN(arrayIndex) && Array.isArray(current)) {
            if (!current[arrayIndex]) current[arrayIndex] = {} as unknown
            current = current[arrayIndex] as Record<string, unknown>
          } else {
            if (!current[key] || typeof current[key] !== 'object') {
              current[key] = {}
            }
            current = current[key] as Record<string, unknown>
          }
        }
        
        const finalKey = keys[keys.length - 1]
        const finalArrayIndex = parseInt(finalKey)
        if (!isNaN(finalArrayIndex) && Array.isArray(current)) {
          (current as unknown[])[finalArrayIndex] = parsedValue
        } else {
          current[finalKey] = parsedValue
        }
        
        // Write back
        const pretty = JSON.stringify(json, null, 2)
        const base64 = btoa(pretty)
        const writeResult = await window.electronAPI?.writeFile(filePath, base64)
        
        if (writeResult?.success) {
          addOutput('success', `Set ${keyPath} = ${JSON.stringify(parsedValue)}`)
          onRefresh?.(true)
        } else {
          addOutput('error', writeResult?.error || 'Failed to write file')
        }
      } catch (err) {
        addOutput('error', `Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // WC - Word/line/character count
    // ============================================
    case 'wc': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: wc <file-path>')
        return outputs
      }
      
      const { vaultPath } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      let filePath: string
      
      if (matches.length > 0 && !matches[0].isDirectory) {
        filePath = matches[0].path
      } else {
        const isWindows = vaultPath.includes('\\')
        const sep = isWindows ? '\\' : '/'
        const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '')
        filePath = `${vaultPath}${sep}${normalizedPath.replace(/\//g, sep)}`
      }
      
      try {
        const result = await window.electronAPI?.readFile(filePath)
        if (result?.success && result.data) {
          const text = atob(result.data)
          const lines = text.split('\n').length
          const words = text.split(/\s+/).filter(w => w.length > 0).length
          const chars = text.length
          const bytes = new Blob([text]).size
          
          addOutput('info', `  ${lines} lines, ${words} words, ${chars} characters, ${bytes} bytes`)
        } else {
          addOutput('error', result?.error || 'Failed to read file')
        }
      } catch (err) {
        addOutput('error', `Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // DIFF - Compare two files
    // ============================================
    case 'diff': {
      const path1 = parsed.args[0]
      const path2 = parsed.args[1]
      
      if (!path1 || !path2) {
        addOutput('error', 'Usage: diff <file1> <file2>')
        return outputs
      }
      
      const { vaultPath } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const isWindows = vaultPath.includes('\\')
      const sep = isWindows ? '\\' : '/'
      
      const resolvePath = (p: string) => {
        const matches = resolvePathPattern(p, files)
        if (matches.length > 0 && !matches[0].isDirectory) {
          return matches[0].path
        }
        const normalizedPath = p.replace(/\\/g, '/').replace(/^\.\//, '')
        return `${vaultPath}${sep}${normalizedPath.replace(/\//g, sep)}`
      }
      
      try {
        const [result1, result2] = await Promise.all([
          window.electronAPI?.readFile(resolvePath(path1)),
          window.electronAPI?.readFile(resolvePath(path2))
        ])
        
        if (!result1?.success || !result1.data) {
          addOutput('error', `Cannot read ${path1}: ${result1?.error || 'unknown error'}`)
          return outputs
        }
        if (!result2?.success || !result2.data) {
          addOutput('error', `Cannot read ${path2}: ${result2?.error || 'unknown error'}`)
          return outputs
        }
        
        const text1 = atob(result1.data)
        const text2 = atob(result2.data)
        
        if (text1 === text2) {
          addOutput('success', 'Files are identical')
          return outputs
        }
        
        const lines1 = text1.split('\n')
        const lines2 = text2.split('\n')
        
        const output: string[] = [`--- ${path1}`, `+++ ${path2}`, '']
        let diffCount = 0
        const maxDiffs = 50
        
        const maxLines = Math.max(lines1.length, lines2.length)
        for (let i = 0; i < maxLines && diffCount < maxDiffs; i++) {
          const line1 = lines1[i]
          const line2 = lines2[i]
          
          if (line1 !== line2) {
            diffCount++
            if (line1 !== undefined && line2 === undefined) {
              output.push(`@@ line ${i + 1} @@`)
              output.push(`- ${line1}`)
            } else if (line1 === undefined && line2 !== undefined) {
              output.push(`@@ line ${i + 1} @@`)
              output.push(`+ ${line2}`)
            } else {
              output.push(`@@ line ${i + 1} @@`)
              output.push(`- ${line1}`)
              output.push(`+ ${line2}`)
            }
          }
        }
        
        if (diffCount >= maxDiffs) {
          output.push(`... (truncated, showing first ${maxDiffs} differences)`)
        }
        
        addOutput('info', output.join('\n'))
      } catch (err) {
        addOutput('error', `Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // GREP-CONTENT - Search within file contents
    // ============================================
    case 'grep-content':
    case 'fgrep':
    case 'rg': {
      const pattern = parsed.args[0]
      const searchPath = parsed.args[1] || '.'
      
      if (!pattern) {
        addOutput('error', 'Usage: grep-content <pattern> [path]')
        addOutput('info', 'Searches text content within files. Use -i for case-insensitive.')
        return outputs
      }
      
      const { vaultPath, currentFolder } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const caseInsensitive = parsed.flags['i'] === true
      
      // Determine which files to search
      let filesToSearch: LocalFile[]
      if (searchPath === '.') {
        // Current folder and subfolders
        const folderPrefix = currentFolder ? currentFolder + '/' : ''
        filesToSearch = files.filter(f => {
          if (f.isDirectory) return false
          const normalizedPath = f.relativePath.replace(/\\/g, '/')
          return currentFolder ? normalizedPath.startsWith(folderPrefix) : true
        })
      } else {
        const matches = resolvePathPattern(searchPath, files)
        if (matches.length === 0) {
          addOutput('error', `No files match: ${searchPath}`)
          return outputs
        }
        
        // Expand folders
        filesToSearch = []
        for (const match of matches) {
          if (match.isDirectory) {
            const folderPath = match.relativePath.replace(/\\/g, '/')
            const filesInFolder = files.filter(f => {
              if (f.isDirectory) return false
              const filePath = f.relativePath.replace(/\\/g, '/')
              return filePath.startsWith(folderPath + '/')
            })
            filesToSearch.push(...filesInFolder)
          } else {
            filesToSearch.push(match)
          }
        }
      }
      
      // Filter to text files only
      const textExtensions = ['.txt', '.md', '.json', '.xml', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', 
                             '.yaml', '.yml', '.ini', '.cfg', '.conf', '.log', '.csv', '.sql', '.sh', '.bat',
                             '.py', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs',
                             '.vue', '.svelte', '.astro', '.toml', '.env', '.gitignore', '.editorconfig']
      filesToSearch = filesToSearch.filter(f => {
        const ext = f.extension?.toLowerCase() || ''
        return textExtensions.includes(`.${ext}`) || ext === ''
      })
      
      if (filesToSearch.length === 0) {
        addOutput('info', 'No text files to search')
        return outputs
      }
      
      addOutput('info', `Searching ${filesToSearch.length} files for "${pattern}"...`)
      
      const results: { file: string; line: number; content: string }[] = []
      const maxResults = 100
      let searchedCount = 0
      
      try {
        const regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g')
        
        for (const file of filesToSearch.slice(0, 50)) { // Limit files to search
          if (results.length >= maxResults) break
          
          try {
            const readResult = await window.electronAPI?.readFile(file.path)
            if (!readResult?.success || !readResult.data) continue
            
            const text = atob(readResult.data)
            // Check if binary
            if (/[\x00-\x08\x0E-\x1F]/.test(text.substring(0, 500))) continue
            
            searchedCount++
            const lines = text.split('\n')
            
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              if (regex.test(lines[i])) {
                results.push({
                  file: file.relativePath,
                  line: i + 1,
                  content: lines[i].substring(0, 200)
                })
                regex.lastIndex = 0 // Reset for next test
              }
            }
          } catch {
            // Skip files that can't be read
          }
        }
        
        if (results.length === 0) {
          addOutput('info', `No matches found in ${searchedCount} files`)
        } else {
          const output = results.map(r => 
            `${r.file}:${r.line}: ${r.content}`
          )
          addOutput('info', `Found ${results.length} matches:\n${output.join('\n')}`)
          if (results.length >= maxResults) {
            addOutput('info', `(showing first ${maxResults} results)`)
          }
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          addOutput('error', `Invalid regex pattern: ${pattern}`)
        } else {
          addOutput('error', `Search failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return outputs
    }
    
    // ============================================
    // SED - Simple find/replace in file
    // ============================================
    case 'sed':
    case 'replace': {
      const path = parsed.args[0]
      const findStr = parsed.args[1]
      const replaceStr = parsed.args[2]
      
      if (!path || findStr === undefined) {
        addOutput('error', 'Usage: sed <file-path> <find> <replace>')
        addOutput('info', 'Use --all to replace all occurrences (default: first only)')
        return outputs
      }
      
      const { vaultPath } = usePDMStore.getState()
      if (!vaultPath) {
        addOutput('error', 'No vault connected')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      let filePath: string
      
      if (matches.length > 0 && !matches[0].isDirectory) {
        filePath = matches[0].path
      } else {
        const isWindows = vaultPath.includes('\\')
        const sep = isWindows ? '\\' : '/'
        const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '')
        filePath = `${vaultPath}${sep}${normalizedPath.replace(/\//g, sep)}`
      }
      
      const replaceAll = parsed.flags['all'] === true || parsed.flags['g'] === true
      
      try {
        const readResult = await window.electronAPI?.readFile(filePath)
        if (!readResult?.success || !readResult.data) {
          addOutput('error', readResult?.error || 'Failed to read file')
          return outputs
        }
        
        const text = atob(readResult.data)
        let newText: string
        let count = 0
        
        if (replaceAll) {
          // Count occurrences and replace all
          const regex = new RegExp(findStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
          count = (text.match(regex) || []).length
          newText = text.split(findStr).join(replaceStr || '')
        } else {
          // Replace first occurrence only
          const index = text.indexOf(findStr)
          if (index !== -1) {
            newText = text.substring(0, index) + (replaceStr || '') + text.substring(index + findStr.length)
            count = 1
          } else {
            newText = text
          }
        }
        
        if (count === 0) {
          addOutput('info', `No occurrences of "${findStr}" found`)
          return outputs
        }
        
        const base64 = btoa(newText)
        const writeResult = await window.electronAPI?.writeFile(filePath, base64)
        
        if (writeResult?.success) {
          addOutput('success', `Replaced ${count} occurrence${count > 1 ? 's' : ''} of "${findStr}"`)
          onRefresh?.(true)
        } else {
          addOutput('error', writeResult?.error || 'Failed to write file')
        }
      } catch (err) {
        addOutput('error', `Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return outputs
    }
    
    // ============================================
    // ENV - Show environment info
    // ============================================
    case 'env':
    case 'version': {
      const { organization, connectedVaults, activeVaultId } = usePDMStore.getState()
      const activeVault = connectedVaults.find(v => v.id === activeVaultId)
      
      addOutput('info', [
        '🔧 BluePDM Environment',
        `   Version: ${window.electronAPI ? 'Desktop' : 'Web'}`,
        `   Organization: ${organization?.name || 'None'}`,
        `   Active Vault: ${activeVault?.name || 'None'}`,
        `   Platform: ${navigator.platform}`,
      ].join('\n'))
      return outputs
    }
    
    // ============================================
    // LOGS - View and export logs
    // ============================================
    case 'logs': {
      const count = parseInt(parsed.flags['n'] as string) || 20
      try {
        const logs = await window.electronAPI?.getLogs()
        if (!logs || logs.length === 0) {
          addOutput('info', 'No logs available')
          return outputs
        }
        
        const recentLogs = logs.slice(-count)
        const lines = recentLogs.map(log => {
          const time = new Date(log.timestamp).toLocaleTimeString()
          const level = log.level.toUpperCase().padEnd(5)
          return `[${time}] ${level} ${log.message}`
        })
        addOutput('info', lines.join('\n'))
      } catch (err) {
        addOutput('error', `Failed to get logs: ${err}`)
      }
      return outputs
    }
    
    case 'export-logs': {
      try {
        const result = await window.electronAPI?.exportLogs()
        if (result?.success && result.path) {
          addOutput('success', `Logs exported to: ${result.path}`)
        } else {
          addOutput('error', result?.error || 'Failed to export logs')
        }
      } catch (err) {
        addOutput('error', `Failed to export logs: ${err}`)
      }
      return outputs
    }
    
    case 'logs-dir': {
      try {
        await window.electronAPI?.openLogsDir()
        addOutput('success', 'Opened logs directory')
      } catch (err) {
        addOutput('error', `Failed to open logs dir: ${err}`)
      }
      return outputs
    }
    
    // ============================================
    // BACKUP - Backup operations
    // ============================================
    case 'backup': {
      const { organization, user } = usePDMStore.getState()
      if (!organization || !user) {
        addOutput('error', 'Not signed in')
        return outputs
      }
      
      addOutput('info', 'Requesting backup...')
      try {
        const result = await requestBackup(organization.id, user.email)
        if (result.success) {
          addOutput('success', 'Backup requested. The designated machine will run the backup shortly.')
        } else {
          addOutput('error', result.error || 'Failed to request backup')
        }
      } catch (err) {
        addOutput('error', `Backup failed: ${err}`)
      }
      return outputs
    }
    
    case 'backup-status': {
      const { organization } = usePDMStore.getState()
      if (!organization) {
        addOutput('error', 'Not signed in')
        return outputs
      }
      
      try {
        const status = await getBackupStatus(organization.id)
        const lines = ['📦 Backup Status']
        
        if (!status.isConfigured) {
          lines.push('   Status: Not configured')
        } else {
          lines.push(`   Provider: ${status.config?.provider || 'Unknown'}`)
          lines.push(`   Bucket: ${status.config?.bucket || 'Unknown'}`)
          lines.push(`   Designated Machine: ${status.config?.designated_machine_name || 'None'}`)
          
          if (status.config?.backup_running_since) {
            lines.push(`   🔄 Backup in progress since ${new Date(status.config.backup_running_since).toLocaleString()}`)
          } else if (status.config?.backup_requested_at) {
            lines.push(`   ⏳ Backup pending (requested ${new Date(status.config.backup_requested_at).toLocaleString()})`)
          }
          
          if (status.latestSnapshot) {
            lines.push(`   Latest: ${new Date(status.latestSnapshot.time).toLocaleString()}`)
          }
          
          lines.push(`   Total Snapshots: ${status.snapshotCount}`)
        }
        
        addOutput('info', lines.join('\n'))
      } catch (err) {
        addOutput('error', `Failed to get backup status: ${err}`)
      }
      return outputs
    }
    
    case 'backup-history':
    case 'snapshots': {
      const { organization } = usePDMStore.getState()
      if (!organization) {
        addOutput('error', 'Not signed in')
        return outputs
      }
      
      try {
        const config = await getBackupConfig(organization.id)
        if (!config) {
          addOutput('error', 'Backup not configured')
          return outputs
        }
        
        const snapshots = await listSnapshots(config)
        
        if (snapshots.length === 0) {
          addOutput('info', 'No backups found')
          return outputs
        }
        
        const lines = ['📦 Backup Snapshots:']
        for (const snap of snapshots.slice(0, 10)) {
          const date = new Date(snap.time).toLocaleString()
          const snapId = snap.short_id || snap.id?.substring(0, 8) || 'unknown'
          lines.push(`  ${snapId} - ${date} (${snap.tags?.join(', ') || 'no tags'})`)
        }
        if (snapshots.length > 10) {
          lines.push(`  ... and ${snapshots.length - 10} more`)
        }
        addOutput('info', lines.join('\n'))
      } catch (err) {
        addOutput('error', `Failed to list snapshots: ${err}`)
      }
      return outputs
    }
    
    // ============================================
    // TRASH - Trash operations
    // ============================================
    case 'trash': {
      const { organization, activeVaultId } = usePDMStore.getState()
      if (!organization) {
        addOutput('error', 'Not signed in')
        return outputs
      }
      
      try {
        const result = await getDeletedFiles(organization.id, { vaultId: activeVaultId || undefined })
        if (result.error) {
          addOutput('error', result.error)
          return outputs
        }
        
        if (result.files.length === 0) {
          addOutput('info', '🗑️ Trash is empty')
          return outputs
        }
        
        const lines = [`🗑️ Trash (${result.files.length} files):`]
        for (const file of result.files.slice(0, 20)) {
          const deletedDate = file.deleted_at ? new Date(file.deleted_at).toLocaleDateString() : ''
          const deletedBy = file.deleted_by_user?.full_name || file.deleted_by_user?.email || ''
          lines.push(`  ${file.file_path} (deleted ${deletedDate}${deletedBy ? ` by ${deletedBy}` : ''})`)
        }
        if (result.files.length > 20) {
          lines.push(`  ... and ${result.files.length - 20} more`)
        }
        addOutput('info', lines.join('\n'))
      } catch (err) {
        addOutput('error', `Failed to get trash: ${err}`)
      }
      return outputs
    }
    
    case 'restore': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: restore <file-path>')
        return outputs
      }
      
      const { organization, user, activeVaultId } = usePDMStore.getState()
      if (!organization || !user) {
        addOutput('error', 'Not signed in')
        return outputs
      }
      
      try {
        // Find file in trash by path
        const result = await getDeletedFiles(organization.id, { vaultId: activeVaultId || undefined })
        const fileToRestore = result.files.find(f => 
          f.file_path.toLowerCase().includes(path.toLowerCase())
        )
        
        if (!fileToRestore) {
          addOutput('error', `No deleted file matching: ${path}`)
          return outputs
        }
        
        const restoreResult = await restoreFile(fileToRestore.id, user.id)
        if (restoreResult.success) {
          addOutput('success', `Restored: ${fileToRestore.file_path}`)
          onRefresh?.(true)
        } else {
          addOutput('error', restoreResult.error || 'Failed to restore')
        }
      } catch (err) {
        addOutput('error', `Failed to restore: ${err}`)
      }
      return outputs
    }
    
    case 'empty-trash': {
      const { organization, user, activeVaultId } = usePDMStore.getState()
      if (!organization || !user) {
        addOutput('error', 'Not signed in')
        return outputs
      }
      
      if (!user.is_admin) {
        addOutput('error', 'Admin access required')
        return outputs
      }
      
      try {
        const result = await emptyTrash(organization.id, user.id, activeVaultId || undefined)
        if (result.success) {
          addOutput('success', `Permanently deleted ${result.deleted} files from trash`)
          onRefresh?.(true)
        } else {
          addOutput('error', result.error || 'Failed to empty trash')
        }
      } catch (err) {
        addOutput('error', `Failed to empty trash: ${err}`)
      }
      return outputs
    }
    
    // ============================================
    // VERSIONS - Version history and rollback
    // ============================================
    case 'versions': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: versions <file-path>')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      if (matches.length === 0 || !matches[0].pdmData?.id) {
        addOutput('error', `Synced file not found: ${path}`)
        return outputs
      }
      
      try {
        const result = await getFileVersions(matches[0].pdmData.id)
        if (result.error || !result.versions) {
          addOutput('error', result.error || 'Failed to get versions')
          return outputs
        }
        
        if (result.versions.length === 0) {
          addOutput('info', 'No version history')
          return outputs
        }
        
        const lines = [`📜 Version History for ${matches[0].name}:`]
        for (const ver of result.versions.slice(0, 15)) {
          const date = new Date(ver.created_at).toLocaleString()
          const user = ver.created_by_user?.full_name || ver.created_by_user?.email || ''
          const current = ver.version === matches[0].pdmData?.version ? ' (current)' : ''
          lines.push(`  v${ver.version} - ${date} by ${user}${current}`)
          if (ver.comment) lines.push(`       "${ver.comment}"`)
        }
        addOutput('info', lines.join('\n'))
      } catch (err) {
        addOutput('error', `Failed to get versions: ${err}`)
      }
      return outputs
    }
    
    case 'rollback': {
      const path = parsed.args[0]
      const versionStr = parsed.args[1]
      
      if (!path || !versionStr) {
        addOutput('error', 'Usage: rollback <file-path> <version>')
        return outputs
      }
      
      const version = parseInt(versionStr)
      if (isNaN(version)) {
        addOutput('error', 'Version must be a number')
        return outputs
      }
      
      const { user } = usePDMStore.getState()
      if (!user) {
        addOutput('error', 'Not signed in')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      if (matches.length === 0 || !matches[0].pdmData?.id) {
        addOutput('error', `Synced file not found: ${path}`)
        return outputs
      }
      
      const file = matches[0]
      if (file.pdmData?.checked_out_by !== user.id) {
        addOutput('error', 'File must be checked out to you to rollback')
        return outputs
      }
      
      try {
        addOutput('info', `Rolling back to version ${version}...`)
        const result = await rollbackToVersion(file.pdmData.id, version, user.id)
        
        if (result.success) {
          addOutput('success', `Rolled back to version ${version}. Check in to save.`)
          onRefresh?.(true)
        } else {
          addOutput('error', result.error || 'Rollback failed')
        }
      } catch (err) {
        addOutput('error', `Rollback failed: ${err}`)
      }
      return outputs
    }
    
    // ============================================
    // ACTIVITY - Activity feed
    // ============================================
    case 'activity': {
      const { organization } = usePDMStore.getState()
      if (!organization) {
        addOutput('error', 'Not signed in')
        return outputs
      }
      
      const count = parseInt(parsed.flags['n'] as string) || 20
      
      try {
        const result = await getRecentActivity(organization.id, count)
        if (result.error || !result.activity) {
          addOutput('error', result.error || 'Failed to get activity')
          return outputs
        }
        
        if (result.activity.length === 0) {
          addOutput('info', 'No recent activity')
          return outputs
        }
        
        const lines = ['📋 Recent Activity:']
        for (const act of result.activity) {
          const time = new Date(act.created_at).toLocaleString()
          const fileName = act.file?.file_name || act.details?.file_name || ''
          lines.push(`  ${time} - ${act.action}${fileName ? `: ${fileName}` : ''}`)
        }
        addOutput('info', lines.join('\n'))
      } catch (err) {
        addOutput('error', `Failed to get activity: ${err}`)
      }
      return outputs
    }
    
    // ============================================
    // METADATA - File metadata
    // ============================================
    case 'metadata': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: metadata <file-path>')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      if (matches.length === 0) {
        addOutput('error', `File not found: ${path}`)
        return outputs
      }
      
      const file = matches[0]
      const lines = [`📋 Metadata for ${file.name}:`]
      lines.push(`   Path: ${file.relativePath}`)
      lines.push(`   Type: ${file.extension || 'Unknown'}`)
      lines.push(`   Size: ${formatBytes(file.size || 0)}`)
      
      if (file.pdmData) {
        lines.push(`   Part Number: ${file.pdmData.part_number || 'None'}`)
        lines.push(`   Description: ${file.pdmData.description || 'None'}`)
        lines.push(`   Revision: ${file.pdmData.revision || 'None'}`)
        lines.push(`   State: ${file.pdmData.state || 'Unknown'}`)
        lines.push(`   Version: ${file.pdmData.version}`)
      }
      
      if (file.pendingMetadata) {
        lines.push(`   [Pending Changes]`)
        if (file.pendingMetadata.part_number !== undefined) {
          lines.push(`     Part Number → ${file.pendingMetadata.part_number || '(clear)'}`)
        }
        if (file.pendingMetadata.description !== undefined) {
          lines.push(`     Description → ${file.pendingMetadata.description || '(clear)'}`)
        }
        if (file.pendingMetadata.revision !== undefined) {
          lines.push(`     Revision → ${file.pendingMetadata.revision}`)
        }
      }
      
      addOutput('info', lines.join('\n'))
      return outputs
    }
    
    case 'set-state': {
      const path = parsed.args[0]
      const newState = parsed.args[1]
      
      if (!path || !newState) {
        addOutput('error', 'Usage: set-state <file-path> <state>')
        addOutput('info', 'States: wip, in_review, released, obsolete')
        return outputs
      }
      
      const validStates = ['wip', 'in_review', 'released', 'obsolete']
      if (!validStates.includes(newState)) {
        addOutput('error', `Invalid state. Must be one of: ${validStates.join(', ')}`)
        return outputs
      }
      
      const { user } = usePDMStore.getState()
      if (!user) {
        addOutput('error', 'Not signed in')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      if (matches.length === 0 || !matches[0].pdmData?.id) {
        addOutput('error', `Synced file not found: ${path}`)
        return outputs
      }
      
      try {
        const result = await updateFileMetadata(
          matches[0].pdmData.id, 
          user.id, 
          { state: newState as any }
        )
        
        if (result.success) {
          addOutput('success', `State changed to: ${newState}`)
          onRefresh?.(true)
        } else {
          addOutput('error', result.error || 'Failed to update state')
        }
      } catch (err) {
        addOutput('error', `Failed to update state: ${err}`)
      }
      return outputs
    }
    
    case 'set-metadata': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: set-metadata <file-path> --part="X" --desc="Y" --rev="Z"')
        return outputs
      }
      
      const matches = resolvePathPattern(path, files)
      if (matches.length === 0) {
        addOutput('error', `File not found: ${path}`)
        return outputs
      }
      
      const file = matches[0]
      const { updatePendingMetadata } = usePDMStore.getState()
      
      const updates: any = {}
      if (parsed.flags['part'] !== undefined) updates.part_number = parsed.flags['part'] || null
      if (parsed.flags['desc'] !== undefined) updates.description = parsed.flags['desc'] || null
      if (parsed.flags['rev'] !== undefined) updates.revision = parsed.flags['rev'] || null
      
      if (Object.keys(updates).length === 0) {
        addOutput('error', 'No metadata to set. Use --part, --desc, or --rev flags')
        return outputs
      }
      
      updatePendingMetadata(file.path, updates)
      addOutput('success', `Metadata staged for ${file.name}. Check in to save.`)
      return outputs
    }
    
    // ============================================
    // BATCH OPERATIONS - Sync all, checkin all
    // ============================================
    case 'pending': {
      const unsynced = files.filter(f => !f.isDirectory && (!f.pdmData || f.diffStatus === 'added'))
      const checkedOut = files.filter(f => !f.isDirectory && f.pdmData?.checked_out_by)
      const { user } = usePDMStore.getState()
      const myCheckouts = checkedOut.filter(f => f.pdmData?.checked_out_by === user?.id)
      
      const lines = ['📋 Pending Operations:']
      lines.push(`   Unsynced files: ${unsynced.length}`)
      lines.push(`   My checkouts: ${myCheckouts.length}`)
      lines.push(`   All checkouts: ${checkedOut.length}`)
      
      if (unsynced.length > 0) {
        lines.push('\n   Unsynced:')
        unsynced.slice(0, 5).forEach(f => lines.push(`     ${f.relativePath}`))
        if (unsynced.length > 5) lines.push(`     ... and ${unsynced.length - 5} more`)
      }
      
      if (myCheckouts.length > 0) {
        lines.push('\n   My Checkouts:')
        myCheckouts.slice(0, 5).forEach(f => lines.push(`     ${f.relativePath}`))
        if (myCheckouts.length > 5) lines.push(`     ... and ${myCheckouts.length - 5} more`)
      }
      
      addOutput('info', lines.join('\n'))
      return outputs
    }
    
    case 'sync-all': {
      const unsynced = files.filter(f => !f.isDirectory && (!f.pdmData || f.diffStatus === 'added'))
      
      if (unsynced.length === 0) {
        addOutput('info', 'No files to sync')
        return outputs
      }
      
      addOutput('info', `Syncing ${unsynced.length} files...`)
      try {
        const result = await executeCommand('sync', { files: unsynced }, { onRefresh })
        if (result.success) {
          addOutput('success', result.message)
        } else {
          addOutput('error', result.message)
        }
      } catch (err) {
        addOutput('error', `Sync failed: ${err}`)
      }
      return outputs
    }
    
    case 'checkin-all': {
      const { user } = usePDMStore.getState()
      if (!user) {
        addOutput('error', 'Not signed in')
        return outputs
      }
      
      const myCheckouts = files.filter(f => 
        !f.isDirectory && f.pdmData?.checked_out_by === user.id
      )
      
      if (myCheckouts.length === 0) {
        addOutput('info', 'No files checked out to you')
        return outputs
      }
      
      addOutput('info', `Checking in ${myCheckouts.length} files...`)
      try {
        const result = await executeCommand('checkin', { files: myCheckouts }, { onRefresh })
        if (result.success) {
          addOutput('success', result.message)
        } else {
          addOutput('error', result.message)
        }
      } catch (err) {
        addOutput('error', `Check-in failed: ${err}`)
      }
      return outputs
    }
    
    case 'checkout-all': {
      const path = parsed.args[0]
      if (!path) {
        addOutput('error', 'Usage: checkout-all <folder-path>')
        return outputs
      }
      
      const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
      const filesInFolder = files.filter(f => {
        if (f.isDirectory) return false
        if (!f.pdmData) return false  // Must be synced
        if (f.pdmData.checked_out_by) return false  // Not already checked out
        const filePath = f.relativePath.replace(/\\/g, '/')
        return filePath.startsWith(normalizedPath + '/') || filePath === normalizedPath
      })
      
      if (filesInFolder.length === 0) {
        addOutput('info', 'No available files to checkout in that folder')
        return outputs
      }
      
      addOutput('info', `Checking out ${filesInFolder.length} files...`)
      try {
        const result = await executeCommand('checkout', { files: filesInFolder }, { onRefresh })
        if (result.success) {
          addOutput('success', result.message)
        } else {
          addOutput('error', result.message)
        }
      } catch (err) {
        addOutput('error', `Checkout failed: ${err}`)
      }
      return outputs
    }
    
    // ============================================
    // SETTINGS - View and change settings
    // ============================================
    case 'settings': {
      const { 
        cadPreviewMode, 
        lowercaseExtensions, 
        viewMode, 
        iconSize, 
        listRowSize,
        sidebarWidth,
        detailsPanelHeight,
        terminalHeight,
        autoConnect
      } = usePDMStore.getState()
      
      const lines = [
        '⚙️ Settings:',
        `   cadPreviewMode: ${cadPreviewMode}`,
        `   lowercaseExtensions: ${lowercaseExtensions}`,
        `   viewMode: ${viewMode}`,
        `   iconSize: ${iconSize}`,
        `   listRowSize: ${listRowSize}`,
        `   sidebarWidth: ${sidebarWidth}`,
        `   detailsPanelHeight: ${detailsPanelHeight}`,
        `   terminalHeight: ${terminalHeight}`,
        `   autoConnect: ${autoConnect}`,
        '',
        'Use: set <setting> <value>'
      ]
      addOutput('info', lines.join('\n'))
      return outputs
    }
    
    case 'set': {
      const setting = parsed.args[0]
      const value = parsed.args[1]
      
      if (!setting || value === undefined) {
        addOutput('error', 'Usage: set <setting> <value>')
        return outputs
      }
      
      const store = usePDMStore.getState()
      
      switch (setting) {
        case 'cadPreviewMode':
          if (value !== 'thumbnail' && value !== 'edrawings') {
            addOutput('error', 'Value must be "thumbnail" or "edrawings"')
            return outputs
          }
          store.setCadPreviewMode(value)
          break
        case 'lowercaseExtensions':
          store.setLowercaseExtensions(value === 'true')
          break
        case 'viewMode':
          if (value !== 'list' && value !== 'icons') {
            addOutput('error', 'Value must be "list" or "icons"')
            return outputs
          }
          store.setViewMode(value)
          break
        case 'iconSize':
          store.setIconSize(parseInt(value) || 96)
          break
        case 'listRowSize':
          store.setListRowSize(parseInt(value) || 24)
          break
        case 'sidebarWidth':
          store.setSidebarWidth(parseInt(value) || 280)
          break
        case 'detailsPanelHeight':
          store.setDetailsPanelHeight(parseInt(value) || 250)
          break
        case 'terminalHeight':
          store.setTerminalHeight(parseInt(value) || 250)
          break
        case 'autoConnect':
          store.setAutoConnect(value === 'true')
          break
        default:
          addOutput('error', `Unknown setting: ${setting}`)
          return outputs
      }
      
      addOutput('success', `Set ${setting} = ${value}`)
      return outputs
    }
    
    case 'get': {
      const setting = parsed.args[0]
      if (!setting) {
        addOutput('error', 'Usage: get <setting>')
        return outputs
      }
      
      const store = usePDMStore.getState()
      const value = (store as any)[setting]
      
      if (value === undefined) {
        addOutput('error', `Unknown setting: ${setting}`)
      } else {
        addOutput('info', `${setting} = ${JSON.stringify(value)}`)
      }
      return outputs
    }
    
    // ============================================
    // VAULT MANAGEMENT
    // ============================================
    case 'switch-vault':
    case 'use': {
      const vaultName = parsed.args.join(' ')
      if (!vaultName) {
        addOutput('error', 'Usage: switch-vault <vault-name>')
        return outputs
      }
      
      const { connectedVaults, switchVault } = usePDMStore.getState()
      const vault = connectedVaults.find(v => 
        v.name.toLowerCase() === vaultName.toLowerCase() ||
        v.id === vaultName
      )
      
      if (!vault) {
        addOutput('error', `Vault not found: ${vaultName}`)
        addOutput('info', `Connected vaults: ${connectedVaults.map(v => v.name).join(', ')}`)
        return outputs
      }
      
      switchVault(vault.id, vault.localPath)
      addOutput('success', `Switched to vault: ${vault.name}`)
      onRefresh?.(false)
      return outputs
    }
    
    case 'disconnect-vault':
    case 'remove-vault': {
      const vaultName = parsed.args.join(' ')
      if (!vaultName) {
        addOutput('error', 'Usage: disconnect-vault <vault-name>')
        return outputs
      }
      
      const { connectedVaults, removeConnectedVault } = usePDMStore.getState()
      const vault = connectedVaults.find(v => 
        v.name.toLowerCase() === vaultName.toLowerCase() ||
        v.id === vaultName
      )
      
      if (!vault) {
        addOutput('error', `Vault not found: ${vaultName}`)
        return outputs
      }
      
      removeConnectedVault(vault.id)
      addOutput('success', `Disconnected vault: ${vault.name}`)
      return outputs
    }
    
    // ============================================
    // AUTH - Sign out, offline mode
    // ============================================
    case 'sign-out':
    case 'logout': {
      // Clear auth state
      const { signOut } = usePDMStore.getState()
      signOut()
      addOutput('success', 'Signed out')
      return outputs
    }
    
    case 'offline': {
      const { setOfflineMode, isOfflineMode } = usePDMStore.getState()
      const enable = parsed.args[0] !== 'off'
      
      if (enable === isOfflineMode) {
        addOutput('info', `Offline mode is already ${isOfflineMode ? 'on' : 'off'}`)
      } else {
        setOfflineMode(enable)
        addOutput('success', `Offline mode ${enable ? 'enabled' : 'disabled'}`)
      }
      return outputs
    }
    
    // ============================================
    // RELOAD - Force full page reload
    // ============================================
    case 'reload-app':
    case 'restart': {
      addOutput('info', 'Reloading app...')
      // Use Electron API to reload - this triggers after response is sent
      setTimeout(async () => {
        await window.electronAPI?.reloadApp()
      }, 100)
      return outputs
    }
  }
  
  // Map command aliases to command IDs
  const commandMap: Record<string, CommandId> = {
    'checkout': 'checkout',
    'co': 'checkout',
    'checkin': 'checkin',
    'ci': 'checkin',
    'sync': 'sync',
    'upload': 'sync',
    'add': 'sync',
    'download': 'download',
    'dl': 'download',
    'get': 'download',
    'delete': 'delete-server',
    'rm': 'delete-server',
    'remove': 'delete-local',
    'rm-local': 'delete-local',
    'discard': 'discard',
    'revert': 'discard',
    'force-release': 'force-release',
    'open': 'open',
    'o': 'open',
    'reveal': 'show-in-explorer',
    'show': 'show-in-explorer'
  }
  
  const commandId = commandMap[parsed.command]
  
  if (!commandId) {
    addOutput('error', `Unknown command: ${parsed.command}. Type 'help' for available commands.`)
    return outputs
  }
  
  // Resolve file paths
  const targetPath = parsed.args[0] || '.'
  const matchedFiles = resolvePathPattern(targetPath, files)
  
  if (matchedFiles.length === 0 && targetPath !== '.') {
    addOutput('error', `No files match: ${targetPath}`)
    return outputs
  }
  
  // For '.' use current folder
  let filesToProcess = matchedFiles
  if (targetPath === '.') {
    const { currentFolder } = usePDMStore.getState()
    if (currentFolder) {
      const folder = files.find(f => f.isDirectory && f.relativePath === currentFolder)
      if (folder) {
        filesToProcess = [folder]
      }
    } else {
      // Root - get all files
      filesToProcess = files.filter(f => !f.isDirectory)
    }
  }
  
  if (filesToProcess.length === 0) {
    addOutput('error', 'No files to process')
    return outputs
  }
  
  addOutput('info', `Processing ${filesToProcess.length} file${filesToProcess.length > 1 ? 's' : ''}...`)
  
  try {
    // Execute the command
    let result: CommandResult
    
    switch (commandId) {
      case 'checkout':
      case 'checkin':
      case 'sync':
      case 'download':
      case 'delete-local':
      case 'discard':
      case 'force-release':
        result = await executeCommand(commandId, { files: filesToProcess }, { onRefresh })
        break
      case 'delete-server':
        result = await executeCommand(commandId, { 
          files: filesToProcess, 
          deleteLocal: parsed.flags['local'] !== false 
        }, { onRefresh })
        break
      case 'open':
        if (filesToProcess.length === 1) {
          result = await executeCommand(commandId, { file: filesToProcess[0] }, { onRefresh })
        } else {
          result = { success: false, message: 'Can only open one file at a time', total: 0, succeeded: 0, failed: 1 }
        }
        break
      case 'show-in-explorer':
        if (filesToProcess.length === 1) {
          result = await executeCommand(commandId, { path: filesToProcess[0].path }, { onRefresh })
        } else {
          result = { success: false, message: 'Can only reveal one file at a time', total: 0, succeeded: 0, failed: 1 }
        }
        break
      default:
        result = { success: false, message: `Command not implemented: ${commandId}`, total: 0, succeeded: 0, failed: 1 }
    }
    
    if (result.success) {
      addOutput('success', result.message)
    } else {
      addOutput('error', result.message)
    }
    
    if (result.errors && result.errors.length > 0) {
      result.errors.slice(0, 5).forEach(err => addOutput('error', `  ${err}`))
    }
    
  } catch (err) {
    addOutput('error', `Command failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  
  return outputs
}

/**
 * Format help text
 */
function formatHelp(command?: string): string {
  if (command) {
    const commands = getAllCommands()
    const cmd = commands.find(c => c.id === command || c.aliases?.includes(command))
    if (cmd) {
      return [
        `📖 ${cmd.name}`,
        `   ${cmd.description}`,
        cmd.usage ? `   Usage: ${cmd.usage}` : '',
        cmd.aliases?.length ? `   Aliases: ${cmd.aliases.join(', ')}` : ''
      ].filter(Boolean).join('\n')
    }
    return `Unknown command: ${command}`
  }
  
  return `
📖 BluePDM Terminal Commands

PDM Operations:
  checkout <path>      Check out files (alias: co)
  checkin <path>       Check in files (alias: ci)
  sync <path>          Upload new files (alias: upload, add)
  download <path>      Download cloud files (alias: dl, get)
  discard <path>       Discard changes, revert to server
  delete <path>        Delete from server (alias: rm)
  remove <path>        Remove local copy (alias: rm-local)
  force-release <path> Force release checkout (admin)

Batch Operations:
  sync-all             Sync all unsynced files
  checkin-all          Check in all my checkouts
  checkout-all <path>  Check out all files in folder
  pending              Show pending operations

File Management:
  mkdir <name>         Create folder (alias: md)
  rename <path> <new>  Rename file/folder (alias: ren)
  move <src> <dest>    Move files (alias: mv)
  copy <src> <dest>    Copy files (alias: cp)
  touch <name>         Create empty file

Text File Operations:
  cat <path>           Display file contents (alias: type)
  head <path> [-n N]   Show first N lines (default 10)
  tail <path> [-n N]   Show last N lines (default 10)
  wc <path>            Word/line/character count
  diff <file1> <file2> Compare two text files
  write <path> <text>  Write text to file (use \\n for newlines)
  append <path> <text> Append text to file
  grep-content <p> [d] Search text in files (alias: rg, fgrep) [-i]
  sed <f> <find> <rep> Find/replace in file (--all for all)

JSON Operations:
  json <path>          Pretty-print JSON file
  json-get <path> [k]  Get value by key path (alias: jq)
  json-set <p> <k> <v> Set value in JSON file

Version Control:
  versions <path>      Show version history
  rollback <path> <v>  Roll back to version (must be checked out)
  activity [-n N]      Show recent activity

Trash:
  trash                List deleted files
  restore <path>       Restore from trash
  empty-trash          Permanently delete all trash (admin)

Navigation:
  ls [path]            List files (alias: dir)
  cd <path>            Change directory
  pwd                  Print current directory
  tree [path]          Show directory tree (--depth=N)

Search & Select:
  find <query>         Search files (alias: search)
  select <pattern>     Select files (--add to append)
  select all/clear     Select all or clear

Info & Metadata:
  status [path]        Show file/vault status
  info <path>          Show file properties
  metadata <path>      Show file metadata
  set-metadata <path>  Set metadata (--part, --desc, --rev)
  set-state <path> <s> Set state (wip/in_review/released/obsolete)
  checkouts            List checked out files (--mine, --others)
  whoami               Show current user

Vault Management:
  vault                Show connected vaults
  switch-vault <name>  Switch active vault (alias: use)
  disconnect-vault     Disconnect a vault

Backup:
  backup               Request backup
  backup-status        Show backup status
  backup-history       List backup snapshots

Settings:
  settings             Show all settings
  set <key> <value>    Change a setting
  get <key>            Get a setting value

Logs:
  logs [-n N]          Show recent logs
  export-logs          Export logs to file
  logs-dir             Open logs directory

Auth:
  sign-out             Sign out (alias: logout)
  offline [on/off]     Toggle offline mode
  reload-app           Force full app reload (alias: restart)

Utilities:
  open <path>          Open with default app
  reveal <path>        Show in Explorer
  pin/unpin <path>     Pin/unpin to sidebar
  ignore [pattern]     Add/show ignore patterns
  refresh              Refresh file list
  cancel               Cancel operations
  history              Command history
  clear                Clear terminal
  env                  Environment info
  help [cmd]           Show this help
`.trim()
}

/**
 * Format time ago
 */
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Auto-complete suggestions for a partial command
 */
export function getAutocompleteSuggestions(input: string, files: LocalFile[]): string[] {
  const parsed = parseCommandString(input)
  const suggestions: string[] = []
  
  // If no command yet, suggest commands
  if (!parsed.command || (parsed.args.length === 0 && !input.includes(' '))) {
    const commands = [
      // PDM operations
      'checkout', 'checkin', 'sync', 'download', 'discard', 'delete', 'remove', 'force-release',
      // Batch operations
      'sync-all', 'checkin-all', 'checkout-all', 'pending',
      // File management
      'mkdir', 'rename', 'move', 'copy', 'touch',
      // Text file operations
      'cat', 'type', 'head', 'tail', 'wc', 'diff', 'write', 'append', 'grep-content', 'rg', 'fgrep', 'sed', 'replace',
      // JSON operations
      'json', 'json-get', 'jq', 'json-set',
      // Version control
      'versions', 'rollback', 'activity',
      // Trash
      'trash', 'restore', 'empty-trash',
      // Navigation
      'ls', 'cd', 'pwd', 'tree',
      // Search & Select
      'find', 'search', 'select',
      // Info & Metadata
      'status', 'info', 'metadata', 'set-metadata', 'set-state', 'checkouts', 'whoami',
      // Vault management
      'vault', 'switch-vault', 'disconnect-vault',
      // Backup
      'backup', 'backup-status', 'backup-history', 'snapshots',
      // Settings
      'settings', 'set', 'get',
      // Logs
      'logs', 'export-logs', 'logs-dir',
      // Auth
      'sign-out', 'offline', 'reload-app', 'restart',
      // Utilities
      'open', 'reveal', 'pin', 'unpin', 'ignore', 'refresh', 
      'cancel', 'history', 'clear', 'env', 'help', 'echo'
    ]
    return commands.filter(c => c.startsWith(parsed.command || ''))
  }
  
  // If command is complete, suggest paths
  const pathPrefix = parsed.args[0] || ''
  const normalizedPrefix = pathPrefix.replace(/\\/g, '/').replace(/^\.\//, '')
  
  // Get matching files/folders
  const matches = files.filter(f => {
    const normalizedPath = f.relativePath.replace(/\\/g, '/')
    return normalizedPath.startsWith(normalizedPrefix)
  })
  
  // Return unique suggestions (just the next path segment)
  const seen = new Set<string>()
  for (const match of matches) {
    const normalizedPath = match.relativePath.replace(/\\/g, '/')
    const remaining = normalizedPath.slice(normalizedPrefix.length)
    const nextSegment = remaining.split('/')[0]
    if (nextSegment && !seen.has(nextSegment)) {
      seen.add(nextSegment)
      suggestions.push(normalizedPrefix + nextSegment + (match.isDirectory ? '/' : ''))
    }
  }
  
  return suggestions.slice(0, 10)
}

