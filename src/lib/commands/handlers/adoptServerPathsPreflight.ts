/**
 * Pre-flight classification for the `adopt-server-paths` command.
 *
 * The inverse of `reconcileMovedPathsPreflight.ts`. That command writes the local path to the
 * server; this one renames the local file back to the path the server already records. Kept
 * apart from the command for the same reason: it is the whole of the dry run and the only thing
 * that decides what gets renamed. It is pure: no store, no filesystem, no clock. Given the same
 * vault it returns the same four buckets, which is what makes the report reviewable before a run
 * and the decision testable without touching disk.
 *
 * The guards mirror the reconcile pre-flight's, read in the other direction:
 * - Destination occupied: the server path may already hold a local file (BluePLM auto-creates
 *   every server folder locally, and a stale copy can sit inside it). Never overwrite it.
 * - Hash disagreement: a file that was moved *and* edited has content that disagrees with what
 *   the server recorded. Relocating it would either write over another file if the disk's inode
 *   was reused (NTFS does this after a deletion) or silently bury the edit. Either way the row
 *   is left for the user to check in rather than moved.
 * - Held by another user: the rename only touches this user's own disk, so it is safe regardless
 *   of who holds the checkout - but a checkout is still evidence someone else's move may be in
 *   flight, so these targets are reported and held back rather than acted on silently. The
 *   command (not this module) decides whether `force` should let them through.
 */

import type { CheckoutUserProfile } from '../../../types/pdm'
import { getCheckoutProfileForOwner } from '../../checkout/checkoutDisplay'
import type { LocalFile } from '../types'

/**
 * A local file whose disk location will be renamed to the path `files.file_path` records.
 *
 * Identified by the row rather than by the local file: the destination is `serverPath`, and the
 * local file is only what is being moved to reach it.
 */
export interface AdoptTarget {
  /** `files.id` of the row this file belongs to. */
  fileId: string
  /** The name the server records for this file - what it will be named after the rename. */
  name: string
  /** Path the server records, forward-slashed and relative to the vault root. The destination. */
  serverPath: string
  /** Path the file currently occupies on disk, in the same form. The source. */
  localPath: string
  /** Absolute local path the file currently occupies, for the rename and the watcher. */
  path: string
  /** NTFS file index number, when known, so the rename can re-key the sync index by inode. */
  ino?: number
  /** Last known synced version, carried through the rename so it is not lost. */
  localVersion?: number
  /** Last known local content hash, carried through the rename so it is not lost. */
  localHash?: string
}

/** A target held by somebody else's checkout. Safe to rename regardless, but reported first. */
export interface BlockedAdoptTarget extends AdoptTarget {
  holderId: string
  /** Null when the checkout profile has not been hydrated into the store. */
  holderName: string | null
}

/** Why a target was left alone even though nobody holds it. */
export type AdoptSkipReason = 'conflict' | 'unverified'

export interface SkippedAdoptTarget extends AdoptTarget {
  reason: AdoptSkipReason
  /** For a conflict, the file (or row) already occupying the destination. */
  occupiedBy?: string
}

/** Blocked targets collapsed to one line per holder, which is how the operator acts on them. */
export interface BlockedAdoptHolder {
  holderId: string
  holderName: string | null
  count: number
}

export interface AdoptServerPathsPreflight {
  /** Every candidate the classification looked at, blocked and skipped included. */
  total: number
  eligible: AdoptTarget[]
  blocked: BlockedAdoptTarget[]
  skipped: SkippedAdoptTarget[]
  /** Descending by count, then by name, so the biggest holder is the first person to ask. */
  holders: BlockedAdoptHolder[]
}

export interface AdoptPreflightInput {
  /** Every local row, `ctx.files`. */
  files: LocalFile[]
  /** The acting user. A row this user holds is not "held by somebody else". */
  userId: string
}

/** Windows spells the same path several ways; every comparison here goes through this. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function holderNameOf(profile: CheckoutUserProfile | null): string | null {
  return profile?.full_name?.trim() || profile?.email?.trim() || null
}

/** A candidate carries its own row: the checkout and the hash are read from it, never looked up. */
interface Candidate {
  file: LocalFile
  target: AdoptTarget
}

/**
 * `diffStatus === 'moved'` is the signal, but the path comparison is the guard: it is what makes
 * the command idempotent. A row an earlier run already adopted keeps its stale `moved` badge
 * until the next load, and selecting on the badge alone would offer to rename it a second time.
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

    const serverName = file.pdmData?.file_name?.trim() || serverPath.split('/').pop() || file.name

    candidates.push({
      file,
      target: {
        fileId,
        name: serverName,
        serverPath: serverPath.replace(/\\/g, '/'),
        localPath: file.relativePath.replace(/\\/g, '/'),
        path: file.path,
        ino: file.ino,
        localVersion: file.localVersion,
        localHash: file.localHash,
      },
    })
  }

  return candidates
}

/**
 * Sort the candidates into the four buckets, in the order of the plan's flow: held by somebody
 * else, then destination already occupied, then content that does not match what the server
 * recorded, then eligible.
 */
export function classifyAdoptTargets({
  files,
  userId,
}: AdoptPreflightInput): AdoptServerPathsPreflight {
  const byPath = new Map<string, LocalFile[]>()
  for (const file of files) {
    if (file.isDirectory) continue
    const key = normalizePath(file.relativePath)
    const existing = byPath.get(key)
    if (existing) existing.push(file)
    else byPath.set(key, [file])
  }

  const eligible: AdoptTarget[] = []
  const blocked: BlockedAdoptTarget[] = []
  const skipped: SkippedAdoptTarget[] = []

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

    // The destination-occupied guard. Unlike the reconcile pre-flight's version, any file
    // sitting at the destination counts as an occupant here, tracked or not - the server auto-
    // creates every folder locally, and a stale, untracked copy can be sitting inside one. There
    // is no server-side collision to check for the other direction: `files.file_path` is unique,
    // so no second server row can already claim this row's own destination.
    const destination = normalizePath(target.serverPath)
    const occupant = (byPath.get(destination) ?? []).find((other) => other.path !== file.path)

    if (occupant) {
      skipped.push({
        ...target,
        reason: 'conflict',
        occupiedBy: occupant.pdmData?.id ?? occupant.relativePath,
      })
      continue
    }

    // An inode match is how these files were recognised, and NTFS reuses inode numbers after a
    // deletion. Where both sides carry a hash they have to agree before the file is moved to the
    // server's path - a wrong match would silently overwrite whatever a reused inode actually
    // belongs to, and a file that was moved *and* edited would have its edit buried under the
    // server's last-known content. A file with no hash on one side or the other has nothing to
    // contradict, so it is accepted - which is the common case here: the hash pass that would
    // have populated `localHash` does not run for a file the merge only ever renders at its
    // local path (see `useLoadFiles.ts`), so most inode-detected moves reach this guard with no
    // `localHash` at all.
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
export function groupHolders(blocked: BlockedAdoptTarget[]): BlockedAdoptHolder[] {
  const holders = new Map<string, BlockedAdoptHolder>()

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
