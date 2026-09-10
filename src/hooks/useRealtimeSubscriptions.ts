import { useEffect, useRef } from 'react'
import { usePDMStore } from '@/stores/pdmStore'
import {
  subscribeToFiles,
  subscribeToFolders,
  subscribeToActivity,
  subscribeToOrganization,
  subscribeToColorSwatches,
  subscribeToPermissions,
  subscribeToVaults,
  unsubscribeAll,
  type FolderRealtimeRow,
} from '@/lib/realtime'
import { buildFullPath } from '@/lib/commands/types'
import { log } from '@/lib/logger'
import {
  hashCheckoutIdentifier,
  isCheckoutProfileForOwner,
  type Organization,
  type PDMFile,
} from '@/types/pdm'

const LOCATION_FLUSH_DEBOUNCE_MS = 100
const NOTIFICATION_BATCH_MS = 500

/**
 * A folder delete produces one row UPDATE per file inside it, each arriving as its own
 * realtime event. This collapses a burst of those into one silent refresh instead of
 * one per file - unrelated to, and much shorter than, the watcher's own suppression
 * window, since nothing here writes to disk yet.
 */
const ORPHAN_DISCARD_REFRESH_DEBOUNCE_MS = 300

export type FileDeletionOutcome =
  | { type: 'not-a-deletion' }
  | { type: 'removed-cloud-only' }
  | { type: 'became-orphaned-locally' }

/**
 * Debounces the silent refresh that follows a realtime deletion, always calling
 * whichever function `getCurrentRefresh` returns at the moment the timer actually
 * fires - never one captured when `schedule` was called. This is what lets the
 * subscription effect keep `requestSilentRefresh` out of its dependency array (a ref
 * holds the latest value; `getCurrentRefresh` reads the ref) without the debounce
 * itself quietly reverting to a stale callback in between.
 *
 * `isActive` is checked at fire time, not at schedule time, so a call scheduled just
 * before the owning effect's cleanup runs never reaches into a torn-down subscription.
 *
 * Exported standalone so the fire-time-not-schedule-time read can be proven with a
 * test that never mounts the hook.
 */
export function createOrphanDiscardRefreshScheduler(
  getCurrentRefresh: () => (() => void) | undefined,
  isActive: () => boolean,
): { schedule: () => void; cancel: () => void } {
  let timeout: ReturnType<typeof setTimeout> | null = null

  const cancel = () => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
  }

  const schedule = () => {
    if (!getCurrentRefresh()) return
    cancel()
    timeout = setTimeout(() => {
      timeout = null
      if (!isActive()) return
      getCurrentRefresh()?.()
    }, ORPHAN_DISCARD_REFRESH_DEBOUNCE_MS)
  }

  return { schedule, cancel }
}

/**
 * Decide what an incoming file UPDATE means for realtime deletion propagation.
 *
 * Trash is a soft delete: `deleted_at` moves from unset to set, and that arrives here
 * as an ordinary UPDATE rather than the DELETE case below - DELETE only fires for a
 * hard row delete, which trash never performs.
 *
 * Exported standalone (no store access) so the classification can be unit tested
 * without mounting the hook. `isRecentlyModified` and `hasPendingMetadata` are
 * re-checked here even though the call site already returns before reaching this for
 * both, so the guards hold for this function's own contract, not only because of where
 * it happens to be called from.
 */
export function classifyDeletionUpdate(params: {
  oldDeletedAt: string | null | undefined
  newDeletedAt: string | null | undefined
  isRecentlyModified: boolean
  hasPendingMetadata: boolean
  hasLocalCopy: boolean
}): FileDeletionOutcome {
  const wasJustDeleted = !params.oldDeletedAt && !!params.newDeletedAt
  if (!wasJustDeleted || params.isRecentlyModified || params.hasPendingMetadata) {
    return { type: 'not-a-deletion' }
  }

  return params.hasLocalCopy
    ? { type: 'became-orphaned-locally' }
    : { type: 'removed-cloud-only' }
}

export type FolderDeletionOutcome = { type: 'not-a-deletion' } | { type: 'deleted' }

/**
 * Decide what an incoming `folders` UPDATE means for realtime deletion propagation.
 *
 * A much smaller mirror of `classifyDeletionUpdate` above, not an extension of it:
 * `folders` has no local-sync-index or pending-metadata concept to guard against
 * (see the plan's "classification gap" section - a directory has no durable synced
 * record to compare against at all), and the caller does nothing with the result
 * beyond scheduling a refresh, so there is no "local copy" branch to classify into.
 * Exported standalone (no store access) so this is unit testable without mounting
 * the hook, the same reason `classifyDeletionUpdate` is.
 */
export function classifyFolderDeletionUpdate(params: {
  oldDeletedAt: string | null | undefined
  newDeletedAt: string | null | undefined
}): FolderDeletionOutcome {
  const wasJustDeleted = !params.oldDeletedAt && !!params.newDeletedAt
  return wasJustDeleted ? { type: 'deleted' } : { type: 'not-a-deletion' }
}

/**
 * Subscribe to realtime updates from Supabase
 * Handles:
 * - File changes (checkout, check-in, version, state)
 * - Activity feed
 * - Organization settings
 * - Color swatches
 * - Permission changes
 *
 * @param requestSilentRefresh Runs a silent (`loadFiles(true)`) pass. Called after a
 * file with a local copy is marked orphaned by a realtime deletion, so the merge that
 * follows stamps the tombstone `orphanedAt` uses and the auto-discard block in
 * useLoadFiles.ts can act on it - within a debounce window, not only on the next loud
 * load. Optional so a caller that has no load pass wired up yet (or a test) still gets
 * correct classification; it just will not see the file actually leave disk until
 * something else triggers a load.
 */
export function useRealtimeSubscriptions(
  organization: Organization | null,
  isOfflineMode: boolean,
  sessionKey = '',
  requestSilentRefresh?: () => void,
) {
  const setOrganization = usePDMStore((s) => s.setOrganization)
  const addToast = usePDMStore((s) => s.addToast)

  // Held in a ref, synced by its own tiny effect, rather than depended on directly by
  // the subscription effect below: `requestSilentRefresh` resolves, through App.tsx,
  // to `loadFiles` -> `runLoadFiles`, whose own dependencies include vaultPath,
  // organization, user, currentVaultId, authenticatedUserId and sessionGeneration. Any
  // change to any of those would otherwise tear down and resubscribe all six realtime
  // channels below and clear the pending orphan-discard timeout, dropping deletion
  // events that arrive during the resubscribe window.
  const requestSilentRefreshRef = useRef(requestSilentRefresh)
  useEffect(() => {
    requestSilentRefreshRef.current = requestSilentRefresh
  }, [requestSilentRefresh])

  useEffect(() => {
    if (!organization || isOfflineMode) return

    const { addCloudFile, updateFilePdmData, removeCloudFile, addToast } = usePDMStore.getState()

    // Batch notifications to avoid toast spam when someone does bulk operations
    // Collects notifications over 500ms then shows a single summary toast
    type NotificationType = 'checkout' | 'checkin' | 'version' | 'state' | 'add' | 'move'
    interface PendingNotification {
      type: NotificationType
      userId: string
      userName: string | null // null means we need to fetch it
      fileNames: string[]
      version?: number
      state?: string
    }

    const pendingNotifications: Map<string, PendingNotification> = new Map()
    let flushTimeout: ReturnType<typeof setTimeout> | null = null
    const userNameCache: Map<string, string> = new Map()
    let subscriptionActive = true
    let checkoutEventSequence = 0
    const latestCheckoutEventByFile = new Map<string, number>()

    // See createOrphanDiscardRefreshScheduler above: reads requestSilentRefreshRef at
    // fire time, so it always calls the latest callback even though this effect does
    // not list requestSilentRefresh as a dependency.
    const orphanDiscardRefreshScheduler = createOrphanDiscardRefreshScheduler(
      () => requestSilentRefreshRef.current,
      () => subscriptionActive,
    )
    const scheduleOrphanDiscardRefresh = orphanDiscardRefreshScheduler.schedule

    // Batch file location updates to prevent render cascade when folder is moved
    // When a folder moves, each file inside sends its own UPDATE event - without batching,
    // this causes N re-renders for N files which can freeze the UI
    interface PendingLocationUpdate {
      fileId: string
      newRelativePath: string
      newFileName: string
      pdmData: PDMFile
    }
    const pendingLocationUpdates: Map<string, PendingLocationUpdate> = new Map()
    let locationFlushTimeout: ReturnType<typeof setTimeout> | null = null

    const flushLocationUpdates = () => {
      locationFlushTimeout = null
      if (pendingLocationUpdates.size === 0) return

      // Defer if a refresh is in progress to prevent concurrent store mutations
      // (refreshCurrentFolder uses startTransition which defers setFiles — writing
      // here would race with that deferred update and can crash React)
      if (usePDMStore.getState().isLoading) {
        log.debug('[Realtime]', 'Deferring location flush - refresh in progress', {
          pendingCount: pendingLocationUpdates.size,
        })
        locationFlushTimeout = setTimeout(flushLocationUpdates, LOCATION_FLUSH_DEBOUNCE_MS)
        return
      }

      const updates = Array.from(pendingLocationUpdates.values())
      pendingLocationUpdates.clear()

      log.info('[Realtime]', 'Flushing batched file location updates', { count: updates.length })

      // Use the batch update function for a single set() call
      const { batchUpdateFileLocationsFromServer } = usePDMStore.getState()
      batchUpdateFileLocationsFromServer(updates)
    }

    const queueLocationUpdate = (
      fileId: string,
      newRelativePath: string,
      newFileName: string,
      pdmData: PDMFile,
    ) => {
      // Overwrite if same file gets multiple updates (last one wins)
      pendingLocationUpdates.set(fileId, { fileId, newRelativePath, newFileName, pdmData })

      // Start/reset the flush timer
      if (locationFlushTimeout) {
        clearTimeout(locationFlushTimeout)
      }
      locationFlushTimeout = setTimeout(flushLocationUpdates, LOCATION_FLUSH_DEBOUNCE_MS)
    }

    const flushNotifications = () => {
      flushTimeout = null

      for (const notification of pendingNotifications.values()) {
        const count = notification.fileNames.length
        const userName = notification.userName || 'Another user'

        let message: string
        if (count === 1) {
          // Single file - show file name
          const fileName = notification.fileNames[0]
          switch (notification.type) {
            case 'checkout':
              message = `${userName} checked out ${fileName}`
              break
            case 'checkin':
              message = `${userName} checked in ${fileName} (v${notification.version})`
              break
            case 'version':
              message = `${userName} updated ${fileName} to v${notification.version}`
              break
            case 'state':
              message = `${fileName} → ${notification.state}`
              break
            case 'add':
              message = `${userName} added ${fileName}`
              break
            case 'move':
              message = `${userName} moved ${fileName}`
              break
          }
        } else {
          // Multiple files - show count
          switch (notification.type) {
            case 'checkout':
              message = `${userName} checked out ${count} files`
              break
            case 'checkin':
              message = `${userName} checked in ${count} files`
              break
            case 'version':
              message = `${userName} updated ${count} files`
              break
            case 'state':
              message = `${count} files → ${notification.state}`
              break
            case 'add':
              message = `${userName} added ${count} files`
              break
            case 'move':
              message = `${userName} moved ${count} files`
              break
          }
        }

        addToast('info', message, 5000)
      }

      pendingNotifications.clear()
    }

    const queueNotification = (
      type: NotificationType,
      userId: string,
      fileName: string,
      extra?: { version?: number; state?: string },
    ) => {
      const key = `${type}:${userId}:${extra?.state || ''}` // Group by type, user, and state (for state changes)

      const existing = pendingNotifications.get(key)
      if (existing) {
        existing.fileNames.push(fileName)
        if (extra?.version) existing.version = extra.version
      } else {
        // Check cache for user name
        const cachedName = userNameCache.get(userId)
        pendingNotifications.set(key, {
          type,
          userId,
          userName: cachedName || null,
          fileNames: [fileName],
          ...extra,
        })

        // Fetch user name if not cached
        if (!cachedName) {
          import('@/lib/supabase').then(({ getUserBasicInfo }) => {
            getUserBasicInfo(userId).then(({ user }) => {
              const displayName = user?.full_name || user?.email?.split('@')[0] || 'Another user'
              userNameCache.set(userId, displayName)

              // Update pending notification if it still exists
              const notification = pendingNotifications.get(key)
              if (notification) {
                notification.userName = displayName
              }
            })
          })
        }
      }

      // Start/reset the flush timer
      if (flushTimeout) {
        clearTimeout(flushTimeout)
      }
      flushTimeout = setTimeout(flushNotifications, NOTIFICATION_BATCH_MS)
    }

    // Subscribe to file changes
    const unsubscribeFiles = subscribeToFiles(organization.id, (eventType, newFile, oldFile) => {
      // Skip updates caused by current user (we handle those locally)
      const { user, activeVaultId } = usePDMStore.getState()
      const currentUserId = user?.id

      // The files subscription is org-wide, so it delivers events for every vault
      // in the organization. Drop events that belong to a different vault than the
      // one currently open, otherwise off-vault moves/inserts fabricate ghost
      // "cloud" folders in the active vault (e.g. a WLC folder leaking across vaults).
      const eventVaultId = newFile?.vault_id ?? oldFile?.vault_id
      if (eventVaultId && activeVaultId && eventVaultId !== activeVaultId) {
        log.debug('[Realtime]', 'SKIP: event for other vault', {
          eventType,
          eventVaultId,
          activeVaultId,
          fileId: newFile?.id ?? oldFile?.id,
        })
        return
      }

      switch (eventType) {
        case 'INSERT':
          // New file added by someone else
          if (newFile && newFile.created_by !== currentUserId) {
            addCloudFile(newFile)
            // Queue batched notification for new files
            queueNotification('add', newFile.created_by, newFile.file_name)
          }
          break

        case 'UPDATE':
          // File updated - could be checkout, version change, state change, path change (move), etc.
          if (newFile) {
            const { isFileRecentlyModified, files, vaultPath } = usePDMStore.getState()
            const localFile = files.find((f) => f.pdmData?.id === newFile.id)

            const recentlyModified = isFileRecentlyModified(newFile.id)
            const hasPendingMetadata = !!(
              localFile?.pendingMetadata && Object.keys(localFile.pendingMetadata).length > 0
            )

            // Log incoming realtime event for debugging
            log.debug('[Realtime]', 'UPDATE event received', {
              fileId: newFile.id,
              serverPartNumber: newFile.part_number,
              oldPath: oldFile?.file_path,
              newPath: newFile.file_path,
              isRecentlyModified: recentlyModified,
              hasPendingMetadata,
              localPartNumber: localFile?.pdmData?.part_number,
            })

            // Skip if file was recently modified locally (prevents state drift)
            // This handles the race condition where stale realtime events arrive
            // shortly after a local check-in/discard operation
            if (recentlyModified) {
              log.debug('[Realtime]', 'SKIP: recently modified file', { fileId: newFile.id })
              break
            }

            // Skip if file has pending metadata (local changes not yet committed)
            // This prevents realtime events from overwriting user's unsaved edits
            if (hasPendingMetadata) {
              log.debug('[Realtime]', 'SKIP: file with pending metadata', { fileId: newFile.id })
              break
            }

            // Deletion propagation: trash is a soft delete (sets deleted_at), so it
            // arrives here as this ordinary UPDATE rather than the DELETE case below -
            // DELETE only fires for a hard row delete, which trash never performs.
            // removeCloudFile already branches correctly on whether a local copy
            // exists: a cloud-only row is dropped outright, a row with a local copy
            // becomes 'deleted_remote' so the auto-discard block in useLoadFiles.ts can
            // act on it under its own guards (pending metadata, disk mtime newer than
            // the tombstone). Those guards run at discard time, using the tombstone the
            // silent refresh below stamps - not here, since a fresh deletion has no
            // tombstone yet.
            const deletion = classifyDeletionUpdate({
              oldDeletedAt: oldFile?.deleted_at,
              newDeletedAt: newFile.deleted_at,
              isRecentlyModified: recentlyModified,
              hasPendingMetadata,
              hasLocalCopy: !!localFile,
            })

            if (deletion.type !== 'not-a-deletion') {
              removeCloudFile(newFile.id)
              log.info('[Realtime]', 'File deleted from vault (soft delete)', {
                fileId: hashCheckoutIdentifier(newFile.id),
                hadLocalCopy: deletion.type === 'became-orphaned-locally',
              })
              if (deletion.type === 'became-orphaned-locally') {
                // Nothing on disk has changed yet, so there is nothing for the file
                // watcher to have an opinion about here - the refresh this schedules
                // is what actually removes the file, and it does that under the merge's
                // own tombstone-mtime and pending-metadata guards, plus the discard
                // path's own watcher suppression, not a debounce.
                scheduleOrphanDiscardRefresh()
              }
              break
            }

            // Check if checkout status changed (regardless of who made the change)
            // This is critical for cross-machine scenarios where user releases checkout from another machine
            const checkoutStatusChanged = oldFile?.checked_out_by !== newFile.checked_out_by

            // Check if file path changed (file was moved)
            // This is critical for cross-machine scenarios where user moves file from another machine
            const pathChanged = oldFile?.file_path !== newFile.file_path

            // Update local state if:
            // 1. Update is from another user (normal case)
            // 2. OR checkout status changed (handles cross-machine checkout releases by same user)
            // 3. OR path changed (handles cross-machine file moves by same user)
            // This prevents state drift between local and database
            if (newFile.updated_by !== currentUserId || checkoutStatusChanged || pathChanged) {
              // Handle path changes (file moved) - must update LocalFile properties, not just pdmData
              // Use batched updates to prevent render cascade when a folder move generates
              // many individual file UPDATE events
              if (pathChanged && vaultPath) {
                const isCurrentUserMove = newFile.updated_by === currentUserId

                log.info('[Realtime]', 'File path changed (moved)', {
                  fileId: newFile.id,
                  oldPath: oldFile?.file_path,
                  newPath: newFile.file_path,
                  updatedBy: newFile.updated_by,
                  isCurrentUser: isCurrentUserMove,
                })

                // IMPORTANT: Skip location updates for current user's own path changes
                // Local optimistic updates (via renameFileInStore) already handle the move.
                // Processing realtime events would create duplicate "cloud" folder entries
                // because batchUpdateFileLocationsFromServer creates parent folders.
                // Only process path changes from OTHER users or cross-machine scenarios.
                if (isCurrentUserMove && localFile) {
                  log.debug(
                    '[Realtime]',
                    'SKIP: path change from current user (optimistic update handles this)',
                    {
                      fileId: newFile.id,
                      hasLocalFile: !!localFile,
                    },
                  )
                  // Still update pdmData to keep file_path in sync, but don't create folders
                  updateFilePdmData(newFile.id, newFile)
                } else {
                  // Queue the update for batching - multiple file moves from a folder move
                  // will be combined into a single store update after 100ms debounce
                  queueLocationUpdate(newFile.id, newFile.file_path, newFile.file_name, newFile)
                }
              } else {
                // Normal pdmData update (checkout, version changes, etc.)
                // Check if file is newly checked out by someone else
                // Realtime updates don't include the joined checked_out_user info,
                // so we need to fetch it separately
                const isNewlyCheckedOut =
                  newFile.checked_out_by &&
                  (!oldFile?.checked_out_by || oldFile.checked_out_by !== newFile.checked_out_by)

                if (isNewlyCheckedOut && newFile.checked_out_by !== currentUserId) {
                  // Fetch user info for the person who checked out the file
                  const ownerId = newFile.checked_out_by
                  if (!ownerId) break
                  // Commit the authoritative owner first. The merge path removes any
                  // profile from the previous checkout before enrichment resolves.
                  updateFilePdmData(newFile.id, newFile)
                  const eventSequence = ++checkoutEventSequence
                  latestCheckoutEventByFile.set(newFile.id, eventSequence)
                  const eventVaultId = newFile.vault_id ?? activeVaultId ?? null
                  const scope = {
                    orgId: organization.id,
                    vaultId: eventVaultId,
                    fileId: newFile.id,
                  }
                  void import('@/lib/supabase')
                    .then(({ getUserBasicInfo }) =>
                      getUserBasicInfo(ownerId, scope).then(({ user }) => {
                        const currentState = usePDMStore.getState()
                        const currentFile = currentState.files.find(
                          (file) => file.pdmData?.id === newFile.id,
                        )
                        const ownerStillMatches =
                          currentFile?.pdmData?.checked_out_by === ownerId
                        const eventStillLatest =
                          latestCheckoutEventByFile.get(newFile.id) === eventSequence
                        const currentActiveVaultId =
                          currentState.activeVaultId ?? currentState.connectedVaults[0]?.id ?? null
                        const vaultStillMatches =
                          currentActiveVaultId === eventVaultId

                        if (
                          !subscriptionActive ||
                          !ownerStillMatches ||
                          !eventStillLatest ||
                          !vaultStillMatches
                        ) {
                          log.debug('[Realtime]', 'Discarding stale checkout profile', {
                            fileId: hashCheckoutIdentifier(newFile.id),
                            ownerId: hashCheckoutIdentifier(ownerId),
                            eventSequence,
                            ownerStillMatches,
                            eventStillLatest,
                            vaultStillMatches,
                            stale: true,
                          })
                          return
                        }

                        if (user && isCheckoutProfileForOwner(user, ownerId)) {
                          updateFilePdmData(newFile.id, {
                            ...newFile,
                            checked_out_user: user,
                          } as Partial<PDMFile>)
                        } else {
                          // Commit the authoritative checkout fields while removing any
                          // profile that could belong to a previous checkout owner.
                          updateFilePdmData(newFile.id, newFile)
                        }
                      }),
                    )
                    .catch((error: unknown) => {
                      log.warn('[Realtime]', 'Checkout profile hydration failed', {
                        fileId: hashCheckoutIdentifier(newFile.id),
                        ownerId: hashCheckoutIdentifier(ownerId),
                        error: error instanceof Error ? error.message : String(error),
                      })
                    })
                } else {
                  // No new checkout by others, just update normally
                  updateFilePdmData(newFile.id, newFile)
                }
              }
            }

            // Check for force check-in from different machine (your file was released)
            // This happens when: you had file checked out on this machine, but it was checked in from elsewhere
            if (oldFile?.checked_out_by === currentUserId && !newFile.checked_out_by) {
              // The file that was checked out by current user is now not checked out
              // Check if it was force-checked-in from a different machine
              const oldMachineId = oldFile?.checked_out_by_machine_id

              // Get current machine ID to compare
              import('@/lib/backup')
                .then(async ({ getMachineId }) => {
                  const currentMachineId = await getMachineId()

                  // Only trigger orphaned checkout if:
                  // 1. File was checked out on THIS machine (oldMachineId === currentMachineId)
                  //    AND someone ELSE did the check-in (force release scenario)
                  // 2. OR file was checked out on ANOTHER machine (oldMachineId !== currentMachineId)
                  //    AND current user checked it in from here (user's other machine has orphaned changes)

                  const wasCheckedOutOnThisMachine =
                    oldMachineId && oldMachineId === currentMachineId
                  const currentUserDidTheCheckin = newFile.updated_by === currentUserId

                  // If user checked in their own file from the same machine, it's NOT an orphan
                  // That's just a normal check-in
                  if (wasCheckedOutOnThisMachine && currentUserDidTheCheckin) {
                    // Normal check-in by user on the same machine - no orphan
                    return
                  }

                  // If file was checked out on this machine but released by someone else
                  // OR if user checked in from a different machine (their other machine has orphaned local copy)
                  if (wasCheckedOutOnThisMachine || (oldMachineId && !currentUserDidTheCheckin)) {
                    log.warn('[Realtime]', 'Force check-in detected', { file: newFile.file_name })

                    // Get the machine name that did the force check-in
                    const checkedInByMachine =
                      newFile.checked_out_by_machine_name || 'another computer'

                    // Get current vault path for building local path
                    const { vaultPath, addOrphanedCheckout } = usePDMStore.getState()

                    // Add to orphaned checkouts list - this will trigger the dialog
                    addOrphanedCheckout({
                      fileId: newFile.id,
                      fileName: newFile.file_name,
                      filePath: newFile.file_path,
                      localPath: vaultPath
                        ? buildFullPath(vaultPath, newFile.file_path)
                        : newFile.file_path,
                      checkedInBy: checkedInByMachine,
                      checkedInAt: newFile.updated_at,
                      newVersion: newFile.version,
                      serverHash: newFile.content_hash || undefined,
                    })
                  }
                })
                .catch(() => {
                  // Couldn't get machine ID, just show normal notification
                })
            }

            // Queue batched notifications for important changes from other users
            if (newFile.updated_by && newFile.updated_by !== currentUserId) {
              // Check for path change (file moved) - highest priority notification
              if (pathChanged) {
                queueNotification('move', newFile.updated_by, newFile.file_name)
              }
              // Check for checkout changes
              else if (oldFile?.checked_out_by !== newFile.checked_out_by) {
                if (newFile.checked_out_by) {
                  queueNotification('checkout', newFile.updated_by, newFile.file_name)
                } else {
                  queueNotification('checkin', newFile.updated_by, newFile.file_name, {
                    version: newFile.version,
                  })
                }
              }
              // Check for new version
              else if (oldFile?.version !== newFile.version) {
                queueNotification('version', newFile.updated_by, newFile.file_name, {
                  version: newFile.version,
                })
              }
              // Check for state change
              else if (oldFile?.workflow_state?.name !== newFile.workflow_state?.name) {
                queueNotification('state', newFile.updated_by, newFile.file_name, {
                  state: newFile.workflow_state?.name,
                })
              }
            }
          }
          break

        case 'DELETE':
          // File deleted from server
          // Note: Supabase realtime DELETE events only include primary key by default,
          // so oldFile may not have all fields (file_name, deleted_by, etc.)
          if (oldFile?.id) {
            removeCloudFile(oldFile.id)
            // Only show toast if we have a valid file name AND it wasn't deleted by current user
            // Skip toast entirely for DELETE events - they spam when bulk deleting and often lack file_name
            // Users can see deleted files in the file browser (red diff status)
          }
          break
      }
    })

    // Subscribe to folder changes. `folders` only carries explicit rows for
    // otherwise-empty directories (schema v49); most folders are implied by
    // file paths and never appear here. The case this exists for: a folder
    // deleted while it held no files produces zero `files` events above, so
    // this is the only realtime signal that reaches another client at all
    // (schema v101 - see supabase/modules/10-source-files.sql REALTIME section).
    const unsubscribeFolders = subscribeToFolders(
      organization.id,
      (eventType, newFolder: FolderRealtimeRow, oldFolder?: FolderRealtimeRow) => {
        const { activeVaultId } = usePDMStore.getState()

        // The folders subscription is org-wide like the files one above, so it
        // delivers events for every vault in the organization. Drop events for
        // a different vault than the one currently open, for the same reason
        // the files handler does.
        const eventVaultId = newFolder?.vault_id ?? oldFolder?.vault_id
        if (eventVaultId && activeVaultId && eventVaultId !== activeVaultId) {
          log.debug('[Realtime]', 'SKIP: folder event for other vault', {
            eventType,
            eventVaultId,
            activeVaultId,
            folderId: newFolder?.id ?? oldFolder?.id,
          })
          return
        }

        // Trash is a soft delete (sets deleted_at) here too; a hard row delete
        // never happens (deleteFolderByPath only ever updates), so only the
        // UPDATE case is meaningful.
        if (eventType !== 'UPDATE') return

        const deletion = classifyFolderDeletionUpdate({
          oldDeletedAt: oldFolder?.deleted_at,
          newDeletedAt: newFolder?.deleted_at,
        })

        if (deletion.type === 'deleted') {
          log.info('[Realtime]', 'Folder deleted from vault (soft delete)', {
            folderId: newFolder?.id,
          })
          // Nothing on disk has changed and there is nothing further to do here
          // - this schedules the same debounced silent refresh a burst of file
          // deletions already uses, which is what lets the merge see the folder
          // is gone. Removing the now-empty directory from disk happens inside
          // discard-orphaned, reached through its own guards once that refresh
          // completes.
          scheduleOrphanDiscardRefresh()
        }
      },
    )

    // Subscribe to activity feed for additional notifications
    const unsubscribeActivity = subscribeToActivity(organization.id, (_activity) => {
      // Activity notifications are handled by the file subscription above
      // This could be used for additional features like showing activity in a panel
    })

    // Subscribe to organization settings changes (integration settings, etc.)
    const unsubscribeOrg = subscribeToOrganization(
      organization.id,
      (_eventType, newOrg, oldOrg) => {
        // Check what changed in the settings JSONB
        const newSettings = (newOrg?.settings || {}) as unknown as Record<string, unknown>
        const oldSettings = (oldOrg?.settings || {}) as unknown as Record<string, unknown>

        // All keys in the settings JSONB that admins can modify
        const settingsKeys = [
          'solidworks_dm_license_key',
          'solidworks_templates',
          'api_url',
          'slack_enabled',
          'slack_webhook_url',
          'odoo_url',
          'odoo_api_key',
          'require_checkout',
          'auto_increment_part_numbers',
          'part_number_prefix',
          'part_number_digits',
          'allowed_extensions',
          'require_description',
          'require_approval_for_release',
          'max_file_size_mb',
          'enforce_email_domain',
          'column_defaults',
        ]

        const changedSettingsKeys = settingsKeys.filter(
          (key) => JSON.stringify(newSettings[key]) !== JSON.stringify(oldSettings[key]),
        )

        // All admin-modifiable fields directly on the organization table
        const orgAdminFields = [
          // Google Drive integration
          'google_drive_enabled',
          'google_drive_client_id',
          'google_drive_client_secret',
          // Company profile
          'logo_url',
          'logo_storage_path',
          'phone',
          'website',
          'contact_email',
          // Address fields
          'address_line1',
          'address_line2',
          'city',
          'state',
          'postal_code',
          'country',
          // Domain settings
          'email_domains',
          'revision_scheme',
          'name',
          'slug',
        ] as const

        const changedOrgFields = orgAdminFields.filter(
          (key) =>
            JSON.stringify((newOrg as unknown as Record<string, unknown>)?.[key]) !==
            JSON.stringify((oldOrg as unknown as Record<string, unknown>)?.[key]),
        )

        // Check JSONB columns for admin settings
        const jsonbAdminFields = [
          'rfq_settings',
          'serialization_settings',
          'module_defaults',
        ] as const

        const changedJsonbFields = jsonbAdminFields.filter(
          (key) =>
            JSON.stringify((newOrg as unknown as Record<string, unknown>)?.[key]) !==
            JSON.stringify((oldOrg as unknown as Record<string, unknown>)?.[key]),
        )

        const allChangedFields = [
          ...changedSettingsKeys,
          ...changedOrgFields,
          ...changedJsonbFields,
        ]

        // Log api_url changes specifically for debugging sync issues
        if (changedSettingsKeys.includes('api_url')) {
          log.info('[Realtime]', 'API URL changed', {
            from: oldSettings.api_url || '(empty)',
            to: newSettings.api_url || '(empty)',
          })
        }

        // Update the organization in the store
        // This triggers the sync useEffect in App.tsx to update apiServerUrl
        // Also triggers re-render in all components that use organization from store
        setOrganization(newOrg)

        // Check if module defaults were force-pushed (admin override)
        const oldForcedAt = (oldOrg as unknown as Record<string, unknown>)
          ?.module_defaults_forced_at
        const newForcedAt = (newOrg as unknown as Record<string, unknown>)
          ?.module_defaults_forced_at
        if (newForcedAt && newForcedAt !== oldForcedAt) {
          // Admin pushed new module config - apply it immediately
          const { loadOrgModuleDefaults } = usePDMStore.getState()
          loadOrgModuleDefaults().then(() => {
            addToast('info', 'Sidebar configuration updated by admin', 5000)
          })
          // Don't show generic "settings updated" toast for forced module config
          return
        }

        // Check if column defaults were force-pushed (admin override)
        const oldColumnForcedAt = (oldOrg as unknown as Record<string, unknown>)
          ?.column_defaults_forced_at
        const newColumnForcedAt = (newOrg as unknown as Record<string, unknown>)
          ?.column_defaults_forced_at
        if (newColumnForcedAt && newColumnForcedAt !== oldColumnForcedAt) {
          const { loadOrgColumnDefaults } = usePDMStore.getState()
          loadOrgColumnDefaults().then(() => {
            addToast('info', 'Column layout updated by admin', 5000)
          })
          return
        }

        // Check if SOLIDWORKS templates were force-pushed (admin override)
        interface SwTemplateSettings {
          documentTemplates?: string
          sheetFormats?: string
          bomTemplates?: string
          customPropertyFolders?: string
          promptForTemplate?: boolean
          lastPushedAt?: string
          lastPushedBy?: string
        }
        const oldTemplateSettings = oldSettings.solidworks_templates as
          | SwTemplateSettings
          | undefined
        const newTemplateSettings = newSettings.solidworks_templates as
          | SwTemplateSettings
          | undefined
        if (
          newTemplateSettings?.lastPushedAt &&
          newTemplateSettings.lastPushedAt !== oldTemplateSettings?.lastPushedAt
        ) {
          // Admin pushed new SOLIDWORKS template config - apply it immediately to registry
          log.info('[Realtime]', 'SOLIDWORKS templates pushed by admin', {
            lastPushedAt: newTemplateSettings.lastPushedAt,
          })

          // Apply to Windows registry automatically
          const { vaultPath, solidworksIntegrationEnabled } = usePDMStore.getState()
          if (
            vaultPath &&
            solidworksIntegrationEnabled &&
            window.electronAPI?.solidworks?.setFileLocations
          ) {
            const settings: {
              documentTemplates?: string
              sheetFormats?: string
              bomTemplates?: string
              customPropertyFolders?: string
              promptForTemplate?: boolean
            } = {}

            // Build absolute paths from vault root + relative paths
            if (newTemplateSettings.documentTemplates) {
              settings.documentTemplates = `${vaultPath}\\${newTemplateSettings.documentTemplates.replace(/\//g, '\\')}`
            }
            if (newTemplateSettings.sheetFormats) {
              settings.sheetFormats = `${vaultPath}\\${newTemplateSettings.sheetFormats.replace(/\//g, '\\')}`
            }
            if (newTemplateSettings.bomTemplates) {
              settings.bomTemplates = `${vaultPath}\\${newTemplateSettings.bomTemplates.replace(/\//g, '\\')}`
            }
            if (newTemplateSettings.customPropertyFolders) {
              settings.customPropertyFolders = `${vaultPath}\\${newTemplateSettings.customPropertyFolders.replace(/\//g, '\\')}`
            }

            // Include prompt for template setting
            if (newTemplateSettings.promptForTemplate !== undefined) {
              settings.promptForTemplate = newTemplateSettings.promptForTemplate
            }

            window.electronAPI.solidworks
              .setFileLocations(settings)
              .then((result) => {
                if (result.success && result.updatedVersions?.length) {
                  log.info('[Realtime]', 'Applied SOLIDWORKS templates to registry', {
                    versions: result.updatedVersions.join(', '),
                  })
                  addToast(
                    'success',
                    `SOLIDWORKS templates updated by admin (${result.updatedVersions.length} version${result.updatedVersions.length > 1 ? 's' : ''})`,
                    5000,
                  )
                } else if (result.error) {
                  log.warn('[Realtime]', 'Failed to apply SOLIDWORKS templates', {
                    error: result.error,
                  })
                }
              })
              .catch((err) => {
                log.warn('[Realtime]', 'Error applying SOLIDWORKS templates', {
                  error: String(err),
                })
              })
          }
          // Don't show generic "settings updated" toast for template push
          return
        }

        if (allChangedFields.length > 0) {
          addToast('info', 'Organization settings updated by an admin', 5000)
        }
      },
    )

    // Subscribe to org color swatch changes (shared palette)
    const unsubscribeColorSwatches = subscribeToColorSwatches(
      organization.id,
      (eventType, swatch) => {
        const { orgColorSwatches } = usePDMStore.getState()

        // Only process org swatches (swatch.org_id is set)
        if (!swatch.org_id) return

        if (eventType === 'INSERT') {
          // Add new org swatch if not already present
          if (!orgColorSwatches.find((s) => s.id === swatch.id)) {
            usePDMStore.setState({
              orgColorSwatches: [
                ...orgColorSwatches,
                {
                  id: swatch.id,
                  color: swatch.color,
                  isOrg: true,
                  createdAt: swatch.created_at,
                },
              ],
            })
          }
        } else if (eventType === 'DELETE') {
          // Remove deleted org swatch
          usePDMStore.setState({
            orgColorSwatches: orgColorSwatches.filter((s) => s.id !== swatch.id),
          })
        }
      },
    )

    // Subscribe to permission changes (vault access, team membership, workflow roles, etc.)
    // This ensures users see access changes immediately when an admin modifies them
    const currentUserId = usePDMStore.getState().user?.id
    const unsubscribePermissions = currentUserId
      ? subscribeToPermissions(currentUserId, organization.id, async (changeType, _eventType) => {
          log.info('[Realtime]', 'Permission change', { changeType })

          // Reload user permissions from the store
          const { loadUserPermissions, loadUserWorkflowRoles } = usePDMStore.getState()
          await loadUserPermissions()

          // Also reload workflow roles when they change
          if (changeType === 'workflow_roles') {
            await loadUserWorkflowRoles()
          }

          const messages: Record<string, string> = {
            vault_access: 'Your vault access has been updated',
            team_vault_access: 'Team vault access has been updated',
            team_members: 'Your team membership has been updated',
            user_permissions: 'Your permissions have been updated',
            teams: 'Team structure has been updated',
            workflow_roles: 'Your workflow roles have been updated',
            job_titles: 'Your job title has been updated',
          }
          addToast('info', messages[changeType] || 'Your access has been updated', 5000)

          // Trigger a refresh of the vault list in WelcomeScreen by updating a timestamp
          // Components watching this will know to reload
          usePDMStore.setState({ permissionsLastUpdated: Date.now() })
        })
      : () => {}

    // Subscribe to vault CRUD changes (vault created/renamed/deleted)
    // This ensures all admins see vault changes in real-time
    const unsubscribeVaults = subscribeToVaults(organization.id, (eventType, vault, _oldVault) => {
      log.info('[Realtime]', 'Vault change', { eventType, vaultName: vault?.name })

      // Trigger a refresh of the vaults list
      const { triggerVaultsRefresh } = usePDMStore.getState()
      triggerVaultsRefresh()

      const vaultName = vault?.name || 'A vault'
      const messages: Record<string, string> = {
        INSERT: `${vaultName} was created`,
        UPDATE: `${vaultName} was updated`,
        DELETE: `A vault was deleted`,
      }
      addToast('info', messages[eventType] || 'Vault configuration changed', 5000)
    })

    return () => {
      subscriptionActive = false
      // Clear any pending notification timeout
      if (flushTimeout) {
        clearTimeout(flushTimeout)
      }
      // Clear any pending location update timeout and flush remaining updates
      if (locationFlushTimeout) {
        clearTimeout(locationFlushTimeout)
        flushLocationUpdates() // Flush any pending updates before cleanup
      }
      // Clear any pending orphan-discard refresh - this effect's subscriptions are
      // unmounting, so firing it after teardown would call into a torn-down state.
      orphanDiscardRefreshScheduler.cancel()
      unsubscribeFiles()
      unsubscribeFolders()
      unsubscribeActivity()
      unsubscribeOrg()
      unsubscribeColorSwatches()
      unsubscribePermissions()
      unsubscribeVaults()
      unsubscribeAll()
    }
    // requestSilentRefresh is intentionally not a dependency - see requestSilentRefreshRef above.
  }, [organization, isOfflineMode, sessionKey, setOrganization, addToast])
}
