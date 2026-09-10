import { describe, expect, it, vi } from 'vitest'

import {
  buildAutoDiscardToastMessage,
  commonOrphanFolderName,
  runAutoDiscardForOrphans,
  selectDiscardableOrphans,
  shouldSkipAutoDiscardForOrphans,
} from './useLoadFiles'
import type { LocalFile } from '@/stores/pdmStore'

function orphan(overrides: Partial<LocalFile> = {}): LocalFile {
  return {
    name: 'part.sldprt',
    path: 'C:/vault/Parts/part.sldprt',
    relativePath: 'Parts/part.sldprt',
    isDirectory: false,
    extension: '.sldprt',
    size: 0,
    modifiedTime: '2026-01-01T00:00:00Z',
    diffStatus: 'deleted_remote',
    ...overrides,
  }
}

describe('selectDiscardableOrphans', () => {
  it('keeps an orphan with no local edits and no pending metadata', () => {
    const files = [orphan()]

    expect(selectDiscardableOrphans(files, new Set())).toEqual(files)
  })

  it('excludes an orphan edited locally after its server row was lost', () => {
    const files = [orphan({ relativePath: 'Parts/edited.sldprt' })]

    const result = selectDiscardableOrphans(
      files,
      new Set(['parts/edited.sldprt']),
    )

    expect(result).toEqual([])
  })

  it('excludes an orphan holding unsaved pending metadata', () => {
    const files = [orphan({ pendingMetadata: { part_number: 'ABC-123' } })]

    expect(selectDiscardableOrphans(files, new Set())).toEqual([])
  })

  it('does not exclude an orphan whose pendingMetadata object is empty', () => {
    const files = [orphan({ pendingMetadata: {} })]

    expect(selectDiscardableOrphans(files, new Set())).toEqual(files)
  })

  it('filters a mixed batch down to only the safe-to-discard files', () => {
    const safe = orphan({ relativePath: 'Parts/safe.sldprt' })
    const editedSinceLost = orphan({ relativePath: 'Parts/edited.sldprt' })
    const withPendingMetadata = orphan({
      relativePath: 'Parts/pending.sldprt',
      pendingMetadata: { revision: 'B' },
    })

    const result = selectDiscardableOrphans(
      [safe, editedSinceLost, withPendingMetadata],
      new Set(['parts/edited.sldprt']),
    )

    expect(result).toEqual([safe])
  })
})

describe('shouldSkipAutoDiscardForOrphans', () => {
  it('does not skip when there are no orphans to act on', () => {
    expect(
      shouldSkipAutoDiscardForOrphans({
        serverRowCount: 0,
        previouslySyncedCount: 1000,
        orphanCount: 0,
      }),
    ).toBe(false)
  })

  it('does not skip for a vault that was never synced before (nothing to have lost sight of)', () => {
    expect(
      shouldSkipAutoDiscardForOrphans({
        serverRowCount: 0,
        previouslySyncedCount: 0,
        orphanCount: 5,
      }),
    ).toBe(false)
  })

  // This is the exact shape from the adversarial review: an empty-but-successful
  // response merges against an empty pdmMap, and every previously-synced local file
  // is classified deleted_remote. Without this guard, all of it would be recycled in
  // one pass on a silent background refresh.
  it('skips when the server returned zero rows with no error, on a previously-synced vault', () => {
    expect(
      shouldSkipAutoDiscardForOrphans({
        serverRowCount: 0,
        previouslySyncedCount: 25000,
        orphanCount: 25000,
      }),
    ).toBe(true)
  })

  it('skips a zero-row response even when only a handful of files are still on disk to orphan', () => {
    // Most of a 1000-file synced index was already cleaned up locally, so only 3 of
    // those paths are still present to be classified deleted_remote - a low fraction
    // that the proportional check alone would let through.
    expect(
      shouldSkipAutoDiscardForOrphans({
        serverRowCount: 0,
        previouslySyncedCount: 1000,
        orphanCount: 3,
      }),
    ).toBe(true)
  })

  it('does not skip when the server fetch never ran (offline or a fetch error, already safe on its own)', () => {
    expect(
      shouldSkipAutoDiscardForOrphans({
        serverRowCount: undefined,
        previouslySyncedCount: 1000,
        orphanCount: 950,
      }),
    ).toBe(false)
  })

  it('does not skip a real, large but partial deletion under the fraction threshold', () => {
    // A few thousand files pruned from a 25k-file vault - the review's own example of
    // a deletion that should still go through automatically.
    expect(
      shouldSkipAutoDiscardForOrphans({
        serverRowCount: 22000,
        previouslySyncedCount: 25000,
        orphanCount: 3000,
      }),
    ).toBe(false)
  })

  it('skips a non-zero but truncated response once the orphan fraction crosses the threshold', () => {
    expect(
      shouldSkipAutoDiscardForOrphans({
        serverRowCount: 50,
        previouslySyncedCount: 1000,
        orphanCount: 950,
      }),
    ).toBe(true)
  })

  it('treats the threshold as exclusive - exactly 90% still passes through', () => {
    expect(
      shouldSkipAutoDiscardForOrphans({
        serverRowCount: 100,
        previouslySyncedCount: 1000,
        orphanCount: 900,
      }),
    ).toBe(false)
  })
})

describe('commonOrphanFolderName', () => {
  it('returns the shared top-level folder when every file is under it', () => {
    const files = [
      orphan({ relativePath: 'RADCAM/part1.sldprt' }),
      orphan({ relativePath: 'RADCAM/sub/part2.sldprt' }),
    ]

    expect(commonOrphanFolderName(files)).toBe('RADCAM')
  })

  it('returns null when the files span multiple top-level folders', () => {
    const files = [
      orphan({ relativePath: 'RADCAM/part1.sldprt' }),
      orphan({ relativePath: 'OtherFolder/part2.sldprt' }),
    ]

    expect(commonOrphanFolderName(files)).toBeNull()
  })

  it('returns null when a file sits at the vault root (no folder to name)', () => {
    const files = [orphan({ relativePath: 'root.sldprt' })]

    expect(commonOrphanFolderName(files)).toBeNull()
  })

  it('returns null for an empty batch', () => {
    expect(commonOrphanFolderName([])).toBeNull()
  })
})

describe('buildAutoDiscardToastMessage', () => {
  it('uses the singular-friendly generic key with no folder name', () => {
    const message = buildAutoDiscardToastMessage(1, null)

    expect(message).toBe('Removed 1 file deleted from the vault')
  })

  it('uses the plural generic key for multiple files with no shared folder', () => {
    const message = buildAutoDiscardToastMessage(3, null)

    expect(message).toBe('Removed 3 files deleted from the vault')
  })

  it('names the folder when every discarded file shared one', () => {
    const message = buildAutoDiscardToastMessage(5, 'RADCAM')

    expect(message).toBe('Removed 5 files from RADCAM (deleted from the vault)')
  })
})

describe('runAutoDiscardForOrphans', () => {
  it('skips without calling discard when there is nothing to discard', async () => {
    const discard = vi.fn().mockResolvedValue(undefined)

    const result = await runAutoDiscardForOrphans('vault-1', [], discard)

    expect(result).toBe('skipped-empty')
    expect(discard).not.toHaveBeenCalled()
  })

  it('runs the discard callback once for a non-empty batch', async () => {
    const discard = vi.fn().mockResolvedValue(undefined)
    const files = [orphan()]

    const result = await runAutoDiscardForOrphans('vault-1', files, discard)

    expect(result).toBe('ran')
    expect(discard).toHaveBeenCalledTimes(1)
    expect(discard).toHaveBeenCalledWith(files)
  })

  it('does not double-fire: a second call for the same vault while the first is still in flight is skipped', async () => {
    let resolveFirst: () => void = () => {}
    const firstDiscardStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const discard = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst()
          setTimeout(resolve, 20)
        }),
    )

    const first = runAutoDiscardForOrphans('vault-1', [orphan()], discard)
    await firstDiscardStarted

    const second = await runAutoDiscardForOrphans('vault-1', [orphan()], discard)
    expect(second).toBe('skipped-in-flight')

    const firstResult = await first
    expect(firstResult).toBe('ran')
    expect(discard).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh discard for the same vault once the prior one has finished', async () => {
    const discard = vi.fn().mockResolvedValue(undefined)

    const first = await runAutoDiscardForOrphans('vault-1', [orphan()], discard)
    const second = await runAutoDiscardForOrphans('vault-1', [orphan()], discard)

    expect(first).toBe('ran')
    expect(second).toBe('ran')
    expect(discard).toHaveBeenCalledTimes(2)
  })

  it('allows concurrent discards for different vaults', async () => {
    let resolveFirst: () => void = () => {}
    const firstDiscardStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const discard = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst()
          setTimeout(resolve, 20)
        }),
    )

    const first = runAutoDiscardForOrphans('vault-1', [orphan()], discard)
    await firstDiscardStarted

    const second = await runAutoDiscardForOrphans('vault-2', [orphan()], discard)
    expect(second).toBe('ran')

    await first
    expect(discard).toHaveBeenCalledTimes(2)
  })

  it('still releases the in-flight guard when discard throws, so a later pass is not stuck skipping forever', async () => {
    const discard = vi.fn().mockRejectedValue(new Error('disk error'))

    await expect(runAutoDiscardForOrphans('vault-1', [orphan()], discard)).rejects.toThrow(
      'disk error',
    )

    const discard2 = vi.fn().mockResolvedValue(undefined)
    const result = await runAutoDiscardForOrphans('vault-1', [orphan()], discard2)
    expect(result).toBe('ran')
  })
})
