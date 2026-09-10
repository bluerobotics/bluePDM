/**
 * Bulk Assembly Command Handlers
 *
 * Commands for performing bulk operations on assemblies and all their associated files:
 * - bulk-download-assembly: Download assembly + all children + drawings
 * - bulk-checkout-assembly: Checkout assembly + all children + drawings
 * - bulk-checkin-assembly: Checkin assembly + all children + drawings
 * - bulk-delete-assembly: Delete local copies of assembly + all children + drawings
 *
 * These commands use the assembly resolver to find all associated files,
 * then delegate to existing single-file command handlers.
 */

import type { Command, BulkAssemblyParams, CommandResult, LocalFile } from '../types'
import { ProgressTracker } from '../executor'
import {
  buildCanonicalFileMap,
  findCanonicalFileById,
  hasLocalContent,
  resolveAssociatedFiles,
} from '@/lib/fileOperations/assemblyResolver'
import { downloadCommand } from './download'
import { checkoutCommand } from './checkout'
import { checkinCommand } from './checkin'
import { deleteLocalCommand } from './delete'
import { log } from '@/lib/logger'
import { FileOperationTracker } from '../../fileOperationTracker'

/**
 * Logging helper for bulk assembly operations
 */
function logBulkAssembly(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  context: Record<string, unknown>,
): void {
  log[level]('[BulkAssembly]', message, context)
}

/**
 * Common validation for bulk assembly commands.
 * Checks auth, organization, file selection, and that the file is an assembly.
 */
function validateBulkAssemblyCommand(
  { files, rootFileId }: BulkAssemblyParams,
  ctx: Parameters<Command<BulkAssemblyParams>['validate']>[1],
  commandName: string,
): string | null {
  if (ctx.isOfflineMode) {
    return `Cannot ${commandName} while offline`
  }

  if (!ctx.user) {
    return 'Please sign in first'
  }

  if (!ctx.organization) {
    return 'No organization connected'
  }

  if (!files || files.length === 0) {
    return 'No files selected'
  }

  if (!rootFileId) {
    return 'No root assembly specified'
  }

  // Find the root file to verify it's an assembly. `findCanonicalFileById` matters here
  // specifically when the selection carries both a `'moved_away'` stub and its `'moved'`
  // partner for this id (a plain `.find()` would return whichever the array lists first) -
  // see `pickCanonicalLocalFile` for why the winner cannot be left to array order. A root that
  // resolves to nothing but an unpartnered stub is tolerated here, deliberately the same way a
  // cloud-only root already is: the root is just the anchor `resolveAssociatedFiles` looks
  // children up from, not something these three commands require local content for on its own
  // account - `hasLocalContent` in each `execute()` already excludes it from whichever
  // actionable set it would otherwise land in.
  const rootFile = findCanonicalFileById(files, rootFileId)
  if (!rootFile) {
    return 'Root assembly not found in selection'
  }

  if (!rootFile.name.toLowerCase().endsWith('.sldasm')) {
    return 'Selected file is not an assembly (.sldasm)'
  }

  return null
}

/**
 * Resolve all files associated with an assembly and convert to LocalFile array.
 * Returns files that exist in the local file map (ctx.files).
 */
async function resolveFilesForBulkOperation(
  rootFileId: string,
  ctx: Parameters<Command<BulkAssemblyParams>['execute']>[1],
  onProgress?: (message: string) => void,
): Promise<{
  files: LocalFile[]
  error: string | null
  stats: { total: number; children: number; drawings: number }
}> {
  const orgId = ctx.organization!.id

  // Build a Map from ctx.files for the resolver. `buildCanonicalFileMap` resolves an id shared
  // between a `'moved_away'` stub and its `'moved'` partner to the partner - a plain
  // `set(file.pdmData.id, file)` per row would let whichever one `ctx.files` lists last for
  // that id silently win, which could park the whole resolution (root included) on a stub with
  // nothing on disk while dropping the real file from the operation entirely.
  const filesMap = buildCanonicalFileMap(ctx.files)

  const result = await resolveAssociatedFiles(rootFileId, orgId, filesMap, onProgress)

  if (result.error) {
    return {
      files: [],
      error: result.error instanceof Error ? result.error.message : String(result.error),
      stats: { total: 0, children: 0, drawings: 0 },
    }
  }

  // Extract LocalFile objects from the result's allFiles Map
  const resolvedFiles: LocalFile[] = []
  for (const [, localFile] of result.allFiles) {
    resolvedFiles.push(localFile)
  }

  return {
    files: resolvedFiles,
    error: null,
    stats: {
      total: resolvedFiles.length,
      children: result.stats.totalChildren,
      drawings: result.stats.drawings,
    },
  }
}

// ============================================
// Bulk Download Assembly Command
// ============================================

export const bulkDownloadAssemblyCommand: Command<BulkAssemblyParams> = {
  id: 'bulk-download-assembly',
  name: 'Download Assembly',
  description: 'Download assembly and all associated files (children, drawings)',
  aliases: ['bulk-dl-asm'],
  usage: 'bulk-download-assembly <assembly-file>',

  validate(params, ctx) {
    return validateBulkAssemblyCommand(params, ctx, 'download assembly')
  },

  async execute({ files, rootFileId }, ctx): Promise<CommandResult> {
    const operationId = `bulk-download-assembly-${Date.now()}`

    logBulkAssembly('info', 'Starting bulk download assembly', {
      operationId,
      rootFileId,
      selectedFileCount: files.length,
    })

    // Initialize tracker
    const tracker = FileOperationTracker.start(
      'download',
      1, // Will update after resolution
      ['(resolving...)'],
    )

    // Create progress tracker for resolution phase
    const toastId = `bulk-download-${Date.now()}`
    const progress = new ProgressTracker(
      ctx,
      'bulk-download-assembly',
      toastId,
      'Resolving assembly files...',
      1,
    )

    // Resolve all associated files
    const {
      files: resolvedFiles,
      error,
      stats,
    } = await resolveFilesForBulkOperation(rootFileId, ctx, (msg) => progress.setStatus(msg))

    if (error) {
      logBulkAssembly('error', 'Failed to resolve assembly files', {
        operationId,
        rootFileId,
        error,
      })
      progress.finish()
      tracker.endOperation('failed', error)
      ctx.addToast('error', `Failed to resolve assembly: ${error}`)
      return {
        success: false,
        message: `Failed to resolve assembly: ${error}`,
        total: 0,
        succeeded: 0,
        failed: 1,
        errors: [error],
      }
    }

    logBulkAssembly('info', 'Resolved assembly files', {
      operationId,
      rootFileId,
      totalFiles: stats.total,
      children: stats.children,
      drawings: stats.drawings,
    })

    // Finish resolution progress
    progress.finish()

    // Filter to only cloud-only files (files that need downloading)
    const cloudOnlyFiles = resolvedFiles.filter((f) => f.diffStatus === 'cloud')

    if (cloudOnlyFiles.length === 0) {
      logBulkAssembly('info', 'All files already downloaded', { operationId })
      tracker.endOperation('completed')
      ctx.addToast('info', 'All assembly files are already downloaded')
      return {
        success: true,
        message: 'All assembly files are already downloaded',
        total: resolvedFiles.length,
        succeeded: resolvedFiles.length,
        failed: 0,
      }
    }

    tracker.endOperation('completed')

    // Delegate to download command
    logBulkAssembly('info', 'Delegating to download command', {
      operationId,
      cloudOnlyCount: cloudOnlyFiles.length,
    })

    return downloadCommand.execute({ files: cloudOnlyFiles }, ctx)
  },
}

// ============================================
// Bulk Checkout Assembly Command
// ============================================

export const bulkCheckoutAssemblyCommand: Command<BulkAssemblyParams> = {
  id: 'bulk-checkout-assembly',
  name: 'Check Out Assembly',
  description: 'Check out assembly and all associated files (children, drawings)',
  aliases: ['bulk-co-asm'],
  usage: 'bulk-checkout-assembly <assembly-file>',

  validate(params, ctx) {
    return validateBulkAssemblyCommand(params, ctx, 'check out assembly')
  },

  async execute({ files, rootFileId }, ctx): Promise<CommandResult> {
    const operationId = `bulk-checkout-assembly-${Date.now()}`

    logBulkAssembly('info', 'Starting bulk checkout assembly', {
      operationId,
      rootFileId,
      selectedFileCount: files.length,
    })

    // Initialize tracker
    const tracker = FileOperationTracker.start('checkout', 1, ['(resolving...)'])

    // Create progress tracker for resolution phase
    const toastId = `bulk-checkout-${Date.now()}`
    const progress = new ProgressTracker(
      ctx,
      'bulk-checkout-assembly',
      toastId,
      'Resolving assembly files...',
      1,
    )

    // Resolve all associated files
    const {
      files: resolvedFiles,
      error,
      stats,
    } = await resolveFilesForBulkOperation(rootFileId, ctx, (msg) => progress.setStatus(msg))

    if (error) {
      logBulkAssembly('error', 'Failed to resolve assembly files', {
        operationId,
        rootFileId,
        error,
      })
      progress.finish()
      tracker.endOperation('failed', error)
      ctx.addToast('error', `Failed to resolve assembly: ${error}`)
      return {
        success: false,
        message: `Failed to resolve assembly: ${error}`,
        total: 0,
        succeeded: 0,
        failed: 1,
        errors: [error],
      }
    }

    logBulkAssembly('info', 'Resolved assembly files', {
      operationId,
      rootFileId,
      totalFiles: stats.total,
      children: stats.children,
      drawings: stats.drawings,
    })

    // Finish resolution progress
    progress.finish()

    // Filter to files that can be checked out (synced, not already checked out, and actually
    // present on disk - `hasLocalContent` excludes a `'moved_away'` stub the same way it
    // excludes a cloud-only file, since checking one out would lock the server row for a path
    // with nothing behind it while the file that actually claimed it sits elsewhere unaffected)
    const checkoutableFiles = resolvedFiles.filter(
      (f) => f.pdmData?.id && !f.pdmData.checked_out_by && hasLocalContent(f),
    )

    if (checkoutableFiles.length === 0) {
      // Check why no files can be checked out
      const alreadyCheckedOut = resolvedFiles.filter(
        (f) => hasLocalContent(f) && f.pdmData?.checked_out_by,
      )
      const cloudOnly = resolvedFiles.filter((f) => f.diffStatus === 'cloud')

      let message = 'No files to check out'
      if (alreadyCheckedOut.length > 0) {
        message = `All ${alreadyCheckedOut.length} files are already checked out`
      } else if (cloudOnly.length > 0) {
        message = `${cloudOnly.length} files need to be downloaded first`
      }

      logBulkAssembly('info', message, { operationId })
      tracker.endOperation('completed')
      ctx.addToast('info', message)
      return {
        success: true,
        message,
        total: resolvedFiles.length,
        succeeded: 0,
        failed: 0,
      }
    }

    tracker.endOperation('completed')

    // Delegate to checkout command
    logBulkAssembly('info', 'Delegating to checkout command', {
      operationId,
      checkoutableCount: checkoutableFiles.length,
    })

    return checkoutCommand.execute({ files: checkoutableFiles }, ctx)
  },
}

// ============================================
// Bulk Checkin Assembly Command
// ============================================

export const bulkCheckinAssemblyCommand: Command<BulkAssemblyParams> = {
  id: 'bulk-checkin-assembly',
  name: 'Check In Assembly',
  description: 'Check in assembly and all associated files (children, drawings)',
  aliases: ['bulk-ci-asm'],
  usage: 'bulk-checkin-assembly <assembly-file>',

  validate(params, ctx) {
    const baseValidation = validateBulkAssemblyCommand(params, ctx, 'check in assembly')
    if (baseValidation) return baseValidation

    return null
  },

  async execute({ files, rootFileId }, ctx): Promise<CommandResult> {
    const operationId = `bulk-checkin-assembly-${Date.now()}`
    const userId = ctx.user!.id

    logBulkAssembly('info', 'Starting bulk checkin assembly', {
      operationId,
      rootFileId,
      selectedFileCount: files.length,
      userId,
    })

    // Initialize tracker
    const tracker = FileOperationTracker.start('checkin', 1, ['(resolving...)'])

    // Create progress tracker for resolution phase
    const toastId = `bulk-checkin-${Date.now()}`
    const progress = new ProgressTracker(
      ctx,
      'bulk-checkin-assembly',
      toastId,
      'Resolving assembly files...',
      1,
    )

    // Resolve all associated files
    const {
      files: resolvedFiles,
      error,
      stats,
    } = await resolveFilesForBulkOperation(rootFileId, ctx, (msg) => progress.setStatus(msg))

    if (error) {
      logBulkAssembly('error', 'Failed to resolve assembly files', {
        operationId,
        rootFileId,
        error,
      })
      progress.finish()
      tracker.endOperation('failed', error)
      ctx.addToast('error', `Failed to resolve assembly: ${error}`)
      return {
        success: false,
        message: `Failed to resolve assembly: ${error}`,
        total: 0,
        succeeded: 0,
        failed: 1,
        errors: [error],
      }
    }

    logBulkAssembly('info', 'Resolved assembly files', {
      operationId,
      rootFileId,
      totalFiles: stats.total,
      children: stats.children,
      drawings: stats.drawings,
    })

    // Finish resolution progress
    progress.finish()

    // Filter to files checked out by the current user and actually present on disk -
    // `hasLocalContent` excludes a `'moved_away'` stub, which has nothing at its own path to
    // upload even when it shares the real file's checkout state
    const checkinableFiles = resolvedFiles.filter(
      (f) => f.pdmData?.id && f.pdmData.checked_out_by === userId && hasLocalContent(f),
    )

    if (checkinableFiles.length === 0) {
      // Provide helpful feedback
      const checkedOutByOthers = resolvedFiles.filter(
        (f) => f.pdmData?.checked_out_by && f.pdmData.checked_out_by !== userId,
      )
      const notCheckedOut = resolvedFiles.filter((f) => !f.pdmData?.checked_out_by)

      let message = 'No files to check in'
      if (checkedOutByOthers.length > 0) {
        message = `${checkedOutByOthers.length} files are checked out by other users`
      } else if (notCheckedOut.length > 0) {
        message = `No files are checked out by you`
      }

      logBulkAssembly('info', message, { operationId })
      tracker.endOperation('completed')
      ctx.addToast('info', message)
      return {
        success: true,
        message,
        total: resolvedFiles.length,
        succeeded: 0,
        failed: 0,
      }
    }

    tracker.endOperation('completed')

    // Delegate to checkin command
    logBulkAssembly('info', 'Delegating to checkin command', {
      operationId,
      checkinableCount: checkinableFiles.length,
    })

    return checkinCommand.execute({ files: checkinableFiles }, ctx)
  },
}

// ============================================
// Bulk Delete Assembly Command
// ============================================

export const bulkDeleteAssemblyCommand: Command<BulkAssemblyParams> = {
  id: 'bulk-delete-assembly',
  name: 'Remove Local Assembly',
  description: 'Remove local copies of assembly and all associated files (children, drawings)',
  aliases: ['bulk-rm-asm'],
  usage: 'bulk-delete-assembly <assembly-file>',

  validate(params, _ctx) {
    // Delete can work offline (local files only)
    if (!params.files || params.files.length === 0) {
      return 'No files selected'
    }

    if (!params.rootFileId) {
      return 'No root assembly specified'
    }

    // Find the root file to verify it's an assembly - see the sibling lookup in
    // `validateBulkAssemblyCommand` for why a plain `.find()` by id is not safe here.
    const rootFile = findCanonicalFileById(params.files, params.rootFileId)
    if (!rootFile) {
      return 'Root assembly not found in selection'
    }

    if (!rootFile.name.toLowerCase().endsWith('.sldasm')) {
      return 'Selected file is not an assembly (.sldasm)'
    }

    return null
  },

  async execute({ files, rootFileId }, ctx): Promise<CommandResult> {
    const operationId = `bulk-delete-assembly-${Date.now()}`

    logBulkAssembly('info', 'Starting bulk delete assembly', {
      operationId,
      rootFileId,
      selectedFileCount: files.length,
    })

    // Initialize tracker
    const tracker = FileOperationTracker.start('delete', 1, ['(resolving...)'])

    // Create progress tracker for resolution phase
    const toastId = `bulk-delete-${Date.now()}`
    const progress = new ProgressTracker(
      ctx,
      'bulk-delete-assembly',
      toastId,
      'Resolving assembly files...',
      1,
    )

    // For delete, we need to handle the case where organization might be null (offline)
    // But we still need the org ID for the resolver
    if (!ctx.organization?.id) {
      progress.finish()
      tracker.endOperation('failed', 'No organization connected')
      ctx.addToast('error', 'No organization connected')
      return {
        success: false,
        message: 'No organization connected',
        total: 0,
        succeeded: 0,
        failed: 1,
        errors: ['No organization connected'],
      }
    }

    // Resolve all associated files
    const {
      files: resolvedFiles,
      error,
      stats,
    } = await resolveFilesForBulkOperation(rootFileId, ctx, (msg) => progress.setStatus(msg))

    if (error) {
      logBulkAssembly('error', 'Failed to resolve assembly files', {
        operationId,
        rootFileId,
        error,
      })
      progress.finish()
      tracker.endOperation('failed', error)
      ctx.addToast('error', `Failed to resolve assembly: ${error}`)
      return {
        success: false,
        message: `Failed to resolve assembly: ${error}`,
        total: 0,
        succeeded: 0,
        failed: 1,
        errors: [error],
      }
    }

    logBulkAssembly('info', 'Resolved assembly files', {
      operationId,
      rootFileId,
      totalFiles: stats.total,
      children: stats.children,
      drawings: stats.drawings,
    })

    // Finish resolution progress
    progress.finish()

    // Filter to files that exist locally (not cloud-only, and not a 'moved_away' stub with
    // nothing at its own path to remove - `deleteLocalCommand` already excludes both via
    // `getSyncedFilesFromSelection`/`getUnsyncedFilesFromSelection`, but filtering here too
    // keeps this command's own counts and toasts accurate rather than relying on that)
    const localFiles = resolvedFiles.filter((f) => hasLocalContent(f))

    if (localFiles.length === 0) {
      logBulkAssembly('info', 'No local files to delete', { operationId })
      tracker.endOperation('completed')
      ctx.addToast('info', 'No local files to remove')
      return {
        success: true,
        message: 'No local files to remove',
        total: resolvedFiles.length,
        succeeded: 0,
        failed: 0,
      }
    }

    // Note: We intentionally do NOT check checkout status here.
    // Checkout status is about server-side locking for editing - it's irrelevant
    // for deleting local copies. The base delete-local command handles this correctly.

    tracker.endOperation('completed')

    // Delegate to delete-local command
    logBulkAssembly('info', 'Delegating to delete-local command', {
      operationId,
      localFileCount: localFiles.length,
    })

    return deleteLocalCommand.execute({ files: localFiles }, ctx)
  },
}
