/**
 * Bulk assembly commands, and the `'moved_away'` stub.
 *
 * A `moved_away` row is a stub at the *server's* recorded path for a file whose content now
 * lives elsewhere on disk - it has no local file behind it. It shares `pdmData.id` with its
 * `'moved'` partner row at the real path.
 *
 * `resolveFilesForBulkOperation` used to build its own `id -> file` map with a plain
 * `set(file.pdmData.id, file)` loop over `ctx.files`, before ever calling the resolver. Whichever
 * of the stub or the partner `ctx.files` happened to list last for a shared id silently won -
 * if the stub won, the real file (the partner) was completely absent from the resolved set,
 * dropping it from the bulk operation the user expected to cover the whole assembly. It now
 * builds that map with `buildCanonicalFileMap`, the same policy `resolveAssociatedFiles` itself
 * uses for its own array input.
 *
 * Each command's own filter for "is this row actually actionable" (checkout's `checkoutableFiles`,
 * checkin's `checkinableFiles`, delete's `localFiles`) used to test only `diffStatus !== 'cloud'`,
 * which a `'moved_away'` stub passes - these now use `hasLocalContent`, so an unpartnered stub
 * (one whose `'moved'` row was not present in `ctx.files` at all - not expected in practice, but
 * not ruled out either) is excluded rather than handed to a command that would try to act on a
 * path with nothing on disk.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommandContext, LocalFile } from '../types'
import type { PDMFile } from '../../../types/pdm'

const getFile = vi.fn()
const getContainsRecursive = vi.fn()
const getDrawingsForFiles = vi.fn()

vi.mock('@/lib/supabase/files/queries', () => ({ getFile, getContainsRecursive, getDrawingsForFiles }))
vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const endOperation = vi.fn()
vi.mock('../../fileOperationTracker', () => ({
  FileOperationTracker: { start: () => ({ endOperation }) },
}))

const downloadExecute = vi.fn().mockResolvedValue({
  success: true,
  message: 'ok',
  total: 0,
  succeeded: 0,
  failed: 0,
})
const checkoutExecute = vi.fn().mockResolvedValue({
  success: true,
  message: 'ok',
  total: 0,
  succeeded: 0,
  failed: 0,
})
const checkinExecute = vi.fn().mockResolvedValue({
  success: true,
  message: 'ok',
  total: 0,
  succeeded: 0,
  failed: 0,
})
const deleteLocalExecute = vi.fn().mockResolvedValue({
  success: true,
  message: 'ok',
  total: 0,
  succeeded: 0,
  failed: 0,
})

vi.mock('./download', () => ({ downloadCommand: { id: 'download', execute: downloadExecute } }))
vi.mock('./checkout', () => ({ checkoutCommand: { id: 'checkout', execute: checkoutExecute } }))
vi.mock('./checkin', () => ({ checkinCommand: { id: 'checkin', execute: checkinExecute } }))
vi.mock('./delete', () => ({ deleteLocalCommand: { id: 'delete-local', execute: deleteLocalExecute } }))

const {
  bulkDownloadAssemblyCommand,
  bulkCheckoutAssemblyCommand,
  bulkCheckinAssemblyCommand,
  bulkDeleteAssemblyCommand,
} = await import('./bulkAssembly')

const ORG_ID = 'org-1'
const USER_ID = 'user-1'
const VAULT = 'C:\\vault'
const ROOT_ID = 'asm-1'
const CHILD_ID = 'child-1'

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

/** A `moved_away` stub at `relativePath` and its `'moved'` partner at `movedTo`, sharing one id. */
function movedAwayPair(
  id: string,
  relativePath: string,
  movedTo: string,
  pdmOverrides: Partial<PDMFile> = {},
): { stub: LocalFile; moved: LocalFile } {
  const pdmData = { id, file_path: relativePath, ...pdmOverrides } as PDMFile
  return {
    stub: localFile(relativePath, {
      diffStatus: 'moved_away',
      movedToRelativePath: movedTo,
      pdmData,
    }),
    moved: localFile(movedTo, { diffStatus: 'moved', pdmData }),
  }
}

function rootFile(overrides: Partial<LocalFile> = {}): LocalFile {
  return localFile('root/Root.sldasm', {
    diffStatus: 'modified',
    pdmData: { id: ROOT_ID, file_path: 'root/Root.sldasm' } as PDMFile,
    ...overrides,
  })
}

function makeContext(files: LocalFile[], overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: { id: USER_ID } as CommandContext['user'],
    organization: { id: ORG_ID } as CommandContext['organization'],
    isOfflineMode: false,
    getEffectiveRole: () => 'member',
    vaultPath: VAULT,
    activeVaultId: 'vault-1',
    files,
    serverFiles: [],
    addToast: vi.fn(),
    addProgressToast: vi.fn(),
    updateProgressToast: vi.fn(),
    removeToast: vi.fn(),
    isProgressToastCancelled: vi.fn(() => false),
    ...overrides,
  } as unknown as CommandContext
}

/** Every relativePath the mocked delegate's `execute` was actually called with, last call. */
function calledWithPaths(mock: typeof checkoutExecute): string[] {
  const call = mock.mock.calls.at(-1) as [{ files: LocalFile[] }, CommandContext] | undefined
  return (call?.[0].files ?? []).map((f) => f.relativePath)
}

beforeEach(() => {
  vi.clearAllMocks()

  getFile.mockResolvedValue({
    file: {
      id: ROOT_ID,
      org_id: ORG_ID,
      file_name: 'Root.sldasm',
      file_path: 'root/Root.sldasm',
      part_number: null,
      revision: null,
      state: null,
    },
    error: null,
  })
  getContainsRecursive.mockResolvedValue({
    references: [
      {
        id: 'ref-1',
        parent_file_id: ROOT_ID,
        child_file_id: CHILD_ID,
        quantity: 1,
        configuration: null,
        reference_type: 'component',
        child: {
          id: CHILD_ID,
          file_name: 'Part.sldprt',
          file_path: 'old/Part.sldprt',
          part_number: null,
          revision: null,
          state: null,
          description: null,
        },
        children: [],
      },
    ],
    error: null,
    stats: { totalNodes: 1, maxDepthReached: 1, assembliesProcessed: 1 },
  })
  getDrawingsForFiles.mockResolvedValue({ drawings: [], error: null })

  downloadExecute.mockResolvedValue({ success: true, message: 'ok', total: 0, succeeded: 0, failed: 0 })
  checkoutExecute.mockResolvedValue({ success: true, message: 'ok', total: 0, succeeded: 0, failed: 0 })
  checkinExecute.mockResolvedValue({ success: true, message: 'ok', total: 0, succeeded: 0, failed: 0 })
  deleteLocalExecute.mockResolvedValue({ success: true, message: 'ok', total: 0, succeeded: 0, failed: 0 })
})

describe('bulk checkout over an assembly with a locally-moved child', () => {
  it('checks out the moved child\u2019s real content, not its stub, when the stub is listed first', async () => {
    const root = rootFile()
    const { stub, moved } = movedAwayPair(CHILD_ID, 'old/Part.sldprt', 'new/Part.sldprt')
    const ctx = makeContext([root, stub, moved])

    const result = await bulkCheckoutAssemblyCommand.execute({ files: [root], rootFileId: ROOT_ID }, ctx)

    expect(result.success).toBe(true)
    expect(checkoutExecute).toHaveBeenCalledTimes(1)
    const paths = calledWithPaths(checkoutExecute)
    expect(paths).toContain('new/Part.sldprt')
    expect(paths).not.toContain('old/Part.sldprt')
  })

  it('resolves the same way when the moved row is listed before the stub', async () => {
    const root = rootFile()
    const { stub, moved } = movedAwayPair(CHILD_ID, 'old/Part.sldprt', 'new/Part.sldprt')
    const ctx = makeContext([root, moved, stub])

    await bulkCheckoutAssemblyCommand.execute({ files: [root], rootFileId: ROOT_ID }, ctx)

    const paths = calledWithPaths(checkoutExecute)
    expect(paths).toContain('new/Part.sldprt')
    expect(paths).not.toContain('old/Part.sldprt')
  })

  it('excludes an unpartnered stub from the checkoutable set entirely rather than passing it through', async () => {
    const root = rootFile()
    const orphanStub = localFile('old/Part.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'new/Part.sldprt',
      pdmData: { id: CHILD_ID, file_path: 'old/Part.sldprt' } as PDMFile,
    })
    const ctx = makeContext([root, orphanStub])

    await bulkCheckoutAssemblyCommand.execute({ files: [root], rootFileId: ROOT_ID }, ctx)

    expect(checkoutExecute).toHaveBeenCalledTimes(1)
    const paths = calledWithPaths(checkoutExecute)
    expect(paths).toContain('root/Root.sldasm')
    expect(paths).not.toContain('old/Part.sldprt')
  })
})

describe('bulk checkin over an assembly with a locally-moved child', () => {
  it('checks in the moved child\u2019s real content, not its stub, regardless of array order', async () => {
    const root = rootFile({ pdmData: { id: ROOT_ID, file_path: 'root/Root.sldasm', checked_out_by: USER_ID } as PDMFile })
    const { stub, moved } = movedAwayPair(CHILD_ID, 'old/Part.sldprt', 'new/Part.sldprt', {
      checked_out_by: USER_ID,
    })
    const ctx = makeContext([root, stub, moved])

    const result = await bulkCheckinAssemblyCommand.execute({ files: [root], rootFileId: ROOT_ID }, ctx)

    expect(result.success).toBe(true)
    expect(checkinExecute).toHaveBeenCalledTimes(1)
    const paths = calledWithPaths(checkinExecute)
    expect(paths).toContain('new/Part.sldprt')
    expect(paths).not.toContain('old/Part.sldprt')
  })

  it('excludes an unpartnered stub even when it is checked out by the current user', async () => {
    const root = rootFile({ pdmData: { id: ROOT_ID, file_path: 'root/Root.sldasm', checked_out_by: USER_ID } as PDMFile })
    const orphanStub = localFile('old/Part.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'new/Part.sldprt',
      pdmData: { id: CHILD_ID, file_path: 'old/Part.sldprt', checked_out_by: USER_ID } as PDMFile,
    })
    const ctx = makeContext([root, orphanStub])

    await bulkCheckinAssemblyCommand.execute({ files: [root], rootFileId: ROOT_ID }, ctx)

    expect(checkinExecute).toHaveBeenCalledTimes(1)
    const paths = calledWithPaths(checkinExecute)
    expect(paths).toContain('root/Root.sldasm')
    expect(paths).not.toContain('old/Part.sldprt')
  })
})

describe('bulk delete-local over an assembly with a locally-moved child', () => {
  it('removes the moved child\u2019s real content, not its stub', async () => {
    const root = rootFile()
    const { stub, moved } = movedAwayPair(CHILD_ID, 'old/Part.sldprt', 'new/Part.sldprt')
    const ctx = makeContext([root, stub, moved])

    const result = await bulkDeleteAssemblyCommand.execute({ files: [root], rootFileId: ROOT_ID }, ctx)

    expect(result.success).toBe(true)
    expect(deleteLocalExecute).toHaveBeenCalledTimes(1)
    const paths = calledWithPaths(deleteLocalExecute)
    expect(paths).toContain('new/Part.sldprt')
    expect(paths).not.toContain('old/Part.sldprt')
  })

  it('excludes an unpartnered stub from the local-files-to-remove set', async () => {
    const root = rootFile()
    const orphanStub = localFile('old/Part.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'new/Part.sldprt',
      pdmData: { id: CHILD_ID, file_path: 'old/Part.sldprt' } as PDMFile,
    })
    const ctx = makeContext([root, orphanStub])

    await bulkDeleteAssemblyCommand.execute({ files: [root], rootFileId: ROOT_ID }, ctx)

    expect(deleteLocalExecute).toHaveBeenCalledTimes(1)
    const paths = calledWithPaths(deleteLocalExecute)
    expect(paths).toContain('root/Root.sldasm')
    expect(paths).not.toContain('old/Part.sldprt')
  })
})

describe('bulk download leaves a moved_away child alone', () => {
  it('never selects a moved_away stub for download - it is not cloud-only, and downloading it would not help', async () => {
    const root = localFile('root/Root.sldasm', {
      diffStatus: 'cloud',
      pdmData: { id: ROOT_ID, file_path: 'root/Root.sldasm' } as PDMFile,
    })
    const { stub, moved } = movedAwayPair(CHILD_ID, 'old/Part.sldprt', 'new/Part.sldprt')
    const ctx = makeContext([root, stub, moved])

    await bulkDownloadAssemblyCommand.execute({ files: [root], rootFileId: ROOT_ID }, ctx)

    expect(downloadExecute).toHaveBeenCalledTimes(1)
    const paths = calledWithPaths(downloadExecute)
    expect(paths).toContain('root/Root.sldasm')
    expect(paths).not.toContain('old/Part.sldprt')
    expect(paths).not.toContain('new/Part.sldprt')
  })
})

describe('validateBulkAssemblyCommand root lookup', () => {
  it('finds the root and passes validation regardless of stub/moved array order', () => {
    const { stub, moved } = movedAwayPair(ROOT_ID, 'old/Root.sldasm', 'new/Root.sldasm')
    const ctxA = makeContext([stub, moved])
    const ctxB = makeContext([moved, stub])

    expect(
      bulkCheckoutAssemblyCommand.validate({ files: [stub, moved], rootFileId: ROOT_ID }, ctxA),
    ).toBeNull()
    expect(
      bulkCheckoutAssemblyCommand.validate({ files: [moved, stub], rootFileId: ROOT_ID }, ctxB),
    ).toBeNull()
  })

  it('still reports "Root assembly not found in selection" when the id is absent entirely', () => {
    const root = rootFile()
    const ctx = makeContext([root])

    const error = bulkCheckoutAssemblyCommand.validate(
      { files: [root], rootFileId: 'does-not-exist' },
      ctx,
    )

    expect(error).toBe('Root assembly not found in selection')
  })

  it('bulk-delete\u2019s own validate() resolves the same way', () => {
    const { stub, moved } = movedAwayPair(ROOT_ID, 'old/Root.sldasm', 'new/Root.sldasm')

    expect(
      bulkDeleteAssemblyCommand.validate(
        { files: [stub, moved], rootFileId: ROOT_ID },
        makeContext([stub, moved]),
      ),
    ).toBeNull()
  })
})
