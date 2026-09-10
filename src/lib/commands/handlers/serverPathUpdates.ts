/**
 * Durable record and batched reporting for background server path updates.
 *
 * Rename applies the filesystem change and the store update first and pushes the server path
 * update into the background, because a folder rename takes minutes for a large folder and
 * must not block the UI. When that background update fails the vault is correct on disk and
 * stale on the server, and the failure has nowhere to go — the promise is discarded and
 * nothing in the renderer remembers it happened.
 *
 * Load-time `moved` detection recovers most of these on its own: it compares the server path
 * against the local path, and the inode that links the two is persisted in the sync index. It
 * cannot recover a file whose inode was never indexed, a file on a volume that reports no
 * inode, or a stale `folders` row — none of those surface as a `moved` file. This record is
 * what those cases have instead.
 */

import { t } from '@/lib/i18n'
import { log } from '@/lib/logger'

/** Which server record the failed update was aimed at. */
export type ServerPathUpdateKind = 'file' | 'folder' | 'folder-contents'

export interface ServerPathUpdateFailure {
  kind: ServerPathUpdateKind
  /** `files.id` for `file`, `folders.id` for both folder kinds. */
  recordId: string
  vaultId?: string
  /** Path the server still records. For `folder-contents`, the prefix of every stale row. */
  oldPath: string
  newPath: string
  error: string
  failedAt: number
}

const STORAGE_KEY = 'blueplm.serverPathUpdateFailures'

// Oldest entries are dropped first. A vault whose server writes keep failing must not
// grow this list until it costs more than the information in it is worth.
const MAX_RECORDED_FAILURES = 200

// One folder rename fails as a unit; so does a multi-select rename the user fired in one
// gesture. Both should cost one toast.
const TOAST_BATCH_WINDOW_MS = 3_000

type AddToast = (type: 'warning', message: string) => void

function getStorage(): Storage | null {
  try {
    // Unit tests run in a node environment, and a renderer can refuse storage access.
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch (error) {
    log.warn('[ServerPathUpdates]', 'Local storage unavailable', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function isFailure(value: unknown): value is ServerPathUpdateFailure {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ServerPathUpdateFailure>
  return (
    (candidate.kind === 'file' ||
      candidate.kind === 'folder' ||
      candidate.kind === 'folder-contents') &&
    typeof candidate.recordId === 'string' &&
    typeof candidate.oldPath === 'string' &&
    typeof candidate.newPath === 'string' &&
    typeof candidate.error === 'string' &&
    typeof candidate.failedAt === 'number'
  )
}

/** Path updates that never reached the server, oldest first. Never throws. */
export function listServerPathUpdateFailures(vaultId?: string): ServerPathUpdateFailure[] {
  const storage = getStorage()
  if (!storage) return []

  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return []

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    const failures = parsed.filter(isFailure)
    return vaultId ? failures.filter((failure) => failure.vaultId === vaultId) : failures
  } catch (error) {
    log.warn('[ServerPathUpdates]', 'Failed to read recorded path update failures', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * Appends one failure to the durable record. Never throws: losing the record is bad, but
 * failing the rename the user already saw succeed on disk is worse.
 */
export function recordServerPathUpdateFailure(failure: ServerPathUpdateFailure): void {
  const storage = getStorage()
  if (!storage) return

  try {
    const failures = [...listServerPathUpdateFailures(), failure].slice(-MAX_RECORDED_FAILURES)
    storage.setItem(STORAGE_KEY, JSON.stringify(failures))
  } catch (error) {
    log.warn('[ServerPathUpdates]', 'Failed to record path update failure', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Drops recorded failures once they have been reconciled. Never throws. */
export function clearServerPathUpdateFailures(): void {
  const storage = getStorage()
  if (!storage) return

  try {
    storage.removeItem(STORAGE_KEY)
  } catch (error) {
    log.warn('[ServerPathUpdates]', 'Failed to clear recorded path update failures', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

let batchedFailureCount = 0
let batchedFailureToast: ReturnType<typeof setTimeout> | null = null

/** Records the failure durably and folds it into at most one toast per batch window. */
export function noteServerPathUpdateFailure(
  failure: ServerPathUpdateFailure,
  addToast: AddToast,
): void {
  log.warn('[ServerPathUpdates]', 'Server path update failed', {
    kind: failure.kind,
    recordId: failure.recordId,
    oldPath: failure.oldPath,
    newPath: failure.newPath,
    error: failure.error,
  })

  recordServerPathUpdateFailure(failure)

  batchedFailureCount++
  if (batchedFailureToast) return

  batchedFailureToast = setTimeout(() => {
    const count = batchedFailureCount
    batchedFailureToast = null
    batchedFailureCount = 0

    log.warn('[ServerPathUpdates]', 'Reporting failed server path updates', { count })
    addToast(
      'warning',
      t(
        'fileOps.serverPathUpdateFailed',
        'Some renames did not reach the server, so it still records the old paths. Run reconcile-moved-paths to update them.',
      ),
    )
  }, TOAST_BATCH_WINDOW_MS)
}
