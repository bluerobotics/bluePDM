import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/i18n', () => ({
  t: (key: string, fallback?: string) => fallback ?? key,
}))

import {
  clearServerPathUpdateFailures,
  listServerPathUpdateFailures,
  noteServerPathUpdateFailure,
  recordServerPathUpdateFailure,
  type ServerPathUpdateFailure,
} from './serverPathUpdates'

/** A localStorage that outlives the module under test, as the real one outlives the app. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed))
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

function failure(overrides: Partial<ServerPathUpdateFailure> = {}): ServerPathUpdateFailure {
  return {
    kind: 'file',
    recordId: 'file-1',
    vaultId: 'vault-1',
    oldPath: 'Parts/Bracket.SLDPRT',
    newPath: 'Parts/Bracket-Rev2.SLDPRT',
    error: 'permission denied',
    failedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('the durable record', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads back what it wrote', () => {
    recordServerPathUpdateFailure(failure())

    expect(listServerPathUpdateFailures()).toEqual([failure()])
  })

  it('survives a restart, because it lives in storage rather than in a promise', () => {
    recordServerPathUpdateFailure(failure())
    const persisted = localStorage.getItem('blueplm.serverPathUpdateFailures')

    // A fresh session sees only what storage kept; module state is gone.
    vi.stubGlobal(
      'localStorage',
      memoryStorage({ 'blueplm.serverPathUpdateFailures': persisted! }),
    )

    expect(listServerPathUpdateFailures()).toEqual([failure()])
  })

  it('filters by vault', () => {
    recordServerPathUpdateFailure(failure({ recordId: 'a', vaultId: 'vault-1' }))
    recordServerPathUpdateFailure(failure({ recordId: 'b', vaultId: 'vault-2' }))

    expect(listServerPathUpdateFailures('vault-2').map((f) => f.recordId)).toEqual(['b'])
  })

  it('caps the list at 200, dropping the oldest first', () => {
    for (let i = 0; i < 205; i++) {
      recordServerPathUpdateFailure(failure({ recordId: `file-${i}` }))
    }

    const recorded = listServerPathUpdateFailures()
    expect(recorded).toHaveLength(200)
    expect(recorded[0].recordId).toBe('file-5')
    expect(recorded[199].recordId).toBe('file-204')
  })

  it('ignores a corrupted entry rather than throwing at the caller', () => {
    localStorage.setItem(
      'blueplm.serverPathUpdateFailures',
      JSON.stringify([{ kind: 'nonsense' }, failure()]),
    )

    expect(listServerPathUpdateFailures()).toEqual([failure()])
  })

  it('ignores unparseable storage', () => {
    localStorage.setItem('blueplm.serverPathUpdateFailures', 'not json')

    expect(listServerPathUpdateFailures()).toEqual([])
  })

  it('clears', () => {
    recordServerPathUpdateFailure(failure())
    clearServerPathUpdateFailures()

    expect(listServerPathUpdateFailures()).toEqual([])
  })

  it('degrades to recording nothing when storage is unavailable', () => {
    vi.unstubAllGlobals()

    expect(() => recordServerPathUpdateFailure(failure())).not.toThrow()
    expect(listServerPathUpdateFailures()).toEqual([])
  })
})

describe('the batched toast', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('raises one toast for a folder whose files all failed for the same reason', async () => {
    const addToast = vi.fn()

    for (let i = 0; i < 50; i++) {
      noteServerPathUpdateFailure(failure({ recordId: `file-${i}` }), addToast)
    }

    expect(addToast).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(addToast).toHaveBeenCalledTimes(1)
    expect(addToast.mock.calls[0][0]).toBe('warning')
    expect(listServerPathUpdateFailures()).toHaveLength(50)
  })

  it('opens a new batch once the window has closed', async () => {
    const addToast = vi.fn()

    noteServerPathUpdateFailure(failure(), addToast)
    await vi.advanceTimersByTimeAsync(3_000)
    noteServerPathUpdateFailure(failure(), addToast)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(addToast).toHaveBeenCalledTimes(2)
  })
})
