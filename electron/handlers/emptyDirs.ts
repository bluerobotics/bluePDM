// Removes directories left empty by a remote file deletion, to the Recycle Bin, and
// nothing else.
//
// ════════════════════════════════════════════════════════════════════════════
// THE TRAP THIS FILE EXISTS TO AVOID
//
// `shell.trashItem` on a directory recycles that directory AND EVERYTHING UNDER IT,
// recursively. `fs:delete-batch` (fs.ts) already relies on exactly that behaviour for
// a user-initiated folder delete, and its automatic-path fallback is a recursive,
// forced permanent filesystem removal. Reusing either of those here would work on a
// clean test vault and destroy data on a real one. This module never calls
// `fs:delete-batch`, and it never falls back to a permanent filesystem removal of any
// kind — see the regression test in emptyDirs.test.ts that asserts as much from this
// file's own source text.
//
// The safety property this file guarantees: a directory is only ever handed to
// `shell.trashItem` if, in the same loop iteration, an *unfiltered* `fs.readdirSync`
// just found it to have zero entries. Not "BluePLM's model shows nothing in it" —
// the renderer's model is filtered (dotfiles, `~$` SOLIDWORKS lock files, `desktop.ini`,
// `Thumbs.db`, the user's own ignore rules — see `isIgnoredVaultPath` in fsWatcher.ts)
// and a separate renderer round-trip to check emptiness first would leave a window for
// SOLIDWORKS to drop a lock file into the directory between the check and the trash.
// So the check and the trash call live here, in the main process, back to back.
//
// ════════════════════════════════════════════════════════════════════════════
// NO isAutomatic PARAMETER, ON PURPOSE
//
// `fs:delete`/`fs:delete-batch` distinguish an unattended caller (auto-discard) from a
// present user, because on the user-initiated path a trash failure may fall back to a
// permanent delete. This handler has no such fallback — it only ever calls
// `shell.trashItem`, unconditionally, exactly like `fs:trash-batch` — so there is
// nothing for an `isAutomatic` flag to switch. Do not add one "for symmetry" with the
// delete handlers; it would have no effect and would suggest a fallback path that does
// not exist and must not be added.
// ════════════════════════════════════════════════════════════════════════════

import { ipcMain, shell } from 'electron'
import fs from 'fs'
import path from 'path'

/** Brief pause to let any in-flight fs events from the caller's own batch settle before this batch's own watcher-suppressed work begins. Mirrors `fs:trash-batch` in fs.ts. */
const FS_EVENT_SETTLE_MS = 50

// ============================================================================
// Pure helpers — no `fs`, `shell`, or `ipcMain` in any signature below, so all of
// this is unit-testable without Electron. `fsWatcher.ignore.test.ts` is the existing
// precedent for testing main-process logic this way.
// ============================================================================

/** Number of non-empty path segments, counted on either separator. */
function countPathSegments(candidatePath: string): number {
  return candidatePath.split(/[\\/]+/).filter((segment) => segment.length > 0).length
}

/**
 * Order candidates deepest-first: most path segments first, then longest string as a
 * tie-break. Callers must re-stat each path at its own turn rather than precomputing an
 * emptiness map — a parent only becomes genuinely empty once its child has actually
 * been recycled, and this ordering is what makes that possible: a nested empty
 * directory is itself an entry in its parent until it is gone, so the parent cannot be
 * judged before the child is handled.
 */
export function sortDeepestFirst(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const depthDelta = countPathSegments(b) - countPathSegments(a)
    if (depthDelta !== 0) return depthDelta
    return b.length - a.length
  })
}

/**
 * True only if `candidatePath` resolves to somewhere strictly inside `root` — not equal
 * to it, and not outside it. This is the one guard in the feature whose failure mode is
 * catastrophic rather than merely wrong, so it is re-checked here in the main process
 * rather than trusted from the renderer.
 *
 * Comparison is lexical (`path.relative`), not case-folded. A caller that built the
 * candidate path from the same `workingDirectory` string this module hands back will
 * always match; a path that differs only by case is refused rather than guessed to be
 * the same directory, which is the safe direction for this particular check to err in.
 */
export function isStrictlyWithinDirectory(candidatePath: string, root: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidatePath)

  if (resolvedCandidate === resolvedRoot) return false

  const relative = path.relative(resolvedRoot, resolvedCandidate)
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

/** What a fresh, adjacent stat + unfiltered readdir just found for one path. */
export interface DirectoryProbe {
  exists: boolean
  isDirectory: boolean
  /** `fs.readdirSync(path).length`, with no filtering of any kind. Meaningless unless `isDirectory`. */
  entryCount: number
}

export type EmptyDirDecision =
  | { outcome: 'alreadyGone' }
  | { outcome: 'remove' }
  | { outcome: 'skip'; reason: string }

/**
 * Decide what to do with one directory from a probe taken immediately beforehand.
 *
 * Three refusal-shaped cases collapse into two outcomes here: absent is treated as
 * success (`alreadyGone`) because there is nothing left on disk to protect or to
 * remove; a file where a directory was expected is a caller bug, not a race, and is
 * refused exactly like a non-empty directory (`skip`) rather than ever reaching
 * `shell.trashItem`. Both `skip` reasons are safe to treat identically at the call
 * site — the directory is left exactly where it is either way.
 */
export function decideEmptyDirRemoval(probe: DirectoryProbe): EmptyDirDecision {
  if (!probe.exists) return { outcome: 'alreadyGone' }
  if (!probe.isDirectory) return { outcome: 'skip', reason: 'not-a-directory' }
  if (probe.entryCount > 0) return { outcome: 'skip', reason: 'not-empty' }
  return { outcome: 'remove' }
}

// ============================================================================
// IPC contract — published to Agent 2, do not change silently.
//
// `fs:trash-empty-dirs`, exposed as `trashEmptyDirs`, signature `(paths: string[])`.
// Same result shape as `fs:delete-batch` / `fs:trash-batch` so callers get one shape
// whichever handler they used.
// ============================================================================

export interface TrashEmptyDirResult {
  path: string
  success: boolean
  error?: string
  /** Left on disk on purpose: not empty, not a directory, outside the working directory, or `shell.trashItem` rejected it. */
  skipped?: boolean
}

export interface TrashEmptyDirsSummary {
  total: number
  succeeded: number
  failed: number
  skipped: number
  duration: number
}

export interface TrashEmptyDirsResponse {
  success: boolean
  results: TrashEmptyDirResult[]
  summary: TrashEmptyDirsSummary
}

export interface EmptyDirHandlerDependencies {
  /** Current watched vault root, or `null` if none is set. Read fresh per call — not captured at registration time. */
  getWorkingDirectory: () => string | null
  /** Stop the vault file watcher. Mirrors the stop half of `fs:trash-batch`'s watcher pause. */
  stopWatcher: () => Promise<void>
  /** Restart the vault file watcher against `dirPath` once the batch is done. */
  startWatcher: (dirPath: string) => Promise<void>
  /** Drop a removed path from the cached vault scan, the way every other delete/trash handler does. */
  forgetScanCacheEntry: (absolutePath: string) => void
  log: (message: string, data?: unknown) => void
}

let trashEmptyDirsBatchCounter = 0

/**
 * Trash every path in `paths` that, at the moment of its own turn, is a genuinely
 * empty directory strictly inside the current working directory. Everything else is
 * left on disk untouched and reported with `skipped: true`.
 */
async function trashEmptyDirectories(
  paths: string[],
  deps: EmptyDirHandlerDependencies,
): Promise<TrashEmptyDirsResponse> {
  const batchId = ++trashEmptyDirsBatchCounter
  const startTime = Date.now()
  const { log } = deps

  if (!paths || paths.length === 0) {
    return { success: true, results: [], summary: emptySummary() }
  }

  log(`[TrashEmptyDirs #${batchId}] START: ${paths.length} directories`)

  const root = deps.getWorkingDirectory()
  const ordered = sortDeepestFirst(paths)
  const results: TrashEmptyDirResult[] = []

  // Only pause the watcher if at least one candidate could actually be processed.
  // A batch made entirely of refused paths never touches the filesystem.
  const needsWatcherPause = !!root && ordered.some((p) => isStrictlyWithinDirectory(p, root))

  if (needsWatcherPause) {
    log(`[TrashEmptyDirs #${batchId}] Stopping file watcher for batch operation`)
    await deps.stopWatcher()
    await new Promise((resolve) => setTimeout(resolve, FS_EVENT_SETTLE_MS))
  }

  try {
    for (const targetPath of ordered) {
      results.push(await processOneDirectory(targetPath, root, batchId, deps))
    }
  } finally {
    if (needsWatcherPause && root && fs.existsSync(root)) {
      log(`[TrashEmptyDirs #${batchId}] Restarting file watcher after batch operation`)
      await deps.startWatcher(root)
    }
  }

  const summary = summarize(paths.length, results, startTime)
  log(
    `[TrashEmptyDirs #${batchId}] END: ${summary.succeeded}/${summary.total} succeeded, ` +
      `${summary.failed} failed (${summary.skipped} skipped), ${summary.duration}ms`,
  )

  return { success: summary.failed === 0, results, summary }
}

/**
 * Handle exactly one path: containment, existence, directory-ness, unfiltered
 * emptiness, then the trash call — all in this one turn, immediately adjacent, on a
 * fresh read. Never reorders or batches these checks across paths.
 */
async function processOneDirectory(
  targetPath: string,
  root: string | null,
  batchId: number,
  deps: EmptyDirHandlerDependencies,
): Promise<TrashEmptyDirResult> {
  const { log } = deps
  const dirName = path.basename(targetPath)

  if (!root || !isStrictlyWithinDirectory(targetPath, root)) {
    log(`[TrashEmptyDirs #${batchId}] Refused (outside working directory): ${targetPath}`)
    return {
      path: targetPath,
      success: false,
      skipped: true,
      error: 'Refused: path is not strictly inside the working directory',
    }
  }

  let probe: DirectoryProbe
  try {
    probe = probeDirectory(targetPath)
  } catch (error) {
    const errorMsg = String(error)
    log(`[TrashEmptyDirs #${batchId}] Could not stat ${dirName}: ${errorMsg}`)
    return { path: targetPath, success: false, skipped: true, error: errorMsg }
  }

  const decision = decideEmptyDirRemoval(probe)

  if (decision.outcome === 'alreadyGone') {
    return { path: targetPath, success: true }
  }

  if (decision.outcome === 'skip') {
    log(`[TrashEmptyDirs #${batchId}] Skipped (${decision.reason}): ${dirName}`)
    return { path: targetPath, success: false, skipped: true, error: decision.reason }
  }

  try {
    await shell.trashItem(targetPath)
    deps.forgetScanCacheEntry(targetPath)
    log(`[TrashEmptyDirs #${batchId}] Trashed empty directory: ${dirName}`)
    return { path: targetPath, success: true }
  } catch (error) {
    const errorMsg = String(error)
    log(`[TrashEmptyDirs #${batchId}] trashItem failed (left on disk): ${dirName} - ${errorMsg}`)
    return {
      path: targetPath,
      success: false,
      skipped: true,
      error: `Could not move to Recycle Bin, left on disk: ${errorMsg}`,
    }
  }
}

/** `fs.existsSync` + `statSync` + unfiltered `readdirSync`, read fresh, right now. */
function probeDirectory(targetPath: string): DirectoryProbe {
  if (!fs.existsSync(targetPath)) {
    return { exists: false, isDirectory: false, entryCount: 0 }
  }

  const stats = fs.statSync(targetPath)
  const isDirectory = stats.isDirectory()
  // No filtering whatsoever: dotfiles, `~$` SOLIDWORKS lock files, `desktop.ini`,
  // `Thumbs.db`, and anything the user's ignore rules exclude all count as an entry.
  const entryCount = isDirectory ? fs.readdirSync(targetPath).length : 0

  return { exists: true, isDirectory, entryCount }
}

function emptySummary(): TrashEmptyDirsSummary {
  return { total: 0, succeeded: 0, failed: 0, skipped: 0, duration: 0 }
}

function summarize(
  total: number,
  results: TrashEmptyDirResult[],
  startTime: number,
): TrashEmptyDirsSummary {
  const succeeded = results.filter((r) => r.success).length
  const failed = results.filter((r) => !r.success).length
  const skipped = results.filter((r) => r.skipped).length
  return { total, succeeded, failed, skipped, duration: Date.now() - startTime }
}

/** Registers `fs:trash-empty-dirs`. The only ipcMain channel this module owns. */
export function registerEmptyDirHandlers(deps: EmptyDirHandlerDependencies): void {
  ipcMain.handle('fs:trash-empty-dirs', async (_event, paths: string[]) =>
    trashEmptyDirectories(paths, deps),
  )
}
