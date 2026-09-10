/**
 * The properties that make this command safe to point at a production vault, mirroring
 * `reconcileMovedPaths.test.ts` for the opposite direction:
 *
 * 1. It never writes unless asked to write.
 * 2. It refuses, by default, when another user holds any target - even though the rename is
 *    always safe - and `force` is what lets those through.
 * 3. It states what it will do and requires confirmation.
 * 4. A run that stops halfway leaves a vault a second run finishes.
 * 5. The summary keeps succeeded, failed, skipped and blocked apart.
 * 6. A successful adopt re-keys the sync index so the move is not re-detected on the next load.
 *
 * The real `t()` is used throughout, so a missing locale key fails these tests instead of
 * printing its own name at the operator.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PDMFile } from '../../../types/pdm'
import type { CommandContext, LocalFile } from '../types'

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const renameItem = vi.fn(
  (_oldPath: string, _newPath: string): Promise<{ success: boolean; error?: string }> =>
    Promise.resolve({ success: true }),
)
const fileExists = vi.fn(() => Promise.resolve(false))
const createFolder = vi.fn(() => Promise.resolve({ success: true }))
const trashEmptyDirs = vi.fn(() =>
  Promise.resolve({
    success: true,
    results: [],
    summary: { total: 0, succeeded: 0, failed: 0, skipped: 0, duration: 0 },
  }),
)

vi.stubGlobal('window', { electronAPI: { renameItem, fileExists, createFolder, trashEmptyDirs } })

const removeFromSyncIndex = vi.fn(() => Promise.resolve())
const addToSyncIndex = vi.fn(() => Promise.resolve())
const updateInodes = vi.fn(() => Promise.resolve())
vi.mock('../../cache/localSyncIndex', () => ({ removeFromSyncIndex, addToSyncIndex, updateInodes }))

vi.mock('../../orphanedDirectories', () => ({
  getOrphanedDirectoryCandidates: () => [],
}))

let storeState: { serverFolderPaths: Set<string> }
vi.mock('@/stores/pdmStore', () => ({
  usePDMStore: { getState: () => storeState },
}))

const { adoptServerPathsCommand } = await import('./adoptServerPaths')

const ME = 'user-me'

interface MovedOptions {
  checkedOutBy?: string
  holderName?: string
  serverHash?: string
  localHash?: string
  serverPath?: string
}

/** A file at `localPath` whose row records `server/<name>` instead. */
function moved(localPath: string, options: MovedOptions = {}): LocalFile {
  const name = localPath.split('/').pop()!
  const serverPath = options.serverPath ?? `server/${name}`

  return {
    name,
    path: `C:/vault/${localPath}`,
    relativePath: localPath,
    isDirectory: false,
    diffStatus: 'moved',
    localHash: options.localHash,
    ino: 7,
    pdmData: {
      id: `row-${name}`,
      file_path: serverPath,
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
  renameFileInStore: ReturnType<typeof vi.fn>
  /** Live view of the store, updated by `renameFileInStore`/`updateFilesInStore` exactly as the real slice would. */
  currentFiles: () => LocalFile[]
}

/**
 * A context whose store updates are real, so a second run sees what the first one left behind.
 * That is the only way to test resumability rather than to assert it.
 */
function makeContext(
  initialFiles: LocalFile[],
  options: { confirm?: boolean | null } = {},
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

  const renameFileInStore = vi.fn((oldPath: string, newPath: string, newRelPath: string) => {
    files = files.map((file) =>
      file.path === oldPath ? { ...file, path: newPath, relativePath: newRelPath } : file,
    )
  })

  const ctx = {
    user: { id: ME },
    organization: { id: 'org-1' },
    isOfflineMode: false,
    vaultPath: 'C:/vault',
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
    renameFileInStore,
    removeFilesFromStore: vi.fn(),
    addExpectedFileChanges: vi.fn(),
    clearExpectedFileChanges: vi.fn(),
    setLastOperationCompletedAt: vi.fn(),
    onRefresh: vi.fn(),
    currentFiles: () => files,
  } as unknown as TestContext

  if (options.confirm === null) {
    ;(ctx as { confirm?: unknown }).confirm = undefined
  }

  return ctx
}

beforeEach(() => {
  vi.clearAllMocks()
  renameItem.mockResolvedValue({ success: true })
  fileExists.mockResolvedValue(false)
  createFolder.mockResolvedValue({ success: true })
  storeState = { serverFolderPaths: new Set() }
})

// ============================================
// Property 1: it never writes unless asked
// ============================================

describe('property 1 — nothing is written unless the caller asks for the write', () => {
  it('reports and renames nothing when `apply` is omitted', async () => {
    const files = [moved('a.sldprt'), moved('b.sldprt')]
    const ctx = makeContext(files)

    const result = await adoptServerPathsCommand.execute({}, ctx)

    expect(renameItem).not.toHaveBeenCalled()
    expect(ctx.confirm).not.toHaveBeenCalled()
    expect(ctx.renameFileInStore).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.succeeded).toBe(0)
    expect(result.total).toBe(2)
    expect(result.message).toContain('Nothing was written')
  })

  it('reports the same four buckets a real run would act on', async () => {
    const ctx = makeContext([
      moved('a.sldprt'),
      moved('held.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('edited.sldprt', { serverHash: 'aaa', localHash: 'bbb' }),
    ])

    const result = await adoptServerPathsCommand.execute({}, ctx)

    const report = (result.details ?? []).join('\n')
    expect(report).toContain('1 can be renamed back to their server path now')
    expect(report).toContain('1 held by Ana Ruiz')
    expect(report).toContain('cannot be verified')
  })

  it('refuses the whole command when signed out or the vault is disconnected', () => {
    const files = [moved('a.sldprt')]

    const signedOut = { ...makeContext(files), user: null } as CommandContext
    expect(adoptServerPathsCommand.validate({}, signedOut)).toContain('sign in')

    const noVault = { ...makeContext(files), vaultPath: null } as CommandContext
    expect(adoptServerPathsCommand.validate({}, noVault)).toContain('vault')
  })

  it('has nothing to offer a vault with no moved files', () => {
    const synced = { ...moved('a.sldprt'), diffStatus: undefined } as LocalFile

    expect(adoptServerPathsCommand.validate({}, makeContext([synced]))).toContain(
      'No file is waiting',
    )
  })
})

// ============================================
// Property 2: held targets are safe but held back by default
// ============================================

describe('property 2 — a target held by another user is refused by default and named', () => {
  it('refuses and names every holder, grouped by user', async () => {
    const ctx = makeContext([
      moved('a.sldprt'),
      moved('held1.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('held2.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('held3.sldprt', { checkedOutBy: 'user-sam', holderName: 'Sam Lee' }),
    ])

    const result = await adoptServerPathsCommand.execute({ apply: true }, ctx)

    expect(renameItem).not.toHaveBeenCalled()
    expect(ctx.confirm).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.succeeded).toBe(0)
    expect(result.message).toContain('2 held by Ana Ruiz')
    expect(result.message).toContain('1 held by Sam Lee')
    // The refusal is also the instruction: ask them, or force it.
    expect(result.message).toContain('--force')
    expect(ctx.addToast).toHaveBeenCalledWith('warning', expect.stringContaining('Ana Ruiz'))
  })

  it('renames the held rows too when the caller forces it', async () => {
    const ctx = makeContext([
      moved('a.sldprt'),
      moved('held.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
    ])

    const result = await adoptServerPathsCommand.execute({ apply: true, force: true }, ctx)

    expect(renameItem).toHaveBeenCalledTimes(2)
    expect(result.succeeded).toBe(2)
    expect(result.success).toBe(true)
  })

  it('does not treat the acting user’s own checkout as somebody else’s', async () => {
    const ctx = makeContext([moved('mine.sldprt', { checkedOutBy: ME })])

    await adoptServerPathsCommand.execute({ apply: true }, ctx)

    expect(renameItem).toHaveBeenCalledTimes(1)
  })
})

// ============================================
// Property 3: state it, then confirm it
// ============================================

describe('property 3 — the run is stated and confirmed before anything is written', () => {
  it('states the counts and the paths, and waits for confirmation', async () => {
    const ctx = makeContext([
      moved('a.sldprt'),
      moved('b.sldprt'),
      moved('held.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('edited.sldprt', { serverHash: 'aaa', localHash: 'bbb' }),
    ])

    await adoptServerPathsCommand.execute({ apply: true, force: true }, ctx)

    const [opts] = ctx.confirm.mock.calls[0] as [
      { title: string; message: string; items: string[]; confirmText: string },
    ]
    // Forced, so the held row is part of the write, not part of the remainder.
    expect(opts.title).toContain('3')
    expect(opts.message).toContain('3 files')
    expect(opts.message).not.toContain('\n')
    expect(opts.message).toContain('1 skipped')
    expect(opts.items).toContain('a.sldprt → server/a.sldprt')
    expect(opts.confirmText).toContain('3')
    expect(ctx.confirm.mock.invocationCallOrder[0]).toBeLessThan(
      renameItem.mock.invocationCallOrder[0],
    )
  })

  it('writes nothing when the user declines', async () => {
    const ctx = makeContext([moved('a.sldprt')], { confirm: false })

    const result = await adoptServerPathsCommand.execute({ apply: true }, ctx)

    expect(renameItem).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.message).toContain('Cancelled')
  })

  it('writes nothing when there is no dialog to confirm with', async () => {
    const ctx = makeContext([moved('a.sldprt')], { confirm: null })

    const result = await adoptServerPathsCommand.execute({ apply: true }, ctx)

    expect(renameItem).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.message).toContain('confirmation dialog')
  })

  it('hands the dialog one item per file so its count is the real count', async () => {
    const many = Array.from({ length: 30 }, (_, i) => moved(`f${i}.sldprt`))
    const ctx = makeContext(many)

    await adoptServerPathsCommand.execute({ apply: true }, ctx)

    const [opts] = ctx.confirm.mock.calls[0] as [{ items: string[]; message: string }]
    expect(opts.items).toHaveLength(30)
    expect(opts.message).toContain('30 files')
  })
})

// ============================================
// Property 4: a stopped run is a resumable run
// ============================================

describe('property 4 — a run that stops halfway leaves a vault a second run finishes', () => {
  it('leaves failed renames untouched and adopts them on the next run', async () => {
    const ctx = makeContext([moved('a.sldprt'), moved('b.sldprt'), moved('c.sldprt')])

    // Keyed by source path rather than call order: the rename batch runs with concurrency, so
    // the order in which the mock is invoked is not the order the targets were listed in.
    renameItem.mockImplementation((oldPath: string) =>
      Promise.resolve(
        oldPath.includes('b.sldprt')
          ? { success: false, error: 'File is open in SolidWorks' }
          : { success: true },
      ),
    )

    const first = await adoptServerPathsCommand.execute({ apply: true }, ctx)

    expect(first.succeeded).toBe(2)
    expect(first.failed).toBe(1)
    expect(first.success).toBe(false)
    expect(first.errors?.[0]).toContain('b.sldprt')
    expect(first.errors?.[0]).toContain('SolidWorks')

    // The failed rename left its file exactly where it was; the store never renamed it.
    const after = ctx.currentFiles()
    expect(after.find((f) => f.name === 'b.sldprt')?.path).toBe('C:/vault/b.sldprt')

    renameItem.mockResolvedValue({ success: true })
    const second = await adoptServerPathsCommand.execute({ apply: true }, ctx)

    expect(second.succeeded).toBe(1)
    expect(second.success).toBe(true)
  })

  it('offers nothing when re-run against a vault it already adopted', async () => {
    const ctx = makeContext([moved('a.sldprt')])

    await adoptServerPathsCommand.execute({ apply: true }, ctx)
    const again = await adoptServerPathsCommand.execute({ apply: true }, ctx)

    expect(renameItem).toHaveBeenCalledTimes(1)
    expect(again.total).toBe(0)
    expect(adoptServerPathsCommand.validate({}, ctx)).toContain('No file is waiting')
  })
})

// ============================================
// Property 5: the summary keeps the outcomes apart
// ============================================

describe('property 5 — succeeded, failed, skipped and blocked are reported separately', () => {
  it('keeps a blocked target out of the run entirely, apart from failed and skipped, without force', async () => {
    const ctx = makeContext([
      moved('a.sldprt'),
      moved('b.sldprt'),
      moved('held.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('edited.sldprt', { serverHash: 'aaa', localHash: 'bbb' }),
    ])

    const result = await adoptServerPathsCommand.execute({ apply: true }, ctx)

    // A held target refuses the whole run by default, exactly like reconcile-moved-paths - the
    // rename is safe, but the operator sees the checkout before anything is renamed.
    expect(renameItem).not.toHaveBeenCalled()
    expect(result.succeeded).toBe(0)
    expect(result.success).toBe(false)
    expect(result.message).toContain('1 held by Ana Ruiz')
  })

  it('counts each outcome in its own bucket and does not read as a success, once forced', async () => {
    const ctx = makeContext([
      moved('a.sldprt'),
      moved('b.sldprt'),
      moved('held.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('edited.sldprt', { serverHash: 'aaa', localHash: 'bbb' }),
    ])

    // Keyed by source path rather than call order: the rename batch runs with concurrency.
    renameItem.mockImplementation((oldPath: string) =>
      Promise.resolve(
        oldPath.includes('b.sldprt') ? { success: false, error: 'disk full' } : { success: true },
      ),
    )

    const result = await adoptServerPathsCommand.execute({ apply: true, force: true }, ctx)

    // Forcing folds the held target into the run, so it lands in succeeded or failed rather than
    // staying blocked - only the pre-flight's unrelated "unverified" skip is left over.
    expect(result.total).toBe(4)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.success).toBe(false)
    expect(result.message).toContain('1 failed')
    expect(result.message).toContain('1 skipped')
    expect(result.message).not.toContain('checked out')
    expect(result.errors?.[0]).toContain('b.sldprt')
    expect(result.errors?.[0]).toContain('disk full')
    expect(ctx.addToast).toHaveBeenCalledWith('warning', expect.stringContaining('2 of 4'))
  })

  it('reports a clean run as a success and says so once', async () => {
    const ctx = makeContext([moved('a.sldprt'), moved('b.sldprt')])

    const result = await adoptServerPathsCommand.execute({ apply: true }, ctx)

    expect(result.success).toBe(true)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.message).toBe('Renamed 2 files back to their server path.')
    expect(ctx.addToast).toHaveBeenCalledWith('success', result.message)
  })
})

// ============================================
// Property 6: the sync index is re-keyed so the move does not re-arm
// ============================================

describe('property 6 — a successful adopt re-keys the sync index', () => {
  it('drops the vacated path, marks the adopted path synced and pins the inode there', async () => {
    const ctx = makeContext([moved('local/a.sldprt')])

    await adoptServerPathsCommand.execute({ apply: true }, ctx)

    expect(removeFromSyncIndex).toHaveBeenCalledWith('vault-1', ['local/a.sldprt'])
    expect(addToSyncIndex).toHaveBeenCalledWith('vault-1', ['server/a.sldprt'])
    expect(updateInodes).toHaveBeenCalledWith('vault-1', [
      expect.objectContaining({ path: 'server/a.sldprt', ino: 7 }),
    ])
  })

  it('touches neither the sync index nor the store when nothing was renamed', async () => {
    const ctx = makeContext([moved('a.sldprt')])
    renameItem.mockResolvedValueOnce({ success: false, error: 'locked' })

    await adoptServerPathsCommand.execute({ apply: true }, ctx)

    expect(removeFromSyncIndex).not.toHaveBeenCalled()
    expect(addToSyncIndex).not.toHaveBeenCalled()
    expect(updateInodes).not.toHaveBeenCalled()
    expect(ctx.renameFileInStore).not.toHaveBeenCalled()
  })

  it('patches the renamed row so it stops reading as moved', async () => {
    const ctx = makeContext([moved('local/a.sldprt')])

    await adoptServerPathsCommand.execute({ apply: true }, ctx)

    const file = ctx.currentFiles()[0]
    expect(file.relativePath).toBe('server/a.sldprt')
    expect(file.diffStatus).toBeUndefined()
  })
})

// ============================================
// Never overwrite
// ============================================

describe('never overwrites a file that appears at the destination', () => {
  it('refuses a rename whose destination exists on disk when the run starts', async () => {
    const ctx = makeContext([moved('a.sldprt')])
    fileExists.mockResolvedValueOnce(true)

    const result = await adoptServerPathsCommand.execute({ apply: true }, ctx)

    expect(renameItem).not.toHaveBeenCalled()
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.errors?.[0]).toContain('server/a.sldprt')
  })
})
