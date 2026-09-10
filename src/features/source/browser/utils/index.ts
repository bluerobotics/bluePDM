// File browser utilities
export { compareFiles, sortFiles, sortByRelevance } from './sorting'

export {
  fuzzyMatch,
  getSearchScore,
  matchesSearch,
  isValidFile,
  isSolidworksTempFile,
  filterValidFiles,
  getFilesInFolder,
  filterBySearch,
  applyFilters,
} from './filtering'
export type { FileFilter } from './filtering'

export {
  isPointInBox,
  getSelectionBoxBounds,
  rectangleIntersectsBox,
  getFilesInSelectionBox,
  createSelectionBox,
  updateSelectionBox,
  getSelectionBoxStyles,
} from './selection'

export {
  isFileSynced,
  isCloudOnly,
  isLocalOnly,
  hasLocalModifications,
  isOutdated,
  isCheckedOutByMe,
  isCheckedOutByOthers,
  getCheckoutStatus,
  getFolderCheckoutStatus,
  isFolderSynced,
} from './fileStatus'

export {
  getProcessingOperation,
  getFileProcessingOperation,
  getFolderProcessingOperation,
} from './processingStatus'
export { matchesKeybinding } from './keybindings'
export type { Keybinding } from './keybindings'
export { buildConfigTreeFlat } from './configTree'
export type { ConfigInput } from './configTree'

// Re-export formatting utilities from central location for backwards compatibility
export { formatBytes, formatSpeed, formatDuration, getCountLabel } from '@/lib/utils'
