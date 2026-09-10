/**
 * Force Release Command (Admin Only)
 *
 * Immediately release the checkout lock on files checked out by others.
 * The server version stays as-is, user's local changes are orphaned.
 */

import type { Command, ForceReleaseParams, CommandResult } from '../types'
import { getSyncedFilesFromSelection } from '../types'
import { adminForceDiscardCheckout } from '../../supabase'
import { processWithConcurrency, CONCURRENT_OPERATIONS } from '../../concurrency'
import { FileOperationTracker } from '../../fileOperationTracker'

export const forceReleaseCommand: Command<ForceReleaseParams> = {
  id: 'force-release',
  name: 'Force Release',
  description: 'Admin: Force release checkout lock on files checked out by others',
  aliases: ['force-unlock'],
  usage: 'force-release <path>',

  validate({ files }, ctx) {
    if (ctx.isOfflineMode) {
      return 'Cannot force release checkouts while offline'
    }

    if (!ctx.user) {
      return 'Please sign in first'
    }

    if (ctx.getEffectiveRole() !== 'admin') {
      return 'Admin privileges required'
    }

    if (!files || files.length === 0) {
      return 'No files selected'
    }

    // Get files checked out by others
    const syncedFiles = getSyncedFilesFromSelection(ctx.files, files)
    const checkedOutByOthers = syncedFiles.filter(
      (f) => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== ctx.user?.id,
    )

    if (checkedOutByOthers.length === 0) {
      return 'No files checked out by others'
    }

    return null
  },

  async execute({ files }, ctx): Promise<CommandResult> {
    const user = ctx.user!

    // Get files checked out by others (for tracker initialization)
    const syncedFilesForTracker = getSyncedFilesFromSelection(ctx.files, files)
    const filesToReleaseForTracker = syncedFilesForTracker.filter(
      (f) => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== user.id,
    )

    // Initialize file operation tracker for DevTools monitoring
    const tracker = FileOperationTracker.start(
      'force-release',
      filesToReleaseForTracker.length,
      filesToReleaseForTracker.map((f) => f.relativePath),
    )

    // Get files checked out by others
    const syncedFiles = getSyncedFilesFromSelection(ctx.files, files)
    const filesToRelease = syncedFiles.filter(
      (f) => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== user.id,
    )

    if (filesToRelease.length === 0) {
      tracker.endOperation('completed')
      return {
        success: true,
        message: 'No files to force release',
        total: 0,
        succeeded: 0,
        failed: 0,
      }
    }

    // Progress tracking
    const toastId = `force-release-${Date.now()}`
    const total = filesToRelease.length
    const startTime = Date.now()

    ctx.addProgressToast(
      toastId,
      `Force releasing ${total} checkout${total > 1 ? 's' : ''}...`,
      total,
    )

    let completedCount = 0

    const updateProgress = () => {
      completedCount++
      const percent = Math.round((completedCount / total) * 100)
      ctx.updateProgressToast(
        toastId,
        completedCount,
        percent,
        undefined,
        `${completedCount}/${total}`,
      )
    }

    let succeeded = 0
    let failed = 0
    const errors: string[] = []

    // Process all files in parallel, collect updates for batch store update
    const pendingUpdates: Array<{
      path: string
      updates: Parameters<typeof ctx.updateFileInStore>[1]
    }> = []

    // Start tracking the release phase
    const releaseStepId = tracker.startStep('Force release checkouts', {
      fileCount: filesToRelease.length,
      concurrency: CONCURRENT_OPERATIONS,
    })
    const releasePhaseStart = Date.now()

    const results = await processWithConcurrency(
      filesToRelease,
      CONCURRENT_OPERATIONS,
      async (file) => {
        try {
          const result = await adminForceDiscardCheckout(file.pdmData!.id, user.id)

          if (result.success) {
            // Queue update for batch processing
            pendingUpdates.push({
              path: file.path,
              updates: {
                pdmData: {
                  ...file.pdmData!,
                  checked_out_by: null,
                  checked_out_user: null,
                  // adminForceDiscardCheckout clears the snapshot server-side, so the
                  // store copy must go too - a released file that keeps one would let a
                  // later discard restore a path from a lock that no longer exists.
                  checked_out_file_path: null,
                  checked_out_file_name: null,
                },
              },
            })

            updateProgress()
            return { success: true }
          } else {
            updateProgress()
            return { success: false, error: result.error || 'Force release failed' }
          }
        } catch (error) {
          updateProgress()
          const errorMsg = error instanceof Error ? error.message : 'Unknown error'
          return { success: false, error: `${file.name}: ${errorMsg}` }
        }
      },
    )

    // Count results
    for (const result of results) {
      if (result.success) {
        succeeded++
      } else {
        failed++
        if (result.error) {
          errors.push(result.error)
        }
      }
    }

    // End release step
    tracker.endStep(releaseStepId, 'completed', {
      succeeded,
      failed,
      durationMs: Date.now() - releasePhaseStart,
    })

    // Apply all store updates in a single atomic batch
    const storeUpdateStepId = tracker.startStep('Atomic store update', {
      updateCount: pendingUpdates.length,
    })
    const storeUpdateStart = performance.now()
    if (pendingUpdates.length > 0) {
      ctx.updateFilesAndClearProcessing(pendingUpdates, [])
    }
    ctx.setLastOperationCompletedAt(Date.now())
    const storeUpdateDuration = Math.round(performance.now() - storeUpdateStart)
    tracker.endStep(storeUpdateStepId, 'completed', { durationMs: storeUpdateDuration })
    window.electronAPI?.log('info', '[ForceRelease] Store update complete', {
      durationMs: storeUpdateDuration,
      updateCount: pendingUpdates.length,
      timestamp: Date.now(),
    })

    // Clean up
    ctx.removeToast(toastId)

    const duration = Date.now() - startTime

    // Note: No ctx.onRefresh() call needed - the incremental store updates
    // via ctx.updateFilesInStore(pendingUpdates) are sufficient.
    // This avoids a redundant full filesystem rescan.

    // Show result toast
    if (failed > 0) {
      ctx.addToast('warning', `Force released ${succeeded}/${total} checkouts (${failed} failed)`)
    } else {
      ctx.addToast('success', `Force released ${succeeded} checkout${succeeded > 1 ? 's' : ''}`)
    }

    // Complete operation tracking
    tracker.endOperation(failed === 0 ? 'completed' : 'failed', failed > 0 ? errors[0] : undefined)

    return {
      success: failed === 0,
      message:
        failed > 0
          ? `Force released ${succeeded}/${total} checkouts`
          : `Force released ${succeeded} checkout${succeeded > 1 ? 's' : ''}`,
      total,
      succeeded,
      failed,
      errors: errors.length > 0 ? errors : undefined,
      duration,
    }
  },
}
