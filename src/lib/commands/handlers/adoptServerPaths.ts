/**
 * Adopt Server Paths Command
 *
 * The inverse of `reconcile-moved-paths`. That command commits a local rename to the server;
 * this one undoes an unwanted one on disk. A file marked `diffStatus === 'moved'` sits at a local
 * path that no longer matches its server row - an accidental rename, a Windows Explorer rename,
 * or an in-app rename whose background server write failed. `reconcile-moved-paths` would
 * propagate that mistake to the server and from there to every other user; this command instead
 * renames the local file back to the path the server already records, so the disk agrees with
 * the vault everyone else sees.
 *
 * It writes to exactly two things: the local filesystem (`window.electronAPI.renameItem`) and the
 * local sync index. Nothing here calls the server. `files.file_path` and `folders` are untouched -
 * they were already correct, which is the whole reason this command exists.
 *
 * Built with the same refusal-first posture as `reconcile-moved-paths`:
 *
 * - Nothing is written unless the caller passes `apply`. Every other entry performs the
 *   pre-flight and reports.
 * - A target held by another user's checkout is safe to rename - it only touches this user's own
 *   disk - but is still held back and named unless `force` opts in.
 * - The write path requires a confirmation dialog. No dialog available means no write.
 * - Every write is one rename, so a run that stops halfway leaves complete files behind it and
 *   untouched files in front of it. Running it again finishes the job.
 * - The summary reports succeeded, failed, skipped and blocked separately, and only reports
 *   success when nothing was left over.
 */

import { log } from '@/lib/logger'
import { t } from '@/lib/i18n'
import { usePDMStore } from '@/stores/pdmStore'

import { beginWatcherSuppression } from '../../fileWatcherSuppression'
import { addToSyncIndex, removeFromSyncIndex, updateInodes } from '../../cache/localSyncIndex'
import { getOrphanedDirectoryCandidates } from '../../orphanedDirectories'
import { processWithConcurrency, CONCURRENT_OPERATIONS } from '../../concurrency'
import { executeCommand } from '../executor'
import type { ParsedCommand, TerminalOutput } from '../parser'
import { registerTerminalCommand } from '../registry'
import type {
  AdoptServerPathsParams,
  Command,
  CommandContext,
  CommandResult,
} from '../types'
import { buildFullPath, getParentDir } from '../types'

import {
  classifyAdoptTargets,
  type AdoptServerPathsPreflight,
  type AdoptTarget,
  type BlockedAdoptHolder,
} from './adoptServerPathsPreflight'

/** Paths named individually in the report's conflict and unverified sections. */
const REPORTED_PATH_LIMIT = 20

/** Failures named individually in the result before they collapse to a count. */
const REPORTED_FAILURE_LIMIT = 10

function logAdopt(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  context: Record<string, unknown>,
): void {
  log[level]('[AdoptServerPaths]', message, context)
}

function holderLabel(holder: BlockedAdoptHolder): string {
  return t('adoptServerPaths.reportHolder', {
    count: holder.count,
    user: holder.holderName ?? t('adoptServerPaths.unknownHolder'),
  })
}

/**
 * `local/path/name.sldprt → server/path/name.sldprt`, one per file that will be renamed on disk.
 *
 * Every one of them, not a sample - the dialog renders the first few and reports the rest as a
 * count, so truncating here would understate what is about to happen.
 */
function pathChangeItems(targets: AdoptTarget[]): string[] {
  return targets.map((target) =>
    t('adoptServerPaths.reportItem', { from: target.localPath, to: target.serverPath }),
  )
}

/** The remainder a confirmed run will deliberately leave behind, as one clause. */
function describeRemainder(preflight: AdoptServerPathsPreflight, forcing: boolean): string | null {
  const parts: string[] = []

  if (preflight.blocked.length > 0 && !forcing) {
    parts.push(t('adoptServerPaths.summaryBlocked', { count: preflight.blocked.length }))
  }
  if (preflight.skipped.length > 0) {
    parts.push(t('adoptServerPaths.summarySkipped', { count: preflight.skipped.length }))
  }

  if (parts.length === 0) return null

  const leftoverCount = (forcing ? 0 : preflight.blocked.length) + preflight.skipped.length
  return t('adoptServerPaths.confirmRemainder', { count: leftoverCount, detail: parts.join(', ') })
}

/**
 * The pre-flight in prose. This is the dry run's entire output and the confirmation's body, so
 * the two can never disagree about what a run would do.
 */
function describePreflight(preflight: AdoptServerPathsPreflight): string[] {
  const lines = [t('adoptServerPaths.reportHeading', { count: preflight.total })]

  lines.push(t('adoptServerPaths.reportEligible', { count: preflight.eligible.length }))

  if (preflight.blocked.length > 0) {
    lines.push(t('adoptServerPaths.reportBlocked', { count: preflight.blocked.length }))
    for (const holder of preflight.holders) {
      lines.push(`  ${holderLabel(holder)}`)
    }
  }

  const conflicts = preflight.skipped.filter((target) => target.reason === 'conflict')
  if (conflicts.length > 0) {
    lines.push(t('adoptServerPaths.reportConflict', { count: conflicts.length }))
    for (const target of conflicts.slice(0, REPORTED_PATH_LIMIT)) {
      lines.push(`  ${target.serverPath}`)
    }
  }

  const unverified = preflight.skipped.filter((target) => target.reason === 'unverified')
  if (unverified.length > 0) {
    lines.push(t('adoptServerPaths.reportUnverified', { count: unverified.length }))
    for (const target of unverified.slice(0, REPORTED_PATH_LIMIT)) {
      lines.push(`  ${target.serverPath}`)
    }
  }

  return lines
}

/** Nothing was written, and the result says which of the four buckets everything landed in. */
function reportOnly(
  preflight: AdoptServerPathsPreflight,
  message: string,
  success: boolean,
): CommandResult {
  return {
    success,
    message,
    total: preflight.total,
    succeeded: 0,
    failed: 0,
    details: describePreflight(preflight),
  }
}

export const adoptServerPathsCommand: Command<AdoptServerPathsParams> = {
  id: 'adopt-server-paths',
  name: 'Adopt Server Paths',
  description:
    'Rename locally moved or renamed files back to the path the server still records for them (the inverse of reconcile-moved-paths)',
  aliases: ['adopt-paths'],
  usage: 'adopt-server-paths [--apply] [--force]',

  validate(_params, ctx) {
    if (!ctx.user) {
      return t('adoptServerPaths.notSignedIn')
    }

    if (!ctx.vaultPath || !ctx.activeVaultId) {
      return t('adoptServerPaths.noVault')
    }

    const preflight = classifyAdoptTargets({ files: ctx.files, userId: ctx.user.id })

    if (preflight.total === 0) {
      return t('adoptServerPaths.nothingToAdopt')
    }

    return null
  },

  async execute({ apply, force }, ctx): Promise<CommandResult> {
    const user = ctx.user!
    const vaultPath = ctx.vaultPath!
    const startedAt = Date.now()

    const preflight = classifyAdoptTargets({ files: ctx.files, userId: user.id })

    logAdopt('info', 'Pre-flight complete', {
      total: preflight.total,
      eligible: preflight.eligible.length,
      blocked: preflight.blocked.length,
      skipped: preflight.skipped.length,
      holders: preflight.holders.length,
      apply: apply === true,
      force: force === true,
    })

    // The default. A caller that has not asked for the write path in as many words gets the report.
    if (!apply) {
      return reportOnly(
        preflight,
        t('adoptServerPaths.dryRunSummary', {
          eligible: preflight.eligible.length,
          total: preflight.total,
        }),
        true,
      )
    }

    // Unlike reconcile, a held target is always *safe* to act on - the rename never touches
    // another user's data. It is refused by default anyway because the checkout is evidence a
    // move might already be in flight elsewhere, and the operator should see that before acting.
    if (preflight.blocked.length > 0 && !force) {
      const holders = preflight.holders.map(holderLabel).join(', ')
      const message = t('adoptServerPaths.refused', {
        count: preflight.blocked.length,
        holders,
      })

      logAdopt('warn', 'Refused: targets are checked out by other users', {
        blocked: preflight.blocked.length,
        holderCount: preflight.holders.length,
      })
      ctx.addToast('warning', message)

      return reportOnly(preflight, message, false)
    }

    const targets = force ? [...preflight.eligible, ...preflight.blocked] : preflight.eligible

    if (targets.length === 0) {
      const message = t('adoptServerPaths.nothingEligible', {
        skipped: preflight.skipped.length,
      })
      ctx.addToast('warning', message)
      return reportOnly(preflight, message, false)
    }

    // Property, not politeness: this command does not write without a stated confirmation. A
    // caller with no dialog to offer gets the report instead.
    if (!ctx.confirm) {
      logAdopt('warn', 'Refused: no confirmation dialog available', {
        eligible: targets.length,
      })
      return reportOnly(preflight, t('adoptServerPaths.confirmUnavailable'), false)
    }

    // One paragraph, because the dialog renders the message as one and a report joined with
    // newlines would arrive as a run-on sentence.
    const remainder = describeRemainder(preflight, force === true)
    const confirmed = await ctx.confirm({
      title: t('adoptServerPaths.confirmTitle', { count: targets.length }),
      message: [
        t('adoptServerPaths.confirmMessage', { count: targets.length }),
        remainder,
      ]
        .filter(Boolean)
        .join(' '),
      items: pathChangeItems(targets),
      confirmText: t('adoptServerPaths.confirmText', { count: targets.length }),
    })

    if (!confirmed) {
      logAdopt('info', 'User declined the adopt', { eligible: targets.length })
      return reportOnly(preflight, t('adoptServerPaths.declined'), false)
    }

    return writeAdoptedPaths(targets, preflight, ctx, vaultPath, startedAt, force === true)
  },
}

interface RenameOutcome {
  target: AdoptTarget
  success: boolean
  error?: string
}

/**
 * Rename one file back to its server path, creating intermediate directories as needed. Never
 * overwrites - a live check immediately before the rename catches a stray file the pre-flight's
 * loaded-rows view could not see (untracked, ignored, or created after the pre-flight ran).
 */
async function renameOneTarget(target: AdoptTarget, vaultPath: string): Promise<RenameOutcome> {
  const destinationPath = buildFullPath(vaultPath, target.serverPath)

  const alreadyOccupied = await window.electronAPI?.fileExists(destinationPath)
  if (alreadyOccupied) {
    logAdopt('warn', 'Refused: destination appeared on disk since the pre-flight ran', {
      path: target.path,
      destinationPath,
    })
    return {
      target,
      success: false,
      error: t('adoptServerPaths.destinationAppeared', { path: target.serverPath }),
    }
  }

  const parentDir = getParentDir(destinationPath)
  const mkdirResult = await window.electronAPI?.createFolder(parentDir)
  if (mkdirResult?.success === false) {
    logAdopt('error', 'Failed to create destination directory', {
      path: target.path,
      parentDir,
      error: mkdirResult.error,
    })
    return {
      target,
      success: false,
      error: t('adoptServerPaths.createFolderFailed', { error: mkdirResult.error ?? '' }),
    }
  }

  const renameResult = await window.electronAPI?.renameItem(target.path, destinationPath)
  if (!renameResult?.success) {
    logAdopt('error', 'Failed to rename file to its server path', {
      path: target.path,
      destinationPath,
      error: renameResult?.error,
    })
    return {
      target,
      success: false,
      error: renameResult?.error || t('adoptServerPaths.unknownError'),
    }
  }

  logAdopt('info', 'Renamed file back to its server path', {
    from: target.localPath,
    to: target.serverPath,
  })

  return { target, success: true }
}

/**
 * The write. Separated from the decision so that everything above this line is reasoning about
 * what to do, and everything below it is doing exactly what was confirmed.
 */
async function writeAdoptedPaths(
  targets: AdoptTarget[],
  preflight: AdoptServerPathsPreflight,
  ctx: CommandContext,
  vaultPath: string,
  startedAt: number,
  forcing: boolean,
): Promise<CommandResult> {
  const toastId = `adopt-server-paths-${Date.now()}`
  // Forcing moves the held targets into `targets` above, so their outcome is already reflected
  // in `succeeded`/`failed` below. Counting them again here as a leftover would report a file
  // this very run just renamed as still checked out and untouched.
  const remainingBlocked = forcing ? 0 : preflight.blocked.length

  // Suppress the watcher for every path this run touches - both the path a file leaves and the
  // one it lands on - so the renames below do not read back as external changes and trigger a
  // full vault reload mid-run.
  const suppressedPaths = targets.flatMap((target) => [target.localPath, target.serverPath])
  const releaseWatcher = beginWatcherSuppression(suppressedPaths, ctx)

  ctx.addProgressToast(toastId, t('adoptServerPaths.progress', { count: targets.length }), targets.length)

  logAdopt('info', 'Renaming files to their server paths', {
    count: targets.length,
    concurrency: CONCURRENT_OPERATIONS,
  })

  let cancelled = false

  try {
    const outcomes = await processWithConcurrency(
      targets,
      CONCURRENT_OPERATIONS,
      async (target) => {
        if (cancelled || ctx.isProgressToastCancelled(toastId)) {
          cancelled = true
          return { target, success: false, error: undefined } as RenameOutcome
        }
        return renameOneTarget(target, vaultPath)
      },
      {
        onItemComplete: (completed, total) => {
          ctx.updateProgressToast(
            toastId,
            completed,
            Math.round((completed / total) * 100),
            undefined,
            `${completed}/${total}`,
          )
        },
      },
    )

    const succeeded = outcomes.filter((o) => o.success).map((o) => o.target)
    const notAttempted = cancelled ? outcomes.filter((o) => !o.success && !o.error).length : 0
    const failures = outcomes.filter((o) => !o.success && o.error)

    applyAdoptedPathsToStore(succeeded, ctx, vaultPath)
    await reKeySyncIndexAfterAdopt(succeeded, ctx)
    const { directoriesRemoved, directoriesKept } = await removeEmptiedSourceDirectories(
      succeeded,
      ctx,
      vaultPath,
    )

    const message = summarize(
      preflight,
      remainingBlocked,
      succeeded.length,
      failures.length,
      notAttempted,
    )
    const errors = failures.slice(0, REPORTED_FAILURE_LIMIT).map(({ target, error }) =>
      t('adoptServerPaths.failureItem', {
        path: target.localPath,
        error: error ?? t('adoptServerPaths.unknownError'),
      }),
    )
    if (failures.length > REPORTED_FAILURE_LIMIT) {
      errors.push(
        t('adoptServerPaths.reportAndMore', { count: failures.length - REPORTED_FAILURE_LIMIT }),
      )
    }

    const complete =
      failures.length === 0 &&
      notAttempted === 0 &&
      remainingBlocked === 0 &&
      preflight.skipped.length === 0

    logAdopt(failures.length > 0 ? 'warn' : 'info', 'Adopt finished', {
      succeeded: succeeded.length,
      failed: failures.length,
      notAttempted,
      blocked: remainingBlocked,
      forced: forcing,
      skipped: preflight.skipped.length,
      directoriesRemoved,
      directoriesKept,
      durationMs: Date.now() - startedAt,
    })

    ctx.addToast(complete ? 'success' : 'warning', message)
    ctx.onRefresh?.()

    return {
      success: complete,
      message,
      total: preflight.total,
      succeeded: succeeded.length,
      failed: failures.length,
      details: describePreflight(preflight),
      errors: errors.length > 0 ? errors : undefined,
      directoriesRemoved: directoriesRemoved > 0 ? directoriesRemoved : undefined,
      directoriesKept: directoriesKept > 0 ? directoriesKept : undefined,
      duration: Date.now() - startedAt,
    }
  } finally {
    ctx.removeToast(toastId)
    releaseWatcher()
  }
}

/**
 * Patch the rows that were renamed so they stop rendering as moved before the next load. The
 * physical rename already made this cosmetic - a re-run would find nothing left to adopt either
 * way - but a badge that outlives the fix reads as a fix that did not work.
 */
function applyAdoptedPathsToStore(
  succeeded: AdoptTarget[],
  ctx: CommandContext,
  vaultPath: string,
): void {
  for (const target of succeeded) {
    const destinationPath = buildFullPath(vaultPath, target.serverPath)
    ctx.renameFileInStore(target.path, destinationPath, target.serverPath, true)
    ctx.updateFilesInStore([
      {
        path: destinationPath,
        // Only the path diverged, and it no longer does: the pre-flight skips any file whose
        // content disagrees with the row, so there is nothing else left for this row to be.
        updates: { diffStatus: undefined },
      },
    ])
  }
}

/**
 * Re-key the sync index so the move does not re-arm on the next load.
 *
 * Two entries have to change:
 * - The path the file left (`target.localPath`) carried the `localOnly` flag
 *   (`useLoadFiles.ts:1774`) and, if the file had an inode, its own inode pin. Both are cleared
 *   by dropping the entry outright - there is nothing left at that path for either to describe.
 * - The path the file landed on (`target.serverPath`) already carried an inode pin re-added on
 *   every load specifically to keep the move detectable (`useLoadFiles.ts:1786`). `addToSyncIndex`
 *   overwrites the whole record rather than merging into it, so calling it here wipes that pin
 *   before `updateInodes` immediately below writes the correct one back - matching how
 *   `discardRestorePath.ts` re-keys a restored checkout path.
 */
async function reKeySyncIndexAfterAdopt(succeeded: AdoptTarget[], ctx: CommandContext): Promise<void> {
  if (succeeded.length === 0 || !ctx.activeVaultId) return

  const vaultId = ctx.activeVaultId

  try {
    await removeFromSyncIndex(vaultId, succeeded.map((target) => target.localPath))
  } catch (error) {
    logAdopt('warn', 'Failed to drop the vacated paths from the sync index', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  try {
    await addToSyncIndex(vaultId, succeeded.map((target) => target.serverPath))
  } catch (error) {
    logAdopt('warn', 'Failed to mark the adopted paths as synced', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const inodeEntries = succeeded
    .filter((target) => typeof target.ino === 'number' && target.ino > 0)
    .map((target) => ({
      path: target.serverPath,
      ino: target.ino as number,
      localVersion: target.localVersion,
      localHash: target.localHash,
    }))

  if (inodeEntries.length === 0) return

  try {
    await updateInodes(vaultId, inodeEntries)
  } catch (error) {
    logAdopt('warn', 'Failed to refresh inodes for the adopted paths', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Recycle whatever directories the renames above just emptied - the common case for a folder
 * rename, where every file in it moves out at once. Never a custom directory removal: the 4.3.2
 * handler re-confirms emptiness with an unfiltered `readdirSync` immediately before recycling and
 * never falls back to a permanent delete.
 */
async function removeEmptiedSourceDirectories(
  succeeded: AdoptTarget[],
  ctx: CommandContext,
  vaultPath: string,
): Promise<{ directoriesRemoved: number; directoriesKept: number }> {
  if (succeeded.length === 0 || !window.electronAPI?.trashEmptyDirs) {
    return { directoriesRemoved: 0, directoriesKept: 0 }
  }

  const { serverFolderPaths } = usePDMStore.getState()
  const candidates = getOrphanedDirectoryCandidates({
    succeededRelativePaths: succeeded.map((target) => target.localPath),
    // Nothing is "kept" here in the discard sense - every rename in `succeeded` left its source
    // path empty by definition - so the ancestor-still-has-content pruning has nothing to prune.
    keptRelativePaths: [],
    serverFolderPaths,
    vaultPath,
  })

  if (candidates.length === 0) return { directoriesRemoved: 0, directoriesKept: 0 }

  try {
    const result = await window.electronAPI.trashEmptyDirs(candidates)
    const removed = result.results.filter((r) => r.success).map((r) => r.path)
    if (removed.length > 0) {
      ctx.removeFilesFromStore(removed)
    }
    return {
      directoriesRemoved: removed.length,
      directoriesKept: result.results.length - removed.length,
    }
  } catch (error) {
    logAdopt('warn', 'Failed to recycle directories emptied by the adopt', {
      error: error instanceof Error ? error.message : String(error),
      candidateCount: candidates.length,
    })
    return { directoriesRemoved: 0, directoriesKept: candidates.length }
  }
}

/**
 * One sentence that cannot be mistaken for a clean run when it was not one. A count of successes
 * on its own reads as success; the leftovers have to be in the same sentence.
 */
function summarize(
  preflight: AdoptServerPathsPreflight,
  remainingBlocked: number,
  succeeded: number,
  failed: number,
  notAttempted: number,
): string {
  const leftovers: string[] = []

  if (failed > 0) leftovers.push(t('adoptServerPaths.summaryFailed', { count: failed }))
  if (notAttempted > 0) {
    leftovers.push(t('adoptServerPaths.summaryNotAttempted', { count: notAttempted }))
  }
  if (remainingBlocked > 0) {
    leftovers.push(t('adoptServerPaths.summaryBlocked', { count: remainingBlocked }))
  }
  if (preflight.skipped.length > 0) {
    leftovers.push(t('adoptServerPaths.summarySkipped', { count: preflight.skipped.length }))
  }

  if (leftovers.length === 0) {
    return t('adoptServerPaths.summaryComplete', { count: succeeded })
  }

  return t('adoptServerPaths.summaryPartial', {
    succeeded,
    total: preflight.total,
    leftovers: leftovers.join(', '),
  })
}

// ============================================
// Terminal entry point
// ============================================

/**
 * The only way a user can start this today, and it reports by default: without `--apply` it runs
 * the pre-flight and prints it. Same order as `reconcile-moved-paths` - read the dry run against
 * the real vault, then ask for the write.
 */
registerTerminalCommand(
  {
    aliases: ['adopt-server-paths', 'adopt-paths'],
    description:
      'Report, and with --apply commit, renaming locally moved files back to the paths their server records still hold',
    usage: 'adopt-server-paths [--apply] [--force]',
    examples: ['adopt-server-paths', 'adopt-server-paths --apply', 'adopt-server-paths --apply --force'],
    category: 'admin',
  },
  async (parsed: ParsedCommand, _files, addOutput, onRefresh) => {
    const apply = parsed.flags.apply === true
    const force = parsed.flags.force === true

    if (!apply) {
      addOutput('info', t('adoptServerPaths.dryRunNote'))
    }

    const result = await executeCommand('adopt-server-paths', { apply, force }, { onRefresh })

    printResult(result, addOutput)
  },
)

function printResult(
  result: CommandResult,
  addOutput: (type: TerminalOutput['type'], content: string) => void,
): void {
  for (const line of result.details ?? []) {
    addOutput('output', line)
  }

  for (const error of result.errors ?? []) {
    addOutput('error', error)
  }

  // Anything short of a complete run prints as an error, not as a note. A refusal and a partial
  // run both leave work behind, and the terminal is the only place the operator sees that.
  addOutput(result.success ? 'success' : 'error', result.message)
}
