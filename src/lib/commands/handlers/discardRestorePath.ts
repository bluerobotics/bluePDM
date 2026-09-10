/**
 * Discard Restore Path
 *
 * Restores a checked-out file's name and folder when discard runs, using the
 * checkout-time path snapshot on `pdmData` (`checked_out_file_path` /
 * `checked_out_file_name` — see the plan's "Shared contract"). Split out of
 * `discard.ts` so the path math is independently unit-testable and so
 * `discard.ts` itself stays under the repo's file-size guidance.
 *
 * The module has two halves:
 * - Pure helpers (`computeRestoreTarget`, `resolveCheckedOutFile`,
 *   `findCollisionAtRestorePath`) that take plain data and are covered by
 *   `discardRestorePath.test.ts`.
 * - Thin orchestration (`resolveCheckoutFileOnDisk`, `performCheckoutPathRestore`,
 *   `finalizeRestoredFileTracking`) that calls `window.electronAPI`, the sync
 *   index, and the store on top of those helpers. This half exists so
 *   `discard.ts` only has to call two functions per file instead of inlining
 *   the whole restore sequence.
 */

import type { CommandContext, LocalFile } from '../types'
import { buildFullPath, getParentDir } from '../types'
import { log } from '@/lib/logger'
import { addToSyncIndex, removeFromSyncIndex, updateInodes } from '../../cache/localSyncIndex'

// ============================================
// Pure helpers
// ============================================

/** The two checkout-time snapshot fields read off a file's `pdmData`. */
export interface CheckoutPathSnapshot {
  checked_out_file_path: string | null
  checked_out_file_name: string | null
}

/** Where a checked-out file must move back to so its on-disk location matches
 * the snapshot taken at checkout. */
export interface RestoreTarget {
  /** Vault-relative path (forward-slash separated) to restore to. */
  originalRelPath: string
  /** File name to restore to. */
  originalFileName: string
  /** True when the parent folder differs, not just the trailing name — a move happened. */
  isMove: boolean
}

function getParentRelPath(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? '' : relPath.slice(0, idx)
}

/**
 * Compute the restore target for a file's checkout-time snapshot versus its
 * current relative path, or null when no restore is needed.
 *
 * Returns null when:
 * - either snapshot field is null (older lock taken before this release, or a
 *   force-released lock that never carried one) — callers must fall back to
 *   today's behaviour and download in place.
 * - the snapshot already matches the current path (no rename or move happened
 *   since checkout).
 *
 * Comparison is case-insensitive, matching how `checkin.ts` detects renames/moves.
 */
export function computeRestoreTarget(
  snapshot: CheckoutPathSnapshot,
  currentRelPath: string,
): RestoreTarget | null {
  const { checked_out_file_path: snapshotPath, checked_out_file_name: snapshotName } = snapshot

  if (!snapshotPath || !snapshotName) return null
  if (snapshotPath.toLowerCase() === currentRelPath.toLowerCase()) return null

  const isMove = getParentRelPath(snapshotPath).toLowerCase() !== getParentRelPath(currentRelPath).toLowerCase()

  return { originalRelPath: snapshotPath, originalFileName: snapshotName, isMove }
}

/**
 * Pick which of several `LocalFile` entries sharing the same server file id is
 * the one actually on disk. Needed because the user may have selected the
 * ghost row at the file's pre-rename path (diffStatus `'deleted'`) while the
 * renamed file lives in a separate `ctx.files` entry with the same id — or the
 * reverse.
 *
 * Pure: the caller supplies on-disk existence per path (a real filesystem
 * check does not belong in a pure module), keyed by `LocalFile.path`.
 * Returns null only when nothing in `candidates` carries `fileId`.
 */
export function resolveCheckedOutFile(
  candidates: LocalFile[],
  fileId: string,
  existsOnDiskByPath: ReadonlyMap<string, boolean>,
): LocalFile | null {
  const matching = candidates.filter((f) => f.pdmData?.id === fileId)
  if (matching.length === 0) return null

  const onDisk = matching.find((f) => existsOnDiskByPath.get(f.path) === true)
  return onDisk ?? matching[0]
}

/**
 * Find another file already occupying the restore target path, if any, so
 * discard can refuse to overwrite it rather than destroy data. Excludes the
 * file being restored itself (its own ghost entry may already sit at that
 * path).
 *
 * Cloud-only rows count. They have no on-disk content to overwrite, but the
 * restore target is constrained server-side too: `files` is unique on
 * `(vault_id, LOWER(file_path)) WHERE deleted_at IS NULL`, and `undoCheckout`
 * writes `file_path` back from the snapshot. A cloud-only row another user
 * created at the snapshot path after this user renamed away from it would pass
 * a disk-only check and then fail that write with 23505 - after the local file
 * had already been renamed and overwritten, since restore and download both
 * run before `undoCheckout`. Refusing here is the only point at which nothing
 * has moved yet.
 */
export function findCollisionAtRestorePath(
  files: LocalFile[],
  originalRelPath: string,
  fileId: string | undefined,
): LocalFile | null {
  const targetLower = originalRelPath.toLowerCase()
  return (
    files.find(
      (f) =>
        !f.isDirectory &&
        f.pdmData?.id !== fileId &&
        f.relativePath.toLowerCase() === targetLower,
    ) ?? null
  )
}

/**
 * Every path a checked-out file's persisted pending metadata (see
 * `persistedPendingMetadata` / `persistedMetadataWriteState` in
 * `src/stores/slices/filesSlice.ts`) could be keyed under by the time discard
 * finishes with this file, deduplicated.
 *
 * `renameFileInStore` migrates those maps (and everything else registered in
 * `src/stores/persistedPathKeys.ts`) from a file's old path to its new one on
 * every rename, case-insensitively. So once `finalizeRestoredFileTracking` has
 * run for a restored file, any entry that existed at `resolvedPath` has
 * already moved to `finalPath` — a caller that clears metadata using only the
 * path the user selected, or only the path the file was resolved to before
 * the restore, would miss it. Callers should pass all three candidates here
 * and clear the deduplicated result in one call rather than clearing per path.
 */
export function pendingMetadataPathsToClear(
  selectedPath: string,
  resolvedPath: string,
  finalPath: string,
): string[] {
  return [...new Set([selectedPath, resolvedPath, finalPath])]
}

// ============================================
// Orchestration (impure: filesystem, sync index, store)
// ============================================

/** Rename/move details recorded once a restore has actually happened on disk. */
export interface RestoredFrom {
  currentRelPath: string
  originalRelPath: string
  originalFileName: string
  isMove: boolean
}

export interface PathRestoreOutcome {
  /** Full path the server content should be downloaded to. */
  downloadPath: string
  /** Non-null when a rename/move actually happened on disk. */
  restoredFrom: RestoredFrom | null
}

export interface PathRestoreError {
  error: string
}

/**
 * Resolve which `ctx.files` entry for a checked-out server record actually
 * sits on disk. Falls back to `selectedFile` when no entry carries `fileId`
 * (should not happen for a discardable file, but keeps this total).
 */
export async function resolveCheckoutFileOnDisk(
  files: LocalFile[],
  fileId: string,
  selectedFile: LocalFile,
): Promise<{ resolvedFile: LocalFile; existsOnDisk: boolean }> {
  const candidates = files.filter((f) => !f.isDirectory && f.pdmData?.id === fileId)
  const relevant = candidates.length > 0 ? candidates : [selectedFile]

  const existsOnDiskByPath = new Map<string, boolean>()
  for (const candidate of relevant) {
    existsOnDiskByPath.set(
      candidate.path,
      (await window.electronAPI?.fileExists(candidate.path)) ?? false,
    )
  }

  const resolvedFile = resolveCheckedOutFile(relevant, fileId, existsOnDiskByPath) ?? selectedFile
  return { resolvedFile, existsOnDisk: existsOnDiskByPath.get(resolvedFile.path) ?? false }
}

/**
 * If `resolvedFile` was renamed or moved during checkout, rename it back to
 * its checkout-time path on disk before the server content is downloaded.
 * Order matters: rename first so the download never lands on a path that is
 * about to be moved out from under it.
 *
 * Returns the path the caller should download to (the restored path, or
 * `resolvedFile.path` unchanged when no restore is needed) plus the rename
 * details needed for the store/cache updates that follow a successful
 * download — or an `error` string so the caller can fail just this one file
 * without aborting the rest of the discard batch.
 *
 * Watcher suppression for the two paths involved is registered here and, on
 * success, left registered for the caller to clear once the batch settles. Any
 * failure clears it before returning, so a rename that could not happen never
 * leaves a path permanently hidden from the watcher.
 */
export async function performCheckoutPathRestore(
  ctx: Pick<
    CommandContext,
    'files' | 'vaultPath' | 'addExpectedFileChanges' | 'clearExpectedFileChanges'
  >,
  resolvedFile: LocalFile,
  selectedFile: LocalFile,
  operationId: string,
): Promise<PathRestoreOutcome | PathRestoreError> {
  const restoreTarget = computeRestoreTarget(
    {
      checked_out_file_path: resolvedFile.pdmData?.checked_out_file_path ?? null,
      checked_out_file_name: resolvedFile.pdmData?.checked_out_file_name ?? null,
    },
    resolvedFile.relativePath,
  )

  if (!restoreTarget) {
    return { downloadPath: resolvedFile.path, restoredFrom: null }
  }

  const vaultPath = ctx.vaultPath || ''
  const originalFullPath = buildFullPath(vaultPath, restoreTarget.originalRelPath)

  const metadataCollision = findCollisionAtRestorePath(
    ctx.files,
    restoreTarget.originalRelPath,
    selectedFile.pdmData?.id,
  )
  const diskCollision = metadataCollision
    ? false
    : ((await window.electronAPI?.fileExists(originalFullPath)) ?? false)

  if (metadataCollision || diskCollision) {
    log.error('[Discard]', 'Restore blocked by collision at original path', {
      operationId,
      fileName: selectedFile.name,
      originalRelPath: restoreTarget.originalRelPath,
      collisionFileName: metadataCollision?.name,
    })
    return {
      error: `${selectedFile.name}: Cannot restore to "${restoreTarget.originalRelPath}" - another file already exists there`,
    }
  }

  const currentFullPath = resolvedFile.path
  const currentRelPath = resolvedFile.relativePath

  // Both the path the file leaves and the one it lands on have to be hidden from
  // the watcher across the rename. Ownership of that suppression is decided by
  // the outcome: on success it is handed to the caller, which reports both paths
  // in `restoredFrom` and clears them on the batch-level timeout once the whole
  // discard settles. On any failure below - including a thrown one - no caller
  // ever learns these paths, so the `finally` releases them here. Without it a
  // failed rename (a file open in SOLIDWORKS gives EPERM/EBUSY) would leave two
  // paths invisible to the watcher for the rest of the session: expectedFileChanges
  // is a plain Set with no TTL.
  const suppressedPaths = [currentRelPath, restoreTarget.originalRelPath]
  ctx.addExpectedFileChanges(suppressedPaths)
  let handedOffToCaller = false

  try {
    const originalParentDir = getParentDir(originalFullPath)
    const mkdirResult = await window.electronAPI?.createFolder(originalParentDir)
    if (mkdirResult?.success === false) {
      log.error('[Discard]', 'Failed to create original parent directory', {
        operationId,
        fileName: selectedFile.name,
        originalParentDir,
        error: mkdirResult.error,
      })
      return { error: `${selectedFile.name}: Failed to restore folder - ${mkdirResult.error}` }
    }

    await window.electronAPI?.setReadonly(currentFullPath, false)

    const renameResult = await window.electronAPI?.renameItem(currentFullPath, originalFullPath)
    if (!renameResult?.success) {
      log.error('[Discard]', 'Failed to rename file back to its original path', {
        operationId,
        fileName: selectedFile.name,
        currentFullPath,
        originalFullPath,
        error: renameResult?.error,
      })
      // The checkout is still held (undoCheckout was never reached), and the
      // file never moved, so it is already writable from the call above — leave
      // it that way rather than falsely marking a checked-out file read-only.
      return {
        error: `${selectedFile.name}: Failed to restore original name - ${renameResult?.error || 'rename failed'}`,
      }
    }

    log.info('[Discard]', 'Restored file to its checkout-time path before download', {
      operationId,
      fileName: selectedFile.name,
      from: currentRelPath,
      to: restoreTarget.originalRelPath,
      isMove: restoreTarget.isMove,
    })

    handedOffToCaller = true
    return {
      downloadPath: originalFullPath,
      restoredFrom: {
        currentRelPath,
        originalRelPath: restoreTarget.originalRelPath,
        originalFileName: restoreTarget.originalFileName,
        isMove: restoreTarget.isMove,
      },
    }
  } finally {
    if (!handedOffToCaller) ctx.clearExpectedFileChanges(suppressedPaths)
  }
}

/**
 * Apply the store rename and cache fixups for a file that was successfully
 * restored to its checkout-time path and re-downloaded.
 *
 * Must run before the caller's own `pendingUpdates` push for this file, since
 * `updateFilesAndClearProcessing` looks entries up by path — the pending
 * update has to be keyed on the restored path, which only exists in the store
 * after this rename runs.
 */
export function finalizeRestoredFileTracking(
  ctx: Pick<CommandContext, 'renameFileInStore' | 'activeVaultId'>,
  resolvedFile: LocalFile,
  downloadPath: string,
  restoredFrom: RestoredFrom,
  localVersion: number | undefined,
  localHash: string,
): void {
  ctx.renameFileInStore(
    resolvedFile.path,
    downloadPath,
    restoredFrom.isMove ? restoredFrom.originalRelPath : restoredFrom.originalFileName,
    restoredFrom.isMove,
  )

  if (!ctx.activeVaultId) return
  const vaultId = ctx.activeVaultId

  removeFromSyncIndex(vaultId, [restoredFrom.currentRelPath]).catch((error: unknown) => {
    log.warn('[Discard]', 'Failed to remove old path from sync index', { error: String(error) })
  })
  addToSyncIndex(vaultId, [restoredFrom.originalRelPath]).catch((error: unknown) => {
    log.warn('[Discard]', 'Failed to add restored path to sync index', { error: String(error) })
  })

  // Renaming on the same volume preserves the inode; re-key the sync index's
  // cached inode to the restored path so the next scan does not misread the
  // path we just moved away from as an unrelated, fresh rename.
  if (typeof resolvedFile.ino === 'number' && resolvedFile.ino > 0) {
    updateInodes(vaultId, [
      { path: restoredFrom.originalRelPath, ino: resolvedFile.ino, localVersion, localHash },
    ]).catch((error: unknown) => {
      log.warn('[Discard]', 'Failed to refresh inode for restored path', { error: String(error) })
    })
  }
}
