import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  computeRestoreTarget,
  findCollisionAtRestorePath,
  pendingMetadataPathsToClear,
  performCheckoutPathRestore,
  resolveCheckedOutFile,
} from './discardRestorePath'
import type { CommandContext, LocalFile } from '../types'

function localFile(overrides: Partial<LocalFile> & { relativePath: string }): LocalFile {
  const { relativePath } = overrides
  const name = relativePath.includes('/') ? relativePath.split('/').pop()! : relativePath
  return {
    name,
    path: `C:/vault/${relativePath.replace(/\//g, '\\')}`,
    isDirectory: false,
    extension: name.includes('.') ? `.${name.split('.').pop()}` : '',
    size: 0,
    modifiedTime: '',
    ...overrides,
  } as LocalFile
}

describe('computeRestoreTarget', () => {
  it('returns a rename target when only the name changed', () => {
    const target = computeRestoreTarget(
      { checked_out_file_path: 'Parts/Bracket.SLDPRT', checked_out_file_name: 'Bracket.SLDPRT' },
      'Parts/Bracket-Rev2.SLDPRT',
    )

    expect(target).toEqual({
      originalRelPath: 'Parts/Bracket.SLDPRT',
      originalFileName: 'Bracket.SLDPRT',
      isMove: false,
    })
  })

  it('returns a move target (isMove: true) when only the folder changed', () => {
    const target = computeRestoreTarget(
      { checked_out_file_path: 'Parts/Bracket.SLDPRT', checked_out_file_name: 'Bracket.SLDPRT' },
      'Archive/Bracket.SLDPRT',
    )

    expect(target).toEqual({
      originalRelPath: 'Parts/Bracket.SLDPRT',
      originalFileName: 'Bracket.SLDPRT',
      isMove: true,
    })
  })

  it('returns a combined rename+move target when both the name and folder changed', () => {
    const target = computeRestoreTarget(
      { checked_out_file_path: 'Parts/Bracket.SLDPRT', checked_out_file_name: 'Bracket.SLDPRT' },
      'Archive/Bracket-Rev2.SLDPRT',
    )

    expect(target).toEqual({
      originalRelPath: 'Parts/Bracket.SLDPRT',
      originalFileName: 'Bracket.SLDPRT',
      isMove: true,
    })
  })

  it('falls back to null when the snapshot is missing (older lock, no snapshot recorded)', () => {
    expect(
      computeRestoreTarget(
        { checked_out_file_path: null, checked_out_file_name: null },
        'Archive/Bracket-Rev2.SLDPRT',
      ),
    ).toBeNull()
  })

  it('falls back to null when only one snapshot field is missing', () => {
    expect(
      computeRestoreTarget(
        { checked_out_file_path: 'Parts/Bracket.SLDPRT', checked_out_file_name: null },
        'Archive/Bracket-Rev2.SLDPRT',
      ),
    ).toBeNull()
  })

  it('returns null (no-op) when the snapshot already matches the current path', () => {
    expect(
      computeRestoreTarget(
        { checked_out_file_path: 'Parts/Bracket.SLDPRT', checked_out_file_name: 'Bracket.SLDPRT' },
        'Parts/Bracket.SLDPRT',
      ),
    ).toBeNull()
  })

  it('treats the no-op comparison as case-insensitive, matching checkin.ts', () => {
    expect(
      computeRestoreTarget(
        { checked_out_file_path: 'Parts/Bracket.SLDPRT', checked_out_file_name: 'Bracket.SLDPRT' },
        'parts/BRACKET.sldprt',
      ),
    ).toBeNull()
  })
})

describe('resolveCheckedOutFile', () => {
  it('prefers the candidate that exists on disk over the ghost row', () => {
    const ghost = localFile({ relativePath: 'Parts/Bracket.SLDPRT', pdmData: { id: 'f1' } as never })
    const renamed = localFile({
      relativePath: 'Parts/Bracket-Rev2.SLDPRT',
      pdmData: { id: 'f1' } as never,
    })

    const existsOnDiskByPath = new Map([
      [ghost.path, false],
      [renamed.path, true],
    ])

    expect(resolveCheckedOutFile([ghost, renamed], 'f1', existsOnDiskByPath)).toBe(renamed)
  })

  it('falls back to the first candidate when nothing is found on disk (genuinely deleted)', () => {
    const ghost = localFile({ relativePath: 'Parts/Bracket.SLDPRT', pdmData: { id: 'f1' } as never })
    const existsOnDiskByPath = new Map([[ghost.path, false]])

    expect(resolveCheckedOutFile([ghost], 'f1', existsOnDiskByPath)).toBe(ghost)
  })

  it('returns null when no candidate carries the file id', () => {
    const unrelated = localFile({ relativePath: 'Parts/Other.SLDPRT', pdmData: { id: 'other' } as never })
    expect(resolveCheckedOutFile([unrelated], 'f1', new Map())).toBeNull()
  })
})

describe('findCollisionAtRestorePath', () => {
  it('detects a different file already occupying the restore target path', () => {
    const files = [
      localFile({ relativePath: 'Parts/Bracket.SLDPRT', pdmData: { id: 'someone-else' } as never }),
    ]

    const collision = findCollisionAtRestorePath(files, 'Parts/Bracket.SLDPRT', 'f1')
    expect(collision?.pdmData?.id).toBe('someone-else')
  })

  it('does not flag the file being restored itself as a collision', () => {
    const files = [localFile({ relativePath: 'Parts/Bracket.SLDPRT', pdmData: { id: 'f1' } as never })]

    expect(findCollisionAtRestorePath(files, 'Parts/Bracket.SLDPRT', 'f1')).toBeNull()
  })

  // A cloud-only row has nothing on disk to overwrite, but undoCheckout writes
  // file_path back from the snapshot, and files is unique on
  // (vault_id, LOWER(file_path)). Letting the restore proceed means renaming and
  // overwriting the local file first and only then failing that write with 23505.
  it('detects a cloud-only row at the target path, which the server write would reject', () => {
    const files = [
      localFile({
        relativePath: 'Parts/Bracket.SLDPRT',
        diffStatus: 'cloud',
        pdmData: { id: 'someone-else' } as never,
      }),
    ]

    expect(findCollisionAtRestorePath(files, 'Parts/Bracket.SLDPRT', 'f1')?.pdmData?.id).toBe(
      'someone-else',
    )
  })

  it('detects a cloud-only row whose path differs from the target only in case', () => {
    // The unique index is on LOWER(file_path), so a case variant collides too.
    const files = [
      localFile({
        relativePath: 'parts/bracket.sldprt',
        diffStatus: 'cloud',
        pdmData: { id: 'someone-else' } as never,
      }),
    ]

    expect(findCollisionAtRestorePath(files, 'Parts/Bracket.SLDPRT', 'f1')).not.toBeNull()
  })

  it('still does not flag the discarded file own cloud-only ghost at the target path', () => {
    const files = [
      localFile({
        relativePath: 'Parts/Bracket.SLDPRT',
        diffStatus: 'cloud',
        pdmData: { id: 'f1' } as never,
      }),
    ]

    expect(findCollisionAtRestorePath(files, 'Parts/Bracket.SLDPRT', 'f1')).toBeNull()
  })

  it('ignores a folder sharing the target path', () => {
    const files = [
      localFile({
        relativePath: 'Parts/Bracket.SLDPRT',
        isDirectory: true,
        pdmData: { id: 'someone-else' } as never,
      }),
    ]

    expect(findCollisionAtRestorePath(files, 'Parts/Bracket.SLDPRT', 'f1')).toBeNull()
  })

  it('returns null when nothing occupies the restore target path', () => {
    const files = [localFile({ relativePath: 'Other/File.SLDPRT', pdmData: { id: 'x' } as never })]
    expect(findCollisionAtRestorePath(files, 'Parts/Bracket.SLDPRT', 'f1')).toBeNull()
  })
})

describe('performCheckoutPathRestore watcher suppression', () => {
  const VAULT_PATH = 'C:/vault'
  const CURRENT_REL_PATH = 'Parts/Bracket-Rev2.SLDPRT'
  const ORIGINAL_REL_PATH = 'Parts/Bracket.SLDPRT'
  const SUPPRESSED_PATHS = [CURRENT_REL_PATH, ORIGINAL_REL_PATH]

  const addExpectedFileChanges = vi.fn()
  const clearExpectedFileChanges = vi.fn()
  const fileExists = vi.fn()
  const createFolder = vi.fn()
  const setReadonly = vi.fn()
  const renameItem = vi.fn()

  /** The file as it sits on disk after being renamed during its checkout. */
  function renamedFile(): LocalFile {
    return localFile({
      relativePath: CURRENT_REL_PATH,
      path: `${VAULT_PATH}/${CURRENT_REL_PATH}`,
      pdmData: {
        id: 'f1',
        checked_out_file_path: ORIGINAL_REL_PATH,
        checked_out_file_name: 'Bracket.SLDPRT',
      } as never,
    })
  }

  function makeContext(files: LocalFile[] = []) {
    return { files, vaultPath: VAULT_PATH, addExpectedFileChanges, clearExpectedFileChanges } as Pick<
      CommandContext,
      'files' | 'vaultPath' | 'addExpectedFileChanges' | 'clearExpectedFileChanges'
    >
  }

  beforeEach(() => {
    vi.clearAllMocks()
    fileExists.mockResolvedValue(false)
    createFolder.mockResolvedValue({ success: true })
    setReadonly.mockResolvedValue(undefined)
    renameItem.mockResolvedValue({ success: true })
    vi.stubGlobal('window', {
      electronAPI: { fileExists, createFolder, setReadonly, renameItem },
    })
  })

  // The success path deliberately hands the suppression to discard.ts, which holds
  // both paths until the batch-level clear timeout so late events for our own rename
  // do not read as an unexpected external change.
  it('leaves both paths suppressed on success for the caller to clear', async () => {
    const file = renamedFile()

    const outcome = await performCheckoutPathRestore(makeContext(), file, file, 'op-1')

    expect(outcome).toEqual({
      downloadPath: `${VAULT_PATH}/${ORIGINAL_REL_PATH}`,
      restoredFrom: {
        currentRelPath: CURRENT_REL_PATH,
        originalRelPath: ORIGINAL_REL_PATH,
        originalFileName: 'Bracket.SLDPRT',
        isMove: false,
      },
    })
    expect(addExpectedFileChanges).toHaveBeenCalledWith(SUPPRESSED_PATHS)
    expect(clearExpectedFileChanges).not.toHaveBeenCalled()
  })

  // A file open in SOLIDWORKS makes the rename fail with EPERM/EBUSY. Nothing
  // reports these paths to the caller in that case, so leaving them registered
  // would hide them from the watcher for the rest of the session.
  it('clears the suppression when the rename back fails', async () => {
    renameItem.mockResolvedValue({ success: false, error: 'EBUSY' })
    const file = renamedFile()

    const outcome = await performCheckoutPathRestore(makeContext(), file, file, 'op-1')

    expect(outcome).toHaveProperty('error')
    expect(addExpectedFileChanges).toHaveBeenCalledWith(SUPPRESSED_PATHS)
    expect(clearExpectedFileChanges).toHaveBeenCalledWith(SUPPRESSED_PATHS)
  })

  it('clears the suppression when the original parent folder cannot be created', async () => {
    createFolder.mockResolvedValue({ success: false, error: 'ENOENT' })
    const file = renamedFile()

    const outcome = await performCheckoutPathRestore(makeContext(), file, file, 'op-1')

    expect(outcome).toHaveProperty('error')
    expect(renameItem).not.toHaveBeenCalled()
    expect(clearExpectedFileChanges).toHaveBeenCalledWith(SUPPRESSED_PATHS)
  })

  it('clears the suppression when the rename throws', async () => {
    renameItem.mockRejectedValue(new Error('ipc died'))
    const file = renamedFile()

    await expect(
      performCheckoutPathRestore(makeContext(), file, file, 'op-1'),
    ).rejects.toThrow('ipc died')

    expect(clearExpectedFileChanges).toHaveBeenCalledWith(SUPPRESSED_PATHS)
  })

  it('registers no suppression at all when no restore is needed', async () => {
    const inPlace = localFile({
      relativePath: ORIGINAL_REL_PATH,
      path: `${VAULT_PATH}/${ORIGINAL_REL_PATH}`,
      pdmData: {
        id: 'f1',
        checked_out_file_path: ORIGINAL_REL_PATH,
        checked_out_file_name: 'Bracket.SLDPRT',
      } as never,
    })

    const outcome = await performCheckoutPathRestore(makeContext(), inPlace, inPlace, 'op-1')

    expect(outcome).toEqual({ downloadPath: inPlace.path, restoredFrom: null })
    expect(addExpectedFileChanges).not.toHaveBeenCalled()
    expect(clearExpectedFileChanges).not.toHaveBeenCalled()
  })

  // Detected before anything moves: the rename and the download both run before
  // undoCheckout, so a collision discovered later cannot be undone.
  it('refuses to restore onto a cloud-only row and moves nothing', async () => {
    const file = renamedFile()
    const cloudRow = localFile({
      relativePath: ORIGINAL_REL_PATH,
      diffStatus: 'cloud',
      pdmData: { id: 'someone-else' } as never,
    })

    const outcome = await performCheckoutPathRestore(
      makeContext([file, cloudRow]),
      file,
      file,
      'op-1',
    )

    expect(outcome).toHaveProperty('error')
    expect(addExpectedFileChanges).not.toHaveBeenCalled()
    expect(renameItem).not.toHaveBeenCalled()
    expect(createFolder).not.toHaveBeenCalled()
  })
})

describe('pendingMetadataPathsToClear', () => {
  it('includes the selected, resolved, and final paths when all three differ', () => {
    // The ghost the user selected, the renamed file resolved on disk, and the
    // path it lands at after being restored to its checkout-time name/folder.
    expect(
      pendingMetadataPathsToClear(
        'C:/vault/Parts/Bracket.SLDPRT',
        'C:/vault/Parts/Bracket-Rev2.SLDPRT',
        'C:/vault/Parts/Bracket.SLDPRT',
      ),
    ).toEqual(['C:/vault/Parts/Bracket.SLDPRT', 'C:/vault/Parts/Bracket-Rev2.SLDPRT'])
  })

  it('dedupes down to one path when no rename or ghost selection was involved', () => {
    expect(
      pendingMetadataPathsToClear(
        'C:/vault/Parts/Bracket.SLDPRT',
        'C:/vault/Parts/Bracket.SLDPRT',
        'C:/vault/Parts/Bracket.SLDPRT',
      ),
    ).toEqual(['C:/vault/Parts/Bracket.SLDPRT'])
  })

  it('keeps all three distinct paths when the selection, resolution, and restore target differ', () => {
    // e.g. the user selected the ghost at the checkout-time path while the file had
    // actually been moved to a third location before this discard resolved it.
    const result = pendingMetadataPathsToClear(
      'C:/vault/Parts/Bracket.SLDPRT',
      'C:/vault/Archive/Bracket-Rev2.SLDPRT',
      'C:/vault/Parts/Bracket.SLDPRT',
    )
    expect(result).toEqual(['C:/vault/Parts/Bracket.SLDPRT', 'C:/vault/Archive/Bracket-Rev2.SLDPRT'])
  })

  it('preserves order and dedupes case-sensitively, matching the exact-string keys the store uses', () => {
    // persistedPendingMetadata is keyed by the exact-cased LocalFile.path, and
    // clearPersistedPendingMetadataForPaths does an exact Set.has() lookup - not
    // a case-insensitive one - so a same-path-different-case input must NOT collapse.
    const result = pendingMetadataPathsToClear(
      'C:/vault/Parts/bracket.sldprt',
      'C:/vault/Parts/Bracket.SLDPRT',
      'C:/vault/Parts/Bracket.SLDPRT',
    )
    expect(result).toEqual(['C:/vault/Parts/bracket.sldprt', 'C:/vault/Parts/Bracket.SLDPRT'])
  })
})
