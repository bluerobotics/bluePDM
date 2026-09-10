/**
 * `'moved_away'` selection exclusions.
 *
 * A `moved_away` row is a stub: it sits at the *server's* recorded path for a file whose
 * content now lives elsewhere on disk (its `'moved'` partner, sharing the same `pdmData.id`).
 * It has `pdmData` and the real file's checkout state, but no local file behind it. Per the
 * plan, a stub must never be a check-in, checkout, or delete target - these tests cover the
 * three selection helpers in this file that decide what a folder-level selection reaches.
 */

import { describe, expect, it } from 'vitest'

import type { LocalFile } from '@/stores/types'
import type { PDMFile } from '@/types/pdm'

import {
  getDiscardableFilesFromSelection,
  getFilesCheckedOutByOthers,
  getLocalDeletionItems,
  getSyncedFilesFromSelection,
} from './types'

const VAULT = 'C:\\vault'

function localFile(relativePath: string, overrides: Partial<LocalFile> = {}): LocalFile {
  return {
    name: relativePath.split(/[/\\]/).pop() || '',
    path: `${VAULT}\\${relativePath.replace(/\//g, '\\')}`,
    relativePath,
    isDirectory: false,
    extension: '.sldprt',
    size: 1,
    modifiedTime: 'now',
    ...overrides,
  }
}

function folder(relativePath: string): LocalFile {
  return localFile(relativePath, { isDirectory: true, extension: '' })
}

/**
 * A `moved_away` stub at `relativePath` (the server's recorded path) plus its `'moved'`
 * partner at `movedToRelativePath` (where the content actually lives), sharing one
 * `pdmData.id` and the same checkout state - exactly the shape `cloudFileReconciliation.ts`
 * produces for an unreconciled inode-matched rename.
 */
function movedAwayPair(
  relativePath: string,
  movedToRelativePath: string,
  pdmOverrides: Partial<PDMFile> = {},
): { stub: LocalFile; moved: LocalFile } {
  const pdmData = {
    id: 'f-1',
    file_path: relativePath,
    checked_out_by: null,
    ...pdmOverrides,
  } as PDMFile

  return {
    stub: localFile(relativePath, {
      diffStatus: 'moved_away',
      movedToRelativePath,
      isSynced: false,
      ino: undefined,
      pdmData,
    }),
    moved: localFile(movedToRelativePath, {
      diffStatus: 'moved',
      pdmData,
    }),
  }
}

describe('getSyncedFilesFromSelection excludes moved_away stubs', () => {
  it('does not return the stub itself, even though it carries pdmData', () => {
    const { stub } = movedAwayPair('old/a.sldprt', 'new/a.sldprt')

    expect(getSyncedFilesFromSelection([stub], [stub])).toEqual([])
  })

  it('does not surface the stub when the old-location folder is selected', () => {
    const { stub, moved } = movedAwayPair('old/a.sldprt', 'new/a.sldprt')
    const oldFolder = folder('old')

    const synced = getSyncedFilesFromSelection([oldFolder, stub, moved], [oldFolder])

    expect(synced).toEqual([])
  })

  it('still reaches the real (moved) row when its own folder is selected', () => {
    const { stub, moved } = movedAwayPair('old/a.sldprt', 'new/a.sldprt')
    const newFolder = folder('new')

    const synced = getSyncedFilesFromSelection([newFolder, stub, moved], [newFolder])

    expect(synced.map((f) => f.relativePath)).toEqual(['new/a.sldprt'])
  })

  it('cannot be used to checkout or checkin through the stub - checked-out-by-others reads empty', () => {
    // The stub carries the real file's checkout state. Before the fix, selecting the
    // old-location folder let a stub checked out by someone else read as "checked out by
    // others" (blocking) or, for the acting user's own checkout, as checked-in-able - either
    // way, an operation reached through a row with no local file behind it.
    const { stub, moved } = movedAwayPair('old/a.sldprt', 'new/a.sldprt', {
      checked_out_by: 'user-ana',
    })
    const oldFolder = folder('old')

    const checkedOutByOthers = getFilesCheckedOutByOthers(
      [oldFolder, stub, moved],
      [oldFolder],
      'user-me',
    )

    expect(checkedOutByOthers).toEqual([])
  })
})

describe('getLocalDeletionItems excludes moved_away stubs', () => {
  it('does not return the stub itself', () => {
    const { stub } = movedAwayPair('old/a.sldprt', 'new/a.sldprt')

    expect(getLocalDeletionItems([stub], [stub])).toEqual([])
  })

  it('leaves the stub out of a folder-level delete-local, alongside the moved row it is not', () => {
    const { stub, moved } = movedAwayPair('old/a.sldprt', 'new/a.sldprt')
    const oldFolder = folder('old')
    const untouched = localFile('old/b.sldprt')

    const items = getLocalDeletionItems([oldFolder, stub, moved, untouched], [oldFolder])

    expect(items.map((f) => f.relativePath).sort()).toEqual(['old', 'old/b.sldprt'])
  })
})

describe('getDiscardableFilesFromSelection excludes moved_away stubs', () => {
  it('does not return the stub itself, even when its checkout matches the acting user', () => {
    const { stub } = movedAwayPair('old/a.sldprt', 'new/a.sldprt', { checked_out_by: 'user-me' })

    expect(getDiscardableFilesFromSelection([stub], [stub], 'user-me')).toEqual([])
  })

  it('reports one discardable file, not two, when a folder selection reaches both halves of a pair', () => {
    // A file moved to a sibling folder under a shared, selected ancestor puts both the stub
    // and its 'moved' partner inside the same folder selection. Before the fix this produced
    // two entries sharing one `pdmData.id` - the same checkout handed to discard's batch twice.
    const { stub, moved } = movedAwayPair('shared/old/a.sldprt', 'shared/new/a.sldprt', {
      checked_out_by: 'user-me',
    })
    const sharedFolder = folder('shared')

    const discardable = getDiscardableFilesFromSelection(
      [sharedFolder, stub, moved],
      [sharedFolder],
      'user-me',
    )

    expect(discardable.map((f) => f.relativePath)).toEqual(['shared/new/a.sldprt'])
  })
})
