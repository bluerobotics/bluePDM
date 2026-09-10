/**
 * Folder Operations
 *
 * Functions for syncing folder structures to the server.
 * Folders are synced immediately when created to ensure team visibility.
 */

import { escapeLikePattern, folderPrefixLikePattern } from '@/lib/utils/likePattern'

import { getSupabaseClient } from '../client'

// ============================================
// Types
// ============================================

export interface FolderRecord {
  id: string
  org_id: string
  vault_id: string
  folder_path: string
  created_by: string | null
  created_at: string
  deleted_at: string | null
  deleted_by: string | null
}

// ============================================
// Helper Functions
// ============================================

function getLogFn(): (level: string, msg: string, data?: any) => void {
  return typeof window !== 'undefined' && (window as any).electronAPI?.log // TODO: type this
    ? (level: string, msg: string, data?: any) => (window as any).electronAPI.log(level, msg, data) // TODO: type this
    : () => {}
}

/**
 * Find the active folder row whose path matches `folderPath` case-insensitively.
 *
 * Folder matching has to be case-insensitive: Windows treats `RADCAM` and
 * `Radcam` as one folder, every consumer of this table keys on
 * `folder_path.toLowerCase()`, and `idx_folders_unique_active` is unique on
 * `LOWER(folder_path)`, so a byte-exact `.eq()` or `.like()` misses rows whose
 * stored spelling differs from the one the caller happens to hold. PostgREST
 * has no case-insensitive equality operator, so the only way there is `.ilike()`
 * - which reads `%` and `_` as wildcards, and `_` in particular is common in a
 * folder name, hence escapeLikePattern on every path that becomes a pattern.
 *
 * The pattern carries no wildcards of its own - this is an exact match compared
 * without regard to case, not a prefix match - so `Part_Files` cannot match
 * `PartXFiles`.
 *
 * Deliberately neither `.single()` nor `.maybeSingle()`. Both ask PostgREST for
 * exactly one row, and a case-insensitive comparison can legitimately match two
 * on a database that predates `idx_folders_unique_active` being unique on
 * `LOWER(folder_path)`, or one that has drifted since: `RADCAM` and `Radcam`
 * were two active rows for one Windows folder, and one production vault carried
 * twenty such pairs. postgrest-js reports that with the same `PGRST116` code it
 * uses for no rows at all, so a caller that reads `PGRST116` as "absent" would
 * take two rows for zero, insert, and fail on the unique index. Ordering plus a
 * limit answers with one row whatever the table holds, and the order follows
 * `remediate_case_colliding_folders()`'s survivor rule as closely as the client
 * can - oldest first, lowest id to break the tie - so two machines looking at
 * the same collision agree on which row they mean.
 */
async function findActiveFolderByPath(
  client: ReturnType<typeof getSupabaseClient>,
  vaultId: string,
  folderPath: string,
) {
  const { data, error } = await client
    .from('folders')
    .select('*')
    .eq('vault_id', vaultId)
    .ilike('folder_path', escapeLikePattern(folderPath))
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)

  return { folder: (data?.[0] as FolderRecord | undefined) ?? null, error }
}

// ============================================
// Sync Operations
// ============================================

/**
 * Sync a folder to the server (create if doesn't exist).
 * Uses upsert pattern - returns existing record if folder already exists.
 *
 * Also syncs all parent folders to ensure path hierarchy exists.
 *
 * @param orgId - Organization ID
 * @param vaultId - Vault ID
 * @param userId - User creating the folder
 * @param folderPath - Relative path (e.g., "Assemblies" or "Project/Assemblies")
 */
export async function syncFolder(
  orgId: string,
  vaultId: string,
  userId: string,
  folderPath: string,
): Promise<{ folder: FolderRecord | null; error: any }> {
  const client = getSupabaseClient()
  const logFn = getLogFn()

  // Normalize path: use forward slashes, no leading/trailing slashes
  const normalizedPath = folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

  logFn('debug', '[syncFolder] Starting sync', { orgId, vaultId, folderPath: normalizedPath })

  try {
    // First, sync all parent folders to ensure hierarchy exists
    const pathParts = normalizedPath.split('/')
    for (let i = 1; i < pathParts.length; i++) {
      const parentPath = pathParts.slice(0, i).join('/')
      await syncSingleFolder(client, orgId, vaultId, userId, parentPath, logFn)
    }

    // Now sync the target folder
    const result = await syncSingleFolder(client, orgId, vaultId, userId, normalizedPath, logFn)
    return result
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logFn('error', '[syncFolder] Exception', { folderPath: normalizedPath, error: errMsg })
    return { folder: null, error }
  }
}

/**
 * Internal helper to sync a single folder (no parent handling)
 */
async function syncSingleFolder(
  client: ReturnType<typeof getSupabaseClient>,
  orgId: string,
  vaultId: string,
  userId: string,
  folderPath: string,
  logFn: (level: string, msg: string, data?: any) => void,
): Promise<{ folder: FolderRecord | null; error: any }> {
  // Check if folder already exists (active, not deleted)
  const { folder: existing, error: fetchError } = await findActiveFolderByPath(
    client,
    vaultId,
    folderPath,
  )

  if (fetchError && fetchError.code !== 'PGRST116') {
    // PGRST116 = no rows returned (expected if folder doesn't exist)
    logFn('error', '[syncFolder] Fetch error', { folderPath, error: fetchError.message })
    return { folder: null, error: fetchError }
  }

  if (existing) {
    logFn('debug', '[syncFolder] Folder already exists', { folderPath, id: existing.id })
    return { folder: existing, error: null }
  }

  // Create new folder record
  const { data: newFolder, error: insertError } = await client
    .from('folders')
    .insert({
      org_id: orgId,
      vault_id: vaultId,
      folder_path: folderPath,
      created_by: userId,
    })
    .select()
    .single()

  if (insertError) {
    // Handle race condition: folder might have been created by another user
    if (insertError.code === '23505') {
      logFn('debug', '[syncFolder] Folder created by another user (race condition)', { folderPath })
      // Fetch the existing record
      const { folder: raceFolder, error: raceFetchError } = await findActiveFolderByPath(
        client,
        vaultId,
        folderPath,
      )
      if (raceFolder) {
        return { folder: raceFolder, error: null }
      }
      // idx_folders_unique_active is partial on `deleted_at IS NULL`, so 23505
      // said an active row for this path exists in some spelling. Not reading it
      // back means something else went wrong - the row was trashed in between,
      // or the re-fetch itself failed - and answering `{ folder: null, error:
      // null }` is what made that invisible: the directory watcher logs only
      // `if (result.error)`, and fileOps leaves `folderPdmData` undefined, which
      // surfaces much later as a delete with no folder id to work from.
      logFn('warn', '[syncFolder] Unique violation but no active folder found', {
        vaultId,
        folderPath,
        insertError: insertError.message,
        fetchError: raceFetchError?.message,
      })
      return { folder: null, error: raceFetchError ?? insertError }
    }
    logFn('error', '[syncFolder] Insert error', { folderPath, error: insertError.message })
    return { folder: null, error: insertError }
  }

  logFn('info', '[syncFolder] Created folder', { folderPath, id: newFolder.id })
  return { folder: newFolder as FolderRecord, error: null }
}

// ============================================
// Query Operations
// ============================================

/**
 * Get all active (non-deleted) folders for a vault.
 *
 * @param vaultId - Vault ID
 */
export async function getVaultFolders(
  vaultId: string,
): Promise<{ folders: FolderRecord[]; error?: string }> {
  const client = getSupabaseClient()
  const logFn = getLogFn()

  logFn('debug', '[getVaultFolders] Fetching folders', { vaultId })

  try {
    const { data, error } = await client
      .from('folders')
      .select('*')
      .eq('vault_id', vaultId)
      .is('deleted_at', null)
      .order('folder_path', { ascending: true })

    if (error) {
      logFn('error', '[getVaultFolders] Query error', { vaultId, error: error.message })
      return { folders: [], error: error.message }
    }

    logFn('debug', '[getVaultFolders] Found folders', { vaultId, count: data?.length || 0 })
    return { folders: (data || []) as FolderRecord[] }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logFn('error', '[getVaultFolders] Exception', { vaultId, error: errMsg })
    return { folders: [], error: errMsg }
  }
}

// ============================================
// Update Operations
// ============================================

/**
 * Update a folder's path (for rename/move operations).
 * Also updates all child folders' paths.
 *
 * @param folderId - Folder ID to update
 * @param newPath - New relative path
 */
export async function updateFolderServerPath(
  folderId: string,
  newPath: string,
): Promise<{ success: boolean; error?: string }> {
  const client = getSupabaseClient()
  const logFn = getLogFn()

  // Normalize path
  const normalizedPath = newPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

  logFn('debug', '[updateFolderServerPath] Updating folder path', {
    folderId,
    newPath: normalizedPath,
  })

  try {
    // Get the current folder to find its old path
    const { data: currentFolder, error: fetchError } = await client
      .from('folders')
      .select('folder_path, vault_id')
      .eq('id', folderId)
      .single()

    if (fetchError || !currentFolder) {
      logFn('error', '[updateFolderServerPath] Folder not found', {
        folderId,
        error: fetchError?.message,
      })
      return { success: false, error: fetchError?.message || 'Folder not found' }
    }

    const oldPath = currentFolder.folder_path

    // Update the folder itself
    const { error: updateError } = await client
      .from('folders')
      .update({ folder_path: normalizedPath })
      .eq('id', folderId)

    if (updateError) {
      logFn('error', '[updateFolderServerPath] Update error', {
        folderId,
        error: updateError.message,
      })
      return { success: false, error: updateError.message }
    }

    // Update all child folders' paths (folders that start with oldPath/)
    const { data: childFolders, error: childFetchError } = await client
      .from('folders')
      .select('id, folder_path')
      .eq('vault_id', currentFolder.vault_id)
      .ilike('folder_path', folderPrefixLikePattern(oldPath))
      .is('deleted_at', null)

    if (childFetchError) {
      logFn('warn', '[updateFolderServerPath] Failed to fetch child folders', {
        error: childFetchError.message,
      })
    } else if (childFolders && childFolders.length > 0) {
      // Update each child folder's path. Splicing off the old prefix by length
      // rather than calling String.replace(oldPath, ...): replace() with a
      // string argument rewrites the first occurrence anywhere in the path, so
      // renaming `Parts` rewrote the trailing segment of `Parts/Old/Parts`, and
      // it is case-sensitive besides. The ILIKE above matched a literal prefix,
      // so the first oldPath.length characters of each child are that prefix
      // whatever case they are stored in.
      for (const child of childFolders) {
        const newChildPath = normalizedPath + child.folder_path.slice(oldPath.length)
        await client.from('folders').update({ folder_path: newChildPath }).eq('id', child.id)
      }
      logFn('debug', '[updateFolderServerPath] Updated child folders', {
        count: childFolders.length,
      })
    }

    logFn('info', '[updateFolderServerPath] Folder path updated', {
      folderId,
      oldPath,
      newPath: normalizedPath,
    })
    return { success: true }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logFn('error', '[updateFolderServerPath] Exception', { folderId, error: errMsg })
    return { success: false, error: errMsg }
  }
}

// ============================================
// Delete Operations
// ============================================

/**
 * Soft delete a folder (set deleted_at timestamp).
 * Also soft deletes all child folders.
 *
 * @param folderId - Folder ID to delete
 * @param userId - User performing the deletion
 */
export async function deleteFolderOnServer(
  folderId: string,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  const client = getSupabaseClient()
  const logFn = getLogFn()

  logFn('debug', '[deleteFolderOnServer] Soft deleting folder', { folderId, userId })

  try {
    // Get the folder to find its path for child deletion
    const { data: folder, error: fetchError } = await client
      .from('folders')
      .select('folder_path, vault_id')
      .eq('id', folderId)
      .single()

    if (fetchError || !folder) {
      logFn('error', '[deleteFolderOnServer] Folder not found', {
        folderId,
        error: fetchError?.message,
      })
      return { success: false, error: fetchError?.message || 'Folder not found' }
    }

    const now = new Date().toISOString()

    // Soft delete the folder
    const { error: deleteError } = await client
      .from('folders')
      .update({
        deleted_at: now,
        deleted_by: userId,
      })
      .eq('id', folderId)

    if (deleteError) {
      logFn('error', '[deleteFolderOnServer] Delete error', {
        folderId,
        error: deleteError.message,
      })
      return { success: false, error: deleteError.message }
    }

    // Soft delete all child folders
    const { error: childDeleteError } = await client
      .from('folders')
      .update({
        deleted_at: now,
        deleted_by: userId,
      })
      .eq('vault_id', folder.vault_id)
      .ilike('folder_path', folderPrefixLikePattern(folder.folder_path))
      .is('deleted_at', null)

    if (childDeleteError) {
      logFn('warn', '[deleteFolderOnServer] Failed to delete child folders', {
        error: childDeleteError.message,
      })
    }

    logFn('info', '[deleteFolderOnServer] Folder soft deleted', {
      folderId,
      folderPath: folder.folder_path,
    })
    return { success: true }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logFn('error', '[deleteFolderOnServer] Exception', { folderId, error: errMsg })
    return { success: false, error: errMsg }
  }
}

/**
 * Delete a folder by path (for cases where we don't have the folder ID).
 * Useful when deleting local folders that may or may not be synced.
 *
 * @param vaultId - Vault ID
 * @param folderPath - Relative path of the folder
 * @param userId - User performing the deletion
 */
export async function deleteFolderByPath(
  vaultId: string,
  folderPath: string,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  const client = getSupabaseClient()
  const logFn = getLogFn()

  // Normalize path
  const normalizedPath = folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

  logFn('debug', '[deleteFolderByPath] Soft deleting folder by path', {
    vaultId,
    folderPath: normalizedPath,
  })

  try {
    const now = new Date().toISOString()

    // Soft delete the exact folder
    const { error: deleteError, count: exactCount } = await client
      .from('folders')
      .update(
        {
          deleted_at: now,
          deleted_by: userId,
        },
        { count: 'exact' },
      )
      .eq('vault_id', vaultId)
      .ilike('folder_path', escapeLikePattern(normalizedPath))
      .is('deleted_at', null)

    if (deleteError) {
      logFn('error', '[deleteFolderByPath] Delete error (exact match)', {
        folderPath: normalizedPath,
        error: deleteError.message,
      })
      return { success: false, error: deleteError.message }
    }

    // Soft delete all child folders (paths that start with normalizedPath/)
    const { error: childError, count: childCount } = await client
      .from('folders')
      .update(
        {
          deleted_at: now,
          deleted_by: userId,
        },
        { count: 'exact' },
      )
      .eq('vault_id', vaultId)
      .ilike('folder_path', folderPrefixLikePattern(normalizedPath))
      .is('deleted_at', null)

    if (childError) {
      logFn('warn', '[deleteFolderByPath] Failed to delete child folders', {
        folderPath: normalizedPath,
        error: childError.message,
      })
    }

    const totalCount = (exactCount || 0) + (childCount || 0)
    logFn('info', '[deleteFolderByPath] Folders soft deleted', {
      folderPath: normalizedPath,
      exactCount,
      childCount,
      totalCount,
    })
    return { success: true }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logFn('error', '[deleteFolderByPath] Exception', { folderPath, error: errMsg })
    return { success: false, error: errMsg }
  }
}
