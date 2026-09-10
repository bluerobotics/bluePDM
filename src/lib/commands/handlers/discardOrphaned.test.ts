import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Ordered record of the calls whose relative order the fix depends on. */
const callOrder: string[] = []

const releaseWatcher = vi.fn(() => {
  callOrder.push('release')
})
const beginWatcherSuppression = vi.fn(() => {
  callOrder.push('suppress')
  return releaseWatcher
})

vi.mock('@/lib/fileWatcherSuppression', () => ({ beginWatcherSuppression }))

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Stubbed rather than resolving real translations - these tests care about *whether*
// and *how often* the automatic-failure notice fires, not its exact wording, which
// autoDiscardKeys.test.ts already covers for every locale.
vi.mock('@/lib/i18n', () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const endOperation = vi.fn()
vi.mock('../../fileOperationTracker', () => ({
  FileOperationTracker: { start: () => ({ endOperation }) },
}))

const removeFromSyncIndex = vi.fn(() => Promise.resolve())
vi.mock('../../cache/localSyncIndex', () => ({ removeFromSyncIndex }))

const { discardOrphanedCommand, resetAutomaticSkipNotices, isAutomaticDiscardCoolingDown } =
  await import('./discardOrphaned')

import type { CommandContext, LocalFile } from '../types'

function orphan(name: string): LocalFile {
  return {
    name,
    path: `C:/vault/${name}`,
    relativePath: name,
    isDirectory: false,
    diffStatus: 'deleted_remote',
  } as LocalFile
}

/** A file present on both sides carries no diff status at all. */
function synced(name: string): LocalFile {
  return { ...orphan(name), diffStatus: undefined }
}

function makeContext(files: LocalFile[]) {
  return {
    files,
    activeVaultId: 'vault-1',
    addProcessingFoldersSync: vi.fn(),
    removeProcessingFolders: vi.fn(),
    addProgressToast: vi.fn(),
    updateProgressToast: vi.fn(),
    removeToast: vi.fn(),
    addToast: vi.fn(),
    removeFilesFromStore: vi.fn(),
    setLastOperationCompletedAt: vi.fn(),
  } as unknown as CommandContext & {
    removeFilesFromStore: ReturnType<typeof vi.fn>
    removeProcessingFolders: ReturnType<typeof vi.fn>
    addToast: ReturnType<typeof vi.fn>
  }
}

/**
 * Batch result where every listed path succeeded unless named in `failures` (a
 * genuine failure, e.g. a locked file) or `skipped` (left on disk because it could
 * not be recycled - the automatic-path outcome under test here).
 */
function batchResult(paths: string[], failures: string[] = [], skipped: string[] = []) {
  const results = paths.map((path) => {
    if (skipped.includes(path)) {
      return {
        path,
        success: false,
        error: 'Could not move to Recycle Bin, left on disk: Failed to perform delete operation',
        skipped: true,
      }
    }
    return {
      path,
      success: !failures.includes(path),
      error: failures.includes(path) ? 'EBUSY' : undefined,
    }
  })
  const succeeded = results.filter((r) => r.success).length
  const skippedCount = results.filter((r) => r.skipped).length

  return {
    success: failures.length === 0 && skipped.length === 0,
    results,
    summary: {
      total: paths.length,
      succeeded,
      failed: paths.length - succeeded,
      skipped: skippedCount,
      duration: 5,
    },
  }
}

let deleteBatch: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  callOrder.length = 0
  // The "already told the user about these" state outlives a single run by design,
  // so it has to be cleared between tests the way a fresh session would start.
  resetAutomaticSkipNotices()

  deleteBatch = vi.fn((paths: string[]) => {
    callOrder.push('deleteBatch')
    return Promise.resolve(batchResult(paths))
  })

  vi.stubGlobal('window', { electronAPI: { deleteBatch, log: vi.fn() } })
})

describe('discard-orphaned watcher suppression', () => {
  it('registers the deletions as expected changes before deleting', async () => {
    const files = [orphan('one.sldprt'), orphan('two.sldprt')]
    const ctx = makeContext(files)

    await discardOrphanedCommand.execute({ files }, ctx)

    expect(beginWatcherSuppression).toHaveBeenCalledTimes(1)
    // Registered against relative paths and the command's own ctx, matching the
    // processing markers and the delete handler.
    expect(beginWatcherSuppression).toHaveBeenCalledWith(['one.sldprt', 'two.sldprt'], ctx)
    expect(callOrder).toEqual(['suppress', 'deleteBatch', 'release'])
  })

  it('releases the registration when the batch returns no result', async () => {
    deleteBatch.mockResolvedValueOnce(undefined)
    const files = [orphan('one.sldprt')]

    const result = await discardOrphanedCommand.execute({ files }, makeContext(files))

    expect(result.success).toBe(false)
    expect(releaseWatcher).toHaveBeenCalledTimes(1)
  })

  it('releases the registration when the batch throws', async () => {
    deleteBatch.mockRejectedValueOnce(new Error('ipc died'))
    const files = [orphan('one.sldprt')]

    await expect(discardOrphanedCommand.execute({ files }, makeContext(files))).rejects.toThrow(
      'ipc died',
    )

    expect(releaseWatcher).toHaveBeenCalledTimes(1)
  })
})

describe('discard-orphaned store updates', () => {
  it('removes only the paths that were actually deleted', async () => {
    const files = [orphan('kept.sldprt'), orphan('gone.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, ['C:/vault/kept.sldprt'])),
    )
    const ctx = makeContext(files)

    const result = await discardOrphanedCommand.execute({ files }, ctx)

    expect(ctx.removeFilesFromStore).toHaveBeenCalledWith(['C:/vault/gone.sldprt'])
    expect(removeFromSyncIndex).toHaveBeenCalledWith('vault-1', ['gone.sldprt'])
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
  })

  it('leaves the store alone when every delete failed', async () => {
    const files = [orphan('one.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, paths)),
    )
    const ctx = makeContext(files)

    await discardOrphanedCommand.execute({ files }, ctx)

    expect(ctx.removeFilesFromStore).not.toHaveBeenCalled()
    expect(ctx.removeProcessingFolders).toHaveBeenCalledWith(['one.sldprt'])
    expect(releaseWatcher).toHaveBeenCalledTimes(1)
  })

  it('expands a folder to the orphans inside it', async () => {
    const child = orphan('folder/inner.sldprt')
    const sibling = synced('folder/sibling.sldprt')
    const folder = { ...orphan('folder'), isDirectory: true } as LocalFile
    const ctx = makeContext([folder, child, sibling])

    await discardOrphanedCommand.execute({ files: [folder] }, ctx)

    // Only the deleted_remote child is discarded, not the synced sibling.
    expect(deleteBatch).toHaveBeenCalledWith(['C:/vault/folder/inner.sldprt'], true, false)
  })
})

describe('discard-orphaned validation', () => {
  it('rejects an empty selection', () => {
    expect(discardOrphanedCommand.validate?.({ files: [] }, makeContext([]))).toBe(
      'No files selected',
    )
  })

  it('rejects a selection with nothing orphaned', () => {
    const file = synced('one.sldprt')
    expect(discardOrphanedCommand.validate?.({ files: [file] }, makeContext([file]))).toBe(
      'No orphaned files to discard',
    )
  })
})

// `isAutomatic` is the flag an unattended caller (e.g. auto-discard on load) must
// set so the main process refuses to permanently delete a file it cannot recycle.
// It defaults to false, which is what every explicit, user-initiated call site
// (context menu, settings) gets by simply not passing it.
describe('discard-orphaned isAutomatic threading', () => {
  it('defaults to false (explicit user delete) when not provided', async () => {
    const files = [orphan('one.sldprt')]

    await discardOrphanedCommand.execute({ files }, makeContext(files))

    expect(deleteBatch).toHaveBeenCalledWith(['C:/vault/one.sldprt'], true, false)
  })

  it('forwards isAutomatic: true for an unattended run', async () => {
    const files = [orphan('one.sldprt')]

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, makeContext(files))

    expect(deleteBatch).toHaveBeenCalledWith(['C:/vault/one.sldprt'], true, true)
  })
})

// Covers the contract fs.ts hands back on the automatic path: a file that could
// not be recycled comes back `skipped: true` rather than `success: true` for a
// permanent delete nobody asked for. This command must treat "skipped" the same
// as "not deleted" for store/index purposes, while still telling the caller which
// files were kept and why, distinctly from a genuine failure (e.g. a lock).
describe('discard-orphaned skipped files (could not recycle)', () => {
  it('leaves a skipped file in the store and sync index, unlike a real delete', async () => {
    const files = [orphan('kept.sldprt'), orphan('gone.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], ['C:/vault/kept.sldprt'])),
    )
    const ctx = makeContext(files)

    const result = await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(ctx.removeFilesFromStore).toHaveBeenCalledWith(['C:/vault/gone.sldprt'])
    expect(removeFromSyncIndex).toHaveBeenCalledWith('vault-1', ['gone.sldprt'])
    expect(result.skipped).toBe(1)
    expect(result.skippedPaths).toEqual(['C:/vault/kept.sldprt'])
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
  })

  it('reports an all-skipped batch as a warning, not the generic error-toast wording', async () => {
    const files = [orphan('kept.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], paths)),
    )
    const ctx = makeContext(files)

    const result = await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(ctx.addToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('could not move to the Recycle Bin'),
    )
    // No genuine failure occurred, so the "N error(s)" wording must not fire.
    expect(ctx.addToast).not.toHaveBeenCalledWith('warning', expect.stringContaining('error(s)'))
    expect(result.errors).toBeUndefined()
  })

  // Auto-discard runs on every background refresh, and a kept file stays orphaned, so
  // the same skip recurs on every pass. Without this the user gets the same warning
  // toast every few seconds for as long as the file is there.
  it('warns once for an unchanged set of kept files across repeated automatic runs', async () => {
    const files = [orphan('kept.sldprt')]
    const skipAll = (paths: string[]) => Promise.resolve(batchResult(paths, [], paths))
    const ctx = makeContext(files)

    deleteBatch.mockImplementation(skipAll)
    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)
    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)
    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    const warnings = ctx.addToast.mock.calls.filter((call) =>
      String(call[1]).includes('could not move to the Recycle Bin'),
    )
    expect(warnings).toHaveLength(1)
  })

  it('warns again once a different file becomes un-recyclable', async () => {
    const ctx = makeContext([orphan('kept.sldprt')])
    deleteBatch.mockImplementation((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], paths)),
    )

    await discardOrphanedCommand.execute({ files: [orphan('kept.sldprt')], isAutomatic: true }, ctx)
    await discardOrphanedCommand.execute({ files: [orphan('other.sldprt')], isAutomatic: true }, ctx)

    const warnings = ctx.addToast.mock.calls.filter((call) =>
      String(call[1]).includes('could not move to the Recycle Bin'),
    )
    expect(warnings).toHaveLength(2)
  })

  // A person clicking "discard" is owed an answer every time, even the same one.
  it('warns on every user-initiated run, without deduplicating', async () => {
    const files = [orphan('kept.sldprt')]
    const ctx = makeContext(files)
    deleteBatch.mockImplementation((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], paths)),
    )

    await discardOrphanedCommand.execute({ files }, ctx)
    await discardOrphanedCommand.execute({ files }, ctx)

    const warnings = ctx.addToast.mock.calls.filter((call) =>
      String(call[1]).includes('could not move to the Recycle Bin'),
    )
    expect(warnings).toHaveLength(2)
  })

  // The read is correctly gated on `isAutomatic`, but until fixed the write was not:
  // a manual run recorded the signature unconditionally, so an automatic run
  // encountering the same kept files afterwards found its own signature already
  // there and stayed silent on what should have been its first report.
  it('does not let a manual run suppress the automatic path first notice for the same files', async () => {
    const files = [orphan('kept.sldprt')]
    const ctx = makeContext(files)
    deleteBatch.mockImplementation((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], paths)),
    )

    // Manual run sees the same kept file first - must toast, and must not record
    // anything the automatic path below would then read as "already reported".
    await discardOrphanedCommand.execute({ files }, ctx)

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    const warnings = ctx.addToast.mock.calls.filter((call) =>
      String(call[1]).includes('could not move to the Recycle Bin'),
    )
    // One for the manual run, one for the automatic run's own first report.
    expect(warnings).toHaveLength(2)
  })

  it('does not let automatic-run bookkeeping affect a later manual run for the same files', async () => {
    const files = [orphan('kept.sldprt')]
    const ctx = makeContext(files)
    deleteBatch.mockImplementation((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], paths)),
    )

    // Automatic run records the signature.
    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)
    // A manual run afterwards must still toast - it never reads the automatic bookkeeping.
    await discardOrphanedCommand.execute({ files }, ctx)

    const warnings = ctx.addToast.mock.calls.filter((call) =>
      String(call[1]).includes('could not move to the Recycle Bin'),
    )
    expect(warnings).toHaveLength(2)
  })

  it('distinguishes a skip from a genuine failure in the same batch', async () => {
    const files = [orphan('kept.sldprt'), orphan('locked.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, ['C:/vault/locked.sldprt'], ['C:/vault/kept.sldprt'])),
    )
    const ctx = makeContext(files)

    const result = await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(result.skipped).toBe(1)
    expect(result.skippedPaths).toEqual(['C:/vault/kept.sldprt'])
    expect(result.errors).toEqual(['locked.sldprt: EBUSY'])
  })
})

// Removing the `if (!isAutomatic)` wrapper around the success/failure toasts would
// currently pass the whole suite - this is the coverage the adversarial review
// pointed at being missing.
describe('discard-orphaned automatic-path toast suppression', () => {
  it('does not show the success toast on an automatic run', async () => {
    const files = [orphan('one.sldprt')]
    const ctx = makeContext(files)

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(ctx.addToast).not.toHaveBeenCalledWith(
      'success',
      expect.stringContaining('Discarded'),
    )
  })

  it('does not show the manual failure-wording toast on an automatic run', async () => {
    const files = [orphan('one.sldprt'), orphan('locked.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, ['C:/vault/locked.sldprt'])),
    )
    const ctx = makeContext(files)

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(ctx.addToast).not.toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('Discarded 1/2 orphaned files'),
    )
  })

  it('still shows the manual failure-wording toast on a user-initiated run with the same batch shape', async () => {
    const files = [orphan('one.sldprt'), orphan('locked.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, ['C:/vault/locked.sldprt'])),
    )
    const ctx = makeContext(files)

    await discardOrphanedCommand.execute({ files }, ctx)

    expect(ctx.addToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('Discarded 1/2 orphaned files'),
    )
  })
})

// A locked file fails identically on every silent refresh until it is closed, so
// without dedup the automatic path would either say nothing (the bug this fixes) or
// repeat the same warning every few seconds for as long as it stays open.
describe('discard-orphaned automatic-path failure notice', () => {
  it('warns once for a genuine failure on an automatic run', async () => {
    const files = [orphan('locked.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, paths)),
    )
    const ctx = makeContext(files)

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(ctx.addToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('autoDiscard.failed.generic'),
    )
  })

  it('warns once for an unchanged failing file across repeated automatic runs', async () => {
    const files = [orphan('locked.sldprt')]
    const ctx = makeContext(files)
    deleteBatch.mockImplementation((paths: string[]) =>
      Promise.resolve(batchResult(paths, paths)),
    )

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)
    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)
    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    const warnings = ctx.addToast.mock.calls.filter((call) =>
      String(call[1]).includes('autoDiscard.failed.generic'),
    )
    expect(warnings).toHaveLength(1)
  })

  it('warns again once a different file becomes the one that fails', async () => {
    const ctx = makeContext([orphan('locked.sldprt')])
    deleteBatch.mockImplementation((paths: string[]) =>
      Promise.resolve(batchResult(paths, paths)),
    )

    await discardOrphanedCommand.execute({ files: [orphan('locked.sldprt')], isAutomatic: true }, ctx)
    await discardOrphanedCommand.execute({ files: [orphan('other.sldprt')], isAutomatic: true }, ctx)

    const warnings = ctx.addToast.mock.calls.filter((call) =>
      String(call[1]).includes('autoDiscard.failed.generic'),
    )
    expect(warnings).toHaveLength(2)
  })

  it('warns again once a previously-failing file starts failing again after succeeding in between', async () => {
    const files = [orphan('locked.sldprt')]
    const ctx = makeContext(files)

    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, paths)),
    )
    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    deleteBatch.mockImplementationOnce((paths: string[]) => Promise.resolve(batchResult(paths)))
    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, paths)),
    )
    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    const warnings = ctx.addToast.mock.calls.filter((call) =>
      String(call[1]).includes('autoDiscard.failed.generic'),
    )
    expect(warnings).toHaveLength(2)
  })

  it('does not dedupe the failure notice on user-initiated runs (unaffected by this change)', async () => {
    const files = [orphan('locked.sldprt')]
    const ctx = makeContext(files)
    deleteBatch.mockImplementation((paths: string[]) =>
      Promise.resolve(batchResult(paths, paths)),
    )

    await discardOrphanedCommand.execute({ files }, ctx)
    await discardOrphanedCommand.execute({ files }, ctx)

    const warnings = ctx.addToast.mock.calls.filter((call) =>
      String(call[1]).includes('Discarded 0/1 orphaned files'),
    )
    expect(warnings).toHaveLength(2)
  })
})

// The UNC-vault case: shell.trashItem fails for every file, so every orphan is
// skipped and, without a cooldown, the whole batch would retry - watcher stop
// included - on every silent refresh forever.
describe('discard-orphaned all-skipped cooldown', () => {
  it('is not cooling down before any automatic run has happened', () => {
    expect(isAutomaticDiscardCoolingDown('vault-1')).toBe(false)
  })

  it('starts a cooldown after an automatic batch where every file was skipped', async () => {
    const files = [orphan('one.sldprt'), orphan('two.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], paths)),
    )
    const ctx = makeContext(files)

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(isAutomaticDiscardCoolingDown('vault-1')).toBe(true)
  })

  it('does not start a cooldown when at least one file was genuinely deleted', async () => {
    const files = [orphan('one.sldprt'), orphan('two.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], ['C:/vault/two.sldprt'])),
    )
    const ctx = makeContext(files)

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(isAutomaticDiscardCoolingDown('vault-1')).toBe(false)
  })

  it('does not start a cooldown for a user-initiated run', async () => {
    const files = [orphan('one.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], paths)),
    )
    const ctx = makeContext(files)

    await discardOrphanedCommand.execute({ files }, ctx)

    expect(isAutomaticDiscardCoolingDown('vault-1')).toBe(false)
  })

  it('clears the cooldown once a later automatic batch makes progress', async () => {
    const files = [orphan('one.sldprt')]
    const ctx = makeContext(files)

    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], paths)),
    )
    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)
    expect(isAutomaticDiscardCoolingDown('vault-1')).toBe(true)

    deleteBatch.mockImplementationOnce((paths: string[]) => Promise.resolve(batchResult(paths)))
    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(isAutomaticDiscardCoolingDown('vault-1')).toBe(false)
  })

  it('expires on its own after enough time has passed, without a later run to clear it', async () => {
    const files = [orphan('one.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], paths)),
    )
    const ctx = makeContext(files)

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)
    expect(isAutomaticDiscardCoolingDown('vault-1')).toBe(true)

    // Generously past any reasonable cooldown - this asserts the cooldown is
    // time-bound, not the exact constant, which is an implementation detail.
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60 * 1000)
    try {
      expect(isAutomaticDiscardCoolingDown('vault-1')).toBe(false)
    } finally {
      dateNowSpy.mockRestore()
    }
  })
})
