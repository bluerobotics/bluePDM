import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

/**
 * Mutable store fixture for the pieces `discardOrphaned.ts` reads directly via
 * `usePDMStore.getState()`: `serverFolderPaths` for the ping-pong guard and
 * `currentFolder`/`setCurrentFolder` for the relocation behaviour. Reset in
 * `beforeEach` below so tests cannot see each other's state.
 */
let storeState: {
  serverFolderPaths: Set<string>
  currentFolder: string
  setCurrentFolder: ReturnType<typeof vi.fn>
}

vi.mock('@/stores/pdmStore', () => ({
  usePDMStore: { getState: () => storeState },
}))

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

function makeContext(files: LocalFile[], overrides: Partial<CommandContext> = {}) {
  return {
    files,
    activeVaultId: 'vault-1',
    vaultPath: null,
    addProcessingFoldersSync: vi.fn(),
    removeProcessingFolders: vi.fn(),
    addProgressToast: vi.fn(),
    updateProgressToast: vi.fn(),
    removeToast: vi.fn(),
    addToast: vi.fn(),
    removeFilesFromStore: vi.fn(),
    setLastOperationCompletedAt: vi.fn(),
    ...overrides,
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
let trashEmptyDirs: ReturnType<typeof vi.fn>

/** A trashEmptyDirs response where every listed path was recycled. */
function dirBatchResult(paths: string[], skipped: string[] = []) {
  const results = paths.map((path) => ({
    path,
    success: !skipped.includes(path),
    error: skipped.includes(path) ? 'Directory is not empty' : undefined,
    skipped: skipped.includes(path) ? true : undefined,
  }))
  const succeeded = results.filter((r) => r.success).length
  return {
    success: skipped.length === 0,
    results,
    summary: {
      total: paths.length,
      succeeded,
      failed: paths.length - succeeded,
      skipped: skipped.length,
      duration: 2,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  callOrder.length = 0
  // The "already told the user about these" state outlives a single run by design,
  // so it has to be cleared between tests the way a fresh session would start.
  resetAutomaticSkipNotices()

  storeState = {
    serverFolderPaths: new Set(),
    currentFolder: '',
    setCurrentFolder: vi.fn((folder: string) => {
      storeState.currentFolder = folder
    }),
  }

  deleteBatch = vi.fn((paths: string[]) => {
    callOrder.push('deleteBatch')
    return Promise.resolve(batchResult(paths))
  })
  trashEmptyDirs = vi.fn((paths: string[]) => {
    callOrder.push('trashEmptyDirs')
    return Promise.resolve(dirBatchResult(paths))
  })

  vi.stubGlobal('window', { electronAPI: { deleteBatch, trashEmptyDirs, log: vi.fn() } })
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

// 4.3.2: directories left empty by this same batch are derived from the batch and
// recycled through `window.electronAPI.trashEmptyDirs` - see
// `src/lib/orphanedDirectories.ts`. Every test below sets `vaultPath` because that is
// exactly the switch `removeOrphanedDirectories` uses to decide whether there is a
// vault to build absolute candidate paths against; every test elsewhere in this file
// leaves it unset (`null`, from `makeContext`'s default) specifically so this whole
// step is a no-op for them, which is itself covered below.
describe('discard-orphaned directory cleanup', () => {
  it('does nothing when the context has no vaultPath, regardless of the batch shape', async () => {
    const files = [orphan('folder/gone.sldprt')]
    const ctx = makeContext(files) // vaultPath left at makeContext's default of null

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(trashEmptyDirs).not.toHaveBeenCalled()
  })

  it('trashes the directory a fully-deleted file leaves behind', async () => {
    const files = [orphan('folder/gone.sldprt')]
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    const result = await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(trashEmptyDirs).toHaveBeenCalledWith(['C:/vault/folder'])
    expect(ctx.removeFilesFromStore).toHaveBeenCalledWith(['C:/vault/folder'])
    expect(result.directoriesRemoved).toBe(1)
    expect(result.directoriesKept).toBeUndefined()
  })

  it('never sends a candidate whose file was actually kept (skipped or failed)', async () => {
    const files = [orphan('folder/kept.sldprt'), orphan('other/gone.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, [], ['C:/vault/folder/kept.sldprt'])),
    )
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    // 'folder' held a kept file and must never even be offered to trashEmptyDirs -
    // this is the optimisation described in orphanedDirectories.ts, not merely
    // something the main process would also have refused.
    expect(trashEmptyDirs).toHaveBeenCalledWith(['C:/vault/other'])
  })

  it('never sends a candidate the server still asserts exists (the ping-pong guard)', async () => {
    const files = [orphan('folder/gone.sldprt')]
    storeState.serverFolderPaths = new Set(['folder'])
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(trashEmptyDirs).not.toHaveBeenCalled()
  })

  it('does not call trashEmptyDirs when nothing was actually deleted', async () => {
    const files = [orphan('folder/locked.sldprt')]
    deleteBatch.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(batchResult(paths, paths)),
    )
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(trashEmptyDirs).not.toHaveBeenCalled()
  })

  it('reports a directory the handler left on disk as kept, not as a file failure', async () => {
    const files = [orphan('folder/gone.sldprt')]
    trashEmptyDirs.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(dirBatchResult(paths, paths)),
    )
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    const result = await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(result.directoriesKept).toBe(1)
    expect(result.directoriesRemoved).toBeUndefined()
    // A kept directory must not appear in the store removal call, nor affect the
    // file-level failure count.
    expect(ctx.removeFilesFromStore).not.toHaveBeenCalledWith(expect.arrayContaining(['C:/vault/folder']))
    expect(result.failed).toBe(0)
  })

  it('does not remove a directory the main process refused, even though the derivation offered it', async () => {
    const files = [orphan('a/b/gone.sldprt')]
    // The main process would refuse 'a/b' too since 'a' is deepest-first before it,
    // but here it is 'a/b' itself that fails while 'a' would otherwise be offered.
    trashEmptyDirs.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(dirBatchResult(paths, ['C:/vault/a/b'])),
    )
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    const result = await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(ctx.removeFilesFromStore).not.toHaveBeenCalledWith(
      expect.arrayContaining(['C:/vault/a/b']),
    )
    expect(result.directoriesKept).toBeGreaterThan(0)
  })

  it('runs inside the same watcher-suppression window as the file batch', async () => {
    const files = [orphan('folder/gone.sldprt')]
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    // One suppression window covers both the file batch and the directory batch -
    // there is no second beginWatcherSuppression call for directories.
    expect(beginWatcherSuppression).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(['suppress', 'deleteBatch', 'trashEmptyDirs', 'release'])
  })

  it('folds the failed trashEmptyDirs call into a kept count rather than throwing', async () => {
    const files = [orphan('folder/gone.sldprt')]
    trashEmptyDirs.mockRejectedValueOnce(new Error('IPC unavailable'))
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    const result = await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(result.success).toBe(true) // the file batch itself still succeeded
    expect(result.directoriesKept).toBe(1)
    expect(ctx.removeFilesFromStore).not.toHaveBeenCalledWith(
      expect.arrayContaining(['C:/vault/folder']),
    )
  })
})

// "Do not add a separate folder-removal call beside the file one in useLoadFiles.ts" -
// the blast-radius guard (shouldSkipAutoDiscardForOrphans, already proven to decline a
// zero-server-row pass in useLoadFiles.test.ts), the all-skipped cooldown, and
// runAutoDiscardForOrphans's re-entrancy guard all live upstream of
// executeCommand('discard-orphaned', ...) and decide whether this command runs at all.
// Directory removal happens only as a step inside `execute`, so a guard that declines
// the file batch declines the directory batch too, for free, *provided* there is no
// second call site. That second half is what this suite checks, at the source level
// rather than by re-deriving the guard's own boolean: if `trashEmptyDirs` is reachable
// from anywhere in useLoadFiles.ts, a decline there would no longer protect
// directories, no matter what this file's own tests show.
describe('discard-orphaned directory removal shares the file guard', () => {
  it('has no second call site for trashEmptyDirs outside this command', () => {
    const useLoadFilesSource = readFileSync(
      resolve(__dirname, '../../../hooks/useLoadFiles.ts'),
      'utf8',
    )

    // useLoadFiles.ts is allowed to read the *result* fields this command returns
    // (directoriesRemoved/directoriesKept, for the toast and the log) - it must never
    // call the IPC bridge itself. If it ever does, a guard decline there (zero server
    // rows, the orphan-fraction cap, the cooldown, the re-entrancy lock) would no
    // longer apply to directories, because it would sit around this call rather than
    // behind it.
    expect(useLoadFilesSource).not.toMatch(/electronAPI\??\.trashEmptyDirs/)
  })

  it('removes both the files and their directory in the same run once the guard passes', async () => {
    const files = [orphan('folder/gone.sldprt')]
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    const result = await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(result.succeeded).toBe(1)
    expect(result.directoriesRemoved).toBe(1)
  })
})

describe('discard-orphaned current-folder relocation', () => {
  it('moves the view to the nearest surviving ancestor when the current folder is removed', async () => {
    const files = [orphan('folder/gone.sldprt')]
    storeState.currentFolder = 'folder'
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(storeState.setCurrentFolder).toHaveBeenCalledWith('')
  })

  it('moves up past a removed ancestor to the nearest surviving one, not straight to root', async () => {
    // 'a/b' and 'a' are both removed (deepest-first), but 'a' is a sibling branch's
    // ancestor too in real usage - here it is simply the last survivor before root.
    const files = [orphan('a/b/gone.sldprt')]
    storeState.currentFolder = 'a/b'
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(storeState.setCurrentFolder).toHaveBeenCalledWith('')
  })

  it('does not move the view when the removed directory is unrelated to the current folder', async () => {
    const files = [orphan('folder/gone.sldprt')]
    storeState.currentFolder = 'unrelated'
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(storeState.setCurrentFolder).not.toHaveBeenCalled()
  })

  it('does not call setCurrentFolder when already at the vault root', async () => {
    const files = [orphan('folder/gone.sldprt')]
    storeState.currentFolder = ''
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(storeState.setCurrentFolder).not.toHaveBeenCalled()
  })

  it('does not relocate when a directory is left on disk instead of removed', async () => {
    const files = [orphan('folder/gone.sldprt')]
    trashEmptyDirs.mockImplementationOnce((paths: string[]) =>
      Promise.resolve(dirBatchResult(paths, paths)),
    )
    storeState.currentFolder = 'folder'
    const ctx = makeContext(files, { vaultPath: 'C:/vault' })

    await discardOrphanedCommand.execute({ files, isAutomatic: true }, ctx)

    expect(storeState.setCurrentFolder).not.toHaveBeenCalled()
  })
})
