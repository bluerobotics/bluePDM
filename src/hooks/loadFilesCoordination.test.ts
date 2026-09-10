import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/performanceMetrics', () => ({ recordMetric: vi.fn() }))

const {
  computeLocalScanFingerprint,
  computeServerFolderFingerprint,
  consumeSupersededLoad,
  isLoadFilesInFlight,
  markLoadSuperseded,
  runExclusiveLoad,
  shouldSkipMerge,
} = await import('./loadFilesCoordination')

import type { LoadFilesRequest, MergeSkipCheckInput } from './loadFilesCoordination'

const VAULT = 'vault-1'

function request(overrides: Partial<LoadFilesRequest> = {}): LoadFilesRequest {
  return { silent: true, forceHashComputation: false, hasChangedPaths: false, ...overrides }
}

/** A pass whose promise the test settles by hand, so overlap is observable. */
function controllable() {
  let settle: () => void = () => {}
  let started = 0
  let running = 0
  let maxConcurrent = 0

  const start = () => {
    started++
    running++
    maxConcurrent = Math.max(maxConcurrent, running)
    return new Promise<void>((resolve) => {
      settle = () => {
        running--
        resolve()
      }
    })
  }

  return {
    start,
    finish: () => settle(),
    get started() {
      return started
    },
    get maxConcurrent() {
      return maxConcurrent
    },
  }
}

/** Lets the microtask queue drain so queued continuations run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.stubGlobal('window', { electronAPI: { log: vi.fn() } })
  // Drain any flag a previous test left behind - the module is shared state.
  consumeSupersededLoad(VAULT)
})

describe('runExclusiveLoad', () => {
  it('reports in-flight only while a pass is running', async () => {
    const pass = controllable()
    expect(isLoadFilesInFlight()).toBe(false)

    const run = runExclusiveLoad(VAULT, request(), pass.start)
    await flush()
    expect(isLoadFilesInFlight()).toBe(true)

    pass.finish()
    await run
    expect(isLoadFilesInFlight()).toBe(false)
  })

  it('joins an in-flight pass that already covers the request', async () => {
    const pass = controllable()

    const first = runExclusiveLoad(VAULT, request(), pass.start)
    await flush()
    const second = runExclusiveLoad(VAULT, request(), pass.start)
    await flush()

    // The joiner awaits the running promise rather than starting its own pass.
    expect(pass.started).toBe(1)

    pass.finish()
    await Promise.all([first, second])
    expect(pass.started).toBe(1)
  })

  it('never overlaps two passes when the second cannot join', async () => {
    const pass = controllable()

    const first = runExclusiveLoad(VAULT, request(), pass.start)
    await flush()
    // hasChangedPaths always forces its own pass: the change may have landed
    // after the running pass scanned that path.
    const second = runExclusiveLoad(VAULT, request({ hasChangedPaths: true }), pass.start)
    await flush()

    expect(pass.started).toBe(1)
    expect(pass.maxConcurrent).toBe(1)

    pass.finish()
    await flush()
    expect(pass.started).toBe(2)

    pass.finish()
    await Promise.all([first, second])
    expect(pass.maxConcurrent).toBe(1)
  })

  it('queues a non-silent request behind a silent pass', async () => {
    const pass = controllable()

    const first = runExclusiveLoad(VAULT, request({ silent: true }), pass.start)
    await flush()
    const second = runExclusiveLoad(VAULT, request({ silent: false }), pass.start)
    await flush()

    expect(pass.started).toBe(1)

    pass.finish()
    await flush()
    expect(pass.started).toBe(2)

    pass.finish()
    await Promise.all([first, second])
  })

  it('queues a force-hash request behind a normal pass', async () => {
    const pass = controllable()

    const first = runExclusiveLoad(VAULT, request(), pass.start)
    await flush()
    const second = runExclusiveLoad(VAULT, request({ forceHashComputation: true }), pass.start)
    await flush()

    expect(pass.started).toBe(1)

    pass.finish()
    await flush()
    expect(pass.started).toBe(2)

    pass.finish()
    await Promise.all([first, second])
  })

  it('does not let a pass for another vault join', async () => {
    const pass = controllable()

    const first = runExclusiveLoad(VAULT, request(), pass.start)
    await flush()
    const second = runExclusiveLoad('vault-2', request(), pass.start)
    await flush()

    expect(pass.started).toBe(1)

    pass.finish()
    await flush()
    expect(pass.started).toBe(2)

    pass.finish()
    await Promise.all([first, second])
  })

  it('releases the lock when a pass rejects', async () => {
    await expect(
      runExclusiveLoad(VAULT, request(), () => Promise.reject(new Error('scan failed'))),
    ).rejects.toThrow('scan failed')

    expect(isLoadFilesInFlight()).toBe(false)

    // A later pass must still be able to acquire.
    await runExclusiveLoad(VAULT, request(), () => Promise.resolve())
    expect(isLoadFilesInFlight()).toBe(false)
  })

  it('runs a queued pass even when the one ahead of it rejected', async () => {
    let rejectFirst: (reason: Error) => void = () => {}
    const first = runExclusiveLoad(
      VAULT,
      request(),
      () => new Promise<void>((_, reject) => (rejectFirst = reject)),
    )
    await flush()

    const second = controllable()
    const queued = runExclusiveLoad(VAULT, request({ hasChangedPaths: true }), second.start)
    await flush()
    expect(second.started).toBe(0)

    rejectFirst(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    await flush()

    expect(second.started).toBe(1)
    second.finish()
    await queued
  })

  /**
   * The guarantee the auto-discard fix rests on. Discarding orphans mutates the
   * filesystem; running it inside the exclusive section means a queued pass cannot
   * already be mid-scan when the mutation lands, so it never has to throw its merge
   * away and rerun.
   */
  it('a mutation performed under the lock is visible before a queued pass scans', async () => {
    let epoch = 0
    let observedAtScanStart = -1

    const mutatingPass = controllable()
    const first = runExclusiveLoad(VAULT, request({ silent: false }), async () => {
      await mutatingPass.start()
      epoch++
    })
    await flush()

    const queued = runExclusiveLoad(VAULT, request({ hasChangedPaths: true }), async () => {
      observedAtScanStart = epoch
    })
    await flush()

    // Still blocked: the mutation has not happened yet.
    expect(observedAtScanStart).toBe(-1)

    mutatingPass.finish()
    await Promise.all([first, queued])

    expect(epoch).toBe(1)
    expect(observedAtScanStart).toBe(1)
  })
})

describe('superseded loads', () => {
  it('drains the flag exactly once', () => {
    markLoadSuperseded(VAULT)
    expect(consumeSupersededLoad(VAULT)).toBe(true)
    expect(consumeSupersededLoad(VAULT)).toBe(false)
  })

  it('is tracked per vault', () => {
    markLoadSuperseded(VAULT)
    expect(consumeSupersededLoad('vault-2')).toBe(false)
    expect(consumeSupersededLoad(VAULT)).toBe(true)
  })

  it('ignores an undefined vault', () => {
    markLoadSuperseded(undefined)
    expect(consumeSupersededLoad(undefined)).toBe(false)
  })
})

describe('computeLocalScanFingerprint', () => {
  const entry = (relativePath: string, size: number, modifiedTime: string) => ({
    relativePath,
    size,
    modifiedTime,
  })

  const base = [entry('a/one.txt', 10, '2026-01-01T00:00:00Z'), entry('b/two.txt', 20, 't2')]

  it('is stable for identical input', () => {
    expect(computeLocalScanFingerprint(base)).toBe(computeLocalScanFingerprint(base))
  })

  it('changes when a path changes', () => {
    const moved = [entry('a/renamed.txt', 10, '2026-01-01T00:00:00Z'), base[1]]
    expect(computeLocalScanFingerprint(moved)).not.toBe(computeLocalScanFingerprint(base))
  })

  it('changes when a size changes', () => {
    const resized = [entry('a/one.txt', 11, '2026-01-01T00:00:00Z'), base[1]]
    expect(computeLocalScanFingerprint(resized)).not.toBe(computeLocalScanFingerprint(base))
  })

  it('changes when a modified time changes', () => {
    const touched = [entry('a/one.txt', 10, '2026-01-02T00:00:00Z'), base[1]]
    expect(computeLocalScanFingerprint(touched)).not.toBe(computeLocalScanFingerprint(base))
  })

  it('changes when a file is removed', () => {
    expect(computeLocalScanFingerprint([base[0]])).not.toBe(computeLocalScanFingerprint(base))
  })

  it('encodes the count, so a delimiter collision cannot alias two scans', () => {
    expect(computeLocalScanFingerprint(base).startsWith('2:')).toBe(true)
    expect(computeLocalScanFingerprint([]).startsWith('0:')).toBe(true)
  })
})

describe('computeServerFolderFingerprint', () => {
  it('is stable for identical input', () => {
    const paths = ['a', 'a/b']
    expect(computeServerFolderFingerprint(paths)).toBe(computeServerFolderFingerprint(paths))
  })

  it('is independent of fetch order', () => {
    expect(computeServerFolderFingerprint(['a/b', 'a'])).toBe(
      computeServerFolderFingerprint(['a', 'a/b']),
    )
  })

  it('changes when a folder is added', () => {
    expect(computeServerFolderFingerprint(['a', 'a/b', 'a/c'])).not.toBe(
      computeServerFolderFingerprint(['a', 'a/b']),
    )
  })

  it('changes when a folder is removed', () => {
    expect(computeServerFolderFingerprint(['a'])).not.toBe(
      computeServerFolderFingerprint(['a', 'a/b']),
    )
  })

  it('detects a create-plus-delete pair that a bare count would cancel out', () => {
    // Same count (2) before and after, but the set of paths differs.
    expect(computeServerFolderFingerprint(['a', 'b'])).not.toBe(
      computeServerFolderFingerprint(['a', 'c']),
    )
  })

  it('encodes the count, so a delimiter collision cannot alias two folder sets', () => {
    expect(computeServerFolderFingerprint(['a', 'b']).startsWith('2:')).toBe(true)
    expect(computeServerFolderFingerprint([]).startsWith('0:')).toBe(true)
  })
})

describe('shouldSkipMerge', () => {
  const unchangedInput = (): MergeSkipCheckInput => ({
    silent: true,
    forceHashComputation: false,
    serverCacheHit: true,
    serverDeltaCount: 0,
    serverFoldersErrored: false,
    lastMerged: {
      scanFingerprint: 'scan-1',
      storeFileCount: 10,
      folderFingerprint: 'folder-1',
    },
    localScanFingerprint: 'scan-1',
    storeFileCount: 10,
    serverFolderFingerprint: 'folder-1',
    filesLoaded: true,
    vaultStale: false,
  })

  it('skips a genuinely unchanged pass', () => {
    // Guards against a fix that makes the check always false, which would pass the
    // "folder change forces a merge" test below for the wrong reason and silently
    // reintroduce a full merge on every background refresh.
    expect(shouldSkipMerge(unchangedInput())).toBe(true)
  })

  it('forces the merge when only the folder fingerprint changed - the bug this guards against', () => {
    // Everything else (server delta, scan fingerprint, store count) is exactly what
    // it is when another machine deletes an empty folder: nothing file-side moves.
    const input = { ...unchangedInput(), serverFolderFingerprint: 'folder-2' }
    expect(shouldSkipMerge(input)).toBe(false)
  })

  it('forces the merge when the folder fetch errored, even with matching fingerprints', () => {
    const input = { ...unchangedInput(), serverFoldersErrored: true }
    expect(shouldSkipMerge(input)).toBe(false)
  })

  it('forces the merge when there is no prior merge to compare against', () => {
    const input = { ...unchangedInput(), lastMerged: undefined }
    expect(shouldSkipMerge(input)).toBe(false)
  })

  it('forces the merge for a non-silent (explicit) request', () => {
    expect(shouldSkipMerge({ ...unchangedInput(), silent: false })).toBe(false)
  })

  it('forces the merge when forceHashComputation is requested', () => {
    expect(shouldSkipMerge({ ...unchangedInput(), forceHashComputation: true })).toBe(false)
  })

  it('forces the merge on a server cache miss', () => {
    expect(shouldSkipMerge({ ...unchangedInput(), serverCacheHit: false })).toBe(false)
  })

  it('forces the merge when the server delta is non-zero', () => {
    expect(shouldSkipMerge({ ...unchangedInput(), serverDeltaCount: 1 })).toBe(false)
  })

  it('forces the merge when the local scan fingerprint changed', () => {
    expect(shouldSkipMerge({ ...unchangedInput(), localScanFingerprint: 'scan-2' })).toBe(false)
  })

  it('forces the merge when the store file count changed', () => {
    expect(shouldSkipMerge({ ...unchangedInput(), storeFileCount: 11 })).toBe(false)
  })

  it('forces the merge before the initial load has completed', () => {
    expect(shouldSkipMerge({ ...unchangedInput(), filesLoaded: false })).toBe(false)
  })

  it('forces the merge when the vault context has gone stale', () => {
    expect(shouldSkipMerge({ ...unchangedInput(), vaultStale: true })).toBe(false)
  })

  it('skips when the vault genuinely has no folders, on repeated empty passes', () => {
    const empty = computeServerFolderFingerprint([])
    const input = {
      ...unchangedInput(),
      lastMerged: { scanFingerprint: 'scan-1', storeFileCount: 10, folderFingerprint: empty },
      serverFolderFingerprint: empty,
    }
    expect(shouldSkipMerge(input)).toBe(true)
  })
})
