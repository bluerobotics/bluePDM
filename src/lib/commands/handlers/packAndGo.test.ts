/**
 * Pack and Go, and the `'moved_away'` stub.
 *
 * A `moved_away` row is a stub at the *server's* recorded path for a file whose content now
 * lives elsewhere on disk - it has no local file behind it. It shares `pdmData.id` (this
 * resolver's map key) with its `'moved'` partner at the real path. Two properties matter here:
 *
 * 1. `validate()` refuses to run Pack and Go directly on a stub row - there is no local
 *    assembly at that path to pack.
 * 2. `execute()`, run on a real assembly whose BOM includes a moved child, zips the child's
 *    real content (via its `'moved'` row) rather than a path that does not exist on disk -
 *    the fix lives one layer down, in `assemblyResolver.ts`'s id-keyed map, but this is the
 *    end-to-end shape the task asked to verify it against.
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

const { packAndGoCommand } = await import('./packAndGo')

const VAULT = 'C:\\vault'

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

function makeContext(files: LocalFile[]): CommandContext {
  return {
    user: { id: 'user-1' } as CommandContext['user'],
    organization: { id: 'org-1' } as CommandContext['organization'],
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
  } as unknown as CommandContext
}

describe('validate refuses a moved_away row', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: {} })
  })

  it('names where the file actually is, when the stub carries a destination', () => {
    const stub = localFile('old/Root.sldasm', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'new/Root.sldasm',
      pdmData: { id: 'asm-1', file_path: 'old/Root.sldasm' } as PDMFile,
    })

    const error = packAndGoCommand.validate({ file: stub }, makeContext([stub]))

    expect(error).toContain('new/Root.sldasm')
  })

  it('still refuses, with a generic message, when the stub carries no destination', () => {
    const bareStub = localFile('old/Root.sldasm', {
      diffStatus: 'moved_away',
      pdmData: { id: 'asm-1', file_path: 'old/Root.sldasm' } as PDMFile,
    })

    const error = packAndGoCommand.validate({ file: bareStub }, makeContext([bareStub]))

    expect(error).not.toBeNull()
  })

  it('allows a synced, non-stub assembly through', () => {
    const assembly = localFile('root/Root.sldasm', {
      diffStatus: 'modified',
      pdmData: { id: 'asm-1', file_path: 'root/Root.sldasm' } as PDMFile,
    })

    expect(packAndGoCommand.validate({ file: assembly }, makeContext([assembly]))).toBeNull()
  })
})

describe('execute zips a moved child by its real content, not its stub', () => {
  const createZip = vi.fn()
  const showSaveDialog = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()

    getFile.mockResolvedValue({
      file: {
        id: 'asm-1',
        org_id: 'org-1',
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

    showSaveDialog.mockResolvedValue({ success: true, canceled: false, path: 'C:\\out.zip' })
    createZip.mockResolvedValue({ success: true, fileCount: 2, totalSize: 100 })

    vi.stubGlobal('window', {
      electronAPI: {
        showSaveDialog,
        archive: { createZip, onProgress: undefined },
      },
    })
  })

  it('zips the moved partner\u2019s path and never the stub\u2019s, regardless of array order', async () => {
    const root = localFile('root/Root.sldasm', {
      diffStatus: 'modified',
      pdmData: { id: 'asm-1', file_path: 'root/Root.sldasm' } as PDMFile,
    })
    const childPdmData = { id: 'child-1', file_path: 'old/Part.sldprt' } as PDMFile
    const stub = localFile('old/Part.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'new/Part.sldprt',
      pdmData: childPdmData,
    })
    const moved = localFile('new/Part.sldprt', { diffStatus: 'moved', pdmData: childPdmData })

    // Listed stub-before-moved: before the resolver fix, whichever of the two an ordinary
    // `Map.set(id, file)` loop visited last would silently win the id.
    const ctx = makeContext([root, stub, moved])

    const result = await packAndGoCommand.execute({ file: root }, ctx)

    expect(result.success).toBe(true)
    expect(createZip).toHaveBeenCalledTimes(1)
    const [zippedFiles] = createZip.mock.calls[0] as [Array<{ path: string; relativePath: string }>]

    expect(zippedFiles.map((f) => f.relativePath)).toContain('new/Part.sldprt')
    expect(zippedFiles.map((f) => f.relativePath)).not.toContain('old/Part.sldprt')
    expect(zippedFiles.some((f) => f.path === stub.path)).toBe(false)
  })

  it('does not zip anything for a child whose only row is an unpartnered stub', async () => {
    const root = localFile('root/Root.sldasm', {
      diffStatus: 'modified',
      pdmData: { id: 'asm-1', file_path: 'root/Root.sldasm' } as PDMFile,
    })
    const orphanStub = localFile('old/Part.sldprt', {
      diffStatus: 'moved_away',
      movedToRelativePath: 'new/Part.sldprt',
      pdmData: { id: 'child-1', file_path: 'old/Part.sldprt' } as PDMFile,
    })

    const ctx = makeContext([root, orphanStub])

    await packAndGoCommand.execute({ file: root }, ctx)

    expect(createZip).toHaveBeenCalledTimes(1)
    const [zippedFiles] = createZip.mock.calls[0] as [Array<{ path: string; relativePath: string }>]
    expect(zippedFiles.some((f) => f.relativePath === 'old/Part.sldprt')).toBe(false)
  })
})
