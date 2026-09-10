import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/i18n', () => ({
  t: (key: string, fallback?: string) => fallback ?? key,
}))

vi.mock('@/stores/pdmStore', () => ({
  usePDMStore: { getState: () => ({ updatePendingMetadata: vi.fn(), setCopySource: vi.fn() }) },
}))

vi.mock('@/lib/metadata/overlay', () => ({
  resolveFileMetadata: () => ({ partNumber: {}, description: {}, revision: {} }),
}))

vi.mock('@/lib/checkout/checkoutDisplay', () => ({
  getCheckoutProfileForOwner: () => null,
}))

vi.mock('../executor', () => ({
  ProgressTracker: class {
    update() {}
    finish() {
      return { duration: 0 }
    }
  },
}))

const updateFilePath = vi.fn()
const updateFolderPath = vi.fn()
const updateFolderServerPath = vi.fn()

vi.mock('../../supabase', () => ({
  updateFilePath: (...args: unknown[]) => updateFilePath(...args),
  updateFolderPath: (...args: unknown[]) => updateFolderPath(...args),
  updateFolderServerPath: (...args: unknown[]) => updateFolderServerPath(...args),
  syncFolder: vi.fn(),
  deleteFolderOnServer: vi.fn(),
}))

vi.mock('../../supabase/files/move', () => ({
  moveFileOnServer: vi.fn(),
}))

import { moveCommand, renameCommand } from './fileOps'
import { listServerPathUpdateFailures } from './serverPathUpdates'
import type { CommandContext, LocalFile } from '../types'

const TOAST_BATCH_WINDOW_MS = 3_000

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

function syncedFile(relativePath: string, id: string): LocalFile {
  const name = relativePath.split('/').pop()!
  return {
    name,
    path: `C:\\vault\\${relativePath.replace(/\//g, '\\')}`,
    relativePath,
    isDirectory: false,
    extension: `.${name.split('.').pop()}`,
    size: 1,
    modifiedTime: '',
    isSynced: true,
    pdmData: { id, file_path: relativePath },
  } as LocalFile
}

function context(): { ctx: CommandContext; toasts: Array<[string, string]> } {
  const toasts: Array<[string, string]> = []
  const ctx = {
    files: [],
    user: { id: 'user-1' },
    vaultPath: 'C:\\vault',
    activeVaultId: 'vault-1',
    processingOperations: new Map(),
    addToast: (type: string, message: string) => void toasts.push([type, message]),
    addExpectedFileChanges: vi.fn(),
    clearExpectedFileChanges: vi.fn(),
    renameFileInStore: vi.fn(),
    updateFilesInStore: vi.fn(),
    setLastOperationCompletedAt: vi.fn(),
  } as unknown as CommandContext

  return { ctx, toasts }
}

const renameItem = vi.fn()

describe('renameCommand when the background server path update fails', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('window', { electronAPI: { renameItem } })
    renameItem.mockReset().mockResolvedValue({ success: true })
    updateFilePath.mockReset()
    updateFolderPath.mockReset()
    updateFolderServerPath.mockReset().mockResolvedValue({ success: true })
  })

  afterEach(async () => {
    // The batch window is module state; leaving one open would swallow the next test's toast.
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_WINDOW_MS)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('still completes the local rename and reports success to the caller', async () => {
    updateFilePath.mockResolvedValue({ success: false, error: 'permission denied' })
    const { ctx, toasts } = context()

    const result = await renameCommand.execute(
      { file: syncedFile('Parts/Bracket.SLDPRT', 'file-1'), newName: 'Bracket-Rev2' },
      ctx,
    )

    expect(result.success).toBe(true)
    // getExtension lowercases the preserved extension.
    expect(renameItem).toHaveBeenCalledWith(
      'C:\\vault\\Parts\\Bracket.SLDPRT',
      'C:\\vault\\Parts\\Bracket-Rev2.sldprt',
    )
    expect(ctx.renameFileInStore).toHaveBeenCalled()
    expect(toasts[0]).toEqual(['success', 'Renamed to Bracket-Rev2.sldprt'])
  })

  it('writes a durable record naming the row the server still has at the old path', async () => {
    updateFilePath.mockResolvedValue({ success: false, error: 'permission denied' })
    const { ctx } = context()

    await renameCommand.execute(
      { file: syncedFile('Parts/Bracket.SLDPRT', 'file-1'), newName: 'Bracket-Rev2' },
      ctx,
    )
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_WINDOW_MS)

    expect(listServerPathUpdateFailures()).toEqual([
      {
        kind: 'file',
        recordId: 'file-1',
        vaultId: 'vault-1',
        oldPath: 'Parts/Bracket.SLDPRT',
        newPath: 'Parts/Bracket-Rev2.sldprt',
        error: 'permission denied',
        failedAt: expect.any(Number),
      },
    ])
  })

  it('records a rejected update, not only a refused one', async () => {
    updateFilePath.mockRejectedValue(new Error('network down'))
    const { ctx } = context()

    await renameCommand.execute(
      { file: syncedFile('Parts/Bracket.SLDPRT', 'file-1'), newName: 'Bracket-Rev2' },
      ctx,
    )
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_WINDOW_MS)

    expect(listServerPathUpdateFailures()[0].error).toBe('network down')
  })

  it('warns once for a batch of files that all failed, not once per file', async () => {
    updateFilePath.mockResolvedValue({ success: false, error: 'permission denied' })
    const { ctx, toasts } = context()

    for (let i = 0; i < 20; i++) {
      await renameCommand.execute(
        { file: syncedFile(`Parts/Bracket-${i}.SLDPRT`, `file-${i}`), newName: `Renamed-${i}` },
        ctx,
      )
    }
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_WINDOW_MS)

    expect(listServerPathUpdateFailures()).toHaveLength(20)
    expect(toasts.filter(([type]) => type === 'warning')).toHaveLength(1)
  })

  it('records the folder row and the nested rows separately when both fail', async () => {
    updateFolderPath.mockResolvedValue({
      success: false,
      updated: 0,
      total: 0,
      errors: ['matches files in more than one vault'],
    })
    updateFolderServerPath.mockResolvedValue({ success: false, error: 'folder not found' })
    const { ctx, toasts } = context()

    const folder = {
      ...syncedFile('Parts', 'folder-1'),
      isDirectory: true,
      extension: '',
    } as LocalFile

    await renameCommand.execute({ file: folder, newName: 'Components' }, ctx)
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_WINDOW_MS)

    expect(listServerPathUpdateFailures().map((f) => f.kind)).toEqual([
      'folder-contents',
      'folder',
    ])
    expect(toasts.filter(([type]) => type === 'warning')).toHaveLength(1)
  })

  it('records nothing when the server update succeeds', async () => {
    updateFilePath.mockResolvedValue({ success: true })
    const { ctx, toasts } = context()

    await renameCommand.execute(
      { file: syncedFile('Parts/Bracket.SLDPRT', 'file-1'), newName: 'Bracket-Rev2' },
      ctx,
    )
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_WINDOW_MS)

    expect(listServerPathUpdateFailures()).toEqual([])
    expect(toasts.filter(([type]) => type === 'warning')).toEqual([])
  })
})

/**
 * A cloud-only file has no local copy, so load-time `moved` detection — which compares a
 * server path against the local path of the same inode — can never reconcile a write that
 * did not land. Reporting success here would leave the store showing a name the server
 * does not have, with nothing able to notice afterwards.
 */
describe('renameCommand on a cloud-only file whose server update fails', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('window', { electronAPI: { renameItem } })
    renameItem.mockReset()
    updateFilePath.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function cloudFile(relativePath: string, id: string): LocalFile {
    return { ...syncedFile(relativePath, id), diffStatus: 'cloud' } as LocalFile
  }

  it('fails the rename, names the reason, and leaves the store alone', async () => {
    updateFilePath.mockResolvedValue({ success: false, error: 'permission denied' })
    const { ctx, toasts } = context()

    const result = await renameCommand.execute(
      { file: cloudFile('Parts/Bracket.SLDPRT', 'file-1'), newName: 'Bracket-Rev2' },
      ctx,
    )

    expect(result.success).toBe(false)
    expect(result.failed).toBe(1)
    expect(ctx.renameFileInStore).not.toHaveBeenCalled()
    expect(toasts).toEqual([
      ['error', 'Could not rename on the server: permission denied'],
    ])
  })

  it('never touches the local filesystem, because there is no local file', async () => {
    updateFilePath.mockResolvedValue({ success: false, error: 'permission denied' })
    const { ctx } = context()

    await renameCommand.execute(
      { file: cloudFile('Parts/Bracket.SLDPRT', 'file-1'), newName: 'Bracket-Rev2' },
      ctx,
    )

    expect(renameItem).not.toHaveBeenCalled()
  })

  it('still renames in the store when the server update succeeds', async () => {
    updateFilePath.mockResolvedValue({ success: true })
    const { ctx, toasts } = context()

    const result = await renameCommand.execute(
      { file: cloudFile('Parts/Bracket.SLDPRT', 'file-1'), newName: 'Bracket-Rev2' },
      ctx,
    )

    expect(result.success).toBe(true)
    expect(ctx.renameFileInStore).toHaveBeenCalled()
    expect(toasts).toEqual([['success', 'Renamed to Bracket-Rev2.sldprt']])
  })
})

/**
 * A `'moved_away'` stub carries its `'moved'` partner's `pdmData`/checkout state, but there is
 * nothing on disk at the stub's own `relativePath`. `canRename`
 * (src/features/source/context-menu/items/FileOperationItems.tsx) and the drag handler
 * (src/features/source/explorer/file-tree/hooks/useTreeDragDrop.ts) already block a stub from
 * reaching rename/move at the UI layer - these are the same two commands refusing independently,
 * so a rename/move that reached this layer some other way still cannot attempt a filesystem
 * operation on a path that does not exist.
 */
describe('renameCommand refuses a moved_away stub, independently of the UI gate', () => {
  function movedAwayStub(relativePath: string, id: string): LocalFile {
    return {
      ...syncedFile(relativePath, id),
      diffStatus: 'moved_away',
      movedToRelativePath: `Elsewhere/${relativePath.split('/').pop()}`,
    } as LocalFile
  }

  it('validate refuses renaming the stub directly', () => {
    const { ctx } = context()
    const error = renameCommand.validate(
      { file: movedAwayStub('Parts/Bracket.SLDPRT', 'file-1'), newName: 'Renamed' },
      ctx,
    )
    expect(error).toBe('File has moved - resolve the pending move first')
  })

  it('does not refuse an ordinary folder rename even when it contains a moved_away stub', () => {
    const folder = { ...syncedFile('Parts', 'folder-1'), isDirectory: true, extension: '' } as LocalFile
    const stub = movedAwayStub('Parts/Bracket.SLDPRT', 'file-1')
    const { ctx } = context()
    ctx.files = [folder, stub]

    const error = renameCommand.validate({ file: folder, newName: 'Components' }, ctx)

    expect(error).toBeNull()
  })
})

describe('moveCommand refuses a moved_away stub directly, and folder moves skip stubs correctly', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: { renameItem } })
    renameItem.mockReset().mockResolvedValue({ success: true, fileCount: 1 })
    updateFilePath.mockReset().mockResolvedValue({ success: true })
    updateFolderPath
      .mockReset()
      .mockResolvedValue({ success: true, updated: 0, total: 0, errors: [] })
    updateFolderServerPath.mockReset().mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function cloudFile(relativePath: string, id: string): LocalFile {
    return { ...syncedFile(relativePath, id), diffStatus: 'cloud' } as LocalFile
  }

  function movedAwayStub(relativePath: string, id: string): LocalFile {
    return {
      ...syncedFile(relativePath, id),
      diffStatus: 'moved_away',
      movedToRelativePath: `Elsewhere/${relativePath.split('/').pop()}`,
    } as LocalFile
  }

  it('validate refuses moving the stub directly', () => {
    const stub = movedAwayStub('Parts/Bracket.SLDPRT', 'file-1')
    const { ctx } = context()

    const error = moveCommand.validate({ files: [stub], targetFolder: 'Archive' }, ctx)

    expect(error).toBe('File has moved - resolve the pending move first')
  })

  it('does not refuse moving a folder that merely contains a moved_away stub', () => {
    const folder = { ...syncedFile('Parts', 'folder-1'), isDirectory: true, extension: '' } as LocalFile
    const stub = movedAwayStub('Parts/Bracket.SLDPRT', 'file-1')
    const { ctx } = context()
    ctx.files = [folder, stub]

    const error = moveCommand.validate({ files: [folder], targetFolder: 'Archive' }, ctx)

    expect(error).toBeNull()
  })

  it('takes the fast path - no local filesystem rename - for a folder whose only contents are a cloud-only file and an unrelated moved_away stub', async () => {
    const folder = { ...syncedFile('Parts', 'folder-1'), isDirectory: true, extension: '' } as LocalFile
    const cloud = cloudFile('Parts/Cloud.SLDPRT', 'file-2')
    const stub = movedAwayStub('Parts/Moved.SLDPRT', 'file-3')
    const { ctx } = context()
    ctx.files = [folder, cloud, stub]

    const result = await moveCommand.execute({ files: [folder], targetFolder: 'Archive' }, ctx)

    expect(result.success).toBe(true)
    // The whole point of the fast path: nothing here has real content to rename on disk, so
    // the folder-level filesystem rename is never attempted.
    expect(renameItem).not.toHaveBeenCalled()
    expect(updateFolderServerPath).toHaveBeenCalledWith('folder-1', 'Archive/Parts')
    expect(ctx.renameFileInStore).toHaveBeenCalledWith(
      folder.path,
      'C:\\vault\\Archive\\Parts',
      'Archive/Parts',
      true,
    )
  })

  it('still performs the local filesystem rename once the folder has one real file, alongside the stub', async () => {
    const folder = { ...syncedFile('Parts', 'folder-1'), isDirectory: true, extension: '' } as LocalFile
    const cloud = cloudFile('Parts/Cloud.SLDPRT', 'file-2')
    const stub = movedAwayStub('Parts/Moved.SLDPRT', 'file-3')
    const real = syncedFile('Parts/Real.SLDPRT', 'file-4')
    const { ctx } = context()
    ctx.files = [folder, cloud, stub, real]

    const result = await moveCommand.execute({ files: [folder], targetFolder: 'Archive' }, ctx)

    expect(result.success).toBe(true)
    expect(renameItem).toHaveBeenCalledWith(folder.path, 'C:\\vault\\Archive\\Parts')
    // The nested pdmData.file_path patch (ctx.updateFilesInStore below) exists to keep a real
    // nested file's server-mirrored path in sync after the folder move - it should never touch
    // the stub, which has nothing on disk for that patch to protect.
    const updates = (ctx.updateFilesInStore as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Array<{ path: string }>
      | undefined
    expect(updates?.some((u) => u.path.includes('Moved.SLDPRT'))).toBe(false)
    expect(updates?.some((u) => u.path.includes('Real.SLDPRT'))).toBe(true)
  })
})

/**
 * A `'moved_away'` stub has `pdmData.file_path` too - it is not excluded by the `pdmData?.file_path`
 * truthiness check the nested-synced-files patch used alone. Patching it to the stub's own newly
 * renamed (still nonexistent) path writes a value into that field that protects nothing, since
 * there was never a real file at the stub's path for `loadFiles()` to lose track of.
 */
describe('renameCommand does not patch a nested moved_away stub\u2019s pdmData.file_path on folder rename', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: { renameItem } })
    renameItem.mockReset().mockResolvedValue({ success: true })
    updateFolderPath
      .mockReset()
      .mockResolvedValue({ success: true, updated: 1, total: 1, errors: [] })
    updateFolderServerPath.mockReset().mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('patches only the real nested file, not the stub', async () => {
    const folder = { ...syncedFile('Parts', 'folder-1'), isDirectory: true, extension: '' } as LocalFile
    const stub = {
      ...syncedFile('Parts/Stub.SLDPRT', 'file-2'),
      diffStatus: 'moved_away',
      movedToRelativePath: 'Elsewhere/Stub.SLDPRT',
    } as LocalFile
    const real = syncedFile('Parts/Real.SLDPRT', 'file-3')
    const { ctx } = context()
    ctx.files = [folder, stub, real]

    await renameCommand.execute({ file: folder, newName: 'Components' }, ctx)

    expect(ctx.updateFilesInStore).toHaveBeenCalledTimes(1)
    const updates = (ctx.updateFilesInStore as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{
      path: string
    }>
    expect(updates).toHaveLength(1)
    expect(updates[0].path).toBe('C:\\vault\\Components\\Real.SLDPRT')
  })
})
