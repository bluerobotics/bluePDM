/**
 * Pre-flight classification for the `reconcile-moved-paths` command.
 *
 * Kept apart from the command because it is the whole of the dry run and the only thing that
 * decides what gets written. It is pure: no store, no database, no clock. Given the same vault it
 * returns the same four buckets, which is what makes the report reviewable before a run and the
 * decision testable without a server.
 */

import type { CheckoutUserProfile } from '../../../types/pdm'
import type { ServerFile } from '../../../stores/types'
import { getCheckoutProfileForOwner } from '../../checkout/checkoutDisplay'
import type { LocalFile } from '../types'

/**
 * A row whose `file_path` the server still records at the file's old location.
 *
 * Identified by the row rather than by the local file: the write is to `files.id`, and the local
 * path is only the value being written.
 */
export interface ReconcileTarget {
  /** `files.id` of the row to be updated. */
  fileId: string
  /** The name the file now has on disk. */
  name: string
  /** Path the server still records, forward-slashed and relative to the vault root. */
  serverPath: string
  /** Path the file actually occupies now, in the same form. */
  localPath: string
  /** Absolute local path, for logs and processing markers. */
  path: string
}

/** A target held by somebody else. `move_file` would refuse it, so the run refuses first. */
export interface BlockedTarget extends ReconcileTarget {
  holderId: string
  /** Null when the checkout profile has not been hydrated into the store. */
  holderName: string | null
}

/** Why a target was left alone even though nobody holds it. */
export type ReconcileSkipReason = 'conflict' | 'unverified'

export interface SkippedTarget extends ReconcileTarget {
  reason: ReconcileSkipReason
  /** For a conflict, the row already sitting on `localPath`. */
  occupiedBy?: string
}

/** Blocked targets collapsed to one line per holder, which is how the operator acts on them. */
export interface BlockedHolder {
  holderId: string
  holderName: string | null
  count: number
}

export interface ReconcilePreflight {
  /** Every candidate the classification looked at, blocked and skipped included. */
  total: number
  eligible: ReconcileTarget[]
  blocked: BlockedTarget[]
  skipped: SkippedTarget[]
  /** Descending by count, then by name, so the biggest holder is the first person to ask. */
  holders: BlockedHolder[]
}

export interface PreflightInput {
  /** Every local row, `ctx.files`. */
  files: LocalFile[]
  /** Every server row for the active vault, `ctx.serverFiles`. */
  serverFiles: ServerFile[]
  /** The acting user. A row this user holds is not blocked — `move_file` allows it. */
  userId: string
}

/** Windows spells the same path several ways; every comparison here goes through this. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function holderNameOf(profile: CheckoutUserProfile | null): string | null {
  return profile?.full_name?.trim() || profile?.email?.trim() || null
}

/**
 * The rows a reconcile would write.
 *
 * `diffStatus === 'moved'` is the signal, but the path comparison is the guard: it is what makes
 * the command idempotent. A row already reconciled keeps its stale `moved` badge until the next
 * load, and selecting on the badge alone would offer to write it a second time.
 */
function findCandidates(files: LocalFile[]): Candidate[] {
  const candidates: Candidate[] = []

  for (const file of files) {
    if (file.isDirectory) continue
    if (file.diffStatus !== 'moved') continue

    const fileId = file.pdmData?.id
    const serverPath = file.pdmData?.file_path
    if (!fileId || !serverPath) continue
    if (normalizePath(serverPath) === normalizePath(file.relativePath)) continue

    candidates.push({
      file,
      target: {
        fileId,
        name: file.name,
        serverPath: serverPath.replace(/\\/g, '/'),
        localPath: file.relativePath.replace(/\\/g, '/'),
        path: file.path,
      },
    })
  }

  return candidates
}

/** A candidate carries its own row: the checkout and the hash are read from it, never looked up. */
interface Candidate {
  file: LocalFile
  target: ReconcileTarget
}

/**
 * Sort the candidates into the four buckets, in the order of the plan's flow: held by somebody
 * else, then destination already occupied, then content that does not match what the server
 * recorded, then eligible.
 */
export function classifyMovedFiles({
  files,
  serverFiles,
  userId,
}: PreflightInput): ReconcilePreflight {
  const byPath = new Map<string, LocalFile[]>()
  for (const file of files) {
    if (file.isDirectory) continue
    const key = normalizePath(file.relativePath)
    const existing = byPath.get(key)
    if (existing) existing.push(file)
    else byPath.set(key, [file])
  }

  const serverRowsByPath = new Map<string, ServerFile>()
  for (const serverFile of serverFiles) {
    serverRowsByPath.set(normalizePath(serverFile.file_path), serverFile)
  }

  const eligible: ReconcileTarget[] = []
  const blocked: BlockedTarget[] = []
  const skipped: SkippedTarget[] = []

  for (const { file, target } of findCandidates(files)) {
    const holderId = file.pdmData?.checked_out_by
    if (holderId && holderId !== userId) {
      blocked.push({
        ...target,
        holderId,
        holderName: holderNameOf(getCheckoutProfileForOwner(file)),
      })
      continue
    }

    // The destination-occupied guard, in both directions a collision can arrive from: another
    // loaded row already on this path, and a server row on this path with no local copy. Writing
    // either way would put two rows on one path, which is the state the vault cannot represent.
    const destination = normalizePath(target.localPath)
    const localOccupant = (byPath.get(destination) ?? []).find(
      (other) => other.pdmData?.id && other.pdmData.id !== target.fileId,
    )
    const serverOccupant = serverRowsByPath.get(destination)
    const occupiedBy =
      localOccupant?.pdmData?.id ??
      (serverOccupant && serverOccupant.id !== target.fileId ? serverOccupant.id : undefined)

    if (occupiedBy) {
      skipped.push({ ...target, reason: 'conflict', occupiedBy })
      continue
    }

    // An inode match is how these files were recognised, and NTFS reuses inode numbers after a
    // deletion. Where both sides carry a hash they have to agree before the row's path is
    // rewritten — a wrong match would write this row onto another file's path silently. A file
    // that was moved *and* edited lands here too, and check-in is the right path for that.
    const serverHash = file.pdmData?.content_hash
    const localHash = file.localHash
    if (serverHash && localHash && serverHash !== localHash) {
      skipped.push({ ...target, reason: 'unverified' })
      continue
    }

    eligible.push(target)
  }

  return {
    total: eligible.length + blocked.length + skipped.length,
    eligible,
    blocked,
    skipped,
    holders: groupHolders(blocked),
  }
}

/** One entry per holder, biggest first. */
export function groupHolders(blocked: BlockedTarget[]): BlockedHolder[] {
  const holders = new Map<string, BlockedHolder>()

  for (const target of blocked) {
    const existing = holders.get(target.holderId)
    if (existing) {
      existing.count++
      // A name from any one of a holder's rows is a name for all of them; hydration is per row.
      existing.holderName = existing.holderName ?? target.holderName
    } else {
      holders.set(target.holderId, {
        holderId: target.holderId,
        holderName: target.holderName,
        count: 1,
      })
    }
  }

  return Array.from(holders.values()).sort(
    (a, b) => b.count - a.count || (a.holderName ?? '').localeCompare(b.holderName ?? ''),
  )
}
