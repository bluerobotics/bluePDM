/**
 * Command System Types
 *
 * Centralized command system for all PDM operations.
 * This enables consistent behavior across:
 * - Right-click context menus (FileContextMenu, FileTree)
 * - Inline buttons (FilePane rows)
 * - Sidebar views (CheckoutView)
 * - Future: Terminal/CLI interface
 * - Future: External API for add-ins
 */

import type { LocalFile as StoreLocalFile, ToastType } from '../../stores/pdmStore'
import type { User, Organization } from '../../types/pdm'
import type { OperationType, ServerFile } from '../../stores/types'
import { buildFullPath as buildVaultFullPath, isPathWithinDirectory } from '../utils'

// Re-export LocalFile for use by handlers
export type LocalFile = StoreLocalFile

// Re-export CommandCategory from registry for external use
export type { CommandCategory } from './registry'

// ============================================
// Command Context - Injected into commands
// ============================================

export interface CommandContext {
  // Auth & Organization
  user: User | null
  organization: Organization | null
  isOfflineMode: boolean
  getEffectiveRole: () => string

  // Vault info
  vaultPath: string | null
  activeVaultId: string | null

  // All files in the vault (for folder operations)
  files: LocalFile[]

  // Every file the server holds for this vault, keyed by relative path. Needed wherever an
  // operation has to cover what is on the server rather than what is in the local tree.
  serverFiles: ServerFile[]

  // Confirmation dialog (async - resolves when user clicks confirm/cancel)
  confirm?: (opts: {
    title: string
    message: string
    items?: string[] // file names to list in a scrollable container
    confirmText?: string // default "Continue"
  }) => Promise<boolean>

  // Toast notifications
  addToast: (type: ToastType, message: string, duration?: number) => void
  addProgressToast: (id: string, message: string, total: number) => void
  updateProgressToast: (
    id: string,
    current: number,
    percent: number,
    speed?: string,
    label?: string,
  ) => void
  removeToast: (id: string) => void
  isProgressToastCancelled: (id: string) => boolean

  // Store updates
  updateFileInStore: (path: string, updates: Partial<LocalFile>) => void
  updateFilesInStore: (updates: Array<{ path: string; updates: Partial<LocalFile> }>) => void // Batch update
  removeFilesFromStore: (paths: string[]) => void
  addFilesToStore: (files: LocalFile[]) => void
  renameFileInStore: (
    oldPath: string,
    newPath: string,
    newNameOrRelPath: string,
    isMove?: boolean,
  ) => void
  clearPersistedPendingMetadataForPaths: (paths: string[]) => void // Clear persisted metadata during checkout
  addProcessingFolder: (path: string, operationType: OperationType) => void
  addProcessingFolders: (paths: string[], operationType: OperationType) => void // Batch add (single state update)
  addProcessingFoldersSync: (paths: string[], operationType: OperationType) => void // Synchronous state update (no batching delay)
  removeProcessingFolder: (path: string) => void
  removeProcessingFolders: (paths: string[]) => void // Batch remove (single state update)
  removeProcessingFoldersSync: (paths: string[]) => void // Synchronous remove (no batching delay)

  /**
   * Read-only access to processing operations map.
   * Used to check if file operations are in progress for files inside folders being moved.
   */
  processingOperations: Map<string, OperationType>

  /**
   * Atomic update: combines file updates + clearing processing state in ONE store update.
   *
   * This prevents two sequential re-renders that occur with separate updateFilesInStore() +
   * removeProcessingFolders() calls. With 8000+ files, each re-render triggers expensive
   * O(N x depth) folderMetrics computation, causing ~5 second UI freezes.
   *
   * Use this at the end of download/get-latest operations instead of separate calls.
   */
  updateFilesAndClearProcessing: (
    updates: Array<{ path: string; updates: Partial<LocalFile> }>,
    pathsToClearProcessing: string[],
  ) => void

  // Auto-download exclusion (for tracking intentionally removed local copies)
  addAutoDownloadExclusion: (relativePath: string) => void

  // File watcher suppression (for preventing redundant refreshes after operations)
  /**
   * Register file paths that we expect to change during this operation.
   * The file watcher will filter out these paths from triggering refreshes.
   */
  addExpectedFileChanges: (paths: string[]) => void

  /**
   * Clear expected file paths after operation completes.
   * Call with the same paths passed to addExpectedFileChanges.
   */
  clearExpectedFileChanges: (paths: string[]) => void

  /**
   * Set the timestamp when the operation completed.
   * This extends the file watcher suppression window to prevent
   * redundant refreshes from file change events that arrive after
   * the operation finishes but before the watcher's debounce completes.
   */
  setLastOperationCompletedAt: (timestamp: number) => void

  // Realtime update debouncing (prevents state drift from stale realtime events)
  /**
   * Mark a file as recently modified locally. Realtime updates will be
   * skipped for this file for 15 seconds to prevent state drift.
   */
  markFileAsRecentlyModified: (fileId: string) => void

  /**
   * Clear the recently modified flag for a file.
   */
  clearRecentlyModified: (fileId: string) => void

  // Refresh callback
  onRefresh?: (silent?: boolean) => void

  /**
   * Existing toast ID (when operation was queued, toast was already created).
   * ProgressTracker will reuse this toast instead of creating a new one.
   */
  existingToastId?: string

  /**
   * If true, the command should skip showing success toasts.
   * Used when the caller wants to show its own custom message (e.g., paste operations).
   */
  silent?: boolean
}

// ============================================
// Command Result
// ============================================

export interface CommandResult {
  success: boolean
  message: string

  // Counts
  total: number
  succeeded: number
  failed: number

  /**
   * Count of files that were deliberately left untouched rather than
   * permanently deleted - currently only set by an automatic discard-orphaned
   * run when `shell.trashItem` could not recycle a file. Included in `failed`
   * (the file was not successfully discarded) but broken out here so a caller
   * can tell "kept on disk for safety" apart from a genuine failure like a
   * locked file. See `.cursor/plans/recycle-bin-reliability-report.md`.
   */
  skipped?: number
  /** Relative paths of the files counted in `skipped`, for surfacing to the user. */
  skippedPaths?: string[]

  /**
   * Count of directories `discard-orphaned` recycled after the file batch above,
   * derived from the batch itself rather than classified - see
   * `src/lib/orphanedDirectories.ts` and
   * `.cursor/plans/release-4.3.2-empty-folders.plan.md`. Undefined for every other
   * command and for a run that removed none.
   */
  directoriesRemoved?: number
  /**
   * Count of directory candidates left on disk on purpose - not empty (something the
   * renderer's filtered view could not see, e.g. a `~$` lock file) or `shell.trashItem`
   * could not recycle them. Mirrors `skipped` above, one register down.
   */
  directoriesKept?: number

  // Optional details
  details?: string[]
  errors?: string[]

  // Timing
  duration?: number // milliseconds
  speed?: string // e.g., "15.3 MB/s"
}

// ============================================
// Command Parameters
// ============================================

/**
 * Base parameters shared by all file commands.
 * Commands that operate on files extend this interface.
 */
export interface BaseCommandParams {
  /** Array of files to operate on. Can include directories for batch operations. */
  files: LocalFile[]
}

/**
 * Parameters for the checkout command.
 * Locks files for exclusive editing by the current user.
 */
export interface CheckoutParams extends BaseCommandParams {}

/**
 * Parameters for the check-in command.
 * Uploads modified files and releases the checkout lock.
 */
export interface CheckinParams extends BaseCommandParams {
  /**
   * Whether to upload new file content.
   * Set to true for modified files that need their content synced to the server.
   * @default true for modified files
   */
  uploadContent?: boolean

  /**
   * Optional comment describing the changes made.
   * Stored in the file's version history for audit purposes.
   */
  comment?: string
}

/**
 * Parameters for the sync (first check-in) command.
 * Uploads new local files to the server for the first time.
 */
export interface SyncParams extends BaseCommandParams {
  /**
   * Extract and store assembly references after sync completes.
   * When enabled, SolidWorks assemblies will have their component references
   * extracted and stored in the `file_references` table for Contains/Where-Used queries.
   *
   * **Requires:** SolidWorks service to be running.
   * **Use case:** Importing existing vaults with assemblies that need BOM data populated.
   *
   * @default false
   */
  extractReferences?: boolean
}

/**
 * Parameters for the download command.
 * Downloads cloud-only files to the local filesystem.
 */
export interface DownloadParams extends BaseCommandParams {}

/**
 * Parameters for the delete-local command.
 * Removes local file copies while keeping the server version intact.
 * Useful for freeing disk space on files you don't need locally.
 */
export interface DeleteLocalParams extends BaseCommandParams {}

/**
 * Parameters for the delete-server command.
 * Performs a soft delete - moves files to trash on the server.
 * Files can be restored from trash by an administrator.
 */
export interface DeleteServerParams extends BaseCommandParams {
  /**
   * Whether to also delete local copies of the files.
   * If false, local files are orphaned (exist locally but not on server).
   * @default false
   */
  deleteLocal?: boolean
}

/**
 * Parameters for the discard command.
 * Reverts checked-out files to their last server version, discarding local changes.
 * Also releases the checkout lock.
 */
export interface DiscardParams extends BaseCommandParams {}

/**
 * Parameters for the discard-orphaned command.
 * Deletes local files that no longer exist on the server (orphaned files).
 * These are files that were previously synced but deleted by another user.
 */
export interface DiscardOrphanedParams extends BaseCommandParams {
  /**
   * True when this discard runs unattended (e.g. the auto-discard-on-load path in
   * `useLoadFiles.ts`), as opposed to a user explicitly invoking "Discard orphaned
   * files" from a context menu or settings. On the automatic path a file that
   * cannot be moved to the Recycle Bin is left on disk and reported via
   * `CommandResult.skipped`/`skippedPaths` rather than being permanently deleted.
   * Defaults to false.
   */
  isAutomatic?: boolean
}

/**
 * Parameters for the get-latest command.
 * Downloads the newest version of outdated files from the server.
 * Used when someone else has checked in a newer version.
 */
export interface GetLatestParams extends BaseCommandParams {}

/**
 * Parameters for the force-release command.
 * Releases another user's checkout lock. **Admin only.**
 * Use with caution - the other user will lose their exclusive access.
 */
export interface ForceReleaseParams extends BaseCommandParams {}

/**
 * Parameters for the rename command.
 * Renames a single file or folder.
 */
export interface RenameParams {
  /** The file or folder to rename. */
  file: LocalFile

  /** The new name (filename only, not a path). */
  newName: string
}

/**
 * Parameters for the move command.
 * Moves files to a different folder within the vault.
 */
export interface MoveParams extends BaseCommandParams {
  /**
   * The target folder path (relative to vault root).
   * Must be an existing directory within the vault.
   */
  targetFolder: string

  /**
   * Optional resolved name to use instead of the original file name.
   * Used when renaming a folder during move to avoid conflicts.
   */
  resolvedName?: string
}

/**
 * Parameters for the merge-folder command.
 * Merges a folder's contents into an existing folder with the same name.
 */
export interface MergeFolderParams {
  /** The source folder to merge from. */
  sourceFolder: LocalFile

  /**
   * The target folder path (relative to vault root).
   * A folder with sourceFolder.name must already exist here.
   */
  targetFolder: string

  /**
   * How to resolve file conflicts during merge.
   * @default 'prompt' - will return conflicts for user to resolve
   */
  conflictResolution?: 'overwrite' | 'rename' | 'skip' | 'prompt'
}

/**
 * Parameters for the copy command.
 * Creates copies of files in a different folder.
 */
export interface CopyParams extends BaseCommandParams {
  /**
   * The target folder path (relative to vault root).
   * Must be an existing directory within the vault.
   */
  targetFolder: string
}

/**
 * Parameters for the new-folder command.
 * Creates a new directory in the vault.
 */
export interface NewFolderParams {
  /** Parent directory path (relative to vault root). Use '' for vault root. */
  parentPath: string

  /** Name for the new folder. */
  folderName: string
}

/**
 * Parameters for the pin command.
 * Pins a file to the sidebar for quick access.
 */
export interface PinParams {
  /** The file to pin. */
  file: LocalFile

  /** ID of the vault the file belongs to. */
  vaultId: string

  /** Display name of the vault (shown in pin UI). */
  vaultName: string
}

/**
 * Parameters for the unpin command.
 * Removes a file from the pinned files list.
 */
export interface UnpinParams {
  /** Full path to the pinned file. */
  path: string
}

/**
 * Parameters for the ignore command.
 * Adds a pattern to the vault's ignore list (.pdmignore).
 */
export interface IgnoreParams {
  /** ID of the vault to add the ignore pattern to. */
  vaultId: string

  /**
   * Glob pattern to ignore (e.g., "*.tmp", "node_modules/").
   * Follows .gitignore pattern syntax.
   */
  pattern: string
}

/**
 * Parameters for the open command.
 * Opens a file with its default system application.
 */
export interface OpenParams {
  /** The file to open. */
  file: LocalFile
}

/**
 * Parameters for the show-in-explorer command.
 * Opens the containing folder in the system file manager.
 */
export interface ShowInExplorerParams {
  /** Full path to the file or folder to reveal. */
  path: string
}

/**
 * Parameters for the sync-metadata command.
 *
 * Consolidated metadata sync command that handles both directions:
 * - For drawings (.slddrw): PULL - reads from SW file, updates pendingMetadata
 * - For parts/assemblies (.sldprt/.sldasm): PUSH - writes from pendingMetadata to SW file
 *
 * Only works on files checked out by the current user.
 */
export interface SyncMetadataParams extends BaseCommandParams {
  /**
   * Leave `Revision` alone on parts and assemblies, at file scope and in every configuration.
   *
   * For a vault where drawings drive revisions and the model is not supposed to carry one. Without
   * it a sync stamps the row's revision into every model it touches, which is correct for a shop
   * that revises models and unwanted for a shop that does not — the caller knows which, and the
   * command does not try to infer it.
   *
   * Undefined means write it, so the context menus and the service tab are unchanged. Drawings are
   * never affected: they take the PULL path, and a drawing's revision is the drawing's own.
   */
  omitRevisionOnModels?: boolean
}

/**
 * Parameters for the extract-references command.
 * Extracts assembly references from SolidWorks files and stores them in the database.
 * This populates the file_references table for Contains/Where-Used queries.
 *
 * **Requires:** SolidWorks service to be running.
 */
export interface ExtractReferencesParams extends BaseCommandParams {
  /**
   * Only process assembly files (.sldasm).
   * If false, all selected files are passed to the extractor (parts and drawings will be skipped anyway).
   * @default true
   */
  assembliesOnly?: boolean
}

// Extract assembly references (batch operation for existing vaults)
export interface ExtractReferencesParams extends BaseCommandParams {
  // Only process assemblies in selection (default true)
  assembliesOnly?: boolean
}

/**
 * Parameters for bulk assembly operations.
 * Operates on a root assembly file and all its associated files
 * (recursive children, sub-assemblies, drawings).
 */
export interface BulkAssemblyParams extends BaseCommandParams {
  /**
   * The root assembly file ID.
   * The resolver will find all associated files from this root.
   */
  rootFileId: string
}

/**
 * Parameters for pack-and-go command.
 * Exports an assembly and all its associated files to a ZIP archive.
 */
export interface PackAndGoParams {
  /** The root assembly file to package */
  file: LocalFile
}

/**
 * Parameters for the match-ghost-file command.
 * Matches a ghost file (server record with stale path) to its renamed local counterpart
 * by updating the server path via moveFileOnServer.
 */
export interface MatchGhostFileParams {
  /** The ghost file (diffStatus === 'deleted', checked out by current user). */
  ghostFile: LocalFile

  /** The local candidate file to match it to (diffStatus === 'added', same extension). */
  targetFile: LocalFile
}

/**
 * Parameters for the reconcile-moved-paths command.
 *
 * Writes the current local path of every `diffStatus === 'moved'` file to its server record. The
 * command takes no selection: the targets are whatever the vault holds, because a partially
 * reconciled vault is what this exists to fix.
 */
export interface ReconcileMovedPathsParams {
  /**
   * Write. Omitted or false performs the pre-flight and reports without touching the server.
   *
   * Named for the write rather than for the dry run so that no caller can write by forgetting a
   * flag. This is the highest-consequence write in the application; it has to be asked for.
   */
  apply?: boolean

  /**
   * Reconcile the rows nobody else holds and leave the held ones alone.
   *
   * Without it a run that finds any target checked out by another user refuses entirely and names
   * the holders, so they can be asked to check in. Opting in is the deliberate second choice.
   */
  skipCheckedOut?: boolean
}

// ============================================
// Command Definition
// ============================================

export type CommandId =
  | 'checkout'
  | 'checkin'
  | 'sync'
  | 'download'
  | 'get-latest'
  | 'delete-local'
  | 'delete-server'
  | 'discard'
  | 'discard-orphaned'
  | 'force-release'
  | 'rename'
  | 'move'
  | 'copy'
  | 'new-folder'
  | 'merge-folder'
  | 'pin'
  | 'unpin'
  | 'ignore'
  | 'open'
  | 'show-in-explorer'
  | 'sync-metadata'
  | 'extract-references'
  | 'bulk-download-assembly'
  | 'bulk-checkout-assembly'
  | 'bulk-checkin-assembly'
  | 'bulk-delete-assembly'
  | 'pack-and-go'
  | 'match-ghost-file'
  | 'reconcile-moved-paths'

export interface Command<TParams = unknown> {
  // Identifier
  id: CommandId
  name: string
  description: string

  // CLI support
  aliases?: string[]
  usage?: string // e.g., "checkout <path> [--recursive]"

  // Validation - returns error message or null if valid
  validate: (params: TParams, ctx: CommandContext) => string | null

  // Execution
  execute: (params: TParams, ctx: CommandContext) => Promise<CommandResult>

  // Undo support (optional)
  canUndo?: boolean
  undo?: (params: TParams, ctx: CommandContext) => Promise<CommandResult>
}

// Type-safe command map
export type CommandMap = {
  checkout: Command<CheckoutParams>
  checkin: Command<CheckinParams>
  sync: Command<SyncParams>
  download: Command<DownloadParams>
  'get-latest': Command<GetLatestParams>
  'delete-local': Command<DeleteLocalParams>
  'delete-server': Command<DeleteServerParams>
  discard: Command<DiscardParams>
  'discard-orphaned': Command<DiscardOrphanedParams>
  'force-release': Command<ForceReleaseParams>
  rename: Command<RenameParams>
  move: Command<MoveParams>
  copy: Command<CopyParams>
  'new-folder': Command<NewFolderParams>
  'merge-folder': Command<MergeFolderParams>
  pin: Command<PinParams>
  unpin: Command<UnpinParams>
  ignore: Command<IgnoreParams>
  open: Command<OpenParams>
  'show-in-explorer': Command<ShowInExplorerParams>
  'sync-metadata': Command<SyncMetadataParams>
  'extract-references': Command<ExtractReferencesParams>
  'bulk-download-assembly': Command<BulkAssemblyParams>
  'bulk-checkout-assembly': Command<BulkAssemblyParams>
  'bulk-checkin-assembly': Command<BulkAssemblyParams>
  'bulk-delete-assembly': Command<BulkAssemblyParams>
  'pack-and-go': Command<PackAndGoParams>
  'match-ghost-file': Command<MatchGhostFileParams>
  'reconcile-moved-paths': Command<ReconcileMovedPathsParams>
}

// ============================================
// Utility Types
// ============================================

/**
 * Every file inside a folder, at any depth.
 *
 * Containment is `isPathWithinDirectory`, the same rule the deletion enumerators and
 * `removeFilesFromStore` use: on a directory boundary, so "Fixed Lens" cannot reach
 * "Fixed Lens Models", and case-insensitive, because Windows is. Comparing case-sensitively
 * found nothing at all under a folder whose stored spelling differed from its children's, so
 * a folder of checked-out files reported none to discard and a folder move carried no
 * bookkeeping for the files it moved.
 *
 * The helper also matches the directory itself, which the previous `+ '/'` form could not, so
 * the exact match is dropped again here: a folder is not one of its own contents.
 */
export function getFilesInFolder(files: LocalFile[], folderPath: string): LocalFile[] {
  return files.filter((f) => {
    if (f.isDirectory) return false
    if (!isPathWithinDirectory(f.relativePath, folderPath)) return false
    // Only the folder itself can be this short; every file under it adds a separator and a
    // name, and differing case or separators cannot change a path's length.
    return f.relativePath.length > folderPath.length
  })
}

// Helper to get synced files from selection (handles folders)
// "Synced" means files that exist BOTH locally AND on server
// Excludes: cloud, deleted (these only exist on server, not locally)
export function getSyncedFilesFromSelection(
  files: LocalFile[],
  selection: LocalFile[],
): LocalFile[] {
  const result: LocalFile[] = []

  // Statuses that indicate file doesn't exist locally (server-only)
  const serverOnlyStatuses = ['cloud', 'deleted']

  for (const item of selection) {
    if (item.isDirectory) {
      // Get all synced files inside the folder
      const filesInFolder = getFilesInFolder(files, item.relativePath)
      const syncedInFolder = filesInFolder.filter(
        (f) => f.pdmData?.id && !serverOnlyStatuses.includes(f.diffStatus || ''),
      )
      result.push(...syncedInFolder)
    } else if (item.pdmData?.id && !serverOnlyStatuses.includes(item.diffStatus || '')) {
      // Look up fresh file from files array to get current pendingMetadata
      // (selection may have stale reference without latest metadata edits)
      const freshFile = files.find((f) => f.path === item.path)
      result.push(freshFile || item)
    }
  }

  // Deduplicate by path
  return [...new Map(result.map((f) => [f.path, f])).values()]
}

// Helper to get unsynced files from selection
// Includes both 'added' (truly new) and 'deleted_remote' (orphaned local files)
export function getUnsyncedFilesFromSelection(
  files: LocalFile[],
  selection: LocalFile[],
): LocalFile[] {
  const result: LocalFile[] = []

  for (const item of selection) {
    if (item.isDirectory) {
      const filesInFolder = getFilesInFolder(files, item.relativePath)
      const unsyncedInFolder = filesInFolder.filter(
        (f) => !f.pdmData || f.diffStatus === 'added' || f.diffStatus === 'deleted_remote',
      )
      result.push(...unsyncedInFolder)
    } else if (
      !item.pdmData ||
      item.diffStatus === 'added' ||
      item.diffStatus === 'deleted_remote'
    ) {
      // Look up fresh file from files array (selection may have stale reference)
      const freshFile = files.find((f) => f.path === item.path)
      result.push(freshFile || item)
    }
  }

  return [...new Map(result.map((f) => [f.path, f])).values()]
}

// Helper to get cloud-only files from selection
export function getCloudOnlyFilesFromSelection(
  files: LocalFile[],
  selection: LocalFile[],
): LocalFile[] {
  const result: LocalFile[] = []

  for (const item of selection) {
    if (item.isDirectory) {
      const filesInFolder = getFilesInFolder(files, item.relativePath)
      const cloudOnly = filesInFolder.filter((f) => f.diffStatus === 'cloud')
      result.push(...cloudOnly)
    } else if (item.diffStatus === 'cloud' && item.pdmData) {
      // Look up fresh file from files array (selection may have stale reference)
      const freshFile = files.find((f) => f.path === item.path)
      result.push(freshFile || item)
    }
  }

  return [...new Map(result.map((f) => [f.path, f])).values()]
}

// Helper to get orphaned files from selection
// Orphaned files are local files that were previously synced but no longer exist on server
// (deleted by another user). They have diffStatus === 'deleted_remote'.
export function getOrphanedFilesFromSelection(
  files: LocalFile[],
  selection: LocalFile[],
): LocalFile[] {
  const result: LocalFile[] = []

  for (const item of selection) {
    if (item.isDirectory) {
      const filesInFolder = getFilesInFolder(files, item.relativePath)
      const orphaned = filesInFolder.filter((f) => f.diffStatus === 'deleted_remote')
      result.push(...orphaned)
    } else if (item.diffStatus === 'deleted_remote') {
      // Look up fresh file from files array (selection may have stale reference)
      const freshFile = files.find((f) => f.path === item.path)
      result.push(freshFile || item)
    }
  }

  return [...new Map(result.map((f) => [f.path, f])).values()]
}

// Helper to get files that can have their checkout discarded/released
// Includes BOTH:
// 1. Synced files (exist locally) checked out by user - will download server version
// 2. Deleted files (don't exist locally) checked out by user - will just release checkout
export function getDiscardableFilesFromSelection(
  files: LocalFile[],
  selection: LocalFile[],
  userId?: string,
): LocalFile[] {
  const result: LocalFile[] = []

  for (const item of selection) {
    if (item.isDirectory) {
      const filesInFolder = getFilesInFolder(files, item.relativePath)
      // Include synced files and 'deleted' files checked out by user
      const discardable = filesInFolder.filter(
        (f) => f.pdmData?.id && f.pdmData.checked_out_by === userId && f.diffStatus !== 'cloud',
      )
      result.push(...discardable)
    } else if (item.pdmData?.id) {
      // Look up fresh file from files array FIRST (selection may have stale reference)
      // Then check on fresh data, not stale selection
      const freshFile = files.find((f) => f.path === item.path)
      if (
        freshFile &&
        freshFile.pdmData?.checked_out_by === userId &&
        freshFile.diffStatus !== 'cloud'
      ) {
        result.push(freshFile)
      }
    }
  }

  return [...new Map(result.map((f) => [f.path, f])).values()]
}

// Helper to get files checked out by others (cannot be modified)
// Used by delete, move, rename commands to block operations on locked files
export function getFilesCheckedOutByOthers(
  allFiles: LocalFile[],
  selection: LocalFile[],
  userId: string | undefined,
): LocalFile[] {
  // Get all synced files from selection (including nested in folders)
  const selectedFiles = getSyncedFilesFromSelection(allFiles, selection)
  return selectedFiles.filter(
    (f) => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== userId,
  )
}

/**
 * One server file record a delete-server selection covers.
 *
 * Identified by the row that will be soft-deleted rather than by a local file, because the
 * two do not correspond: a server row can have no local file at all.
 */
export interface ServerDeletionTarget {
  /** `files.id` of the record to soft-delete. */
  fileId: string
  name: string
  /** Path on the server, forward-slashed and relative to the vault root. */
  relativePath: string
  /** Absolute local path, for store removal and processing spinners. */
  path: string
  /** The store row for this record, when one exists. */
  localFile?: LocalFile
}

/**
 * Every server record a delete-server selection covers.
 *
 * A folder's contents come from `serverFiles`, not from the local rows under it. The two
 * disagree whenever a file was never downloaded or its row was pruned, and enumerating
 * locally left the difference behind: one folder delete found 5 of the 53 records the server
 * actually held, and the other 48 survived as orphans that a later copy to the same path then
 * collided with. `serverFiles` holds the active vault only, so a prefix match cannot reach
 * outside it, and the match is on a directory boundary so deleting "Fixed Lens" does not take
 * "Fixed Lens Models" with it.
 *
 * Selected files are unchanged: a file is exactly itself, and only when it carries a record.
 *
 * @param files - All local rows, used to attach the store row for each record
 * @param serverFiles - The vault's server file list
 * @param selection - The items the user acted on
 * @param vaultPath - Vault root, for the absolute path of records with no local row
 */
export function getServerDeletionTargets(
  files: LocalFile[],
  serverFiles: ServerFile[],
  selection: LocalFile[],
  vaultPath: string | null,
): ServerDeletionTarget[] {
  const localByRelativePath = new Map<string, LocalFile>()
  for (const file of files) {
    if (file.isDirectory) continue
    localByRelativePath.set(file.relativePath.replace(/\\/g, '/').toLowerCase(), file)
  }

  const targets = new Map<string, ServerDeletionTarget>()

  const addServerFile = (serverFile: ServerFile): void => {
    if (targets.has(serverFile.id)) return
    const relativePath = serverFile.file_path.replace(/\\/g, '/')
    const localFile = localByRelativePath.get(relativePath.toLowerCase())
    targets.set(serverFile.id, {
      fileId: serverFile.id,
      name: serverFile.name,
      relativePath,
      path: localFile?.path ?? buildVaultFullPath(vaultPath ?? '', relativePath),
      localFile,
    })
  }

  for (const item of selection) {
    if (item.isDirectory) {
      for (const serverFile of serverFiles) {
        if (isPathWithinDirectory(serverFile.file_path, item.relativePath)) {
          addServerFile(serverFile)
        }
      }
    } else if (item.pdmData?.id && !targets.has(item.pdmData.id)) {
      targets.set(item.pdmData.id, {
        fileId: item.pdmData.id,
        name: item.name,
        relativePath: item.relativePath.replace(/\\/g, '/'),
        path: item.path,
        localFile: item,
      })
    }
  }

  return Array.from(targets.values())
}

/**
 * What a delete-server selection covers on disk: the selected items themselves plus every
 * local file inside a selected folder, so each file is handed to the batch delete explicitly
 * rather than relying on the folder delete to take its contents with it.
 *
 * Containment is decided by `isPathWithinDirectory`, the same rule `getServerDeletionTargets`
 * uses for the server records and `removeFilesFromStore` uses when it prunes a folder's
 * children. When these disagreed, a folder whose stored spelling differed in case from its
 * children's left the files on disk while the records and the rows were both gone.
 *
 * Cloud-only items are skipped: there is nothing local to delete.
 *
 * @param files - All local rows, searched for the contents of selected folders
 * @param selection - The items the user acted on
 */
export function getLocalDeletionItems(files: LocalFile[], selection: LocalFile[]): LocalFile[] {
  const items: LocalFile[] = []

  for (const item of selection) {
    if (item.diffStatus === 'cloud') continue
    items.push(item)
    if (!item.isDirectory) continue

    for (const file of files) {
      if (file.isDirectory) continue
      if (file.diffStatus === 'cloud') continue
      if (isPathWithinDirectory(file.relativePath, item.relativePath)) items.push(file)
    }
  }

  // A file can be both selected and inside a selected folder
  return [...new Map(items.map((f) => [f.path, f])).values()]
}

/**
 * Get ghost files from selection: server records checked out by the current user
 * that don't exist locally (diffStatus === 'deleted'). These are candidates for
 * the "Match to Local File" resolution flow.
 */
export function getGhostFilesFromSelection(
  files: LocalFile[],
  selection: LocalFile[],
  userId?: string,
): LocalFile[] {
  const result: LocalFile[] = []

  for (const item of selection) {
    if (item.isDirectory) {
      const filesInFolder = getFilesInFolder(files, item.relativePath)
      const ghosts = filesInFolder.filter(
        (f) => !f.isDirectory && f.diffStatus === 'deleted' && f.pdmData?.checked_out_by === userId,
      )
      result.push(...ghosts)
    } else if (!item.isDirectory && item.pdmData?.id) {
      const freshFile = files.find((f) => f.path === item.path)
      if (
        freshFile &&
        freshFile.diffStatus === 'deleted' &&
        freshFile.pdmData?.checked_out_by === userId
      ) {
        result.push(freshFile)
      }
    }
  }

  return [...new Map(result.map((f) => [f.path, f])).values()]
}

// Format bytes to human readable
// Re-export shared utility functions for backwards compatibility
export { formatBytes, formatSpeed, buildFullPath, getParentDir } from '../utils'
