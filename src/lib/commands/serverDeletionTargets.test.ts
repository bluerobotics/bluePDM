/**
 * What a delete-server selection actually covers.
 *
 * Enumerating a folder's contents from the local rows found 5 of the 53 records the server
 * held under it. The other 48 survived the delete as orphans and were then shadowed by a
 * copy onto the same path, which is why the copied files rendered as server-only. The
 * enumeration reads the server list instead, on a directory boundary - the vault that
 * produced this had a "Fixed Lens" folder next to a "Fixed Lens Models" folder, and a bare
 * prefix match would have deleted both.
 */

import { describe, expect, it } from 'vitest'

import { isPathWithinDirectory } from '@/lib/utils'
import type { LocalFile, ServerFile } from '@/stores/types'
import type { PDMFile } from '@/types/pdm'
import { getLocalDeletionItems, getServerDeletionTargets } from './types'

const VAULT = 'C:\\vault'

function localFile(
  relativePath: string,
  overrides: Partial<LocalFile> = {},
): LocalFile {
  return {
    name: relativePath.split('/').pop() || '',
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

function serverFile(id: string, filePath: string): ServerFile {
  return {
    id,
    file_path: filePath,
    name: filePath.split('/').pop() || '',
    extension: '.sldprt',
    content_hash: 'hash',
  }
}

function synced(relativePath: string, id: string): LocalFile {
  return localFile(relativePath, {
    pdmData: { id, file_path: relativePath } as PDMFile,
    isSynced: true,
  })
}

describe('isPathWithinDirectory', () => {
  it('matches the directory itself and its descendants', () => {
    expect(isPathWithinDirectory('dev/Fixed Lens', 'dev/Fixed Lens')).toBe(true)
    expect(isPathWithinDirectory('dev/Fixed Lens/a.sldprt', 'dev/Fixed Lens')).toBe(true)
    expect(isPathWithinDirectory('dev/Fixed Lens/deep/a.sldprt', 'dev/Fixed Lens')).toBe(true)
  })

  it('stops at the separator, so "Fixed Lens" does not reach "Fixed Lens Models"', () => {
    expect(isPathWithinDirectory('dev/Fixed Lens Models', 'dev/Fixed Lens')).toBe(false)
    expect(isPathWithinDirectory('dev/Fixed Lens Models/a.sldprt', 'dev/Fixed Lens')).toBe(false)
  })

  it('ignores case and separator style', () => {
    expect(isPathWithinDirectory('DEV\\Fixed Lens\\a.sldprt', 'dev/fixed lens')).toBe(true)
    expect(isPathWithinDirectory('dev/Fixed Lens/a.sldprt', 'dev/Fixed Lens/')).toBe(true)
  })

  it('matches nothing for an empty directory', () => {
    expect(isPathWithinDirectory('dev/Fixed Lens/a.sldprt', '')).toBe(false)
  })
})

describe('getServerDeletionTargets', () => {
  const serverFiles: ServerFile[] = [
    serverFile('s-1', 'dev/Fixed Lens/a.sldprt'),
    serverFile('s-2', 'dev/Fixed Lens/nested/b.sldprt'),
    serverFile('s-3', 'dev/Fixed Lens Models/c.sldprt'),
    serverFile('s-4', 'other/d.sldprt'),
  ]

  it('covers every server record under a folder, not only the ones with a local row', () => {
    const files = [folder('dev/Fixed Lens'), synced('dev/Fixed Lens/a.sldprt', 's-1')]

    const targets = getServerDeletionTargets(
      files,
      serverFiles,
      [folder('dev/Fixed Lens')],
      VAULT,
    )

    expect(targets.map((t) => t.fileId).sort()).toEqual(['s-1', 's-2'])
  })

  it('spares the sibling folder whose name it is a prefix of', () => {
    const targets = getServerDeletionTargets([], serverFiles, [folder('dev/Fixed Lens')], VAULT)

    expect(targets.some((t) => t.relativePath.startsWith('dev/Fixed Lens Models'))).toBe(false)
  })

  it('never reaches outside the selected folder', () => {
    const targets = getServerDeletionTargets([], serverFiles, [folder('dev/Fixed Lens')], VAULT)

    expect(targets.some((t) => t.relativePath.startsWith('other/'))).toBe(false)
  })

  it('attaches the local row when there is one and builds a path when there is not', () => {
    const files = [synced('dev/Fixed Lens/a.sldprt', 's-1')]

    const targets = getServerDeletionTargets(
      files,
      serverFiles,
      [folder('dev/Fixed Lens')],
      VAULT,
    )
    const withLocal = targets.find((t) => t.fileId === 's-1')
    const withoutLocal = targets.find((t) => t.fileId === 's-2')

    expect(withLocal?.localFile?.relativePath).toBe('dev/Fixed Lens/a.sldprt')
    expect(withoutLocal?.localFile).toBeUndefined()
    expect(withoutLocal?.path).toBe(`${VAULT}\\dev\\Fixed Lens\\nested\\b.sldprt`)
  })

  it('takes a selected file as itself, and only when it carries a record', () => {
    const tracked = synced('dev/Fixed Lens/a.sldprt', 's-1')
    const untracked = localFile('dev/Fixed Lens/new.sldprt', { diffStatus: 'added' })

    const targets = getServerDeletionTargets(
      [tracked, untracked],
      serverFiles,
      [tracked, untracked],
      VAULT,
    )

    expect(targets.map((t) => t.fileId)).toEqual(['s-1'])
  })

  it('counts a record once when it is both selected and inside a selected folder', () => {
    const tracked = synced('dev/Fixed Lens/a.sldprt', 's-1')

    const targets = getServerDeletionTargets(
      [tracked],
      serverFiles,
      [folder('dev/Fixed Lens'), tracked],
      VAULT,
    )

    expect(targets.filter((t) => t.fileId === 's-1')).toHaveLength(1)
  })

  it('matches folder and record paths case-insensitively', () => {
    const targets = getServerDeletionTargets([], serverFiles, [folder('DEV/FIXED LENS')], VAULT)

    expect(targets.map((t) => t.fileId).sort()).toEqual(['s-1', 's-2'])
  })
})

/**
 * The local half of the same selection. It has to agree with the server half above and with
 * `removeFilesFromStore`, because a file this misses is deleted from the server and dropped
 * from the store while staying on disk, where the app can no longer see it.
 */
describe('getLocalDeletionItems', () => {
  it('reaches a folder\u2019s files when the folder row is spelled in a different case', () => {
    const child = localFile('dev/Fixed Lens/a.sldprt')
    const nested = localFile('dev/Fixed Lens/nested/b.sldprt')
    const selected = folder('dev/FIXED LENS')

    const items = getLocalDeletionItems([selected, child, nested], [selected])

    expect(items.map((f) => f.relativePath).sort()).toEqual([
      'dev/FIXED LENS',
      'dev/Fixed Lens/a.sldprt',
      'dev/Fixed Lens/nested/b.sldprt',
    ])
  })

  it('stops at the separator, so "Fixed Lens" does not reach "Fixed Lens Models"', () => {
    const inside = localFile('dev/Fixed Lens/a.sldprt')
    const sibling = localFile('dev/Fixed Lens Models/c.sldprt')
    const selected = folder('dev/Fixed Lens')

    const items = getLocalDeletionItems([selected, inside, sibling], [selected])

    expect(items.map((f) => f.relativePath)).not.toContain('dev/Fixed Lens Models/c.sldprt')
    expect(items.map((f) => f.relativePath).sort()).toEqual([
      'dev/Fixed Lens',
      'dev/Fixed Lens/a.sldprt',
    ])
  })

  it('leaves cloud-only rows alone, in the selection and inside a folder', () => {
    const cloudChild = localFile('dev/Fixed Lens/cloud.sldprt', { diffStatus: 'cloud' })
    const localChild = localFile('dev/Fixed Lens/a.sldprt')
    const selected = folder('dev/Fixed Lens')
    const cloudSelected = localFile('other/cloud.sldprt', { diffStatus: 'cloud' })

    const items = getLocalDeletionItems(
      [selected, cloudChild, localChild, cloudSelected],
      [selected, cloudSelected],
    )

    expect(items.map((f) => f.relativePath).sort()).toEqual([
      'dev/Fixed Lens',
      'dev/Fixed Lens/a.sldprt',
    ])
  })

  it('counts a file once when it is both selected and inside a selected folder', () => {
    const child = localFile('dev/Fixed Lens/a.sldprt')
    const selected = folder('dev/Fixed Lens')

    const items = getLocalDeletionItems([selected, child], [selected, child])

    expect(items.filter((f) => f.relativePath === 'dev/Fixed Lens/a.sldprt')).toHaveLength(1)
  })
})
