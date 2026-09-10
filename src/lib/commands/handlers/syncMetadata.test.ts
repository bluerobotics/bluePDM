/**
 * Sync Metadata, and the `'moved_away'` stub.
 *
 * `getSwFilesFromSelection` matches SolidWorks files by path and extension alone - it never went
 * through `getSyncedFilesFromSelection`, so nothing about `diffStatus` was ever considered. A
 * `'moved_away'` stub (a row at the *server's* recorded path for a file whose content now lives
 * elsewhere on disk, sharing `pdmData.id` - and thus its checkout state - with its `'moved'`
 * partner) matched exactly as readily as a real file. Left uncorrected, this drove the
 * SolidWorks Document Manager API to write custom properties at a path with nothing on disk,
 * while the file the user actually meant - the partner - was never touched.
 *
 * The eligibility filter had a second, related gap: it tested `pdmData.id` and `checked_out_by`
 * alone, so a `'cloud'` row (never downloaded to *this* machine) carrying a checkout taken from
 * another machine or session passed it exactly as a real local file would.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommandContext, LocalFile } from '../types'
import type { PDMFile } from '../../../types/pdm'

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/pendingMetadata', () => ({
  dropCommittedPendingMetadata: vi.fn(() => null),
}))

const pullDrawingMetadata = vi.fn()
vi.mock('./syncMetadataPull', () => ({ pullDrawingMetadata: (...args: unknown[]) => pullDrawingMetadata(...args) }))

const pushDrawingMetadata = vi.fn()
const pushPartAssemblyMetadata = vi.fn()
vi.mock('./syncMetadataPush', () => ({
  pushDrawingMetadata: (...args: unknown[]) => pushDrawingMetadata(...args),
  pushPartAssemblyMetadata: (...args: unknown[]) => pushPartAssemblyMetadata(...args),
}))

vi.mock('./syncMetadataProperties', () => ({ isParentAuthoritative: vi.fn(() => true) }))

const storeState = {
  updatePendingMetadata: vi.fn(),
  solidworksServiceStatus: { dmApiAvailable: true },
}
vi.mock('../../../stores/pdmStore', () => ({
  usePDMStore: { getState: () => storeState },
}))

const { syncMetadataCommand } = await import('./syncMetadata')

const VAULT = 'C:\\vault'
const USER_ID = 'user-1'
const PART_ID = 'part-1'

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

function makeContext(files: LocalFile[]): CommandContext {
  return {
    user: { id: USER_ID } as CommandContext['user'],
    organization: { id: 'org-1' } as CommandContext['organization'],
    isOfflineMode: false,
    vaultPath: VAULT,
    activeVaultId: 'vault-1',
    files,
    serverFiles: [],
    addToast: vi.fn(),
    addProgressToast: vi.fn(),
    updateProgressToast: vi.fn(),
    removeToast: vi.fn(),
    isProgressToastCancelled: vi.fn(() => false),
    addProcessingFoldersSync: vi.fn(),
    removeProcessingFolders: vi.fn(),
  } as unknown as CommandContext
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.updatePendingMetadata.mockClear()
  pushPartAssemblyMetadata.mockResolvedValue({ success: true })
  pushDrawingMetadata.mockResolvedValue({ success: true })
  pullDrawingMetadata.mockResolvedValue(null)

  vi.stubGlobal('window', {
    electronAPI: {
      solidworks: {
        getServiceStatus: vi.fn().mockResolvedValue({
          data: { running: true, documentManagerAvailable: true },
        }),
      },
    },
  })
})

describe('getSwFilesFromSelection resolves a moved child to its real content', () => {
  it('pushes metadata to the moved partner\u2019s path, not the stub\u2019s, when a folder is selected', async () => {
    const selectedFolder = folder('parts')
    const pdmData = { id: PART_ID, checked_out_by: USER_ID } as PDMFile
    const stub = localFile('parts/Part.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'elsewhere/Part.sldprt',
      pdmData,
    })
    const moved = localFile('elsewhere/Part.sldprt', { diffStatus: 'moved', pdmData })
    const ctx = makeContext([selectedFolder, stub, moved])

    const result = await syncMetadataCommand.execute({ files: [selectedFolder] }, ctx)

    expect(result.success).toBe(true)
    expect(pushPartAssemblyMetadata).toHaveBeenCalledTimes(1)
    const [file, fullPath] = pushPartAssemblyMetadata.mock.calls[0] as [LocalFile, string]
    expect(file.relativePath).toBe('elsewhere/Part.sldprt')
    expect(fullPath).toBe(moved.path)
  })

  it('resolves the same way when the moved row is listed before the stub', async () => {
    const selectedFolder = folder('parts')
    const pdmData = { id: PART_ID, checked_out_by: USER_ID } as PDMFile
    const stub = localFile('parts/Part.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'elsewhere/Part.sldprt',
      pdmData,
    })
    const moved = localFile('elsewhere/Part.sldprt', { diffStatus: 'moved', pdmData })
    const ctx = makeContext([selectedFolder, moved, stub])

    await syncMetadataCommand.execute({ files: [selectedFolder] }, ctx)

    const [file] = pushPartAssemblyMetadata.mock.calls[0] as [LocalFile, string]
    expect(file.relativePath).toBe('elsewhere/Part.sldprt')
  })

  it('does not push metadata for a child whose only row is an unpartnered stub', async () => {
    const selectedFolder = folder('parts')
    const orphanStub = localFile('parts/Part.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'elsewhere/Part.sldprt',
      pdmData: { id: PART_ID, checked_out_by: USER_ID } as PDMFile,
    })
    const ctx = makeContext([selectedFolder, orphanStub])

    const result = await syncMetadataCommand.execute({ files: [selectedFolder] }, ctx)

    expect(pushPartAssemblyMetadata).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })
})

describe('eligibility excludes rows with nothing on disk, even when checked out by the current user', () => {
  it('excludes a moved_away stub selected directly, when it has no partner anywhere', async () => {
    const orphanStub = localFile('old/Part.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'new/Part.sldprt',
      pdmData: { id: PART_ID, checked_out_by: USER_ID } as PDMFile,
    })
    const ctx = makeContext([orphanStub])

    const error = syncMetadataCommand.validate({ files: [orphanStub] }, ctx)

    expect(error).toBe('No eligible files. Files must be local-only or checked out for editing.')
  })

  it('excludes a cloud-only row even when pdmData says the current user has it checked out', async () => {
    const cloudFile = localFile('Part.sldprt', {
      diffStatus: 'cloud',
      pdmData: { id: PART_ID, checked_out_by: USER_ID } as PDMFile,
    })
    const ctx = makeContext([cloudFile])

    const error = syncMetadataCommand.validate({ files: [cloudFile] }, ctx)

    expect(error).toBe('No eligible files. Files must be local-only or checked out for editing.')

    const result = await syncMetadataCommand.execute({ files: [cloudFile] }, ctx)
    expect(pushPartAssemblyMetadata).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('still allows a real, checked-out local file through', async () => {
    const realFile = localFile('Part.sldprt', {
      diffStatus: 'modified',
      pdmData: { id: PART_ID, checked_out_by: USER_ID } as PDMFile,
    })
    const ctx = makeContext([realFile])

    expect(syncMetadataCommand.validate({ files: [realFile] }, ctx)).toBeNull()

    await syncMetadataCommand.execute({ files: [realFile] }, ctx)
    expect(pushPartAssemblyMetadata).toHaveBeenCalledTimes(1)
  })

  it('still allows a brand new, local-only file through (no pdmData at all)', async () => {
    const newFile = localFile('New.sldprt', { pdmData: undefined })
    const ctx = makeContext([newFile])

    expect(syncMetadataCommand.validate({ files: [newFile] }, ctx)).toBeNull()
  })
})
