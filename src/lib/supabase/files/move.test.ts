/**
 * `moveFilesOnServer` is the only thing that writes during a reconcile, so the guarantees the
 * command reports rest on it: one `move_file` per file, a per-file outcome for each, and a stop that
 * leaves the remaining files untouched rather than half-written.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
vi.mock('../client', () => ({ getSupabaseClient: () => ({ rpc }) }))

const { moveFileOnServer, moveFilesOnServer } = await import('./move')

/** The `move_file` RPC's JSONB reply. */
function replies(outcomes: Record<string, { success: boolean; error?: string }>) {
  rpc.mockImplementation((_name: string, params: { p_file_id: string }) => {
    const outcome = outcomes[params.p_file_id] ?? { success: true }
    return Promise.resolve({ data: outcome, error: null })
  })
}

function moves(...fileIds: string[]) {
  return fileIds.map((fileId) => ({
    fileId,
    newFilePath: `new/${fileId}.sldprt`,
    newFileName: `${fileId}.sldprt`,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  replies({})
})

describe('moveFileOnServer', () => {
  it('reports the RPC’s refusal rather than a transport success', async () => {
    replies({ a: { success: false, error: 'Cannot move: file is checked out by Ana Ruiz' } })

    const result = await moveFileOnServer('a', 'user-me', 'new/a.sldprt', 'a.sldprt')

    expect(result).toEqual({
      success: false,
      error: 'Cannot move: file is checked out by Ana Ruiz',
    })
  })

  it('reports a transport error as a failure', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'network died' } })

    expect(await moveFileOnServer('a', 'user-me', 'new/a.sldprt')).toEqual({
      success: false,
      error: 'network died',
    })
  })
})

describe('moveFilesOnServer', () => {
  it('issues one move_file per file and returns an outcome for each, in order', async () => {
    const result = await moveFilesOnServer(moves('a', 'b', 'c'), 'user-me')

    expect(rpc).toHaveBeenCalledTimes(3)
    expect(rpc).toHaveBeenCalledWith('move_file', {
      p_file_id: 'a',
      p_user_id: 'user-me',
      p_new_file_path: 'new/a.sldprt',
      p_new_file_name: 'a.sldprt',
    })
    expect(result.results.map((r) => r.fileId)).toEqual(['a', 'b', 'c'])
    expect(result.succeeded).toBe(3)
    expect(result.failed).toBe(0)
    expect(result.stopped).toBe(false)
  })

  it('keeps the counts and the errors the previous serial version returned', async () => {
    replies({ b: { success: false, error: 'Cannot move: file is checked out by Ana Ruiz' } })

    const result = await moveFilesOnServer(moves('a', 'b', 'c'), 'user-me')

    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.errors).toEqual(['b: Cannot move: file is checked out by Ana Ruiz'])
    expect(result.results[1]).toEqual({
      fileId: 'b',
      attempted: true,
      success: false,
      error: 'Cannot move: file is checked out by Ana Ruiz',
    })
  })

  it('reports progress once per completed file', async () => {
    const onProgress = vi.fn()

    await moveFilesOnServer(moves('a', 'b'), 'user-me', { concurrency: 1, onProgress })

    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it('leaves the remaining files untouched once shouldStop returns true', async () => {
    let stop = false
    rpc.mockImplementation(() => {
      // Stop after the first write settles, the way a cancelled progress toast would.
      stop = true
      return Promise.resolve({ data: { success: true }, error: null })
    })

    const result = await moveFilesOnServer(moves('a', 'b', 'c'), 'user-me', {
      concurrency: 1,
      shouldStop: () => stop,
    })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(result.succeeded).toBe(1)
    // Not attempted is not failed: nothing was written to b or c, so a re-run picks them up.
    expect(result.failed).toBe(0)
    expect(result.stopped).toBe(true)
    expect(result.results.filter((r) => !r.attempted).map((r) => r.fileId)).toEqual(['b', 'c'])
  })

  it('does nothing at all when given nothing', async () => {
    const result = await moveFilesOnServer([], 'user-me')

    expect(rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ succeeded: 0, failed: 0, errors: [], results: [], stopped: false })
  })
})
