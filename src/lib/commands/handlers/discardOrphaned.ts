/**
 * Discard Orphaned Command
 *
 * Delete local files that no longer exist on the server (orphaned files).
 * These are files that were previously synced but have been deleted from the vault
 * by another user. They show with 'deleted_remote' status.
 *
 * This command:
 * 1. Deletes the local files from disk
 * 2. Removes them from the local sync index
 * 3. Updates the store to remove the files from view
 *
 * The deletions are registered as expected file changes for the duration, so the
 * watcher does not read them back as external edits and trigger a vault reload.
 *
 * `params.isAutomatic` distinguishes this running unattended (auto-discard on
 * load) from a user explicitly invoking it from a context menu or settings. On
 * the automatic path, a file that `shell.trashItem` cannot recycle is left on
 * disk rather than permanently deleted - see
 * `.cursor/plans/recycle-bin-reliability-report.md`. The caller finds out via
 * `CommandResult.skipped` / `skippedPaths`.
 */

import type { Command, CommandResult, DiscardOrphanedParams, LocalFile } from '../types'
import { getFilesInFolder } from '../types'
import { t } from '@/lib/i18n'
import { log } from '@/lib/logger'
import { FileOperationTracker } from '../../fileOperationTracker'
import { removeFromSyncIndex } from '../../cache/localSyncIndex'
import { beginWatcherSuppression } from '@/lib/fileWatcherSuppression'

/**
 * Per vault, the files the last automatic run left on disk, as a stable signature.
 *
 * An unattended discard repeats on every background refresh, and a file that could
 * not be recycled is kept on purpose, so it is still orphaned on the next pass and
 * would be reported again indefinitely. Holding the last signature turns that into
 * one message per distinct set of kept files, while a genuinely new one still says so.
 *
 * Keyed by vault because two vaults can legitimately be keeping different files, and
 * one must not silence the other's first report.
 */
const lastAutomaticSkipSignatures = new Map<string, string>()

/**
 * Per vault, the files the last automatic run genuinely failed to delete (e.g. a file
 * locked open in SOLIDWORKS), as a stable signature. Same shape and same reason as
 * `lastAutomaticSkipSignatures` above: a lock persists across every silent refresh
 * until the file is closed, so without this the automatic path would either say
 * nothing (the pre-fix behaviour) or repeat the same warning every few seconds.
 */
const lastAutomaticFailureSignatures = new Map<string, string>()

/**
 * Per vault, when the last automatic run left every file in the batch on disk because
 * none of them could be recycled - the UNC-path-vault case, where `shell.trashItem`
 * fails for everything and the batch would otherwise retry, watcher-stop-and-all, on
 * every refresh forever. Absent means no cooldown is active.
 */
const lastAutomaticAllSkippedAt = new Map<string, number>()

/**
 * How long an all-skipped automatic batch backs off before the same vault is tried
 * again.
 *
 * The cost being bounded is a background one - a watcher stop, a settle delay, three
 * EBUSY retries with backoff, and a watcher restart - repeated for the whole batch on
 * every silent refresh with nothing to show for it. Ten minutes turns "every refresh"
 * into a handful of attempts a day, which is negligible against that cost, while
 * staying short enough that a share which becomes writable again (a remounted drive,
 * a fixed permission) is not left orphaned for the rest of the session.
 */
const AUTOMATIC_ALL_SKIPPED_COOLDOWN_MS = 10 * 60 * 1000

/** Clear the per-vault skip/failure notices and cooldowns. Exported for tests, which share module state. */
export function resetAutomaticSkipNotices(): void {
  lastAutomaticSkipSignatures.clear()
  lastAutomaticFailureSignatures.clear()
  lastAutomaticAllSkippedAt.clear()
}

/**
 * Whether an automatic discard for this vault is in its post-all-skipped cooldown.
 * The caller in `useLoadFiles.ts` checks this before even invoking the command, so
 * the cooldown actually saves the watcher-stop/settle/retry cost rather than merely
 * suppressing the toast after paying it again.
 */
export function isAutomaticDiscardCoolingDown(vaultId: string): boolean {
  const skippedAt = lastAutomaticAllSkippedAt.get(vaultId)
  if (skippedAt === undefined) return false
  return Date.now() - skippedAt < AUTOMATIC_ALL_SKIPPED_COOLDOWN_MS
}

function logDiscardOrphaned(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  context: Record<string, unknown>,
) {
  log[level]('[DiscardOrphaned]', message, context)
}

/**
 * Get orphaned files (deleted_remote) from a selection.
 * Handles both individual files and folders.
 */
function getOrphanedFilesFromSelection(files: LocalFile[], selection: LocalFile[]): LocalFile[] {
  const result: LocalFile[] = []

  for (const item of selection) {
    if (item.isDirectory) {
      // Get all orphaned files inside the folder
      const filesInFolder = getFilesInFolder(files, item.relativePath)
      const orphanedInFolder = filesInFolder.filter((f) => f.diffStatus === 'deleted_remote')
      result.push(...orphanedInFolder)
    } else if (item.diffStatus === 'deleted_remote') {
      result.push(item)
    }
  }

  // Deduplicate by path
  return [...new Map(result.map((f) => [f.path, f])).values()]
}

export const discardOrphanedCommand: Command<DiscardOrphanedParams> = {
  id: 'discard-orphaned',
  name: 'Discard Orphaned Files',
  description: 'Delete local files that no longer exist on the server',
  aliases: ['remove-orphaned', 'cleanup-orphaned'],
  usage: 'discard-orphaned <path>',

  validate({ files }, ctx) {
    if (!files || files.length === 0) {
      return 'No files selected'
    }

    // Get orphaned files
    const orphanedFiles = getOrphanedFilesFromSelection(ctx.files, files)

    if (orphanedFiles.length === 0) {
      return 'No orphaned files to discard'
    }

    return null
  },

  async execute({ files, isAutomatic = false }, ctx): Promise<CommandResult> {
    const operationStart = performance.now()
    const operationId = `discard-orphaned-${Date.now()}`

    // Get orphaned files
    const filesToDiscard = getOrphanedFilesFromSelection(ctx.files, files)

    logDiscardOrphaned('info', 'Starting discard orphaned operation', {
      operationId,
      selectedCount: files.length,
      orphanedCount: filesToDiscard.length,
      isAutomatic,
    })

    if (filesToDiscard.length === 0) {
      return {
        success: true,
        message: 'No orphaned files to discard',
        total: 0,
        succeeded: 0,
        failed: 0,
      }
    }

    // Initialize file operation tracker for DevTools monitoring
    const tracker = FileOperationTracker.start(
      'delete',
      filesToDiscard.length,
      filesToDiscard.map((f) => f.relativePath),
    )

    const total = filesToDiscard.length

    // Track paths being processed
    const pathsBeingProcessed = filesToDiscard.map((f) => f.relativePath)
    ctx.addProcessingFoldersSync(pathsBeingProcessed, 'delete')

    // Without this the watcher sees our own deletions as external changes once the
    // batch operation restarts it, and kicks off a full vault reload. Matches the
    // delete handler; the helper carries a backstop so a missed release cannot
    // suppress these paths for the rest of the session.
    const releaseWatcher = beginWatcherSuppression(pathsBeingProcessed, ctx)

    try {
      // Progress tracking
      const toastId = `discard-orphaned-${Date.now()}`
      ctx.addProgressToast(
        toastId,
        `Removing ${total} orphaned file${total !== 1 ? 's' : ''}...`,
        total,
      )

      // Yield to let confirmation modal close
      await new Promise((resolve) => setTimeout(resolve, 0))

      // Delete local files using batch operation. `isAutomatic` tells the main
      // process this run is unattended: a file that cannot be moved to the Recycle
      // Bin comes back with `skipped: true` and is left on disk rather than being
      // permanently deleted. See .cursor/plans/recycle-bin-reliability-report.md.
      const filePaths = filesToDiscard.map((f) => f.path)
      const batchResult = (await window.electronAPI?.deleteBatch(filePaths, true, isAutomatic)) as
        | {
            success: boolean
            results: Array<{
              path: string
              success: boolean
              error?: string
              skipped?: boolean
            }>
            summary: {
              total: number
              succeeded: number
              failed: number
              skipped: number
              duration: number
            }
          }
        | undefined

      if (!batchResult) {
        tracker.endOperation('failed', 'No response from system')
        ctx.removeProcessingFolders(pathsBeingProcessed)
        ctx.removeToast(toastId)
        ctx.addToast('error', 'Failed to discard orphaned files - no response from system')
        return {
          success: false,
          message: 'Discard operation failed',
          total,
          succeeded: 0,
          failed: total,
        }
      }

      const succeeded = batchResult.summary.succeeded
      const failed = batchResult.summary.failed

      // Get paths that were successfully deleted
      const deletedPaths = batchResult.results.filter((r) => r.success).map((r) => r.path)

      // Update progress
      ctx.updateProgressToast(toastId, total, 100, undefined, `${total}/${total}`)

      // Remove successfully deleted files from the store
      if (deletedPaths.length > 0) {
        ctx.removeFilesFromStore(deletedPaths)

        // Remove from sync index so they're not marked as orphaned if recreated
        if (ctx.activeVaultId) {
          const relativePaths = filesToDiscard
            .filter((f) => deletedPaths.includes(f.path))
            .map((f) => f.relativePath)
          removeFromSyncIndex(ctx.activeVaultId, relativePaths).catch((err) => {
            logDiscardOrphaned('warn', 'Failed to update sync index', { error: String(err) })
          })
        }
      }

      // Clear processing state
      ctx.removeProcessingFolders(pathsBeingProcessed)
      ctx.setLastOperationCompletedAt(Date.now())
      ctx.removeToast(toastId)

      // Extract errors for feedback, keeping a skip (kept on disk on purpose) separate
      // from a genuine failure (e.g. a locked file) - they need different wording and
      // different caller handling.
      const errors: string[] = []
      const skippedPaths: string[] = []
      const failedPaths: string[] = []
      for (const result of batchResult.results) {
        if (result.success || !result.error) continue

        if (result.skipped) {
          skippedPaths.push(result.path)
          logDiscardOrphaned('warn', 'Kept orphaned file on disk - could not recycle it', {
            path: result.path,
            error: result.error,
          })
          continue
        }

        failedPaths.push(result.path)
        const fileName = result.path.split(/[/\\]/).pop() || result.path
        errors.push(`${fileName}: ${result.error}`)
        logDiscardOrphaned('error', 'Failed to delete orphaned file', {
          path: result.path,
          error: result.error,
        })
      }

      // Show result toast. A skip is reported separately from a genuine failure -
      // it is expected, protective behavior, not something gone wrong.
      //
      // The automatic path stays silent here and reports through the returned
      // `CommandResult` instead. It runs on every background refresh, so a toast
      // raised from inside the command would fire again on each pass for as long as
      // the condition lasts - and a file that cannot be recycled is left on disk on
      // purpose, so that condition lasts indefinitely. The caller in useLoadFiles
      // owns the one message the user sees for an unattended run.
      const genuineFailures = failed - skippedPaths.length
      if (!isAutomatic) {
        if (genuineFailures > 0) {
          if (errors.length === 1) {
            ctx.addToast(
              'warning',
              `Discarded ${succeeded}/${total} orphaned files. Error: ${errors[0]}`,
            )
          } else {
            ctx.addToast(
              'warning',
              `Discarded ${succeeded}/${total} orphaned files. ${errors.length} error(s)`,
            )
          }
        } else if (succeeded > 0) {
          ctx.addToast('success', `Discarded ${succeeded} orphaned file${succeeded > 1 ? 's' : ''}`)
        }
      }

      // A skip is worth telling the user about on either path, but the automatic path
      // runs on every background refresh and a file left on disk stays orphaned, so the
      // same skip recurs forever. Announce it only when the set of kept files changes.
      // With no active vault there is nothing to key the notice by, so it is not
      // deduplicated - reporting twice is the safe direction to fail here.
      //
      // The dedupe bookkeeping is read and written only on the automatic path - a
      // manual run always toasts and must not touch state that the automatic path
      // relies on to decide whether *its* next report is new. Recording under a
      // manual run would silence the automatic path's first genuine report of the
      // same set; likewise a manual run must never read (and be silenced by) a
      // signature the automatic path recorded. Mirrors the failure-signature block
      // below, which already gets this right.
      const skipNoticeKey = ctx.activeVaultId
      if (skippedPaths.length > 0) {
        const signature = [...skippedPaths].sort().join('\u0000')
        const alreadyReported =
          isAutomatic &&
          skipNoticeKey !== null &&
          lastAutomaticSkipSignatures.get(skipNoticeKey) === signature
        if (!alreadyReported) {
          ctx.addToast(
            'warning',
            `Kept ${skippedPaths.length} orphaned file${skippedPaths.length > 1 ? 's' : ''} on disk - could not move to the Recycle Bin`,
          )
        }
        if (isAutomatic && skipNoticeKey !== null) {
          lastAutomaticSkipSignatures.set(skipNoticeKey, signature)
        }
      } else if (isAutomatic && skipNoticeKey !== null) {
        lastAutomaticSkipSignatures.delete(skipNoticeKey)
      }

      // The automatic path's own toast is suppressed above unconditionally, which
      // means a genuine failure (e.g. a locked file) would otherwise never reach the
      // user at all, then retry silently on every refresh for as long as it lasts.
      // Mirrors the skip notice above: one warning per distinct failing set per
      // vault, not none and not one per refresh. User-initiated runs already get an
      // answer every time from the block above, so this only ever fires here for
      // isAutomatic.
      if (isAutomatic && skipNoticeKey !== null) {
        if (failedPaths.length > 0) {
          const signature = [...failedPaths].sort().join('\u0000')
          const alreadyReported = lastAutomaticFailureSignatures.get(skipNoticeKey) === signature
          if (!alreadyReported) {
            // Number morphology is language-specific, so this only selects which
            // pre-written form to use, never assembles one language's grammar for
            // another (see `_one`/`_other` pairs in `src/lib/i18n/locales/*.ts`).
            const suffix = failedPaths.length === 1 ? '_one' : '_other'
            ctx.addToast(
              'warning',
              t(`autoDiscard.failed.generic${suffix}`, { count: failedPaths.length }),
            )
          }
          lastAutomaticFailureSignatures.set(skipNoticeKey, signature)
        } else {
          lastAutomaticFailureSignatures.delete(skipNoticeKey)
        }

        // A batch that left every file behind, none genuinely failed, is the
        // UNC-vault signature: `shell.trashItem` fails for everything, so the whole
        // batch would otherwise retry - watcher stop included - on every refresh
        // with no progress possible. See AUTOMATIC_ALL_SKIPPED_COOLDOWN_MS.
        if (total > 0 && skippedPaths.length === total) {
          lastAutomaticAllSkippedAt.set(skipNoticeKey, Date.now())
        } else {
          lastAutomaticAllSkippedAt.delete(skipNoticeKey)
        }
      }

      logDiscardOrphaned('info', 'Discard orphaned operation complete', {
        operationId,
        total,
        succeeded,
        failed,
        skipped: skippedPaths.length,
        durationMs: Math.round(performance.now() - operationStart),
      })

      tracker.endOperation(failed === 0 ? 'completed' : 'failed', failed > 0 ? errors[0] : undefined)

      return {
        success: failed === 0,
        message:
          failed > 0
            ? `Discarded ${succeeded}/${total} orphaned files`
            : `Discarded ${succeeded} orphaned file${succeeded > 1 ? 's' : ''}`,
        total,
        succeeded,
        failed,
        skipped: skippedPaths.length > 0 ? skippedPaths.length : undefined,
        skippedPaths: skippedPaths.length > 0 ? skippedPaths : undefined,
        errors: errors.length > 0 ? errors : undefined,
        duration: batchResult.summary.duration,
      }
    } finally {
      releaseWatcher()
    }
  },
}
