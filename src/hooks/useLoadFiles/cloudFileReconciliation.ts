// Extracted from useLoadFiles.ts per the TODO(decompose) marker that used to sit at
// its call site (originally lines ~1511-1638). Pure function: no IPC, no store
// access, and no `window.electronAPI` calls other than logging.

import { buildFullPath } from '@/lib/commands/types'
import type { CachedServerFile } from '@/lib/cache/vaultFileCache'
import type { LocalFile } from '@/stores/types'
import { isCheckoutProfileForOwner, reconcileCheckoutProfile } from '@/types/pdm'
import type { CheckoutUserProfile, PDMFile } from '@/types/pdm'

/**
 * Inputs the cloud-file reconciliation pass needs from the merge that has already
 * matched every local file it can against the server list.
 */
export interface CloudFileReconciliationParams {
  /** Every file the server currently records for this vault. */
  pdmFiles: CachedServerFile[]
  /** The merged local file list, after the primary local/server match pass. */
  localFiles: LocalFile[]
  /** Lower-cased relative paths present on local disk. */
  localPathSet: ReadonlySet<string>
  /** Lower-cased server paths already claimed by an inode-based rename match,
   * built alongside `inodeRenameMap` in `useLoadFiles.ts`. */
  inodeMatchedServerPaths: ReadonlySet<string>
  /** Reverse of `inodeMatchedServerPaths`: lower-cased server path -> the local
   * file's actual (non-lower-cased) relative path that claimed it via inode match.
   * Required to know where a `moved_away` stub should point. */
  inodeMatchedServerPathToLocalPath: ReadonlyMap<string, string>
  /** Checkout profile enrichment preserved from the previous render, keyed by
   * `files.id`, so a cloud-only or moved-away row does not lose a profile it
   * already resolved. */
  existingCheckedOutUsers: ReadonlyMap<string, CheckoutUserProfile>
  /** Current user id, to distinguish "I deleted this" from a genuine cloud file. */
  userId: string | undefined
  /** Absolute vault root, for building each injected row's absolute path. */
  vaultPath: string
  /** Cooperative yield gate so a large vault does not block the main thread. */
  yieldIfSlow: () => Promise<void>
  /** Items processed between yield checks. */
  yieldCheckStride: number
}

export interface CloudFileReconciliationResult {
  /** `localFiles`, with cloud-only, moved-away, and ghost-orphan matches applied. */
  localFiles: LocalFile[]
  /** Folder paths implied by an injected cloud-only or moved-away file that do not
   * already exist locally - consumed by the caller's auto-create-folders step. */
  cloudFolders: Set<string>
}

/**
 * Cloud-file reconciliation — the second half of the local/server merge.
 *
 * Walks the server's file list once more, for every row the primary pass did not
 * match to a local file, and either:
 *  - Suppresses it, when a hash-based move already accounts for its content at an
 *    unknown local destination (no local evidence names *which* file claimed it).
 *  - Emits a `moved_away` stub at the server's path, when an inode-based rename
 *    match upstream *does* know the destination - so the vault's own record of
 *    this path is never silently emptied (see the plan's D1).
 *  - Otherwise adds it as a `cloud` (downloadable) or `deleted` (ghost, checked out
 *    by me but missing locally) placeholder, as before.
 *
 * Finally cross-references any remaining ghost against an orphan (local file, no
 * server match) in the same folder and extension, auto-matching the pair when
 * there is exactly one candidate on each side - a safety net for renames the
 * inode/hash passes missed.
 */
export async function reconcileCloudFiles(
  params: CloudFileReconciliationParams,
): Promise<CloudFileReconciliationResult> {
  const {
    pdmFiles,
    localPathSet,
    inodeMatchedServerPaths,
    inodeMatchedServerPathToLocalPath,
    existingCheckedOutUsers,
    userId,
    vaultPath,
    yieldIfSlow,
    yieldCheckStride,
  } = params

  let localFiles = params.localFiles
  const cloudFolders = new Set<string>()

  // Local content hashes let us recognise a hash-based move (no inode evidence)
  // and skip re-adding its old server row.
  const localContentHashes = new Set(
    localFiles.filter((f) => !f.isDirectory && f.localHash).map((f) => f.localHash),
  )

  const registerCloudFolderAncestors = (filePath: string): void => {
    const pathParts = filePath.split('/')
    let currentPath = ''
    for (let i = 0; i < pathParts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${pathParts[i]}` : pathParts[i]
      if (!localPathSet.has(currentPath.toLowerCase()) && !cloudFolders.has(currentPath)) {
        cloudFolders.add(currentPath)
      }
    }
  }

  let cloudScanIndex = 0
  for (const pdmFile of pdmFiles) {
    if (cloudScanIndex++ % yieldCheckStride === yieldCheckStride - 1) {
      await yieldIfSlow()
    }

    if (localPathSet.has(pdmFile.file_path.toLowerCase())) continue

    const serverPathLower = pdmFile.file_path.toLowerCase()
    const isCheckedOutByMe = pdmFile.checked_out_by === userId
    const wasMoved = pdmFile.content_hash && localContentHashes.has(pdmFile.content_hash)
    const wasInodeRenamed = inodeMatchedServerPaths.has(serverPathLower)

    // Hash-only move: the content exists locally at some other path, but nothing
    // upstream recorded exactly which file claimed it, so there is no destination
    // to point a stub at. The file is handled entirely at its new location.
    if (wasMoved) continue

    if (wasInodeRenamed) {
      const movedToRelativePath = inodeMatchedServerPathToLocalPath.get(serverPathLower)
      // inodeMatchedServerPaths and inodeMatchedServerPathToLocalPath are built
      // together upstream from the same loop, so this should always resolve. If it
      // somehow doesn't, fall back to the pre-4.3.3 suppress-only behaviour rather
      // than emit a stub with no destination to render.
      if (movedToRelativePath) {
        registerCloudFolderAncestors(pdmFile.file_path)

        const preservedUserInfo = existingCheckedOutUsers.get(pdmFile.id)
        const stubServerFile = pdmFile as unknown as PDMFile
        const stubPdmData = reconcileCheckoutProfile(
          stubServerFile,
          isCheckoutProfileForOwner(preservedUserInfo, stubServerFile.checked_out_by)
            ? preservedUserInfo
            : stubServerFile.checked_out_user,
        )

        localFiles.push({
          name: pdmFile.file_name,
          path: buildFullPath(vaultPath, pdmFile.file_path),
          relativePath: pdmFile.file_path,
          isDirectory: false,
          extension: pdmFile.extension || '',
          size: pdmFile.file_size || 0,
          modifiedTime: pdmFile.updated_at || '',
          pdmData: stubPdmData,
          isSynced: false,
          diffStatus: 'moved_away',
          movedToRelativePath,
        })
      }
      continue
    }

    // Neither move signal fired - a genuine cloud-only file (or, if I had it
    // checked out, a ghost of one I deleted/moved without either signal catching it).
    const isDeletedByMe = isCheckedOutByMe

    registerCloudFolderAncestors(pdmFile.file_path)

    const preservedCloudUserInfo = existingCheckedOutUsers.get(pdmFile.id)
    const cloudPdmFile = pdmFile as unknown as PDMFile
    const cloudFilePdmData = reconcileCheckoutProfile(
      cloudPdmFile,
      isCheckoutProfileForOwner(preservedCloudUserInfo, cloudPdmFile.checked_out_by)
        ? preservedCloudUserInfo
        : cloudPdmFile.checked_out_user,
    )

    localFiles.push({
      name: pdmFile.file_name,
      path: buildFullPath(vaultPath, pdmFile.file_path),
      relativePath: pdmFile.file_path,
      isDirectory: false,
      extension: pdmFile.extension || '',
      size: pdmFile.file_size || 0,
      modifiedTime: pdmFile.updated_at || '',
      pdmData: cloudFilePdmData,
      isSynced: false, // Not synced locally
      diffStatus: isDeletedByMe ? 'deleted' : 'cloud', // Deleted if I moved/removed it, otherwise cloud
    })
  }

  // --- Ghost-orphan cross-referencing (safety net) ---
  // If inode detection missed a rename, we may have a ghost (server file, no local)
  // AND an orphan (local file, no server match) in the same folder with the same
  // extension. Auto-match them to prevent the ghost/orphan pair from persisting.
  const ghostFiles = localFiles.filter(
    (f) => f.diffStatus === 'deleted' && f.pdmData && !f.isDirectory,
  )
  const orphanFiles = localFiles.filter(
    (f) => f.diffStatus === 'deleted_remote' && !f.isDirectory,
  )

  if (ghostFiles.length > 0 && orphanFiles.length > 0) {
    const orphansByFolderExt = new Map<string, (typeof localFiles)[number][]>()
    for (const orphan of orphanFiles) {
      const folder = orphan.relativePath
        .substring(0, orphan.relativePath.lastIndexOf('/'))
        .toLowerCase()
      const ext = (orphan.extension || '').toLowerCase()
      const key = `${folder}|${ext}`
      const list = orphansByFolderExt.get(key) || []
      list.push(orphan)
      orphansByFolderExt.set(key, list)
    }

    for (const ghost of ghostFiles) {
      const folder = ghost.relativePath
        .substring(0, ghost.relativePath.lastIndexOf('/'))
        .toLowerCase()
      const ext = (ghost.extension || '').toLowerCase()
      const candidates = orphansByFolderExt.get(`${folder}|${ext}`)
      if (candidates && candidates.length === 1) {
        const orphan = candidates[0]
        window.electronAPI?.log('info', '[LoadFiles] Ghost-orphan cross-reference match', {
          ghostPath: ghost.relativePath,
          orphanPath: orphan.relativePath,
        })
        orphan.pdmData = ghost.pdmData
        orphan.diffStatus = 'moved'
        orphan.isSynced = true
        ghost.diffStatus = 'cloud'
        ghost.pdmData = { ...ghost.pdmData, _suppressedByOrphanMatch: true } as any // TODO: type this
        candidates.length = 0
      }
    }

    localFiles = localFiles.filter((f) => !(f.pdmData as any)?._suppressedByOrphanMatch) // TODO: type this
  }

  return { localFiles, cloudFolders }
}
