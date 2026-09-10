/**
 * What a folder selection covers locally.
 *
 * `getFilesInFolder` feeds copy, move, rename, merge, discard, get-latest and every
 * "files from selection" helper, so a folder it reads as empty makes all of them do nothing
 * quietly. It read every folder as empty whose stored spelling differed in case from its
 * children's paths, which on Windows is the same folder. The vault that produced this had a
 * "Fixed Lens" folder next to a "Fixed Lens Models" folder, so the containment test has to
 * ignore case and still stop at the separator.
 */

import { describe, expect, it } from 'vitest'

import type { LocalFile } from '@/stores/types'
import type { PDMFile } from '@/types/pdm'
import { getDiscardableFilesFromSelection, getFilesInFolder } from './types'

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

describe('getFilesInFolder', () => {
  it('reaches a folder\u2019s files when the folder is spelled in a different case', () => {
    const child = localFile('dev/Fixed Lens/a.sldprt')
    const nested = localFile('dev/Fixed Lens/nested/b.sldprt')
    const files = [folder('dev/Fixed Lens'), child, nested]

    const found = getFilesInFolder(files, 'dev/FIXED LENS')

    expect(found.map((f) => f.relativePath).sort()).toEqual([
      'dev/Fixed Lens/a.sldprt',
      'dev/Fixed Lens/nested/b.sldprt',
    ])
  })

  it('reaches them when the children are the ones spelled differently', () => {
    const files = [folder('dev/FIXED LENS'), localFile('dev/Fixed Lens/a.sldprt')]

    const found = getFilesInFolder(files, 'dev/FIXED LENS')

    expect(found.map((f) => f.relativePath)).toEqual(['dev/Fixed Lens/a.sldprt'])
  })

  it('stops at the separator, so "Fixed Lens" does not reach "Fixed Lens Models"', () => {
    const files = [
      localFile('dev/Fixed Lens/a.sldprt'),
      localFile('dev/Fixed Lens Models/c.sldprt'),
      localFile('dev/FIXED LENS MODELS/d.sldprt'),
    ]

    const found = getFilesInFolder(files, 'dev/Fixed Lens')

    expect(found.map((f) => f.relativePath)).toEqual(['dev/Fixed Lens/a.sldprt'])
  })

  it('matches across separator styles in either argument', () => {
    const files = [
      localFile('dev\\Fixed Lens\\a.sldprt'),
      localFile('dev/Fixed Lens/nested/b.sldprt'),
    ]

    expect(getFilesInFolder(files, 'dev/Fixed Lens')).toHaveLength(2)
    expect(getFilesInFolder(files, 'dev\\Fixed Lens')).toHaveLength(2)
    expect(getFilesInFolder(files, 'dev\\FIXED LENS')).toHaveLength(2)
  })

  it('excludes directory rows and the folder itself', () => {
    const files = [
      folder('dev/Fixed Lens'),
      folder('dev/Fixed Lens/nested'),
      localFile('dev/Fixed Lens/nested/b.sldprt'),
    ]

    const found = getFilesInFolder(files, 'dev/Fixed Lens')

    expect(found.map((f) => f.relativePath)).toEqual(['dev/Fixed Lens/nested/b.sldprt'])
  })

  it('does not take a file path to mean the file itself', () => {
    // The helper matches the directory it is given; a file is not inside itself, and the
    // callers that pass a file path elsewhere handle it as a file.
    const files = [localFile('dev/Fixed Lens/a.sldprt')]

    expect(getFilesInFolder(files, 'dev/Fixed Lens/a.sldprt')).toEqual([])
    expect(getFilesInFolder(files, 'dev/FIXED LENS/A.SLDPRT')).toEqual([])
  })

  it('matches nothing for an empty folder path', () => {
    const files = [localFile('dev/Fixed Lens/a.sldprt'), localFile('top.sldprt')]

    expect(getFilesInFolder(files, '')).toEqual([])
  })
})

/**
 * The selection helpers all expand folders through `getFilesInFolder`, so the case fix has to
 * be visible through them. Discard is the one the incident was reported against: the folder
 * held files checked out by the user and the command refused with "nothing to discard".
 */
describe('getDiscardableFilesFromSelection', () => {
  it('finds a folder\u2019s checked-out files when the folder row differs in case', () => {
    const userId = 'user-1'
    const checkedOut = localFile('dev/Fixed Lens/a.sldprt', {
      pdmData: {
        id: 'f-1',
        file_path: 'dev/Fixed Lens/a.sldprt',
        checked_out_by: userId,
      } as PDMFile,
      diffStatus: 'modified',
    })
    const selected = folder('dev/FIXED LENS')

    const discardable = getDiscardableFilesFromSelection(
      [selected, checkedOut],
      [selected],
      userId,
    )

    expect(discardable.map((f) => f.relativePath)).toEqual(['dev/Fixed Lens/a.sldprt'])
  })

  it('leaves the neighbouring folder\u2019s checkouts alone', () => {
    const userId = 'user-1'
    const sibling = localFile('dev/Fixed Lens Models/c.sldprt', {
      pdmData: {
        id: 'f-2',
        file_path: 'dev/Fixed Lens Models/c.sldprt',
        checked_out_by: userId,
      } as PDMFile,
      diffStatus: 'modified',
    })
    const selected = folder('dev/Fixed Lens')

    const discardable = getDiscardableFilesFromSelection([selected, sibling], [selected], userId)

    expect(discardable).toEqual([])
  })
})
