/**
 * PULL's reference-database parent inference, and the `'moved_away'` stub.
 *
 * `inferParentFromReferenceDatabase` looks up the drawing's parent model by the *database's*
 * recorded relative path (`childPath`), matched against the store's local rows by
 * `relativePath`. For a parent that has moved locally, that match is the `'moved_away'` stub -
 * the row at the server's recorded path - not the `'moved'` partner that actually has the
 * model's current properties on disk. Reading properties from the stub's path just fails
 * (there is nothing there), losing a parent this drawing could otherwise have inherited from.
 *
 * This is read-only, unlike the write-side bug in `syncMetadata.ts`'s `getSwFilesFromSelection` -
 * a wrong path here degrades gracefully to other inference strategies or the drawing's own
 * properties, it does not write anywhere - but it is the same "resolve to the row with real
 * content" fix.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LocalFile } from '../types'
import type { PDMFile } from '../../../types/pdm'

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getSwReferencesCached = vi.fn()
vi.mock('@/lib/solidworks', () => ({
  getSwReferencesCached: (...args: unknown[]) => getSwReferencesCached(...args),
}))

const getContains = vi.fn()
vi.mock('@/lib/supabase', () => ({ getContains: (...args: unknown[]) => getContains(...args) }))

const VAULT = 'C:\\vault'
const DRAWING_ID = 'drawing-1'
const PARENT_ID = 'part-1'

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

let storeFiles: LocalFile[] = []
vi.mock('@/stores/pdmStore', () => ({
  usePDMStore: { getState: () => ({ files: storeFiles, vaultPath: VAULT }) },
}))

const { pullDrawingMetadata } = await import('./syncMetadataPull')

const getProperties = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  storeFiles = []

  vi.stubGlobal('window', { electronAPI: { solidworks: { getProperties } } })

  // The drawing's own properties: empty is fine, it's a fallback we don't expect to need.
  getProperties.mockImplementation(async (path: string) => {
    if (path === DRAWING.path) return { success: true, data: { fileProperties: {} } }
    return { success: false }
  })

  // No SW references resolved, and not for either of the special reasons that would short
  // circuit inference (SW not running / COM inaccessible) - forces the inference chain.
  getSwReferencesCached.mockResolvedValue({ success: false, error: 'NO_REFERENCES' })
})

const DRAWING = localFile('parts/Part.slddrw', {
  pdmData: { id: DRAWING_ID, file_path: 'parts/Part.slddrw' } as PDMFile,
})

describe('inferParentFromReferenceDatabase resolves a moved parent to its real content', () => {
  it('reads properties from the moved partner\u2019s path, not the stub\u2019s', async () => {
    const parentPdmData = { id: PARENT_ID, file_path: 'parts/Model.sldprt' } as PDMFile
    const stub = localFile('parts/Model.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'elsewhere/Model.sldprt',
      pdmData: parentPdmData,
    })
    const moved = localFile('elsewhere/Model.sldprt', { diffStatus: 'moved', pdmData: parentPdmData })
    storeFiles = [DRAWING, stub, moved]

    getContains.mockResolvedValue({
      references: [{ child: { file_path: 'parts/Model.sldprt' } }],
      error: null,
    })
    getProperties.mockImplementation(async (path: string) => {
      if (path === DRAWING.path) return { success: true, data: { fileProperties: {} } }
      if (path === moved.path) {
        return { success: true, data: { fileProperties: { Number: 'PN-777', Description: 'Real part' } } }
      }
      // Any other path, including the stub's, has nothing on disk.
      return { success: false }
    })

    const result = await pullDrawingMetadata(DRAWING.path, DRAWING)

    expect(result?.inheritedFromParent).toBe(true)
    expect(result?.partNumber).toBe('PN-777')
    expect(result?.parentModelPath).toBe(moved.path)
    expect(getProperties).toHaveBeenCalledWith(moved.path)
    expect(getProperties).not.toHaveBeenCalledWith(stub.path)
  })

  it('degrades to the drawing\u2019s own properties, not a thrown error, when the stub has no partner anywhere', async () => {
    // No partner anywhere in the store to fall back to by path - `inferParentFromReferenceDatabase`
    // itself can only fall back to reconstructing the database's own (stub) path in that case,
    // which then fails the same `getProperties` call it always would have. The fix's job here is
    // narrower than in the partnered case above: make sure that failure still degrades cleanly to
    // the drawing's own properties rather than surfacing as anything worse.
    const orphanStub = localFile('parts/Model.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'elsewhere/Model.sldprt',
      pdmData: { id: PARENT_ID, file_path: 'parts/Model.sldprt' } as PDMFile,
    })
    storeFiles = [DRAWING, orphanStub]

    getContains.mockResolvedValue({
      references: [{ child: { file_path: 'parts/Model.sldprt' } }],
      error: null,
    })

    const result = await pullDrawingMetadata(DRAWING.path, DRAWING)

    expect(result?.inheritedFromParent).toBeUndefined()
    expect(result?.partNumber).toBeNull()
  })
})
