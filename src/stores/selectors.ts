// Memoized selectors for the PDM store
//
// These selectors provide optimized access to derived state, preventing
// unnecessary re-renders by using proper equality functions and memoization.
//
// Usage patterns (Zustand v5+):
// - For primitive values: usePDMStore(s => s.value) - no equality needed
// - For objects/arrays: usePDMStore(useShallow(s => s.value)) - shallow comparison
// - For derived state: Use these custom hooks with internal memoization
//
// The useShallow wrapper from 'zustand/react/shallow' enables shallow equality
// comparison for object/array selectors, preventing re-renders when the selected
// values are shallowly equal but referentially different.

import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { usePDMStore } from './pdmStore'

/**
 * Get files that are checked out by the current user
 */
export function useCheckedOutFiles() {
  const files = usePDMStore((s) => s.files)
  const userId = usePDMStore((s) => s.user?.id)

  return useMemo(() => files.filter((f) => f.pdmData?.checked_out_by === userId), [files, userId])
}

/**
 * Get files with pending metadata changes
 */
export function usePendingFiles() {
  const files = usePDMStore((s) => s.files)

  return useMemo(
    () => files.filter((f) => f.pendingMetadata && Object.keys(f.pendingMetadata).length > 0),
    [files],
  )
}

/**
 * Get files that need to be synced (added, modified, or deleted).
 *
 * Deliberately excludes 'moved_away': it is a stub shadowing a file already
 * counted here as 'moved' at its new location, not separate work of its own.
 */
export function useFilesNeedingSync() {
  const files = usePDMStore((s) => s.files)

  return useMemo(
    () =>
      files.filter(
        (f) =>
          f.diffStatus === 'added' ||
          f.diffStatus === 'modified' ||
          f.diffStatus === 'deleted' ||
          f.diffStatus === 'moved',
      ),
    [files],
  )
}

/**
 * Get files that need to be updated from server
 */
export function useOutdatedFiles() {
  const files = usePDMStore((s) => s.files)

  return useMemo(() => files.filter((f) => f.diffStatus === 'outdated'), [files])
}

/**
 * Get cloud-only files (not downloaded locally)
 */
export function useCloudOnlyFiles() {
  const files = usePDMStore((s) => s.files)

  return useMemo(() => files.filter((f) => f.diffStatus === 'cloud'), [files])
}

/**
 * Get files in a specific folder (direct children only)
 */
export function useFilesInFolder(folderPath: string) {
  const files = usePDMStore((s) => s.files)

  return useMemo(() => {
    if (!folderPath) {
      // Root level - files with no slash in relativePath
      return files.filter((f) => !f.relativePath.includes('/'))
    }

    const prefix = folderPath + '/'
    return files.filter((f) => {
      if (!f.relativePath.startsWith(prefix)) return false
      // Check it's a direct child (no more slashes after the prefix)
      const remainder = f.relativePath.slice(prefix.length)
      return !remainder.includes('/')
    })
  }, [files, folderPath])
}

/**
 * Get count of files by diff status
 */
export function useDiffStatusCounts() {
  const files = usePDMStore((s) => s.files)

  return useMemo(() => {
    let added = 0
    let modified = 0
    let deleted = 0
    let outdated = 0
    let cloud = 0
    let cloudNew = 0
    let moved = 0
    // The stub side of the same moves - never overlaps `moved`, since each moved
    // file contributes to exactly one of the two, at different paths.
    let movedAway = 0

    for (const file of files) {
      if (file.isDirectory) continue
      switch (file.diffStatus) {
        case 'added':
          added++
          break
        case 'modified':
          modified++
          break
        case 'deleted':
          deleted++
          break
        case 'outdated':
          outdated++
          break
        case 'cloud':
          cloud++
          break
        case 'moved':
          moved++
          break
        case 'moved_away':
          movedAway++
          break
      }
    }

    return { added, modified, deleted, outdated, cloud, cloudNew, moved, movedAway }
  }, [files])
}

/**
 * Get the active vault
 */
export function useActiveVault() {
  const connectedVaults = usePDMStore((s) => s.connectedVaults)
  const activeVaultId = usePDMStore((s) => s.activeVaultId)

  return useMemo(
    () => connectedVaults.find((v) => v.id === activeVaultId),
    [connectedVaults, activeVaultId],
  )
}

/**
 * Get all folder paths from files
 */
export function useFolderPaths() {
  const files = usePDMStore((s) => s.files)

  return useMemo(() => {
    const folders = new Set<string>()
    for (const file of files) {
      if (file.isDirectory) {
        folders.add(file.relativePath)
      }
    }
    return folders
  }, [files])
}

/**
 * Get unique file extensions
 */
export function useFileExtensions() {
  const files = usePDMStore((s) => s.files)

  return useMemo(() => {
    const extensions = new Set<string>()
    for (const file of files) {
      if (!file.isDirectory && file.extension) {
        extensions.add(file.extension.toLowerCase())
      }
    }
    return Array.from(extensions).sort()
  }, [files])
}

/**
 * Check if any operations are in progress
 */
export function useIsOperationInProgress() {
  const isLoading = usePDMStore((s) => s.isLoading)
  const isRefreshing = usePDMStore((s) => s.isRefreshing)
  const syncProgress = usePDMStore((s) => s.syncProgress)
  const operationQueue = usePDMStore((s) => s.operationQueue)
  const processingOperations = usePDMStore((s) => s.processingOperations)

  return (
    isLoading ||
    isRefreshing ||
    syncProgress.isActive ||
    operationQueue.length > 0 ||
    processingOperations.size > 0
  )
}

/**
 * Get the effective user (considering impersonation)
 */
export function useEffectiveUser() {
  const user = usePDMStore((s) => s.user)
  const impersonatedUser = usePDMStore((s) => s.impersonatedUser)

  return useMemo(() => {
    if (impersonatedUser) {
      return {
        id: impersonatedUser.id,
        email: impersonatedUser.email,
        full_name: impersonatedUser.full_name,
        avatar_url: impersonatedUser.avatar_url,
        role: impersonatedUser.role,
        isImpersonating: true,
      }
    }
    return user ? { ...user, isImpersonating: false } : null
  }, [user, impersonatedUser])
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOM SELECTOR HOOKS
// These hooks provide optimized access to commonly used state combinations,
// reducing boilerplate and ensuring consistent performance patterns.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get file tree navigation state (for FileTree component)
 * Groups related navigation state to reduce selector count.
 */
export function useFileTreeNavigation() {
  const currentFolder = usePDMStore((s) => s.currentFolder)
  const expandedFolders = usePDMStore((s) => s.expandedFolders)
  const pinnedSectionExpanded = usePDMStore((s) => s.pinnedSectionExpanded)

  return { currentFolder, expandedFolders, pinnedSectionExpanded }
}

/**
 * Get file tree actions (for FileTree component)
 * Stable reference to grouped actions.
 */
export function useFileTreeActions() {
  return usePDMStore(
    useShallow((s) => ({
      toggleFolder: s.toggleFolder,
      setCurrentFolder: s.setCurrentFolder,
      togglePinnedSection: s.togglePinnedSection,
    })),
  )
}

/**
 * Get vault management state (for FileTree and vault-related components)
 */
export function useVaultState() {
  const connectedVaults = usePDMStore(useShallow((s) => s.connectedVaults))
  const activeVaultId = usePDMStore((s) => s.activeVaultId)
  const vaultPath = usePDMStore((s) => s.vaultPath)
  const vaultName = usePDMStore((s) => s.vaultName)

  return { connectedVaults, activeVaultId, vaultPath, vaultName }
}

/**
 * Get vault management actions
 */
export function useVaultActions() {
  return usePDMStore(
    useShallow((s) => ({
      switchVault: s.switchVault,
      toggleVaultExpanded: s.toggleVaultExpanded,
      removeConnectedVault: s.removeConnectedVault,
      setVaultPath: s.setVaultPath,
      setVaultConnected: s.setVaultConnected,
    })),
  )
}

/**
 * Get file selection state and actions
 */
export function useFileSelectionState() {
  const selectedFiles = usePDMStore(useShallow((s) => s.selectedFiles))
  const { setSelectedFiles, toggleFileSelection, clearSelection } = usePDMStore(
    useShallow((s) => ({
      setSelectedFiles: s.setSelectedFiles,
      toggleFileSelection: s.toggleFileSelection,
      clearSelection: s.clearSelection,
    })),
  )

  return { selectedFiles, setSelectedFiles, toggleFileSelection, clearSelection }
}

/**
 * Get file loading state
 */
export function useFileLoadingState() {
  const isLoading = usePDMStore((s) => s.isLoading)
  const filesLoaded = usePDMStore((s) => s.filesLoaded)
  const isRefreshing = usePDMStore((s) => s.isRefreshing)

  return { isLoading, filesLoaded, isRefreshing }
}

/**
 * Get toast notification actions
 */
export function useToastActions() {
  return usePDMStore(
    useShallow((s) => ({
      addToast: s.addToast,
      addProgressToast: s.addProgressToast,
      updateProgressToast: s.updateProgressToast,
      removeToast: s.removeToast,
    })),
  )
}

/**
 * Get processing operations state for file operations feedback
 */
export function useProcessingState() {
  const processingOperations = usePDMStore((s) => s.processingOperations)
  const {
    addProcessingFolder,
    addProcessingFolders,
    addProcessingFoldersSync,
    removeProcessingFolder,
    removeProcessingFolders,
    getProcessingOperation,
  } = usePDMStore(
    useShallow((s) => ({
      addProcessingFolder: s.addProcessingFolder,
      addProcessingFolders: s.addProcessingFolders,
      addProcessingFoldersSync: s.addProcessingFoldersSync,
      removeProcessingFolder: s.removeProcessingFolder,
      removeProcessingFolders: s.removeProcessingFolders,
      getProcessingOperation: s.getProcessingOperation,
    })),
  )

  return {
    processingOperations,
    addProcessingFolder,
    addProcessingFolders,
    addProcessingFoldersSync,
    removeProcessingFolder,
    removeProcessingFolders,
    getProcessingOperation,
  }
}

/**
 * Get view mode state for file pane display options
 */
export function useViewModeState() {
  const viewMode = usePDMStore((s) => s.viewMode)
  const iconSize = usePDMStore((s) => s.iconSize)
  const listRowSize = usePDMStore((s) => s.listRowSize)
  const { setViewMode, setIconSize, setListRowSize } = usePDMStore(
    useShallow((s) => ({
      setViewMode: s.setViewMode,
      setIconSize: s.setIconSize,
      setListRowSize: s.setListRowSize,
    })),
  )

  return { viewMode, iconSize, listRowSize, setViewMode, setIconSize, setListRowSize }
}

/**
 * Get column configuration state for file list table
 */
export function useColumnState() {
  const columns = usePDMStore(useShallow((s) => s.columns))
  const sortColumn = usePDMStore((s) => s.sortColumn)
  const sortDirection = usePDMStore((s) => s.sortDirection)
  const { setColumnWidth, reorderColumns, toggleColumnVisibility, toggleSort } = usePDMStore(
    useShallow((s) => ({
      setColumnWidth: s.setColumnWidth,
      reorderColumns: s.reorderColumns,
      toggleColumnVisibility: s.toggleColumnVisibility,
      toggleSort: s.toggleSort,
    })),
  )

  return {
    columns,
    sortColumn,
    sortDirection,
    setColumnWidth,
    reorderColumns,
    toggleColumnVisibility,
    toggleSort,
  }
}

/**
 * Get search state for file filtering
 */
export function useSearchState() {
  const searchQuery = usePDMStore((s) => s.searchQuery)
  const searchType = usePDMStore((s) => s.searchType)
  const { setSearchQuery, setSearchType } = usePDMStore(
    useShallow((s) => ({
      setSearchQuery: s.setSearchQuery,
      setSearchType: s.setSearchType,
    })),
  )

  return { searchQuery, searchType, setSearchQuery, setSearchType }
}

/**
 * Get user display preferences affecting file display
 */
export function useDisplayPreferences() {
  const lowercaseExtensions = usePDMStore((s) => s.lowercaseExtensions)
  const hideSolidworksTempFiles = usePDMStore((s) => s.hideSolidworksTempFiles)

  return { lowercaseExtensions, hideSolidworksTempFiles }
}

/**
 * Get tabs state for multi-tab navigation
 */
export function useTabsState() {
  const tabsEnabled = usePDMStore((s) => s.tabsEnabled)
  const activeTabId = usePDMStore((s) => s.activeTabId)
  const tabs = usePDMStore(useShallow((s) => s.tabs))
  const { updateTabFolder, addTab, closeTab, setActiveTab } = usePDMStore(
    useShallow((s) => ({
      updateTabFolder: s.updateTabFolder,
      addTab: s.addTab,
      closeTab: s.closeTab,
      setActiveTab: s.setActiveTab,
    })),
  )

  return { tabsEnabled, activeTabId, tabs, updateTabFolder, addTab, closeTab, setActiveTab }
}

/**
 * Get details panel state
 */
export function useDetailsPanelState() {
  const detailsPanelVisible = usePDMStore((s) => s.detailsPanelVisible)
  const detailsPanelTab = usePDMStore((s) => s.detailsPanelTab)
  const { toggleDetailsPanel, setDetailsPanelTab } = usePDMStore(
    useShallow((s) => ({
      toggleDetailsPanel: s.toggleDetailsPanel,
      setDetailsPanelTab: s.setDetailsPanelTab,
    })),
  )

  return { detailsPanelVisible, detailsPanelTab, toggleDetailsPanel, setDetailsPanelTab }
}

// Re-export convenience hooks from pdmStore for backward compatibility
export { useSelectedFiles, useVisibleFiles } from './pdmStore'
