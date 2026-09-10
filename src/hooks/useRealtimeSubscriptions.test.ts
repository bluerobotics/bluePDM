import { describe, expect, it, vi } from 'vitest'

import { classifyDeletionUpdate, createOrphanDiscardRefreshScheduler } from './useRealtimeSubscriptions'

/**
 * `classifyDeletionUpdate` is what turns a soft-deleted server row (trash sets
 * `deleted_at` and arrives as an UPDATE, never a DELETE) into a decision the realtime
 * handler can act on. These tests exercise the exported function directly rather than
 * the effect it lives in, since mounting the hook would mean standing up realtime
 * channels and the whole PDM store.
 */
describe('classifyDeletionUpdate', () => {
  it('is not a deletion when deleted_at was already set (an ordinary metadata update)', () => {
    const result = classifyDeletionUpdate({
      oldDeletedAt: '2026-01-01T00:00:00Z',
      newDeletedAt: '2026-01-01T00:00:00Z',
      isRecentlyModified: false,
      hasPendingMetadata: false,
      hasLocalCopy: true,
    })

    expect(result).toEqual({ type: 'not-a-deletion' })
  })

  it('is not a deletion when deleted_at is being cleared (a restore from trash)', () => {
    const result = classifyDeletionUpdate({
      oldDeletedAt: '2026-01-01T00:00:00Z',
      newDeletedAt: null,
      isRecentlyModified: false,
      hasPendingMetadata: false,
      hasLocalCopy: true,
    })

    expect(result).toEqual({ type: 'not-a-deletion' })
  })

  it('classifies the null -> set transition as removing a cloud-only file', () => {
    const result = classifyDeletionUpdate({
      oldDeletedAt: null,
      newDeletedAt: '2026-01-01T00:00:00Z',
      isRecentlyModified: false,
      hasPendingMetadata: false,
      hasLocalCopy: false,
    })

    expect(result).toEqual({ type: 'removed-cloud-only' })
  })

  it('classifies the same transition as orphaning a local copy when one exists', () => {
    const result = classifyDeletionUpdate({
      oldDeletedAt: undefined,
      newDeletedAt: '2026-01-01T00:00:00Z',
      isRecentlyModified: false,
      hasPendingMetadata: false,
      hasLocalCopy: true,
    })

    expect(result).toEqual({ type: 'became-orphaned-locally' })
  })

  it('still holds the recently-modified guard even though the call site already checks it', () => {
    const result = classifyDeletionUpdate({
      oldDeletedAt: null,
      newDeletedAt: '2026-01-01T00:00:00Z',
      isRecentlyModified: true,
      hasPendingMetadata: false,
      hasLocalCopy: true,
    })

    expect(result).toEqual({ type: 'not-a-deletion' })
  })

  it('still holds the pending-metadata guard even though the call site already checks it', () => {
    const result = classifyDeletionUpdate({
      oldDeletedAt: null,
      newDeletedAt: '2026-01-01T00:00:00Z',
      isRecentlyModified: false,
      hasPendingMetadata: true,
      hasLocalCopy: true,
    })

    expect(result).toEqual({ type: 'not-a-deletion' })
  })
})

/**
 * `createOrphanDiscardRefreshScheduler` is what lets the subscription effect keep
 * `requestSilentRefresh` out of its dependency array: a ref holds the latest value,
 * and this scheduler reads the ref at fire time rather than closing over whatever
 * was current when `schedule` was called. These tests exercise it directly rather
 * than mounting the hook, since this repo's vitest config runs in the `node`
 * environment (no DOM) and has no React rendering test utilities installed.
 */
describe('createOrphanDiscardRefreshScheduler', () => {
  it('does nothing and leaves no pending timer when no refresh function is available', () => {
    vi.useFakeTimers()
    try {
      const { schedule } = createOrphanDiscardRefreshScheduler(
        () => undefined,
        () => true,
      )

      schedule()
      vi.runAllTimers()

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('debounces repeated calls into a single fire', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn()
      const { schedule } = createOrphanDiscardRefreshScheduler(
        () => refresh,
        () => true,
      )

      schedule()
      schedule()
      schedule()
      vi.runAllTimers()

      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // This is the property the fix depends on: the hook's effect does not resubscribe
  // when requestSilentRefresh changes identity, so the value read when the debounce
  // fires must be the current one, not the one captured when it was scheduled.
  it('calls whichever function getCurrentRefresh returns at fire time, not at schedule time', () => {
    vi.useFakeTimers()
    try {
      const stale = vi.fn()
      const current = vi.fn()
      let latest: (() => void) | undefined = stale

      const { schedule } = createOrphanDiscardRefreshScheduler(
        () => latest,
        () => true,
      )

      schedule()
      // Swap the callback after scheduling but before the debounce fires.
      latest = current
      vi.runAllTimers()

      expect(stale).not.toHaveBeenCalled()
      expect(current).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire once cancelled', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn()
      const { schedule, cancel } = createOrphanDiscardRefreshScheduler(
        () => refresh,
        () => true,
      )

      schedule()
      cancel()
      vi.runAllTimers()

      expect(refresh).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // isActive corresponds to the effect's subscriptionActive flag, which flips to
  // false in cleanup. A refresh scheduled just before unmount must not fire into a
  // torn-down subscription.
  it('checks isActive at fire time, not at schedule time', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn()
      let active = true
      const { schedule } = createOrphanDiscardRefreshScheduler(
        () => refresh,
        () => active,
      )

      schedule()
      active = false
      vi.runAllTimers()

      expect(refresh).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a later schedule call replaces an earlier pending one rather than firing twice', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn()
      const { schedule } = createOrphanDiscardRefreshScheduler(
        () => refresh,
        () => true,
      )

      schedule()
      vi.advanceTimersByTime(1)
      schedule()
      vi.runAllTimers()

      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
