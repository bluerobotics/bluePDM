/**
 * `delete-server` with `deleteLocal: false` ("delete from server, keep local copy"), and the
 * `'moved_away'` stub.
 *
 * `getServerDeletionTargets` attaches, for each server record a *folder* selection expands to,
 * whichever local row sits at the server's own recorded relativePath - by design, since that is
 * the row that answers "what does the server think is here". For a moved file, that row is the
 * `'moved_away'` stub, not the `'moved'` partner with the real content elsewhere on disk.
 *
 * Before this fix, "keep local copy" tested only `diffStatus !== 'cloud'`, which a stub passes,
 * so it was the stub - not the partner - that got converted to a local-only `'added'` row with
 * `pdmData` cleared. That created a phantom entry at a path with nothing on disk, while the
 * partner (the file that actually has the content the user asked to keep) was left alone, still
 * carrying `pdmData` for the server record this operation just deleted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommandContext, LocalFile } from '../types'
import type { ServerFile } from '../../../stores/types'
import type { PDMFile } from '../../../types/pdm'

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/fileWatcherSuppression', () => ({
  beginWatcherSuppression: vi.fn(() => vi.fn()),
}))
vi.mock('../../fileOperationTracker', () => ({
  FileOperationTracker: {
    start: () => ({ startStep: () => 'step', endStep: vi.fn(), endOperation: vi.fn() }),
  },
}))
vi.mock('../../cache/localSyncIndex', () => ({ removeFromSyncIndex: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../cache/vaultFileCache', () => ({ clearVaultCache: vi.fn().mockResolvedValue(undefined) }))

const softDeleteFile = vi.fn()
const checkinFile = vi.fn()
const deleteFolderByPath = vi.fn().mockResolvedValue(undefined)
vi.mock('../../supabase', () => ({ checkinFile, softDeleteFile, deleteFolderByPath }))

const { deleteServerCommand } = await import('./delete')

const VAULT = 'C:\\vault'
const ROOT_ID = 'child-1'

function localFile(relativePath: string, overrides: Partial<LocalFile> = {}): LocalFile {
  return {
    name: relativePath.split(/[/\\]/).pop() || '',
    path: `${VAULT}\\${relativePath.replace(/\//g, '\\')}`,
    relativePath,
    isDirectory: false,
    extension: relativePath.includes('.') ? `.${relativePath.split('.').pop()}` : '',
    size: 1,
    modifiedTime: 'now',
    ...overrides,
  } as LocalFile
}

function folder(relativePath: string): LocalFile {
  return localFile(relativePath, { isDirectory: true, name: relativePath, pdmData: undefined })
}

function serverFile(relativePath: string, id: string): ServerFile {
  return {
    id,
    file_path: relativePath,
    name: relativePath.split('/').pop() || '',
    extension: '.sldprt',
    content_hash: 'hash',
  }
}

function makeContext(files: LocalFile[], serverFiles: ServerFile[]): CommandContext {
  return {
    user: { id: 'user-1' } as CommandContext['user'],
    organization: { id: 'org-1' } as CommandContext['organization'],
    isOfflineMode: false,
    vaultPath: VAULT,
    activeVaultId: 'vault-1',
    files,
    serverFiles,
    addToast: vi.fn(),
    addProgressToast: vi.fn(),
    updateProgressToast: vi.fn(),
    removeToast: vi.fn(),
    isProgressToastCancelled: vi.fn(() => false),
    addProcessingFoldersSync: vi.fn(),
    removeProcessingFoldersSync: vi.fn(),
    setLastOperationCompletedAt: vi.fn(),
    removeFilesFromStore: vi.fn(),
    updateFilesInStore: vi.fn(),
    addExpectedFileChanges: vi.fn(),
  } as unknown as CommandContext
}

describe('delete-server keep-local, folder selection with a moved child', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    softDeleteFile.mockResolvedValue({ success: true })
    vi.stubGlobal('window', {
      electronAPI: { setReadonlyBatch: vi.fn().mockResolvedValue({ success: true, results: [] }) },
    })
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
  })

  it('keeps the moved partner\u2019s content, not the stub, and clears the partner\u2019s pdmData', async () => {
    const selectedFolder = folder('parts')
    const pdmData = { id: ROOT_ID, file_path: 'parts/Part.sldprt' } as PDMFile
    const stub = localFile('parts/Part.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'elsewhere/Part.sldprt',
      pdmData,
    })
    const moved = localFile('elsewhere/Part.sldprt', { diffStatus: 'moved', pdmData })

    const ctx = makeContext(
      [selectedFolder, stub, moved],
      [serverFile('parts/Part.sldprt', ROOT_ID)],
    )

    const result = await deleteServerCommand.execute(
      { files: [selectedFolder], deleteLocal: false },
      ctx,
    )

    expect(result.success).toBe(true)
    expect(softDeleteFile).toHaveBeenCalledWith(ROOT_ID, 'user-1')

    const updateFilesInStore = ctx.updateFilesInStore as ReturnType<typeof vi.fn>
    expect(updateFilesInStore).toHaveBeenCalledTimes(1)
    const [updates] = updateFilesInStore.mock.calls[0] as [
      Array<{ path: string; updates: Partial<LocalFile> }>,
    ]

    // The partner (real content) is the one converted to local-only, not the stub.
    expect(updates).toHaveLength(1)
    expect(updates[0].path).toBe(moved.path)
    expect(updates[0].updates.pdmData).toBeUndefined()
    expect(updates[0].updates.diffStatus).toBe('added')
  })

  it('keeps nothing when the stub has no partner anywhere in ctx.files', async () => {
    const selectedFolder = folder('parts')
    const orphanStub = localFile('parts/Part.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'elsewhere/Part.sldprt',
      pdmData: { id: ROOT_ID, file_path: 'parts/Part.sldprt' } as PDMFile,
    })

    const ctx = makeContext(
      [selectedFolder, orphanStub],
      [serverFile('parts/Part.sldprt', ROOT_ID)],
    )

    const result = await deleteServerCommand.execute(
      { files: [selectedFolder], deleteLocal: false },
      ctx,
    )

    expect(result.success).toBe(true)
    expect(softDeleteFile).toHaveBeenCalledWith(ROOT_ID, 'user-1')
    expect(ctx.updateFilesInStore).not.toHaveBeenCalled()
  })
})
