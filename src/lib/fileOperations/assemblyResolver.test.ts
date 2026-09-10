/**
 * `resolveAssociatedFiles`'s handling of `'moved_away'` stubs.
 *
 * A `moved_away` row is a stub: it sits at the *server's* recorded path for a file whose
 * content now lives elsewhere on disk, sharing `pdmData.id` (and thus this resolver's map key)
 * with its `'moved'` partner row at the real path. Building the id-keyed `allFiles` map by
 * visiting an array once and calling `set(id, file)` per row - the resolver's original logic -
 * left the winner to iteration order: whichever of the two rows happened to be listed last for
 * that id silently overwrote the other. If the stub won, every downstream consumer (Pack and
 * Go, bulk download/checkout/checkin/delete) resolved that id to a path with nothing on disk.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LocalFile } from '@/stores/pdmStore'
import type { PDMFile } from '@/types/pdm'

const getFile = vi.fn()
const getContainsRecursive = vi.fn()
const getDrawingsForFiles = vi.fn()

vi.mock('@/lib/supabase/files/queries', () => ({ getFile, getContainsRecursive, getDrawingsForFiles }))
vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { pickCanonicalLocalFile, buildCanonicalFileMap, findCanonicalFileById, resolveAssociatedFiles } =
  await import('./assemblyResolver')

const ORG_ID = 'org-1'
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

/** A `moved_away` stub at `relativePath` and its `'moved'` partner at `movedTo`, sharing one id. */
function movedAwayPair(
  id: string,
  relativePath: string,
  movedTo: string,
): { stub: LocalFile; moved: LocalFile } {
  const pdmData = { id, file_path: relativePath } as PDMFile
  return {
    stub: localFile(relativePath, {
      diffStatus: 'moved_away',
      movedToRelativePath: movedTo,
      pdmData,
    }),
    moved: localFile(movedTo, { diffStatus: 'moved', pdmData }),
  }
}

describe('pickCanonicalLocalFile', () => {
  it('prefers the row with local content over the stub, regardless of which is listed first', () => {
    const { stub, moved } = movedAwayPair('f-1', 'old/a.sldprt', 'new/a.sldprt')

    expect(pickCanonicalLocalFile([stub, moved], [stub, moved])).toBe(moved)
    expect(pickCanonicalLocalFile([moved, stub], [stub, moved])).toBe(moved)
  })

  it('resolves a lone stub by its movedToRelativePath when the partner is not among the id-matched candidates', () => {
    const { stub } = movedAwayPair('f-1', 'old/a.sldprt', 'new/a.sldprt')
    // Present in the broader file list, but not grouped under the stub's id - e.g. a caller
    // passed a filtered id-candidate set while still supplying the full list for path lookup.
    const atDestination = localFile('new/a.sldprt', { diffStatus: 'added' })

    expect(pickCanonicalLocalFile([stub], [stub, atDestination])).toBe(atDestination)
  })

  it('falls back to the stub itself when nothing sits at its recorded destination', () => {
    const { stub } = movedAwayPair('f-1', 'old/a.sldprt', 'new/a.sldprt')

    expect(pickCanonicalLocalFile([stub], [stub])).toBe(stub)
  })

  it('falls back to the stub itself when it carries no destination at all', () => {
    const bareStub = localFile('old/a.sldprt', {
      diffStatus: 'moved_away',
      pdmData: { id: 'f-1', file_path: 'old/a.sldprt' } as PDMFile,
    })

    expect(pickCanonicalLocalFile([bareStub], [bareStub])).toBe(bareStub)
  })
})

describe('buildCanonicalFileMap', () => {
  it('resolves a shared id to the moved row rather than whichever the loop visits last', () => {
    const { stub, moved } = movedAwayPair('f-1', 'old/a.sldprt', 'new/a.sldprt')

    expect(buildCanonicalFileMap([stub, moved]).get('f-1')).toBe(moved)
    expect(buildCanonicalFileMap([moved, stub]).get('f-1')).toBe(moved)
  })

  it('keeps ids that only appear once, and drops rows with no pdmData.id', () => {
    const solo = localFile('root/Root.sldasm', {
      pdmData: { id: 'asm-1', file_path: 'root/Root.sldasm' } as PDMFile,
    })
    const noId = localFile('untracked.sldprt', { pdmData: undefined })

    const map = buildCanonicalFileMap([solo, noId])

    expect(map.get('asm-1')).toBe(solo)
    expect(map.size).toBe(1)
  })

  it('this is the exact map bulkAssembly.ts\u2019s resolveFilesForBulkOperation now builds, in place of its own set(id, file) loop', () => {
    const { stub, moved } = movedAwayPair('child-1', 'old/Part.sldprt', 'new/Part.sldprt')
    const root = localFile('root/Root.sldasm', {
      pdmData: { id: 'asm-1', file_path: 'root/Root.sldasm' } as PDMFile,
    })

    // Listed stub-before-moved, the order that let the stub win under the old set() loop.
    const map = buildCanonicalFileMap([root, stub, moved])

    expect(map.get('child-1')?.relativePath).toBe('new/Part.sldprt')
  })
})

describe('findCanonicalFileById', () => {
  it('finds the moved row regardless of which one is listed first', () => {
    const { stub, moved } = movedAwayPair('f-1', 'old/a.sldprt', 'new/a.sldprt')

    expect(findCanonicalFileById([stub, moved], 'f-1')).toBe(moved)
    expect(findCanonicalFileById([moved, stub], 'f-1')).toBe(moved)
  })

  it('returns undefined when no row carries the id at all', () => {
    const { moved } = movedAwayPair('f-1', 'old/a.sldprt', 'new/a.sldprt')

    expect(findCanonicalFileById([moved], 'f-2')).toBeUndefined()
  })

  it('falls back to the stub when it is the only row for the id anywhere in the list', () => {
    const { stub } = movedAwayPair('f-1', 'old/a.sldprt', 'new/a.sldprt')

    expect(findCanonicalFileById([stub], 'f-1')).toBe(stub)
  })
})

describe('resolveAssociatedFiles resolves a moved child to its real content', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getFile.mockResolvedValue({
      file: {
        id: 'asm-1',
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
          parent_file_id: 'asm-1',
          child_file_id: 'child-1',
          quantity: 1,
          configuration: null,
          reference_type: 'component',
          child: {
            id: 'child-1',
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
  })

  it('resolves the shared id to the moved row, not the stub, when the stub is listed first', async () => {
    const { stub, moved } = movedAwayPair('child-1', 'old/Part.sldprt', 'new/Part.sldprt')
    const root = localFile('root/Root.sldasm', {
      diffStatus: 'modified',
      pdmData: { id: 'asm-1', file_path: 'root/Root.sldasm' } as PDMFile,
    })

    const result = await resolveAssociatedFiles('asm-1', ORG_ID, [root, stub, moved])

    expect(result.error).toBeNull()
    const resolvedChild = result.allFiles.get('child-1')
    expect(resolvedChild?.relativePath).toBe('new/Part.sldprt')
    expect(resolvedChild?.diffStatus).not.toBe('moved_away')
  })

  it('resolves the same way when the moved row is listed first', async () => {
    const { stub, moved } = movedAwayPair('child-1', 'old/Part.sldprt', 'new/Part.sldprt')
    const root = localFile('root/Root.sldasm', {
      diffStatus: 'modified',
      pdmData: { id: 'asm-1', file_path: 'root/Root.sldasm' } as PDMFile,
    })

    const result = await resolveAssociatedFiles('asm-1', ORG_ID, [root, moved, stub])

    expect(result.allFiles.get('child-1')?.relativePath).toBe('new/Part.sldprt')
  })

  it('still resolves the root file itself when it, too, has a moved_away stub sharing its id', async () => {
    const { stub, moved } = movedAwayPair('asm-1', 'old/Root.sldasm', 'new/Root.sldasm')

    const result = await resolveAssociatedFiles('asm-1', ORG_ID, [stub, moved])

    expect(result.allFiles.get('asm-1')?.relativePath).toBe('new/Root.sldasm')
  })
})
