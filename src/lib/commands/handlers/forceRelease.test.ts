import { beforeEach, describe, expect, it, vi } from 'vitest'

const adminForceDiscardCheckout = vi.fn()
vi.mock('../../supabase', () => ({ adminForceDiscardCheckout }))

vi.mock('../../fileOperationTracker', () => ({
  FileOperationTracker: {
    start: () => ({
      startStep: () => 'step-1',
      endStep: vi.fn(),
      endOperation: vi.fn(),
    }),
  },
}))

const { forceReleaseCommand } = await import('./forceRelease')

import type { CommandContext, LocalFile } from '../types'

const ADMIN_ID = 'admin-1'
const OTHER_USER_ID = 'other-1'

/** A synced file another user holds the checkout on, with a path snapshot recorded. */
function lockedFile(name: string): LocalFile {
  return {
    name,
    path: `C:/vault/${name}`,
    relativePath: name,
    isDirectory: false,
    pdmData: {
      id: `id-${name}`,
      checked_out_by: OTHER_USER_ID,
      checked_out_user: { id: OTHER_USER_ID, email: 'other@example.com', full_name: 'Other' },
      checked_out_file_path: name,
      checked_out_file_name: name,
    },
  } as LocalFile
}

function makeContext(files: LocalFile[]) {
  return {
    files,
    user: { id: ADMIN_ID },
    addProgressToast: vi.fn(),
    updateProgressToast: vi.fn(),
    removeToast: vi.fn(),
    addToast: vi.fn(),
    updateFilesAndClearProcessing: vi.fn(),
    setLastOperationCompletedAt: vi.fn(),
  } as unknown as CommandContext & {
    updateFilesAndClearProcessing: ReturnType<typeof vi.fn>
  }
}

/** The pdmData patch queued for a given store path. */
function queuedPdmData(ctx: ReturnType<typeof makeContext>, path: string) {
  const [updates] = ctx.updateFilesAndClearProcessing.mock.calls[0] as [
    Array<{ path: string; updates: { pdmData?: Record<string, unknown> } }>,
  ]
  return updates.find((update) => update.path === path)?.updates.pdmData
}

beforeEach(() => {
  vi.clearAllMocks()
  adminForceDiscardCheckout.mockResolvedValue({ success: true })
  vi.stubGlobal('window', { electronAPI: { log: vi.fn() } })
})

describe('force-release store update', () => {
  // adminForceDiscardCheckout clears the snapshot server-side. A store copy left
  // behind would sit on a file that is no longer checked out, where a later discard
  // would read it and try to restore a path from a lock that no longer exists.
  it('clears the checkout path snapshot along with the lock', async () => {
    const files = [lockedFile('one.sldprt')]
    const ctx = makeContext(files)

    await forceReleaseCommand.execute({ files }, ctx)

    expect(queuedPdmData(ctx, 'C:/vault/one.sldprt')).toMatchObject({
      checked_out_by: null,
      checked_out_user: null,
      checked_out_file_path: null,
      checked_out_file_name: null,
    })
  })

  it('queues nothing for a release that failed', async () => {
    const files = [lockedFile('one.sldprt')]
    adminForceDiscardCheckout.mockResolvedValue({ success: false, error: 'not an admin' })
    const ctx = makeContext(files)

    const result = await forceReleaseCommand.execute({ files }, ctx)

    expect(result.failed).toBe(1)
    expect(ctx.updateFilesAndClearProcessing).not.toHaveBeenCalled()
  })
})
