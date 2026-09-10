/**
 * The five properties that make this command safe to point at a production vault. Each one is a
 * behaviour a reviewer should be able to check in one test rather than infer from the handler:
 *
 * 1. It never writes unless asked to write.
 * 2. It refuses, by default, when another user holds any target, and names the holders.
 * 3. It states what it will do and requires confirmation.
 * 4. A run that stops halfway leaves a vault that a second run finishes.
 * 5. The summary keeps succeeded, failed, skipped and blocked apart.
 *
 * The real `t()` is used throughout, so a missing locale key fails these tests instead of printing
 * its own name at the operator.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServerMoveOutcome } from '../../supabase/files/move'
import type { PDMFile } from '../../../types/pdm'
import type { CommandContext, LocalFile } from '../types'

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const moveFilesOnServer = vi.fn()
vi.mock('../../supabase/files/move', () => ({ moveFilesOnServer }))

const removeFromSyncIndex = vi.fn(() => Promise.resolve())
vi.mock('../../cache/localSyncIndex', () => ({ removeFromSyncIndex }))

const clearVaultCache = vi.fn(() => Promise.resolve())
vi.mock('../../cache/vaultFileCache', () => ({ clearVaultCache }))

const { reconcileMovedPathsCommand } = await import('./reconcileMovedPaths')

const ME = 'user-me'

interface MovedOptions {
  checkedOutBy?: string
  holderName?: string
  serverHash?: string
  localHash?: string
}

/** A file at `localPath` whose row still records `old/<name>`. */
function moved(localPath: string, options: MovedOptions = {}): LocalFile {
  const name = localPath.split('/').pop()!

  return {
    name,
    path: `C:/vault/${localPath}`,
    relativePath: localPath,
    isDirectory: false,
    diffStatus: 'moved',
    localHash: options.localHash,
    pdmData: {
      id: `row-${name}`,
      file_path: `old/${name}`,
      file_name: name,
      content_hash: options.serverHash ?? null,
      checked_out_by: options.checkedOutBy ?? null,
      checked_out_user: options.checkedOutBy
        ? {
            id: options.checkedOutBy,
            email: `${options.checkedOutBy}@example.com`,
            full_name: options.holderName ?? null,
            avatar_url: null,
          }
        : null,
    } as unknown as PDMFile,
  } as LocalFile
}

type TestContext = CommandContext & {
  confirm: ReturnType<typeof vi.fn>
  addToast: ReturnType<typeof vi.fn>
  onRefresh: ReturnType<typeof vi.fn>
  /** Live view of the store, updated by `updateFilesInStore` exactly as the real slice would. */
  currentFiles: () => LocalFile[]
}

/**
 * A context whose store updates are real, so a second run sees what the first one left behind.
 * That is the only way to test resumability rather than to assert it.
 */
function makeContext(
  initialFiles: LocalFile[],
  options: { confirm?: boolean | null; cancelAfter?: number } = {},
): TestContext {
  let files = [...initialFiles]

  const updateFilesInStore = vi.fn(
    (updates: Array<{ path: string; updates: Partial<LocalFile> }>) => {
      const byPath = new Map(updates.map((u) => [u.path.toLowerCase(), u.updates]))
      files = files.map((file) => {
        const update = byPath.get(file.path.toLowerCase())
        return update ? { ...file, ...update } : file
      })
    },
  )

  const ctx = {
    user: { id: ME },
    organization: { id: 'org-1' },
    isOfflineMode: false,
    activeVaultId: 'vault-1',
    get files() {
      return files
    },
    serverFiles: [],
    confirm: vi.fn(() => Promise.resolve(options.confirm ?? true)),
    addToast: vi.fn(),
    addProgressToast: vi.fn(),
    updateProgressToast: vi.fn(),
    removeToast: vi.fn(),
    isProgressToastCancelled: vi.fn(() => false),
    updateFilesInStore,
    setLastOperationCompletedAt: vi.fn(),
    onRefresh: vi.fn(),
    currentFiles: () => files,
  } as unknown as TestContext

  if (options.confirm === null) {
    ;(ctx as { confirm?: unknown }).confirm = undefined
  }

  return ctx
}

/** Every listed file written, unless named in `failures`, and nothing after `stopAfter`. */
function serverResult(
  fileIds: string[],
  options: { failures?: Record<string, string>; stopAfter?: number } = {},
) {
  const results: ServerMoveOutcome[] = fileIds.map((fileId, index) => {
    if (options.stopAfter !== undefined && index >= options.stopAfter) {
      return { fileId, attempted: false, success: false }
    }
    const error = options.failures?.[fileId]
    return { fileId, attempted: true, success: !error, error }
  })

  const attempted = results.filter((r) => r.attempted)

  return {
    succeeded: attempted.filter((r) => r.success).length,
    failed: attempted.filter((r) => !r.success).length,
    errors: attempted.filter((r) => !r.success).map((r) => `${r.fileId}: ${r.error}`),
    results,
    stopped: results.some((r) => !r.attempted),
  }
}

/** The file ids a single `moveFilesOnServer` call was asked to write. */
function writtenIds(call = 0): string[] {
  const moves = moveFilesOnServer.mock.calls[call][0] as Array<{ fileId: string }>
  return moves.map((move) => move.fileId)
}

beforeEach(() => {
  vi.clearAllMocks()
  moveFilesOnServer.mockImplementation((moves: Array<{ fileId: string }>) =>
    Promise.resolve(serverResult(moves.map((move) => move.fileId))),
  )
})

// ============================================
// Property 1: it never writes unless asked
// ============================================

describe('property 1 — nothing is written unless the caller asks for the write', () => {
  it('reports and writes nothing when `apply` is omitted', async () => {
    const files = [moved('new/a.sldprt'), moved('new/b.sldprt')]
    const ctx = makeContext(files)

    const result = await reconcileMovedPathsCommand.execute({}, ctx)

    expect(moveFilesOnServer).not.toHaveBeenCalled()
    expect(ctx.confirm).not.toHaveBeenCalled()
    expect(ctx.updateFilesInStore).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.succeeded).toBe(0)
    expect(result.total).toBe(2)
    expect(result.message).toContain('Nothing was written')
  })

  it('reports the same four buckets a real run would act on', async () => {
    const ctx = makeContext([
      moved('new/a.sldprt'),
      moved('new/held.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('new/edited.sldprt', { serverHash: 'aaa', localHash: 'bbb' }),
    ])

    const result = await reconcileMovedPathsCommand.execute({}, ctx)

    const report = (result.details ?? []).join('\n')
    expect(report).toContain('1 can have their server path written now')
    expect(report).toContain('1 held by Ana Ruiz')
    expect(report).toContain('cannot be verified')
  })

  it('writes nothing when `apply` is set but the pre-flight finds nothing eligible', async () => {
    const ctx = makeContext([moved('new/edited.sldprt', { serverHash: 'aaa', localHash: 'bbb' })])

    const result = await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    expect(moveFilesOnServer).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
  })

  it('refuses the whole command while offline or signed out', () => {
    const files = [moved('new/a.sldprt')]

    const offline = { ...makeContext(files), isOfflineMode: true } as CommandContext
    expect(reconcileMovedPathsCommand.validate({}, offline)).toContain('offline')

    const signedOut = { ...makeContext(files), user: null } as CommandContext
    expect(reconcileMovedPathsCommand.validate({}, signedOut)).toContain('sign in')
  })

  it('has nothing to offer a vault with no moved files', () => {
    const synced = { ...moved('new/a.sldprt'), diffStatus: undefined } as LocalFile

    expect(reconcileMovedPathsCommand.validate({}, makeContext([synced]))).toContain(
      'No file is waiting',
    )
  })
})

// ============================================
// Property 2: refuse when somebody else holds a target
// ============================================

describe('property 2 — a target held by another user refuses the run and names the holders', () => {
  it('refuses and names every holder, grouped by user', async () => {
    const ctx = makeContext([
      moved('new/a.sldprt'),
      moved('new/held1.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('new/held2.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('new/held3.sldprt', { checkedOutBy: 'user-sam', holderName: 'Sam Lee' }),
    ])

    const result = await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    expect(moveFilesOnServer).not.toHaveBeenCalled()
    expect(ctx.confirm).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.succeeded).toBe(0)
    expect(result.message).toContain('2 held by Ana Ruiz')
    expect(result.message).toContain('1 held by Sam Lee')
    // The refusal is also the instruction: ask them, or opt in.
    expect(result.message).toContain('--skip-checked-out')
    expect(ctx.addToast).toHaveBeenCalledWith('warning', expect.stringContaining('Ana Ruiz'))
  })

  it('skips exactly the held rows and reconciles the rest when the caller opts in', async () => {
    const ctx = makeContext([
      moved('new/a.sldprt'),
      moved('new/b.sldprt'),
      moved('new/held.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
    ])

    const result = await reconcileMovedPathsCommand.execute(
      { apply: true, skipCheckedOut: true },
      ctx,
    )

    expect(writtenIds()).toEqual(['row-a.sldprt', 'row-b.sldprt'])
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    // Two of three is not a success, even when the third was skipped on purpose.
    expect(result.success).toBe(false)
    expect(result.message).toContain('1 checked out by others')

    // The held row keeps its stale path and its badge; nobody wrote over the holder's work.
    const held = ctx.currentFiles().find((f) => f.name === 'held.sldprt')!
    expect(held.pdmData?.file_path).toBe('old/held.sldprt')
    expect(held.diffStatus).toBe('moved')
  })

  it('does not treat the acting user’s own checkout as somebody else’s', async () => {
    const ctx = makeContext([moved('new/mine.sldprt', { checkedOutBy: ME })])

    await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    expect(writtenIds()).toEqual(['row-mine.sldprt'])
  })
})

// ============================================
// Property 3: state it, then confirm it
// ============================================

describe('property 3 — the run is stated and confirmed before anything is written', () => {
  it('states the counts and the paths, and waits for confirmation', async () => {
    const ctx = makeContext([
      moved('new/a.sldprt'),
      moved('new/b.sldprt'),
      moved('new/held.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('new/edited.sldprt', { serverHash: 'aaa', localHash: 'bbb' }),
    ])

    await reconcileMovedPathsCommand.execute({ apply: true, skipCheckedOut: true }, ctx)

    const [opts] = ctx.confirm.mock.calls[0] as [
      { title: string; message: string; items: string[]; confirmText: string },
    ]
    expect(opts.title).toContain('2')
    expect(opts.message).toContain('2 files will have their server path updated')
    // The dialog renders the message as a single paragraph, so it has to read as one.
    expect(opts.message).not.toContain('\n')
    expect(opts.message).toContain('2 more are left unchanged')
    expect(opts.message).toContain('1 checked out by others')
    expect(opts.message).toContain('1 skipped')
    expect(opts.items).toContain('old/a.sldprt → new/a.sldprt')
    expect(opts.confirmText).toContain('2')
    // Stated before written, not alongside it.
    expect(ctx.confirm.mock.invocationCallOrder[0]).toBeLessThan(
      moveFilesOnServer.mock.invocationCallOrder[0],
    )
  })

  it('writes nothing when the user declines', async () => {
    const ctx = makeContext([moved('new/a.sldprt')], { confirm: false })

    const result = await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    expect(moveFilesOnServer).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.message).toContain('Cancelled')
  })

  it('writes nothing when there is no dialog to confirm with', async () => {
    const ctx = makeContext([moved('new/a.sldprt')], { confirm: null })

    const result = await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    expect(moveFilesOnServer).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.message).toContain('confirmation dialog')
  })

  /**
   * The dialog shows the first few items and reports the rest as a count, so it is handed every
   * file. Truncating here would make it say "20 files" over a 455-file write.
   */
  it('hands the dialog one item per file so its count is the real count', async () => {
    const many = Array.from({ length: 30 }, (_, i) => moved(`new/f${i}.sldprt`))
    const ctx = makeContext(many)

    await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    const [opts] = ctx.confirm.mock.calls[0] as [{ items: string[]; message: string }]
    expect(opts.items).toHaveLength(30)
    expect(opts.message).toContain('30 files')
  })
})

// ============================================
// Property 4: a stopped run is a resumable run
// ============================================

describe('property 4 — a run that stops halfway leaves a vault a second run finishes', () => {
  it('leaves the unwritten rows untouched and reconciles them on the next run', async () => {
    const ctx = makeContext([moved('new/a.sldprt'), moved('new/b.sldprt'), moved('new/c.sldprt')])

    moveFilesOnServer.mockImplementationOnce((moves: Array<{ fileId: string }>) =>
      Promise.resolve(
        serverResult(
          moves.map((m) => m.fileId),
          { stopAfter: 1 },
        ),
      ),
    )

    const first = await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    expect(first.succeeded).toBe(1)
    expect(first.failed).toBe(0)
    expect(first.success).toBe(false)
    expect(first.message).toContain('2 not attempted')

    // Only the written row moved on; the other two still record their old paths.
    const after = ctx.currentFiles()
    expect(after.find((f) => f.name === 'a.sldprt')?.pdmData?.file_path).toBe('new/a.sldprt')
    expect(after.find((f) => f.name === 'b.sldprt')?.pdmData?.file_path).toBe('old/b.sldprt')
    expect(after.find((f) => f.name === 'c.sldprt')?.pdmData?.file_path).toBe('old/c.sldprt')

    const second = await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    // The finished row is not offered again — no row is written twice.
    expect(writtenIds(1)).toEqual(['row-b.sldprt', 'row-c.sldprt'])
    expect(second.succeeded).toBe(2)
    expect(second.success).toBe(true)
  })

  it('offers nothing when re-run against a vault it already reconciled', async () => {
    const ctx = makeContext([moved('new/a.sldprt')])

    await reconcileMovedPathsCommand.execute({ apply: true }, ctx)
    const again = await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    expect(moveFilesOnServer).toHaveBeenCalledTimes(1)
    expect(again.total).toBe(0)
    expect(reconcileMovedPathsCommand.validate({}, ctx)).toContain('No file is waiting')
  })

  it('stops the run when the operator cancels the progress toast', async () => {
    const ctx = makeContext([moved('new/a.sldprt')])
    ;(ctx.isProgressToastCancelled as ReturnType<typeof vi.fn>).mockReturnValue(true)

    await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    const [, , options] = moveFilesOnServer.mock.calls[0] as [
      unknown,
      string,
      { shouldStop: () => boolean },
    ]
    expect(options.shouldStop()).toBe(true)
  })
})

// ============================================
// Property 5: the summary keeps the outcomes apart
// ============================================

describe('property 5 — succeeded, failed, skipped and blocked are reported separately', () => {
  it('counts each outcome in its own bucket and does not read as a success', async () => {
    const ctx = makeContext([
      moved('new/a.sldprt'),
      moved('new/b.sldprt'),
      moved('new/held.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('new/edited.sldprt', { serverHash: 'aaa', localHash: 'bbb' }),
    ])

    moveFilesOnServer.mockImplementationOnce((moves: Array<{ fileId: string }>) =>
      Promise.resolve(
        serverResult(
          moves.map((m) => m.fileId),
          { failures: { 'row-b.sldprt': 'Cannot move: file is checked out by Sam Lee' } },
        ),
      ),
    )

    const result = await reconcileMovedPathsCommand.execute(
      { apply: true, skipCheckedOut: true },
      ctx,
    )

    expect(result.total).toBe(4)
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.success).toBe(false)
    expect(result.message).toContain('1 failed')
    expect(result.message).toContain('1 checked out by others')
    expect(result.message).toContain('1 skipped')
    expect(result.message).toContain('Run it again')

    // The failure carries the server's own words, so the operator can act on the reason.
    expect(result.errors?.[0]).toContain('new/b.sldprt')
    expect(result.errors?.[0]).toContain('checked out by Sam Lee')

    // A failed row keeps its old path; only the written row was patched.
    expect(ctx.currentFiles().find((f) => f.name === 'b.sldprt')?.pdmData?.file_path).toBe(
      'old/b.sldprt',
    )
    expect(ctx.addToast).toHaveBeenCalledWith('warning', expect.stringContaining('1 of 4'))
  })

  it('reports a clean run as a success and says so once', async () => {
    const ctx = makeContext([moved('new/a.sldprt'), moved('new/b.sldprt')])

    const result = await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    expect(result.success).toBe(true)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.message).toBe('Reconciled 2 server paths.')
    expect(ctx.addToast).toHaveBeenCalledWith('success', 'Reconciled 2 server paths.')
  })

  it('names failures individually up to a limit, then counts them', async () => {
    const many = Array.from({ length: 14 }, (_, i) => moved(`new/f${i}.sldprt`))
    const ctx = makeContext(many)

    moveFilesOnServer.mockImplementationOnce((moves: Array<{ fileId: string }>) =>
      Promise.resolve(
        serverResult(
          moves.map((m) => m.fileId),
          { failures: Object.fromEntries(moves.map((m) => [m.fileId, 'RPC refused'])) },
        ),
      ),
    )

    const result = await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    expect(result.failed).toBe(14)
    expect(result.errors).toHaveLength(11)
    expect(result.errors?.[10]).toContain('4 more')
  })
})

// ============================================
// After a successful run
// ============================================

describe('after a run', () => {
  it('patches the written rows, drops their old paths from the sync index and invalidates the cache', async () => {
    const ctx = makeContext([moved('new/a.sldprt')])

    await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    const file = ctx.currentFiles()[0]
    expect(file.pdmData?.file_path).toBe('new/a.sldprt')
    expect(file.pdmData?.file_name).toBe('a.sldprt')
    // The row is no longer moved, so the badge goes with the fix rather than surviving it.
    expect(file.diffStatus).toBeUndefined()

    expect(removeFromSyncIndex).toHaveBeenCalledWith('vault-1', ['old/a.sldprt'])
    expect(clearVaultCache).toHaveBeenCalledWith('vault-1')
    expect(ctx.onRefresh).toHaveBeenCalled()
  })

  it('touches neither the sync index nor the cache when nothing was written', async () => {
    const ctx = makeContext([moved('new/a.sldprt')])
    moveFilesOnServer.mockImplementationOnce((moves: Array<{ fileId: string }>) =>
      Promise.resolve(
        serverResult(
          moves.map((m) => m.fileId),
          { failures: { 'row-a.sldprt': 'RPC refused' } },
        ),
      ),
    )

    await reconcileMovedPathsCommand.execute({ apply: true }, ctx)

    expect(removeFromSyncIndex).not.toHaveBeenCalled()
    expect(clearVaultCache).not.toHaveBeenCalled()
    expect(ctx.updateFilesInStore).not.toHaveBeenCalled()
  })

  it('clears the progress toast even when the write throws', async () => {
    const ctx = makeContext([moved('new/a.sldprt')])
    moveFilesOnServer.mockRejectedValueOnce(new Error('network died'))

    await expect(reconcileMovedPathsCommand.execute({ apply: true }, ctx)).rejects.toThrow(
      'network died',
    )

    expect(ctx.removeToast).toHaveBeenCalled()
  })
})
