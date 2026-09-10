import { describe, expect, it } from 'vitest'

import { reconcileCloudFiles } from './cloudFileReconciliation'
import type { CachedServerFile } from '@/lib/cache/vaultFileCache'
import type { LocalFile } from '@/stores/types'

const VAULT_PATH = 'C:/vault'

function serverFile(overrides: Partial<CachedServerFile> = {}): CachedServerFile {
  return {
    id: 'file-1',
    file_path: 'Fixed Lens Models/part.sldprt',
    file_name: 'part.sldprt',
    extension: '.sldprt',
    file_type: 'part',
    part_number: null,
    description: null,
    revision: 'A',
    version: 1,
    content_hash: 'hash-1',
    file_size: 1024,
    state: null,
    checked_out_by: null,
    checked_out_at: null,
    updated_at: '2026-01-01T00:00:00Z',
    custom_properties: null,
    checked_out_file_path: null,
    checked_out_file_name: null,
    ...overrides,
  }
}

function movedLocalFile(overrides: Partial<LocalFile> = {}): LocalFile {
  return {
    name: 'part.sldprt',
    path: 'C:/vault/athom/part.sldprt',
    relativePath: 'athom/part.sldprt',
    isDirectory: false,
    extension: '.sldprt',
    size: 1024,
    modifiedTime: '2026-01-01T00:00:00Z',
    diffStatus: 'moved',
    isSynced: true,
    ino: 42,
    ...overrides,
  }
}

const YIELD_NOOP = async () => {}

describe('reconcileCloudFiles', () => {
  it('emits exactly one moved_away stub, naming the destination, for an inode-matched rename', async () => {
    const movedFile = movedLocalFile({ pdmData: serverFile() as unknown as LocalFile['pdmData'] })
    const serverPathLower = 'fixed lens models/part.sldprt'

    const result = await reconcileCloudFiles({
      pdmFiles: [serverFile()],
      localFiles: [movedFile],
      localPathSet: new Set(['athom/part.sldprt']),
      inodeMatchedServerPaths: new Set([serverPathLower]),
      inodeMatchedServerPathToLocalPath: new Map([[serverPathLower, 'athom/part.sldprt']]),
      existingCheckedOutUsers: new Map(),
      userId: 'user-1',
      vaultPath: VAULT_PATH,
      yieldIfSlow: YIELD_NOOP,
      yieldCheckStride: 256,
    })

    const stubs = result.localFiles.filter((f) => f.diffStatus === 'moved_away')
    expect(stubs).toHaveLength(1)
    expect(stubs[0].relativePath).toBe('Fixed Lens Models/part.sldprt')
    expect(stubs[0].movedToRelativePath).toBe('athom/part.sldprt')
    expect(stubs[0].isSynced).toBe(false)
    expect(stubs[0].pdmData?.id).toBe('file-1')

    // The 'moved' row at the new location is untouched.
    const movedRows = result.localFiles.filter((f) => f.diffStatus === 'moved')
    expect(movedRows).toHaveLength(1)
    expect(movedRows[0].relativePath).toBe('athom/part.sldprt')
  })

  it('produces neither a moved row nor a moved_away stub once the paths are reconciled', async () => {
    // The local file already sits at the server's path - no move to report.
    const result = await reconcileCloudFiles({
      pdmFiles: [serverFile()],
      localFiles: [],
      localPathSet: new Set(['fixed lens models/part.sldprt']),
      inodeMatchedServerPaths: new Set(),
      inodeMatchedServerPathToLocalPath: new Map(),
      existingCheckedOutUsers: new Map(),
      userId: 'user-1',
      vaultPath: VAULT_PATH,
      yieldIfSlow: YIELD_NOOP,
      yieldCheckStride: 256,
    })

    expect(result.localFiles).toHaveLength(0)
    expect(result.cloudFolders.size).toBe(0)
  })

  it('leaves a hash-only move unchanged (no stub - no local evidence of the destination)', async () => {
    const hashMovedFile: LocalFile = {
      name: 'part.sldprt',
      path: 'C:/vault/new-name/part.sldprt',
      relativePath: 'new-name/part.sldprt',
      isDirectory: false,
      extension: '.sldprt',
      size: 1024,
      modifiedTime: '2026-01-01T00:00:00Z',
      localHash: 'hash-1',
    }

    const result = await reconcileCloudFiles({
      pdmFiles: [serverFile()],
      localFiles: [hashMovedFile],
      localPathSet: new Set(['new-name/part.sldprt']),
      inodeMatchedServerPaths: new Set(),
      inodeMatchedServerPathToLocalPath: new Map(),
      existingCheckedOutUsers: new Map(),
      userId: 'user-1',
      vaultPath: VAULT_PATH,
      yieldIfSlow: YIELD_NOOP,
      yieldCheckStride: 256,
    })

    // Nothing injected at the old server path, and the hash-matched local file
    // itself is passed through untouched by this pass.
    expect(result.localFiles).toEqual([hashMovedFile])
  })

  it('does not count a moved_away stub as cloud', async () => {
    const serverPathLower = 'fixed lens models/part.sldprt'

    const result = await reconcileCloudFiles({
      pdmFiles: [serverFile()],
      localFiles: [],
      localPathSet: new Set(),
      inodeMatchedServerPaths: new Set([serverPathLower]),
      inodeMatchedServerPathToLocalPath: new Map([[serverPathLower, 'athom/part.sldprt']]),
      existingCheckedOutUsers: new Map(),
      userId: 'user-1',
      vaultPath: VAULT_PATH,
      yieldIfSlow: YIELD_NOOP,
      yieldCheckStride: 256,
    })

    expect(result.localFiles.filter((f) => f.diffStatus === 'cloud')).toHaveLength(0)
    expect(result.localFiles.filter((f) => f.diffStatus === 'moved_away')).toHaveLength(1)
  })

  it('still adds a genuine cloud-only file as "cloud" when neither move signal fires', async () => {
    const result = await reconcileCloudFiles({
      pdmFiles: [serverFile({ file_path: 'Parts/new-file.sldprt', content_hash: 'hash-2' })],
      localFiles: [],
      localPathSet: new Set(),
      inodeMatchedServerPaths: new Set(),
      inodeMatchedServerPathToLocalPath: new Map(),
      existingCheckedOutUsers: new Map(),
      userId: 'user-1',
      vaultPath: VAULT_PATH,
      yieldIfSlow: YIELD_NOOP,
      yieldCheckStride: 256,
    })

    expect(result.localFiles).toHaveLength(1)
    expect(result.localFiles[0].diffStatus).toBe('cloud')
    expect(result.cloudFolders.has('Parts')).toBe(true)
  })

  it('falls back to the pre-4.3.3 suppress-only behaviour if the reverse map is missing an entry', async () => {
    // Defensive case: inodeMatchedServerPaths says this path was claimed, but the
    // reverse map (built alongside it) somehow has no destination for it.
    const serverPathLower = 'fixed lens models/part.sldprt'

    const result = await reconcileCloudFiles({
      pdmFiles: [serverFile()],
      localFiles: [],
      localPathSet: new Set(),
      inodeMatchedServerPaths: new Set([serverPathLower]),
      inodeMatchedServerPathToLocalPath: new Map(),
      existingCheckedOutUsers: new Map(),
      userId: 'user-1',
      vaultPath: VAULT_PATH,
      yieldIfSlow: YIELD_NOOP,
      yieldCheckStride: 256,
    })

    expect(result.localFiles).toHaveLength(0)
  })
})
