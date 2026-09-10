/**
 * Local Sync Index - IndexedDB-based tracking of previously synced files
 *
 * This module tracks which files have been synced to each vault. When a file
 * exists locally but is not on the server AND is in the sync index, it means
 * another user deleted it from the vault - these are "orphaned" files.
 *
 * This allows distinguishing between:
 * - Files the user created locally (genuinely new) - NOT in sync index
 * - Files that were previously synced but deleted by another user (orphaned) - IN sync index
 *
 * The sync index is updated when:
 * - Files are synced (first check-in)
 * - Files are downloaded
 * - Files are checked out
 * - Server file list is loaded (all server files are marked as "known synced")
 * - Files are deleted from server (removed from index)
 * - Orphaned files are discarded (removed from index)
 *
 * A path that leaves the server while the file is still on disk is kept as a
 * tombstone rather than pruned, because "was previously synced" is the only
 * evidence that distinguishes an orphan from a file the user authored. Without it
 * the answer survived exactly one load after the server row disappeared.
 */

import { log } from '@/lib/logger'

const DB_NAME = 'blueplm-sync-index'
const DB_VERSION = 3
const STORE_NAME = 'sync-index'

/**
 * How long a tombstone keeps asserting that a path was once synced.
 *
 * The assertion is what allows the file to be deleted from disk, so it must not
 * outlive the confidence behind it: after a month unaddressed, the likelier reading
 * of a local file at a path the server dropped is that the path was reused. Expiry
 * reclassifies the file as 'added', which is the direction that leaves work in place.
 */
const ORPHAN_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface SyncIndexEntry {
  key: string // vaultId:relativePath (compound key)
  vaultId: string
  relativePath: string // lowercase for case-insensitive matching
  lastSyncedAt: number // timestamp
  ino?: number // NTFS file index number (survives renames)
  localVersion?: number // last known synced version (survives app restart)
  localHash?: string // last known content hash (survives app restart)
  // Path the index knows only from local state: the old server path of a file moved
  // on disk, or its new local path before the move reaches the server. Carrying the
  // inode at both paths is what keeps rename detection working across loads, so these
  // entries must survive the server prune - but they are not evidence of a sync, so
  // orphan detection must never see them.
  localOnly?: boolean
  // When this path was first observed missing from the server while the file was still
  // on disk. Set only for paths that were server-backed, so it means "the server row
  // for a file we hold went away", not "this path is unknown to the server".
  orphanedAt?: number
}

/** What the loader needs about a path the sync index knows. */
export interface SyncIndexPathInfo {
  /** Set only on tombstoned paths: when the server row was first seen gone. */
  orphanedAt?: number
}

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * Open or create the IndexedDB database
 */
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      log.error('[SyncIndex]', 'Failed to open IndexedDB', { error: request.error })
      reject(request.error)
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      // Non-destructive: only create the store if it doesn't exist.
      // New optional fields (localVersion, localHash) don't need schema changes
      // because IndexedDB records are schemaless.
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' })
        store.createIndex('vaultId', 'vaultId', { unique: false })
        store.createIndex('relativePath', 'relativePath', { unique: false })
      }
    }
  })

  return dbPromise
}

/**
 * Generate compound key for sync index entry
 */
function makeKey(vaultId: string, relativePath: string): string {
  return `${vaultId}:${relativePath.toLowerCase()}`
}

/**
 * Get the sync index for a vault - previously synced paths (lowercase) keyed for
 * `has()` lookups, with tombstone detail for the paths that carry it.
 * This is the main function used during file loading to detect orphaned files.
 *
 * Local-only paths are excluded: they record an inode for rename detection, not a
 * sync, and treating one as evidence of a sync would classify a moved file as an
 * orphan. Tombstones past their TTL are excluded for the same reason the prune
 * would drop them on the next write.
 */
export async function getSyncIndex(vaultId: string): Promise<Map<string, SyncIndexPathInfo>> {
  try {
    const db = await openDB()

    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const index = store.index('vaultId')
      const request = index.getAll(IDBKeyRange.only(vaultId))

      request.onsuccess = () => {
        const entries = request.result as SyncIndexEntry[]
        const now = Date.now()
        const paths = new Map<string, SyncIndexPathInfo>()
        let tombstoned = 0

        for (const entry of entries) {
          if (entry.localOnly) continue
          if (entry.orphanedAt !== undefined) {
            if (now - entry.orphanedAt > ORPHAN_TOMBSTONE_TTL_MS) continue
            tombstoned++
          }
          paths.set(entry.relativePath, { orphanedAt: entry.orphanedAt })
        }

        log.info(
          '[SyncIndex]',
          `Loaded ${paths.size} synced paths (${tombstoned} orphan tombstones) for vault ${vaultId}`,
        )
        resolve(paths)
      }

      request.onerror = () => {
        log.error('[SyncIndex]', 'Failed to read sync index', { error: request.error })
        resolve(new Map())
      }
    })
  } catch (error) {
    log.error('[SyncIndex]', 'Error reading sync index', { error })
    return new Map()
  }
}

/**
 * Add paths to the sync index for a vault.
 * Called after successful sync, download, checkout, or when loading server files.
 *
 * @param vaultId - The vault ID
 * @param paths - Array of relative paths (will be lowercased for storage)
 */
export async function addToSyncIndex(vaultId: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return

  try {
    const db = await openDB()
    const now = Date.now()

    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)

      let completed = 0
      let errors = 0

      for (const path of paths) {
        const normalizedPath = path.toLowerCase()
        const entry: SyncIndexEntry = {
          key: makeKey(vaultId, path),
          vaultId,
          relativePath: normalizedPath,
          lastSyncedAt: now,
        }

        const request = store.put(entry)
        request.onsuccess = () => {
          completed++
          if (completed + errors === paths.length) {
            log.info('[SyncIndex]', `Added ${completed} paths to sync index for vault ${vaultId}`)
            resolve()
          }
        }
        request.onerror = () => {
          errors++
          if (completed + errors === paths.length) {
            if (errors > 0) {
              log.warn('[SyncIndex]', `Added ${completed} paths with ${errors} errors`)
            }
            resolve()
          }
        }
      }
    })
  } catch (error) {
    log.error('[SyncIndex]', 'Error adding to sync index', { error })
  }
}

/**
 * Remove paths from the sync index for a vault.
 * Called when files are deleted from server or when orphaned files are discarded.
 *
 * @param vaultId - The vault ID
 * @param paths - Array of relative paths to remove
 */
export async function removeFromSyncIndex(vaultId: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return

  try {
    const db = await openDB()

    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)

      let completed = 0
      let errors = 0

      for (const path of paths) {
        const key = makeKey(vaultId, path)
        const request = store.delete(key)

        request.onsuccess = () => {
          completed++
          if (completed + errors === paths.length) {
            log.info(
              '[SyncIndex]',
              `Removed ${completed} paths from sync index for vault ${vaultId}`,
            )
            resolve()
          }
        }
        request.onerror = () => {
          errors++
          if (completed + errors === paths.length) {
            resolve()
          }
        }
      }
    })
  } catch (error) {
    log.error('[SyncIndex]', 'Error removing from sync index', { error })
  }
}

/**
 * Clear the entire sync index for a vault.
 * Called when a vault is disconnected.
 *
 * @param vaultId - The vault ID to clear
 */
export async function clearSyncIndex(vaultId: string): Promise<void> {
  try {
    const db = await openDB()

    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const index = store.index('vaultId')

      // First get all keys for this vault
      const keysRequest = index.getAllKeys(IDBKeyRange.only(vaultId))

      keysRequest.onsuccess = () => {
        const keys = keysRequest.result

        if (keys.length === 0) {
          log.info('[SyncIndex]', `No entries to clear for vault ${vaultId}`)
          resolve()
          return
        }

        let deleted = 0
        for (const key of keys) {
          const deleteRequest = store.delete(key)
          deleteRequest.onsuccess = () => {
            deleted++
            if (deleted === keys.length) {
              log.info('[SyncIndex]', `Cleared ${deleted} entries for vault ${vaultId}`)
              resolve()
            }
          }
          deleteRequest.onerror = () => {
            deleted++
            if (deleted === keys.length) {
              resolve()
            }
          }
        }
      }

      keysRequest.onerror = () => {
        log.error('[SyncIndex]', 'Failed to get keys for clearing', { error: keysRequest.error })
        resolve()
      }
    })
  } catch (error) {
    log.error('[SyncIndex]', 'Error clearing sync index', { error })
  }
}

/**
 * Bulk update the sync index with all server files.
 * This is an optimized version that replaces the entire index for a vault.
 * Called during file loading to ensure all server files are tracked.
 *
 * A path that is no longer on the server is either dropped or tombstoned, depending
 * on whether the file is still on disk. Callers that cannot say what is on disk get
 * the plain drop, so a caller with a partial view can never tombstone.
 *
 * @param vaultId - The vault ID
 * @param serverPaths - Array of all server file paths
 * @param localPaths - Lowercased relative paths present on disk, from a complete scan
 */
export async function updateSyncIndexFromServer(
  vaultId: string,
  serverPaths: string[],
  localPaths?: ReadonlySet<string>,
): Promise<void> {
  if (serverPaths.length === 0) return

  try {
    const db = await openDB()
    const now = Date.now()

    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const vaultIndex = store.index('vaultId')

      // Pre-read existing entries to preserve ino, localVersion, and localHash values.
      // store.put() replaces the entire record, so without this those fields
      // would be wiped on every load.
      const existingRequest = vaultIndex.getAll(IDBKeyRange.only(vaultId))
      existingRequest.onsuccess = () => {
        const existingEntries = existingRequest.result as SyncIndexEntry[]
        const existingDataMap = new Map<
          string,
          { ino?: number; localVersion?: number; localHash?: string }
        >()
        for (const e of existingEntries) {
          if (e.ino || e.localVersion !== undefined || e.localHash) {
            existingDataMap.set(e.key, {
              ino: e.ino,
              localVersion: e.localVersion,
              localHash: e.localHash,
            })
          }
        }

        // Resolve entries whose paths are no longer on the server. Stale paths
        // accumulate from renames and prevent correct inode detection, so most are
        // dropped - but a path whose file is still on disk is the only record that
        // the file was ever synced, and dropping it makes an orphan indistinguishable
        // from a file the user authored.
        const serverKeySet = new Set(serverPaths.map((p) => makeKey(vaultId, p)))
        let tombstonesCreated = 0
        let tombstonesDropped = 0

        for (const existing of existingEntries) {
          if (serverKeySet.has(existing.key)) continue

          // Owned by rename detection, which needs the inode at both paths. The prune
          // and updateInodes used to delete and recreate these on every load.
          if (existing.localOnly) continue

          // Gone from disk as well: nothing left to classify, and keeping the record
          // would make a future file at this path look like an orphan.
          if (!localPaths?.has(existing.relativePath)) {
            store.delete(existing.key)
            if (existing.orphanedAt !== undefined) tombstonesDropped++
            continue
          }

          if (existing.orphanedAt === undefined) {
            store.put({ ...existing, orphanedAt: now })
            tombstonesCreated++
          } else if (now - existing.orphanedAt > ORPHAN_TOMBSTONE_TTL_MS) {
            store.delete(existing.key)
            tombstonesDropped++
          }
        }

        let completed = 0

        for (const path of serverPaths) {
          const key = makeKey(vaultId, path)
          const existingData = existingDataMap.get(key)
          // Rebuilt from scratch, so a path back on the server loses both localOnly
          // and orphanedAt. That is the exit for a reconciled move and for a file
          // another user restored, and it is why a stored flag is never authoritative.
          const entry: SyncIndexEntry = {
            key,
            vaultId,
            relativePath: path.toLowerCase(),
            lastSyncedAt: now,
            ino: existingData?.ino,
            localVersion: existingData?.localVersion,
            localHash: existingData?.localHash,
          }

          const request = store.put(entry)
          request.onsuccess = () => {
            completed++
            if (completed === serverPaths.length) {
              log.info(
                '[SyncIndex]',
                `Updated sync index with ${serverPaths.length} server paths`,
                {
                  tombstonesCreated,
                  tombstonesDropped,
                },
              )
              resolve()
            }
          }
          request.onerror = () => {
            completed++
            if (completed === serverPaths.length) {
              resolve()
            }
          }
        }
      }

      existingRequest.onerror = () => {
        log.error(
          '[SyncIndex]',
          'Failed to pre-read existing entries, falling back to no-ino update',
        )
        let completed = 0
        for (const path of serverPaths) {
          const entry: SyncIndexEntry = {
            key: makeKey(vaultId, path),
            vaultId,
            relativePath: path.toLowerCase(),
            lastSyncedAt: now,
          }
          const request = store.put(entry)
          request.onsuccess = () => {
            completed++
            if (completed === serverPaths.length) resolve()
          }
          request.onerror = () => {
            completed++
            if (completed === serverPaths.length) resolve()
          }
        }
      }
    })
  } catch (error) {
    log.error('[SyncIndex]', 'Error updating sync index from server', { error })
  }
}

/**
 * Check if a specific path is in the sync index for a vault.
 *
 * @param vaultId - The vault ID
 * @param relativePath - The relative path to check
 * @returns True if the path was previously synced
 */
export async function isInSyncIndex(vaultId: string, relativePath: string): Promise<boolean> {
  try {
    const db = await openDB()

    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const key = makeKey(vaultId, relativePath)
      const request = store.get(key)

      request.onsuccess = () => {
        resolve(!!request.result)
      }

      request.onerror = () => {
        log.error('[SyncIndex]', 'Failed to check sync index', { error: request.error })
        resolve(false)
      }
    })
  } catch (error) {
    log.error('[SyncIndex]', 'Error checking sync index', { error })
    return false
  }
}

/**
 * Get a map of inode -> relativePath for all entries that have an inode recorded.
 * Used during file loading for rename detection: if a local file's inode matches
 * a previously-synced path's inode, it was renamed (not a new file).
 */
export async function getInodeMap(vaultId: string): Promise<Map<number, string[]>> {
  try {
    const db = await openDB()

    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const index = store.index('vaultId')
      const request = index.getAll(IDBKeyRange.only(vaultId))

      request.onsuccess = () => {
        const entries = request.result as SyncIndexEntry[]
        const map = new Map<number, string[]>()
        for (const entry of entries) {
          if (entry.ino && entry.ino > 0) {
            const existing = map.get(entry.ino)
            if (existing) {
              existing.push(entry.relativePath)
            } else {
              map.set(entry.ino, [entry.relativePath])
            }
          }
        }
        log.info(
          '[SyncIndex]',
          `Loaded inode map: ${map.size} entries with inodes for vault ${vaultId}`,
        )
        resolve(map)
      }

      request.onerror = () => {
        log.error('[SyncIndex]', 'Failed to read inode map', { error: request.error })
        resolve(new Map())
      }
    })
  } catch (error) {
    log.error('[SyncIndex]', 'Error reading inode map', { error })
    return new Map()
  }
}

/**
 * Batch-update inodes (and optionally localVersion/localHash) for sync index entries.
 * Called after file loading to persist the current inode for each matched file,
 * so the next load can use inodes for rename detection and version/hash for
 * accurate outdated status on app restart.
 *
 * Creates new entries if none exist (upsert) so files from any entry path
 * (SolidWorks DM API extension, manual copy, etc.) get inode tracking.
 *
 * `localOnly` must be passed for every entry whose path is not on the server on this
 * load, and left absent otherwise. It is derived per load and written unconditionally
 * so a path that becomes server-backed loses the flag; a stored flag is never trusted.
 */
export async function updateInodes(
  vaultId: string,
  entries: Array<{
    path: string
    ino: number
    localVersion?: number
    localHash?: string
    localOnly?: boolean
  }>,
): Promise<void> {
  if (entries.length === 0) return

  try {
    const db = await openDB()

    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)

      let completed = 0

      for (const { path, ino, localVersion, localHash, localOnly } of entries) {
        const key = makeKey(vaultId, path)
        const getRequest = store.get(key)

        getRequest.onsuccess = () => {
          completed++
          const existing = getRequest.result as SyncIndexEntry | undefined
          if (existing) {
            existing.ino = ino
            if (localVersion !== undefined) existing.localVersion = localVersion
            if (localHash !== undefined) existing.localHash = localHash
            if (localOnly) {
              existing.localOnly = true
            } else {
              delete existing.localOnly
            }
            store.put(existing)
          } else {
            const newEntry: SyncIndexEntry = {
              key,
              vaultId,
              relativePath: path.toLowerCase(),
              lastSyncedAt: Date.now(),
              ino,
              localVersion,
              localHash,
              localOnly,
            }
            store.put(newEntry)
          }
          if (completed === entries.length) {
            resolve()
          }
        }

        getRequest.onerror = () => {
          completed++
          if (completed === entries.length) {
            resolve()
          }
        }
      }
    })
  } catch (error) {
    log.error('[SyncIndex]', 'Error updating inodes', { error })
  }
}

/**
 * Get a map of relativePath -> { localVersion, localHash } for all entries that have
 * version or hash data. Used during file loading to restore version/hash state after
 * app restart, preventing false-positive "outdated" (purple) highlights.
 */
export async function getVersionMap(
  vaultId: string,
): Promise<Map<string, { localVersion?: number; localHash?: string }>> {
  try {
    const db = await openDB()

    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const index = store.index('vaultId')
      const request = index.getAll(IDBKeyRange.only(vaultId))

      request.onsuccess = () => {
        const entries = request.result as SyncIndexEntry[]
        const map = new Map<string, { localVersion?: number; localHash?: string }>()
        for (const entry of entries) {
          if (entry.localVersion !== undefined || entry.localHash) {
            map.set(entry.relativePath, {
              localVersion: entry.localVersion,
              localHash: entry.localHash,
            })
          }
        }
        log.info(
          '[SyncIndex]',
          `Loaded version map: ${map.size} entries with version/hash data for vault ${vaultId}`,
        )
        resolve(map)
      }

      request.onerror = () => {
        log.error('[SyncIndex]', 'Failed to read version map', { error: request.error })
        resolve(new Map())
      }
    })
  } catch (error) {
    log.error('[SyncIndex]', 'Error reading version map', { error })
    return new Map()
  }
}

/**
 * Get statistics about the sync index for a vault.
 * Useful for debugging and UI display.
 */
export async function getSyncIndexStats(
  vaultId: string,
): Promise<{ count: number; oldestSync: number | null; newestSync: number | null }> {
  try {
    const db = await openDB()

    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const index = store.index('vaultId')
      const request = index.getAll(IDBKeyRange.only(vaultId))

      request.onsuccess = () => {
        const entries = request.result as SyncIndexEntry[]
        if (entries.length === 0) {
          resolve({ count: 0, oldestSync: null, newestSync: null })
          return
        }

        let oldest = entries[0].lastSyncedAt
        let newest = entries[0].lastSyncedAt

        for (const entry of entries) {
          if (entry.lastSyncedAt < oldest) oldest = entry.lastSyncedAt
          if (entry.lastSyncedAt > newest) newest = entry.lastSyncedAt
        }

        resolve({
          count: entries.length,
          oldestSync: oldest,
          newestSync: newest,
        })
      }

      request.onerror = () => {
        resolve({ count: 0, oldestSync: null, newestSync: null })
      }
    })
  } catch (error) {
    log.error('[SyncIndex]', 'Error getting stats', { error })
    return { count: 0, oldestSync: null, newestSync: null }
  }
}
