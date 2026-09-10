import type { LocalFile } from './types'

/**
 * Helpers for applying path-keyed updates to the `files` array.
 *
 * Every write that replaces the array invalidates the tree, folderMetrics and
 * sorting memos, each of which is O(N) over tens of thousands of files. Keeping the
 * array (and each element) referentially stable when an update would not actually
 * change anything makes redundant writes free for everything downstream.
 */

/** True when at least one of the update's own keys differs from the current value. */
export function hasActualChange(file: LocalFile, updates: Partial<LocalFile>): boolean {
  for (const key of Object.keys(updates) as Array<keyof LocalFile>) {
    if (!Object.is(file[key], updates[key])) return true
  }
  return false
}

/**
 * True when two rows hold the same value for every key either of them carries.
 *
 * Unlike `hasActualChange`, a key present on only one side counts as a difference, so a
 * replacement that drops a field is not mistaken for a no-op.
 */
function isEquivalentRow(a: LocalFile, b: LocalFile): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof LocalFile>
  for (const key of keys) {
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}

export interface AppliedFileUpdates {
  files: LocalFile[]
  /** How many store entries the update map matched, whether or not values changed. */
  matchCount: number
  /** False when every matched entry already held the incoming values. */
  changed: boolean
}

/**
 * Apply a path-keyed update map (lowercase keys, for case-insensitive matching on
 * Windows) to the files array.
 *
 * Returns the original array when no file's values actually changed, and preserves
 * the original element reference for every file that did not change.
 */
export function applyFileUpdates(
  files: LocalFile[],
  updateMap: Map<string, Partial<LocalFile>>,
): AppliedFileUpdates {
  let matchCount = 0
  let changed = false

  const newFiles = files.map((file) => {
    const fileUpdates = updateMap.get(file.path.toLowerCase())
    if (!fileUpdates) return file

    matchCount++
    if (!hasActualChange(file, fileUpdates)) return file

    changed = true
    return { ...file, ...fileUpdates }
  })

  return { files: changed ? newFiles : files, matchCount, changed }
}

/**
 * Fold a row describing what a caller just wrote to disk onto the row already at that path.
 *
 * The incoming row is built locally by whoever did the writing, so it is the authority on
 * everything the filesystem knows: identity, size, mtime, hash, inode, which version of the
 * content is on disk, and the resulting badge. Those are taken whole, including when they are
 * absent - a hash or version carried over from the file that used to be there would describe
 * content that no longer exists.
 *
 * It is not the authority on anything the server owns or the user typed. `pdmData` especially:
 * a copy constructs its row without ever consulting the server, so overwriting with it would
 * cut the file loose from its record. Those fields are taken from the incumbent whenever the
 * incoming row has nothing to say about them.
 *
 * Returns the incumbent unchanged when the merge would not alter it, so a repeated write does
 * not replace the array element and invalidate every memo keyed on it.
 */
export function mergeWrittenFile(existing: LocalFile, incoming: LocalFile): LocalFile {
  const merged: LocalFile = {
    ...incoming,
    pdmData: incoming.pdmData ?? existing.pdmData,
    pendingMetadata: incoming.pendingMetadata ?? existing.pendingMetadata,
    metadataWriteState: incoming.metadataWriteState ?? existing.metadataWriteState,
    pendingVersionNotes: incoming.pendingVersionNotes ?? existing.pendingVersionNotes,
    pendingCheckinNote: incoming.pendingCheckinNote ?? existing.pendingCheckinNote,
    copiedFromFileId: incoming.copiedFromFileId ?? existing.copiedFromFileId,
    copiedVersion: incoming.copiedVersion ?? existing.copiedVersion,
  }

  return isEquivalentRow(existing, merged) ? existing : merged
}
