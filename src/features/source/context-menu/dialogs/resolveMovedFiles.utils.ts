/**
 * Pure helpers for `ResolveMovedFilesDialog`.
 *
 * Kept apart from the component so the two things that are actually worth testing — which pairs
 * get listed, and which of them a given scope selection covers — can be tested without React.
 *
 * `reconcile-moved-paths` and `adopt-server-paths` both take no selection: `classifyMovedFiles`
 * and `classifyAdoptTargets` always look at the whole vault, by design (see their own preflight
 * modules). Scoping the *decision* — the eligible/blocked/skipped counts a run would actually
 * produce — would show numbers that disagree with what clicking "run" does. So scope here only
 * ever filters the **preview list** of from/to pairs; the counts stay vault-wide. `isInScope` is
 * shared by the pair list and, if a caller ever wants it, the preflight target lists, because a
 * `ReconcileTarget`/`AdoptTarget` and a `MovedPair` describe the same two paths under the same two
 * field names.
 */

import { isPathWithinDirectory } from '@/lib/utils'
import type { LocalFile } from '@/stores/pdmStore'

/** One pending move, named by the paths every target/pair in this flow already uses. */
export interface MovedPair {
  /** `files.id` — shared by a `'moved'` row and its `'moved_away'` stub. */
  fileId: string
  name: string
  /** The path the vault still records for the file. */
  serverPath: string
  /** The path the file's content actually occupies right now. */
  localPath: string
}

/** Anything with the two paths a scope can be tested against. */
export interface ScopeMatchable {
  fileId: string
  serverPath: string
  localPath: string
}

export type ResolveScopeType = 'file' | 'folder' | 'vault'

export type ResolveScope =
  | { type: 'vault' }
  | { type: 'file'; fileId: string | null }
  | { type: 'folder'; folderPath: string }

function toForwardSlash(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Every pending move in `files`, one row per logical file.
 *
 * A `'moved'` row already carries both paths (`pdmData.file_path` is the server path,
 * `relativePath` is where it sits now) and is preferred. A `'moved_away'` stub is read only when
 * its `'moved'` partner is not in the array — e.g. a folder-scoped fetch that happens to include
 * only the stub's side — using `movedToRelativePath` for the destination it already carries.
 */
export function buildMovedPairs(files: LocalFile[]): MovedPair[] {
  const byId = new Map<string, MovedPair>()

  for (const file of files) {
    if (file.diffStatus !== 'moved') continue
    const fileId = file.pdmData?.id
    const serverPath = file.pdmData?.file_path
    if (!fileId || !serverPath) continue

    byId.set(fileId, {
      fileId,
      name: file.name,
      serverPath: toForwardSlash(serverPath),
      localPath: toForwardSlash(file.relativePath),
    })
  }

  for (const file of files) {
    if (file.diffStatus !== 'moved_away') continue
    const fileId = file.pdmData?.id
    if (!fileId || byId.has(fileId)) continue
    if (!file.movedToRelativePath) continue

    byId.set(fileId, {
      fileId,
      name: file.pdmData?.file_name?.trim() || file.name,
      serverPath: toForwardSlash(file.relativePath),
      localPath: toForwardSlash(file.movedToRelativePath),
    })
  }

  return Array.from(byId.values()).sort((a, b) => a.serverPath.localeCompare(b.serverPath))
}

/**
 * Whether `item` falls under `scope`.
 *
 * A folder scope matches on either path, not just one: the folder tree shows a pending-move
 * count on both the source and destination folders (Agent 1/2's design), so opening the dialog
 * from either side should show the same move. An empty folder path (the vault root, opened with
 * no sub-path) matches everything, same as an explicit vault scope — `isPathWithinDirectory`
 * itself refuses to treat an empty directory as "everything", so that case is handled here first.
 */
export function isInScope(item: ScopeMatchable, scope: ResolveScope): boolean {
  switch (scope.type) {
    case 'vault':
      return true
    case 'file':
      return scope.fileId !== null && item.fileId === scope.fileId
    case 'folder':
      if (!scope.folderPath) return true
      return (
        isPathWithinDirectory(item.localPath, scope.folderPath) ||
        isPathWithinDirectory(item.serverPath, scope.folderPath)
      )
  }
}

export function filterByScope<T extends ScopeMatchable>(items: T[], scope: ResolveScope): T[] {
  return items.filter((item) => isInScope(item, scope))
}

/** The parent folder of a relative path, `''` for a root-level file. */
function parentFolderOf(relativePath: string): string {
  const normalized = toForwardSlash(relativePath)
  const separatorIndex = normalized.lastIndexOf('/')
  return separatorIndex === -1 ? '' : normalized.slice(0, separatorIndex)
}

/**
 * The scope type the dialog should open with, given the file or folder it was opened from.
 * A folder badge opens scoped to that folder; a file's context-menu item opens scoped to that
 * file; no context (should not normally happen) falls back to the vault.
 */
export function inferDefaultScopeType(contextFile: LocalFile | null): ResolveScopeType {
  if (!contextFile) return 'vault'
  return contextFile.isDirectory ? 'folder' : 'file'
}

/** Build the concrete scope for the currently selected scope type and opening context. */
export function buildScope(scopeType: ResolveScopeType, contextFile: LocalFile | null): ResolveScope {
  if (scopeType === 'file') {
    return { type: 'file', fileId: contextFile?.pdmData?.id ?? null }
  }

  if (scopeType === 'folder') {
    const folderPath = contextFile
      ? contextFile.isDirectory
        ? contextFile.relativePath
        : parentFolderOf(contextFile.relativePath)
      : ''
    return { type: 'folder', folderPath }
  }

  return { type: 'vault' }
}
