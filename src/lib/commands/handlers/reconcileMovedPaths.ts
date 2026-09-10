/**
 * Reconcile Moved Paths Command
 *
 * Commits file moves that are already sitting on the user's disk. A file moved or renamed locally
 * while the matching server update failed shows as `diffStatus === 'moved'` and no other code path
 * can fix it: check-in only processes files the current user has checked out, and the ghost-match
 * flow only accepts a ghost that is both `deleted` and checked out. This command writes the current
 * local path to the server row, one `move_file` call per file.
 *
 * It is the highest-consequence write in the application, so it is built to be refused rather than
 * to be forgiven:
 *
 * - Nothing is written unless the caller passes `apply`. Every other entry — the command with no
 *   params, the terminal with no flag — performs the pre-flight and reports.
 * - A target held by another user refuses the whole run and names the holders, unless
 *   `skipCheckedOut` opts into leaving theirs alone.
 * - The write path requires a confirmation dialog. No dialog available means no write.
 * - Every write is one `move_file`, so a run that stops halfway leaves complete rows behind it and
 *   untouched rows in front of it. Running it again finishes the job.
 * - The summary reports succeeded, failed, skipped and blocked separately, and only reports success
 *   when nothing was left over.
 */

import { log } from '@/lib/logger'
import { t } from '@/lib/i18n'

import { clearVaultCache } from '../../cache/vaultFileCache'
import { removeFromSyncIndex } from '../../cache/localSyncIndex'
import { CONCURRENT_OPERATIONS } from '../../concurrency'
import { moveFilesOnServer } from '../../supabase/files/move'
import { executeCommand } from '../executor'
import type { ParsedCommand, TerminalOutput } from '../parser'
import { registerTerminalCommand } from '../registry'
import type {
  Command,
  CommandContext,
  CommandResult,
  LocalFile,
  ReconcileMovedPathsParams,
} from '../types'

import {
  classifyMovedFiles,
  type BlockedHolder,
  type ReconcilePreflight,
  type ReconcileTarget,
} from './reconcileMovedPathsPreflight'

/** Paths named individually in the report's conflict and unverified sections. */
const REPORTED_PATH_LIMIT = 20

/** Failures named individually in the result before they collapse to a count. */
const REPORTED_FAILURE_LIMIT = 10

function logReconcile(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  context: Record<string, unknown>,
): void {
  log[level]('[ReconcileMovedPaths]', message, context)
}

function holderLabel(holder: BlockedHolder): string {
  return t('reconcileMovedPaths.reportHolder', {
    count: holder.count,
    user: holder.holderName ?? t('reconcileMovedPaths.unknownHolder'),
  })
}

/**
 * `old/path/name.sldprt → new/path/name.sldprt`, one per file that will be written.
 *
 * Every one of them, not a sample: the dialog renders the first few and reports the rest as a count
 * (`CommandConfirmContainer.tsx:79`), so truncating here would understate what is about to happen.
 */
function pathChangeItems(targets: ReconcileTarget[]): string[] {
  return targets.map((target) =>
    t('reconcileMovedPaths.reportItem', { from: target.serverPath, to: target.localPath }),
  )
}

/** The remainder a confirmed run will deliberately leave behind, as one clause. */
function describeRemainder(preflight: ReconcilePreflight): string | null {
  const parts: string[] = []

  if (preflight.blocked.length > 0) {
    parts.push(t('reconcileMovedPaths.summaryBlocked', { count: preflight.blocked.length }))
  }
  if (preflight.skipped.length > 0) {
    parts.push(t('reconcileMovedPaths.summarySkipped', { count: preflight.skipped.length }))
  }

  if (parts.length === 0) return null

  return t('reconcileMovedPaths.confirmRemainder', {
    count: preflight.blocked.length + preflight.skipped.length,
    detail: parts.join(', '),
  })
}

/**
 * The pre-flight in prose. This is the dry run's entire output and the confirmation's body, so the
 * two can never disagree about what a run would do.
 */
function describePreflight(preflight: ReconcilePreflight): string[] {
  const lines = [t('reconcileMovedPaths.reportHeading', { count: preflight.total })]

  lines.push(t('reconcileMovedPaths.reportEligible', { count: preflight.eligible.length }))

  if (preflight.blocked.length > 0) {
    lines.push(t('reconcileMovedPaths.reportBlocked', { count: preflight.blocked.length }))
    for (const holder of preflight.holders) {
      lines.push(`  ${holderLabel(holder)}`)
    }
  }

  const conflicts = preflight.skipped.filter((target) => target.reason === 'conflict')
  if (conflicts.length > 0) {
    lines.push(t('reconcileMovedPaths.reportConflict', { count: conflicts.length }))
    for (const target of conflicts.slice(0, REPORTED_PATH_LIMIT)) {
      lines.push(`  ${target.localPath}`)
    }
  }

  const unverified = preflight.skipped.filter((target) => target.reason === 'unverified')
  if (unverified.length > 0) {
    lines.push(t('reconcileMovedPaths.reportUnverified', { count: unverified.length }))
    for (const target of unverified.slice(0, REPORTED_PATH_LIMIT)) {
      lines.push(`  ${target.localPath}`)
    }
  }

  return lines
}

/** Nothing was written, and the result says which of the four buckets everything landed in. */
function reportOnly(
  preflight: ReconcilePreflight,
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

export const reconcileMovedPathsCommand: Command<ReconcileMovedPathsParams> = {
  id: 'reconcile-moved-paths',
  name: 'Reconcile Moved Paths',
  description: 'Write the current local path of locally moved files to their server records',
  aliases: ['reconcile-moves'],
  usage: 'reconcile-moved-paths [--apply] [--skip-checked-out]',

  validate(_params, ctx) {
    if (ctx.isOfflineMode) {
      return t('reconcileMovedPaths.offline')
    }

    if (!ctx.user) {
      return t('reconcileMovedPaths.notSignedIn')
    }

    if (!ctx.organization) {
      return t('reconcileMovedPaths.noOrganization')
    }

    if (!ctx.activeVaultId) {
      return t('reconcileMovedPaths.noVault')
    }

    const preflight = classifyMovedFiles({
      files: ctx.files,
      serverFiles: ctx.serverFiles,
      userId: ctx.user.id,
    })

    if (preflight.total === 0) {
      return t('reconcileMovedPaths.nothingToReconcile')
    }

    return null
  },

  async execute({ apply, skipCheckedOut }, ctx): Promise<CommandResult> {
    const user = ctx.user!
    const startedAt = Date.now()

    const preflight = classifyMovedFiles({
      files: ctx.files,
      serverFiles: ctx.serverFiles,
      userId: user.id,
    })

    logReconcile('info', 'Pre-flight complete', {
      total: preflight.total,
      eligible: preflight.eligible.length,
      blocked: preflight.blocked.length,
      skipped: preflight.skipped.length,
      holders: preflight.holders.length,
      apply: apply === true,
      skipCheckedOut: skipCheckedOut === true,
    })

    // The default. A caller that has not asked for the write path in as many words gets the report.
    if (!apply) {
      return reportOnly(
        preflight,
        t('reconcileMovedPaths.dryRunSummary', {
          eligible: preflight.eligible.length,
          total: preflight.total,
        }),
        true,
      )
    }

    // Refuse rather than write around other people's checkouts. `move_file` would refuse these rows
    // one at a time mid-batch; refusing up front is what lets the operator go and ask them.
    if (preflight.blocked.length > 0 && !skipCheckedOut) {
      const holders = preflight.holders.map(holderLabel).join(', ')
      const message = t('reconcileMovedPaths.refused', {
        count: preflight.blocked.length,
        holders,
      })

      logReconcile('warn', 'Refused: targets are checked out by other users', {
        blocked: preflight.blocked.length,
        holderCount: preflight.holders.length,
      })
      ctx.addToast('warning', message)

      return reportOnly(preflight, message, false)
    }

    if (preflight.eligible.length === 0) {
      const message = t('reconcileMovedPaths.nothingEligible', {
        blocked: preflight.blocked.length,
        skipped: preflight.skipped.length,
      })
      ctx.addToast('warning', message)
      return reportOnly(preflight, message, false)
    }

    // Property, not politeness: this command does not write without a stated confirmation. A caller
    // with no dialog to offer gets the report instead.
    if (!ctx.confirm) {
      logReconcile('warn', 'Refused: no confirmation dialog available', {
        eligible: preflight.eligible.length,
      })
      return reportOnly(preflight, t('reconcileMovedPaths.confirmUnavailable'), false)
    }

    // One paragraph, because the dialog renders the message as one (`CommandConfirmContainer.tsx:67`)
    // and a report joined with newlines would arrive as a run-on sentence.
    const remainder = describeRemainder(preflight)
    const confirmed = await ctx.confirm({
      title: t('reconcileMovedPaths.confirmTitle', { count: preflight.eligible.length }),
      message: [
        t('reconcileMovedPaths.confirmMessage', { count: preflight.eligible.length }),
        remainder,
      ]
        .filter(Boolean)
        .join(' '),
      items: pathChangeItems(preflight.eligible),
      confirmText: t('reconcileMovedPaths.confirmText', { count: preflight.eligible.length }),
    })

    if (!confirmed) {
      logReconcile('info', 'User declined the reconcile', { eligible: preflight.eligible.length })
      return reportOnly(preflight, t('reconcileMovedPaths.declined'), false)
    }

    return writeReconciledPaths(preflight, ctx, user.id, startedAt)
  },
}

/**
 * The write. Separated from the decision so that everything above this line is reasoning about what
 * to do, and everything below it is doing exactly what was confirmed.
 */
async function writeReconciledPaths(
  preflight: ReconcilePreflight,
  ctx: CommandContext,
  userId: string,
  startedAt: number,
): Promise<CommandResult> {
  const eligible = preflight.eligible
  const toastId = `reconcile-moved-paths-${Date.now()}`

  ctx.addProgressToast(
    toastId,
    t('reconcileMovedPaths.progress', { count: eligible.length }),
    eligible.length,
  )

  logReconcile('info', 'Writing server paths', {
    count: eligible.length,
    concurrency: CONCURRENT_OPERATIONS,
  })

  const result = await moveFilesOnServer(
    eligible.map((target) => ({
      fileId: target.fileId,
      newFilePath: target.localPath,
      newFileName: target.name,
    })),
    userId,
    {
      concurrency: CONCURRENT_OPERATIONS,
      onProgress: (completed, total) => {
        ctx.updateProgressToast(
          toastId,
          completed,
          Math.round((completed / total) * 100),
          undefined,
          `${completed}/${total}`,
        )
      },
      // Cancelling stops the run; it does not undo it. Safe because each write is one row.
      shouldStop: () => ctx.isProgressToastCancelled(toastId),
    },
    // The toast goes even if the write throws, or it hangs at whatever count it reached.
  ).finally(() => ctx.removeToast(toastId))

  const succeeded: ReconcileTarget[] = []
  const failures: Array<{ target: ReconcileTarget; error?: string }> = []
  let notAttempted = 0

  result.results.forEach((outcome, index) => {
    const target = eligible[index]
    if (!outcome.attempted) {
      notAttempted++
    } else if (outcome.success) {
      succeeded.push(target)
    } else {
      failures.push({ target, error: outcome.error })
    }
  })

  applyReconciledPathsToStore(succeeded, ctx)
  await cleanUpAfterReconcile(succeeded, ctx)

  const message = summarize(preflight, succeeded.length, failures.length, notAttempted)
  const errors = failures.slice(0, REPORTED_FAILURE_LIMIT).map(({ target, error }) =>
    t('reconcileMovedPaths.failureItem', {
      path: target.localPath,
      error: error ?? t('reconcileMovedPaths.unknownError'),
    }),
  )

  if (failures.length > REPORTED_FAILURE_LIMIT) {
    errors.push(
      t('reconcileMovedPaths.reportAndMore', { count: failures.length - REPORTED_FAILURE_LIMIT }),
    )
  }

  const complete =
    failures.length === 0 &&
    notAttempted === 0 &&
    preflight.blocked.length === 0 &&
    preflight.skipped.length === 0

  logReconcile(failures.length > 0 ? 'warn' : 'info', 'Reconcile finished', {
    succeeded: succeeded.length,
    failed: failures.length,
    notAttempted,
    blocked: preflight.blocked.length,
    skipped: preflight.skipped.length,
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
    duration: Date.now() - startedAt,
  }
}

/**
 * Patch the rows that were written so they stop rendering as moved before the next load. The path
 * comparison in the pre-flight makes this cosmetic rather than load-bearing — a re-run would skip
 * these rows either way — but a badge that outlives the fix reads as a fix that did not work.
 */
function applyReconciledPathsToStore(succeeded: ReconcileTarget[], ctx: CommandContext): void {
  if (succeeded.length === 0) return

  const byPath = new Map(ctx.files.map((file) => [file.path, file]))
  const updates: Array<{ path: string; updates: Partial<LocalFile> }> = []

  for (const target of succeeded) {
    const file = byPath.get(target.path)
    if (!file?.pdmData) continue

    updates.push({
      path: target.path,
      updates: {
        pdmData: { ...file.pdmData, file_path: target.localPath, file_name: target.name },
        // Only the path diverged, and it no longer does: the pre-flight skips any file whose
        // content disagrees with the row, so there is nothing else left for this row to be.
        diffStatus: undefined,
      },
    })
  }

  if (updates.length > 0) {
    ctx.updateFilesInStore(updates)
    ctx.setLastOperationCompletedAt(Date.now())
  }
}

/**
 * Drop the old paths from the sync index and invalidate the vault cache, so the next load reads the
 * server rather than replaying rows that still carry the old path. Both are best-effort: they make
 * the next load cheaper and more accurate, and neither is what made the write correct.
 */
async function cleanUpAfterReconcile(
  succeeded: ReconcileTarget[],
  ctx: CommandContext,
): Promise<void> {
  if (succeeded.length === 0 || !ctx.activeVaultId) return

  const vaultId = ctx.activeVaultId

  try {
    await removeFromSyncIndex(
      vaultId,
      succeeded.map((target) => target.serverPath),
    )
  } catch (error) {
    logReconcile('warn', 'Failed to drop the old paths from the sync index', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  try {
    await clearVaultCache(vaultId)
  } catch (error) {
    logReconcile('warn', 'Failed to invalidate the vault file cache', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * One sentence that cannot be mistaken for a clean run when it was not one. A count of successes on
 * its own reads as success; the leftovers have to be in the same sentence.
 */
function summarize(
  preflight: ReconcilePreflight,
  succeeded: number,
  failed: number,
  notAttempted: number,
): string {
  const leftovers: string[] = []

  if (failed > 0) leftovers.push(t('reconcileMovedPaths.summaryFailed', { count: failed }))
  if (notAttempted > 0) {
    leftovers.push(t('reconcileMovedPaths.summaryNotAttempted', { count: notAttempted }))
  }
  if (preflight.blocked.length > 0) {
    leftovers.push(t('reconcileMovedPaths.summaryBlocked', { count: preflight.blocked.length }))
  }
  if (preflight.skipped.length > 0) {
    leftovers.push(t('reconcileMovedPaths.summarySkipped', { count: preflight.skipped.length }))
  }

  if (leftovers.length === 0) {
    return t('reconcileMovedPaths.summaryComplete', { count: succeeded })
  }

  return t('reconcileMovedPaths.summaryPartial', {
    succeeded,
    total: preflight.total,
    leftovers: leftovers.join(', '),
  })
}

// ============================================
// Terminal entry point
// ============================================

/**
 * The only way a user can start this today, and it reports by default: without `--apply` it runs the
 * pre-flight and prints it. That is the order the rollout needs — read the dry run against the real
 * vault, then ask for the write.
 */
registerTerminalCommand(
  {
    aliases: ['reconcile-moved-paths', 'reconcile-moves'],
    description:
      'Report, and with --apply commit, the server paths of files moved locally while the server kept the old path',
    usage: 'reconcile-moved-paths [--apply] [--skip-checked-out]',
    examples: [
      'reconcile-moved-paths',
      'reconcile-moved-paths --apply',
      'reconcile-moved-paths --apply --skip-checked-out',
    ],
    category: 'admin',
  },
  async (parsed: ParsedCommand, _files, addOutput, onRefresh) => {
    const apply = parsed.flags.apply === true
    const skipCheckedOut = parsed.flags['skip-checked-out'] === true

    if (!apply) {
      addOutput('info', t('reconcileMovedPaths.dryRunNote'))
    }

    const result = await executeCommand(
      'reconcile-moved-paths',
      { apply, skipCheckedOut },
      { onRefresh },
    )

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

  // Anything short of a complete run prints as an error, not as a note. A refusal and a partial run
  // both leave work behind, and the terminal is the only place the operator sees that.
  addOutput(result.success ? 'success' : 'error', result.message)
}
