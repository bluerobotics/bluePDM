import { recordMetric } from '@/lib/performanceMetrics'
import type { LoadFilesSessionContext } from '@/types/pdm'

/**
 * Cross-instance coordination state for `loadFiles`.
 *
 * Module-scoped rather than refs because `useLoadFiles` is instantiated by several
 * components, and silent watcher-driven refreshes never set `isLoading`, so there is
 * no other signal that a full scan and merge is already underway.
 */

export interface LoadFilesRequest {
  silent: boolean
  forceHashComputation: boolean
  /** Set when the file watcher supplied the specific paths that changed. */
  hasChangedPaths: boolean
  /** Auth boundary for callers that need session-scoped serialization. */
  authenticatedUserId?: LoadFilesSessionContext['authenticatedUserId']
  sessionGeneration?: LoadFilesSessionContext['sessionGeneration']
}

interface InFlightLoad {
  vaultId: string | undefined
  request: LoadFilesRequest
  promise: Promise<void>
}

let inFlightLoad: InFlightLoad | null = null
let currentSessionContext: LoadFilesSessionContext | undefined

interface LoadSessionBoundary {
  authenticatedUserId?: LoadFilesSessionContext['authenticatedUserId']
  sessionGeneration?: LoadFilesSessionContext['sessionGeneration']
}

function sessionContextMatches(active: LoadSessionBoundary, incoming: LoadSessionBoundary): boolean {
  return (
    active.authenticatedUserId === incoming.authenticatedUserId &&
    active.sessionGeneration === incoming.sessionGeneration
  )
}

function withCurrentSessionContext(request: LoadFilesRequest): LoadFilesRequest {
  return {
    ...request,
    authenticatedUserId:
      request.authenticatedUserId !== undefined
        ? request.authenticatedUserId
        : currentSessionContext?.authenticatedUserId,
    sessionGeneration:
      request.sessionGeneration !== undefined
        ? request.sessionGeneration
        : currentSessionContext?.sessionGeneration,
  }
}

/**
 * Publish the auth boundary used by legacy `useLoadFiles` callers that do not
 * pass a request object to this module. A changed boundary invalidates
 * per-vault merge shortcuts, while an in-flight pass is allowed to finish and
 * reject its own stale commit.
 */
export function setLoadFilesSessionContext(context: LoadFilesSessionContext): void {
  if (sessionContextMatches(currentSessionContext ?? {}, context)) return

  resetLoadFilesCoordination()
  currentSessionContext = { ...context }
}

/** Drop coordination state that belongs to a previous auth/session boundary. */
export function resetLoadFilesCoordination(): void {
  supersededLoads.clear()
  lastMergedState.clear()
}

/** True while a full loadFiles pass is running (including silent refreshes). */
export function isLoadFilesInFlight(): boolean {
  return inFlightLoad !== null
}

/**
 * Whether an already-running pass satisfies an incoming request, letting the caller
 * await it instead of starting a second scan. A force-hash pass covers a normal one
 * but not vice versa, and a silent pass does not cover a request that expects the
 * loading spinner.
 */
function inFlightCoversRequest(active: LoadFilesRequest, incoming: LoadFilesRequest): boolean {
  // A watcher-reported change may have landed after the running pass scanned that
  // path, so those requests always get their own pass rather than joining.
  if (incoming.hasChangedPaths) return false
  if (incoming.forceHashComputation && !active.forceHashComputation) return false
  if (!incoming.silent && active.silent) return false
  return true
}

/**
 * Serialize loadFiles passes.
 *
 * Two passes must never overlap: each does a full local scan plus a full server
 * merge, and the last setFiles wins, so concurrent passes burn the main thread twice
 * and can commit stale results. Requests that an in-flight pass already satisfies
 * join it; anything else queues behind it.
 */
export async function runExclusiveLoad(
  vaultId: string | undefined,
  request: LoadFilesRequest,
  start: () => Promise<void>,
): Promise<void> {
  const scopedRequest = withCurrentSessionContext(request)

  while (inFlightLoad) {
    const active = inFlightLoad
    if (
      active.vaultId === vaultId &&
      sessionContextMatches(active.request, scopedRequest) &&
      inFlightCoversRequest(active.request, scopedRequest)
    ) {
      window.electronAPI?.log('info', '[LoadFiles] Joining in-flight load', { ...scopedRequest })
      recordMetric('VaultLoad', 'Joined in-flight load', { ...scopedRequest })
      return active.promise
    }

    window.electronAPI?.log('info', '[LoadFiles] Queued behind in-flight load', {
      ...scopedRequest,
    })
    recordMetric('VaultLoad', 'Queued behind in-flight load', { ...scopedRequest })
    // Errors from the previous pass are already logged by the pass itself.
    await active.promise.catch(() => undefined)
  }

  const promise = start()
  inFlightLoad = { vaultId, request: scopedRequest, promise }

  try {
    await promise
  } finally {
    if (inFlightLoad?.promise === promise) {
      inFlightLoad = null
    }
  }
}

/**
 * Vaults whose in-flight pass refused to commit because a file operation landed
 * mid-scan. Set by the pass, drained by the caller once the pass has finished and
 * re-entry is safe.
 */
const supersededLoads = new Set<string>()

export function markLoadSuperseded(vaultId: string | undefined): void {
  if (vaultId) supersededLoads.add(vaultId)
}

/** Returns whether the vault needs another pass, clearing the flag. */
export function consumeSupersededLoad(vaultId: string | undefined): boolean {
  if (!vaultId) return false
  return supersededLoads.delete(vaultId)
}

/**
 * State of the last merge that actually committed, per vault. Lets a silent refresh
 * recognise that neither disk, server, store, nor the server's explicit folder
 * records moved, and skip the merge entirely.
 */
export interface MergedVaultState {
  scanFingerprint: string
  storeFileCount: number
  /** `computeServerFolderFingerprint` over the folder rows fetched this pass. */
  folderFingerprint: string
}

const lastMergedState = new Map<string, MergedVaultState>()

export function getLastMergedState(vaultId: string | undefined): MergedVaultState | undefined {
  return vaultId ? lastMergedState.get(vaultId) : undefined
}

export function setLastMergedState(vaultId: string | undefined, state: MergedVaultState): void {
  if (vaultId) lastMergedState.set(vaultId, state)
}

/**
 * FNV-1a over path/size/mtime of every scanned entry. Cheap enough (tens of ms on a
 * 27k-item vault) to be worth it against a multi-second merge, and sensitive to
 * exactly the fields the merge derives diff status from.
 */
export function computeLocalScanFingerprint(
  files: Array<{ relativePath: string; size: number; modifiedTime: string }>,
): string {
  const FNV_OFFSET_BASIS = 0x811c9dc5
  const FNV_PRIME = 0x01000193

  let hash = FNV_OFFSET_BASIS
  const appendString = (value: string) => {
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i)
      hash = Math.imul(hash, FNV_PRIME)
    }
  }

  for (const file of files) {
    appendString(file.relativePath)
    appendString('|')
    appendString(String(file.size))
    appendString('|')
    appendString(file.modifiedTime)
    appendString('\n')
  }

  return `${files.length}:${(hash >>> 0).toString(16)}`
}

/**
 * FNV-1a over the sorted server folder paths (the `folders` table rows fetched for
 * the empty-folder-sync feature, not folders implied by file paths).
 *
 * A bare count would miss a create-plus-delete pair landing in the same silent-
 * refresh window, since the count before and after is identical - hashing every path
 * catches that. Folder counts are small next to file counts, so this stays cheap.
 * Sorting first makes the fingerprint independent of the order the server returned
 * rows in.
 */
export function computeServerFolderFingerprint(folderPaths: readonly string[]): string {
  const FNV_OFFSET_BASIS = 0x811c9dc5
  const FNV_PRIME = 0x01000193

  let hash = FNV_OFFSET_BASIS
  const appendString = (value: string) => {
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i)
      hash = Math.imul(hash, FNV_PRIME)
    }
  }

  const sorted = [...folderPaths].sort()
  for (const path of sorted) {
    appendString(path)
    appendString('\n')
  }

  return `${sorted.length}:${(hash >>> 0).toString(16)}`
}

/** What `shouldSkipMerge` needs from one `loadFiles` pass to decide whether the
 * merge that follows can be skipped. */
export interface MergeSkipCheckInput {
  silent: boolean
  forceHashComputation: boolean
  /** `serverResultWithCache.cacheHit` - the watermark query found no file changes. */
  serverCacheHit: boolean
  /** `serverResultWithCache.deltaCount`. */
  serverDeltaCount: number
  /** True when the folder-records fetch itself failed. Treated as "unknown", not
   * "unchanged", so it always fails the skip rather than trusting a fallback `[]`. */
  serverFoldersErrored: boolean
  lastMerged: MergedVaultState | undefined
  localScanFingerprint: string
  storeFileCount: number
  serverFolderFingerprint: string
  filesLoaded: boolean
  vaultStale: boolean
}

/**
 * Whether a silent refresh's merge can be skipped because none of its four inputs -
 * server file delta, local disk scan, in-memory store, and the server's explicit
 * folder records - moved since the last pass that committed.
 *
 * The folder fingerprint exists because the other three are all file-side: deleting
 * an empty folder on another machine changes no file, so it moves the file delta,
 * the scan fingerprint, and the store count not at all. Without a folder-side signal
 * this always evaluated to "skip", which silently no-ops the merge that the
 * `folders` realtime subscription schedules to pick the deletion up.
 *
 * Restricted by the caller to silent refreshes and to vaults already merged once, so
 * explicit user refreshes and a vault's first load always take the full merge path.
 */
export function shouldSkipMerge(input: MergeSkipCheckInput): boolean {
  return (
    input.silent &&
    !input.forceHashComputation &&
    input.serverCacheHit &&
    input.serverDeltaCount === 0 &&
    !input.serverFoldersErrored &&
    input.lastMerged !== undefined &&
    input.lastMerged.scanFingerprint === input.localScanFingerprint &&
    input.lastMerged.storeFileCount === input.storeFileCount &&
    input.lastMerged.folderFingerprint === input.serverFolderFingerprint &&
    input.filesLoaded &&
    !input.vaultStale
  )
}
