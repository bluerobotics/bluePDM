/**
 * The two store actions a caller reaches for after it has changed the disk.
 *
 * A folder delete followed by a copy onto the same path is what broke both of them at
 * once. The delete passed only the six paths its batch touched, so every row beneath the
 * folder survived; the copy then found those survivors sitting at the paths it was writing
 * and dropped its own rows in their favour, leaving 66 of 72 copied files rendering as
 * files that were not on disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'

import type { LocalFile, PDMStoreState, FilesSlice, ServerFile } from '../types'
import type { PDMFile } from '../../types/pdm'
import { createFilesSlice } from './filesSlice'

vi.mock('@/stores/pdmStore', () => ({
  usePDMStore: {
    getState: vi.fn(),
  },
}))

type FilesSliceCreator = StateCreator<PDMStoreState, [['zustand/persist', unknown]], [], FilesSlice>
type StoreSet = Parameters<FilesSliceCreator>[0]
type StoreGet = Parameters<FilesSliceCreator>[1]

const VAULT = 'C:\\vault'

function file(
  overrides: Partial<LocalFile> & Pick<LocalFile, 'path' | 'relativePath'>,
): LocalFile {
  return {
    name: overrides.relativePath.split('/').pop() || '',
    isDirectory: false,
    extension: '.sldprt',
    size: 1,
    modifiedTime: 'then',
    ...overrides,
  }
}

function pdm(id: string, filePath: string): PDMFile {
  return { id, file_path: filePath } as PDMFile
}

function serverFile(id: string, filePath: string): ServerFile {
  return {
    id,
    file_path: filePath,
    name: filePath.split('/').pop() || '',
    extension: '.sldprt',
    content_hash: 'hash',
  }
}

describe('store actions that follow a disk write', () => {
  let store: PDMStoreState

  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: { log: vi.fn() } })

    store = {} as unknown as PDMStoreState

    const set: StoreSet = (partial) => {
      const update = typeof partial === 'function' ? partial(store) : partial
      store = { ...store, ...update }
    }
    const get: StoreGet = () => store
    const api = {} as Parameters<FilesSliceCreator>[2]
    const filesSlice = createFilesSlice(set, get, api)

    store = {
      ...filesSlice,
      files: [],
      serverFiles: [],
      selectedFiles: [],
      user: null,
      vaultPath: VAULT,
      persistedPendingMetadata: {},
      persistedMetadataWriteState: {},
      persistedCopySource: {},
    } as unknown as PDMStoreState
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('addFilesToStore', () => {
    it('takes the incoming row for facts the disk owns', () => {
      store.setFiles([
        file({
          path: `${VAULT}\\dest\\lens.sldprt`,
          relativePath: 'dest/lens.sldprt',
          size: 10,
          modifiedTime: 'then',
          diffStatus: 'cloud',
          isSynced: false,
          localHash: 'old-hash',
          localVersion: 3,
        }),
      ])

      store.addFilesToStore([
        file({
          path: `${VAULT}\\dest\\lens.sldprt`,
          relativePath: 'dest/lens.sldprt',
          size: 4096,
          modifiedTime: 'now',
          diffStatus: 'added',
          isSynced: false,
        }),
      ])

      expect(store.files).toHaveLength(1)
      const merged = store.files[0]
      expect(merged.diffStatus).toBe('added')
      expect(merged.size).toBe(4096)
      expect(merged.modifiedTime).toBe('now')
      expect(merged.localHash).toBeUndefined()
      expect(merged.localVersion).toBeUndefined()
    })

    it('keeps the incumbent server linkage the incoming row never had', () => {
      store.setFiles([
        file({
          path: `${VAULT}\\dest\\lens.sldprt`,
          relativePath: 'dest/lens.sldprt',
          pdmData: pdm('file-1', 'dest/lens.sldprt'),
          isSynced: true,
          pendingCheckinNote: 'note from before',
        }),
      ])

      store.addFilesToStore([
        file({
          path: `${VAULT}\\dest\\lens.sldprt`,
          relativePath: 'dest/lens.sldprt',
          diffStatus: 'added',
          isSynced: false,
        }),
      ])

      expect(store.files[0].pdmData?.id).toBe('file-1')
      expect(store.files[0].pendingCheckinNote).toBe('note from before')
      expect(store.files[0].isSynced).toBe(false)
    })

    it('lets the incoming row replace server fields it does supply', () => {
      store.setFiles([
        file({
          path: `${VAULT}\\dest\\lens.sldprt`,
          relativePath: 'dest/lens.sldprt',
          pdmData: pdm('stale', 'dest/lens.sldprt'),
          pendingMetadata: { description: 'stale' },
        }),
      ])

      const fresh = pdm('fresh', 'dest/lens.sldprt')
      store.addFilesToStore([
        file({
          path: `${VAULT}\\dest\\lens.sldprt`,
          relativePath: 'dest/lens.sldprt',
          pdmData: fresh,
          pendingMetadata: { description: 'copied' },
        }),
      ])

      expect(store.files[0].pdmData).toBe(fresh)
      expect(store.files[0].pendingMetadata).toEqual({ description: 'copied' })
    })

    it('appends rows for paths nothing holds yet', () => {
      store.setFiles([
        file({ path: `${VAULT}\\dest\\lens.sldprt`, relativePath: 'dest/lens.sldprt' }),
      ])

      store.addFilesToStore([
        file({ path: `${VAULT}\\dest\\mount.sldprt`, relativePath: 'dest/mount.sldprt' }),
      ])

      expect(store.files.map((f) => f.relativePath).sort()).toEqual([
        'dest/lens.sldprt',
        'dest/mount.sldprt',
      ])
    })

    it('matches paths case-insensitively rather than adding a second row', () => {
      store.setFiles([
        file({ path: `${VAULT}\\DEST\\Lens.SLDPRT`, relativePath: 'DEST/Lens.SLDPRT' }),
      ])

      store.addFilesToStore([
        file({
          path: `${VAULT}\\dest\\lens.sldprt`,
          relativePath: 'dest/lens.sldprt',
          diffStatus: 'added',
        }),
      ])

      expect(store.files).toHaveLength(1)
      expect(store.files[0].diffStatus).toBe('added')
    })

    it('leaves the array alone when the merge would change nothing', () => {
      store.setFiles([
        file({
          path: `${VAULT}\\dest\\lens.sldprt`,
          relativePath: 'dest/lens.sldprt',
          diffStatus: 'added',
        }),
      ])
      const before = store.files

      store.addFilesToStore([
        file({
          path: `${VAULT}\\dest\\lens.sldprt`,
          relativePath: 'dest/lens.sldprt',
          diffStatus: 'added',
        }),
      ])

      expect(store.files).toBe(before)
    })

    it('drops a disk fact the incoming row no longer carries, even when nothing else moved', () => {
      store.setFiles([
        file({
          path: `${VAULT}\\dest\\lens.sldprt`,
          relativePath: 'dest/lens.sldprt',
          diffStatus: 'added',
          localVersion: 3,
        }),
      ])

      store.addFilesToStore([
        file({
          path: `${VAULT}\\dest\\lens.sldprt`,
          relativePath: 'dest/lens.sldprt',
          diffStatus: 'added',
        }),
      ])

      expect(store.files[0].localVersion).toBeUndefined()
    })
  })

  describe('removeFilesFromStore', () => {
    beforeEach(() => {
      store.setFiles([
        file({
          path: `${VAULT}\\dest\\Fixed Lens`,
          relativePath: 'dest/Fixed Lens',
          isDirectory: true,
          extension: '',
        }),
        file({
          path: `${VAULT}\\dest\\Fixed Lens\\a.sldprt`,
          relativePath: 'dest/Fixed Lens/a.sldprt',
        }),
        file({
          path: `${VAULT}\\dest\\Fixed Lens\\nested\\b.sldprt`,
          relativePath: 'dest/Fixed Lens/nested/b.sldprt',
        }),
        file({
          path: `${VAULT}\\dest\\Fixed Lens Models`,
          relativePath: 'dest/Fixed Lens Models',
          isDirectory: true,
          extension: '',
        }),
        file({
          path: `${VAULT}\\dest\\Fixed Lens Models\\c.sldprt`,
          relativePath: 'dest/Fixed Lens Models/c.sldprt',
        }),
      ])
      store.setServerFiles([
        serverFile('s-a', 'dest/Fixed Lens/a.sldprt'),
        serverFile('s-b', 'dest/Fixed Lens/nested/b.sldprt'),
        serverFile('s-c', 'dest/Fixed Lens Models/c.sldprt'),
      ])
    })

    it('prunes a removed folder\u2019s contents from files, not only from serverFiles', () => {
      store.removeFilesFromStore([`${VAULT}\\dest\\Fixed Lens`])

      expect(store.files.map((f) => f.relativePath)).toEqual([
        'dest/Fixed Lens Models',
        'dest/Fixed Lens Models/c.sldprt',
      ])
      expect(store.serverFiles.map((sf) => sf.file_path)).toEqual([
        'dest/Fixed Lens Models/c.sldprt',
      ])
    })

    it('stops at the directory boundary, so "Fixed Lens" spares "Fixed Lens Models"', () => {
      store.removeFilesFromStore([`${VAULT}\\dest\\Fixed Lens`])

      expect(store.files.some((f) => f.relativePath.startsWith('dest/Fixed Lens Models'))).toBe(
        true,
      )
      expect(
        store.serverFiles.some((sf) => sf.file_path.startsWith('dest/Fixed Lens Models')),
      ).toBe(true)
    })

    it('removes only the named row when it is a file', () => {
      store.removeFilesFromStore([`${VAULT}\\dest\\Fixed Lens\\a.sldprt`])

      expect(store.files.map((f) => f.relativePath)).toEqual([
        'dest/Fixed Lens',
        'dest/Fixed Lens/nested/b.sldprt',
        'dest/Fixed Lens Models',
        'dest/Fixed Lens Models/c.sldprt',
      ])
    })
  })
})
