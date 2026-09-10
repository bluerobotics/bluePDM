// FilePane feature module
// Main FilePane component and all sub-components, hooks, and utilities

// Main component
export { FilePane } from './FilePane'

// Hooks
// Note: Config state is now in Zustand store (usePDMStore.expandedConfigFiles, etc.)
export {
  useContextMenuState,
  useDialogState,
  useInlineActionHover,
  useDragState,
  useRenameState,
} from './hooks'

export type {
  UseContextMenuStateReturn,
  ContextMenuState,
  EmptyContextMenuState,
  ColumnContextMenuState,
  ConfigContextMenuState,
  RefRowContextMenuState,
  UseDialogStateReturn,
  CustomConfirmState,
  DeleteLocalCheckoutConfirmState,
  ConflictDialogState,
  UseInlineActionHoverReturn,
  UseDragStateReturn,
  SelectionBox,
  UseRenameStateReturn,
} from './hooks'

// Components
export {
  ColumnHeaders,
  ListRowIcon,
  CellRenderer,
  FileRow,
  ConfigRow,
  FileListBody,
  FileCard,
  FileIconCard,
  FileGridView,
  EmptyState,
  LoadingState,
  ErrorState,
  NoVaultEmptyState,
  FileToolbar,
  ViewToggle,
  SizeSlider,
  AddMenu,
  PathActions,
  SearchIndicator,
  SelectionBoxOverlay,
  DragOverlay,
  CustomConfirmDialog,
  ConflictDialog,
  FolderConflictDialog,
  DeleteLocalCheckoutDialog,
  ColumnContextMenu,
  ConfigContextMenu,
  EmptyContextMenu,
  FileContextMenu,
  RefRowContextMenu,
  ReviewRequestModal,
  CheckoutRequestModal,
  NotifyModal,
  ShareLinkModal,
  ECOModal,
} from './components'
export type {
  ColumnHeadersProps,
  ListRowIconProps,
  CellRendererProps,
  FileRowProps,
  ConfigRowProps,
  FileListBodyProps,
  FileCardProps,
  FileGridViewProps,
  EmptyStateProps,
  LoadingStateProps,
  ErrorStateProps,
  FileToolbarProps,
  ViewToggleProps,
  ViewMode,
  SizeSliderProps,
  AddMenuProps,
  PathActionsProps,
  SearchIndicatorProps,
  SelectionBoxOverlayProps,
  DragOverlayProps,
  CustomConfirmDialogProps,
  ConflictDialogProps,
  FolderConflictDialogProps,
  DeleteLocalCheckoutDialogProps,
  ColumnContextMenuProps,
  ConfigContextMenuProps,
  EmptyContextMenuProps,
  FileContextMenuProps,
  RefRowContextMenuProps,
  ReviewRequestModalProps,
  CheckoutRequestModalProps,
  NotifyModalProps,
  ShareLinkModalProps,
  ECOModalProps,
  OrgUser,
  ECO,
} from './components'

// Utilities
export {
  // Sorting
  compareFiles,
  sortFiles,
  sortByRelevance,
  // Filtering
  fuzzyMatch,
  getSearchScore,
  matchesSearch,
  isValidFile,
  isSolidworksTempFile,
  filterValidFiles,
  getFilesInFolder,
  filterBySearch,
  applyFilters,
  // Selection
  isPointInBox,
  getSelectionBoxBounds,
  rectangleIntersectsBox,
  getFilesInSelectionBox,
  createSelectionBox,
  updateSelectionBox,
  getSelectionBoxStyles,
  // File Status
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
  // Processing Status
  getProcessingOperation,
  getFileProcessingOperation,
  getFolderProcessingOperation,
  // Keybindings
  matchesKeybinding,
  // Config Tree
  buildConfigTreeFlat,
} from './utils'
export type { FileFilter, Keybinding, ConfigInput } from './utils'

// Types
export type {
  FilePaneProps,
  // FileRowProps exported from ./components
  FileIconCardProps,
  ColumnConfig,
  SelectionState,
  DragState,
  FolderMetrics,
  FolderMetricsMap,
  CheckoutUser,
  ConfigWithDepth,
  FileConflict,
  FolderConflictDialogState,
  SortDirection,
  SortColumn,
} from './types'

export { COLUMN_TRANSLATION_KEYS } from './types'

// Constants
export {
  DEFAULT_ROW_HEIGHT,
  DEFAULT_ICON_SIZE,
  MIN_COLUMN_WIDTH,
  RESIZE_HANDLE_WIDTH,
  GRID_CARD_SIZE,
  ICON_SIZE_MIN,
  ICON_SIZE_MAX,
  LIST_ROW_SIZE_MIN,
  LIST_ROW_SIZE_MAX,
  SW_CONFIG_EXTENSIONS,
  SW_THUMBNAIL_EXTENSIONS,
  THUMBNAIL_LOAD_DELAY,
  MAX_THUMBNAIL_SIZE,
} from './constants'

// Context
export {
  FilePaneProvider,
  useFilePaneContext,
  FilePaneHandlersProvider,
  useFilePaneHandlers,
} from './context'
export type {
  FilePaneContextValue,
  FilePaneProviderProps,
  FilePaneHandlersContextValue,
  FilePaneHandlersProviderProps,
} from './context'
