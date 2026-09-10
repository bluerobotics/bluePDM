import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CachedServerFile } from './vaultFileCache'

// getFilesDelta / getVaultFilesCount are the only runtime imports vaultFileCache.ts pulls from
// this module (LightweightFile/DeltaFile are types, erased at compile time), so this mock is a
// complete replacement.
vi.mock('@/lib/supabase/files/queries', () => ({
  getFilesDelta: vi.fn(),
  getVaultFilesCount: vi.fn(),
}))

const ORG_ID = 'org-a'
const VAULT_ID = 'vault-a'

function file(id: string): CachedServerFile {
  return {
    id,
    file_path: `designs/${id}.sldprt`,
    file_name: `${id}.sldprt`,
    extension: '.sldprt',
    file_type: 'part',
    part_number: null,
    description: null,
    revision: null,
    version: 1,
    content_hash: `hash-${id}`,
    file_size: 100,
    state: 'In Work',
    checked_out_by: null,
    checked_out_at: null,
    updated_at: '2026-08-10T17:00:00.000Z',
    custom_properties: null,
    checked_out_file_path: null,
    checked_out_file_name: null,
  }
}

function files(count: number, prefix = 'file'): CachedServerFile[] {
  return Array.from({ length: count }, (_, index) => file(`${prefix}-${index}`))
}

/**
 * Minimal in-memory IndexedDB fake covering only the operations vaultFileCache.ts uses:
 * open/onupgradeneeded/onsuccess, a single object store keyed by 'vaultId', and
 * get/put/delete/clear. vitest's environment is 'node', so there is no real indexedDB.
 */
function installFakeIndexedDB() {
  const stores = new Map<string, Map<string, unknown>>()
  const keyPaths = new Map<string, string>()

  class FakeRequest {
    result: unknown
    error: unknown = null
    onsuccess: (() => void) | null = null
    onerror: (() => void) | null = null
  }

  function succeed(request: FakeRequest, result: unknown) {
    request.result = result
    queueMicrotask(() => request.onsuccess?.())
  }

  class FakeStore {
    constructor(
      private readonly data: Map<string, unknown>,
      private readonly keyPath: string,
    ) {}
    createIndex() {
      // Not queried anywhere in vaultFileCache.ts - safe to no-op.
    }
    get(key: string) {
      const request = new FakeRequest()
      queueMicrotask(() => succeed(request, this.data.get(key)))
      return request
    }
    put(value: Record<string, unknown>) {
      const request = new FakeRequest()
      this.data.set(String(value[this.keyPath]), value)
      queueMicrotask(() => succeed(request, undefined))
      return request
    }
    delete(key: string) {
      const request = new FakeRequest()
      this.data.delete(key)
      queueMicrotask(() => succeed(request, undefined))
      return request
    }
    clear() {
      const request = new FakeRequest()
      this.data.clear()
      queueMicrotask(() => succeed(request, undefined))
      return request
    }
  }

  const fakeDb = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    deleteObjectStore(name: string) {
      stores.delete(name)
      keyPaths.delete(name)
    },
    createObjectStore(name: string, options: { keyPath: string }) {
      stores.set(name, new Map())
      keyPaths.set(name, options.keyPath)
      return { createIndex: () => {} }
    },
    transaction(name: string) {
      return {
        objectStore: () => new FakeStore(stores.get(name)!, keyPaths.get(name)!),
        abort: () => {},
      }
    },
  }

  ;(globalThis as { indexedDB?: unknown }).indexedDB = {
    open() {
      const request = new FakeRequest()
      queueMicrotask(() => {
        request.result = fakeDb
        ;(request as unknown as { onupgradeneeded?: (event: unknown) => void }).onupgradeneeded?.({
          target: { result: fakeDb },
        })
        request.onsuccess?.()
      })
      return request
    },
  }
}

/** Flushes the queueMicrotask chains the fake IndexedDB and cache write queue use. */
async function flush() {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('getFilesWithCache count reconciliation', () => {
  let getFilesDelta: ReturnType<typeof vi.fn>
  let getVaultFilesCount: ReturnType<typeof vi.fn>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cacheModule: any // TODO: type this - dynamically re-imported per test after vi.resetModules()

  beforeEach(async () => {
    vi.resetModules()
    installFakeIndexedDB()

    const queries = await import('@/lib/supabase/files/queries')
    getFilesDelta = queries.getFilesDelta as ReturnType<typeof vi.fn>
    getVaultFilesCount = queries.getVaultFilesCount as ReturnType<typeof vi.fn>
    getFilesDelta.mockReset()
    getVaultFilesCount.mockReset()

    cacheModule = await import('./vaultFileCache')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('forces a full refetch and rebuilds the cache when the merged count disagrees with the server', async () => {
    const cached = files(3, 'cached')
    await cacheModule.setCachedVaultFiles(ORG_ID, VAULT_ID, cached)
    await flush()

    getFilesDelta.mockResolvedValue({ files: [], error: null })
    getVaultFilesCount.mockResolvedValue({ count: 5, error: null }) // 3 cached, 5 on server

    const fresh = files(5, 'fresh')
    const fetchFullFn = vi.fn().mockResolvedValue({ files: fresh, error: null })

    const result = await cacheModule.getFilesWithCache(ORG_ID, VAULT_ID, fetchFullFn)

    expect(fetchFullFn).toHaveBeenCalledTimes(1)
    expect(result.cacheHit).toBe(false)
    expect(result.files).toHaveLength(5)

    await flush()
    const rebuilt = await cacheModule.getCachedVaultFiles(ORG_ID, VAULT_ID)
    expect(rebuilt?.files).toHaveLength(5)
  })

  it('suppresses an immediate second forced refetch via the per-vault cooldown', async () => {
    await cacheModule.setCachedVaultFiles(ORG_ID, VAULT_ID, files(3, 'cached'))
    await flush()

    // Server count never matches the merged cache, so every call would force a refetch
    // if not for the cooldown.
    getFilesDelta.mockResolvedValue({ files: [], error: null })
    getVaultFilesCount.mockResolvedValue({ count: 999, error: null })

    const fetchFullFn = vi.fn().mockResolvedValue({ files: files(10, 'full'), error: null })

    const first = await cacheModule.getFilesWithCache(ORG_ID, VAULT_ID, fetchFullFn)
    expect(fetchFullFn).toHaveBeenCalledTimes(1)
    expect(first.cacheHit).toBe(false)

    await flush() // let the rebuilt cache write land before the second call reads it

    const second = await cacheModule.getFilesWithCache(ORG_ID, VAULT_ID, fetchFullFn)

    // Cooldown suppressed the forced refetch: still exactly one call, and this load
    // fell through to the normal cache-hit path instead.
    expect(fetchFullFn).toHaveBeenCalledTimes(1)
    expect(second.cacheHit).toBe(true)
  })

  it('skips the reconciliation check and preserves existing behavior when the count fails', async () => {
    const cached = files(3, 'cached')
    await cacheModule.setCachedVaultFiles(ORG_ID, VAULT_ID, cached)
    await flush()

    getFilesDelta.mockResolvedValue({ files: [], error: null })
    getVaultFilesCount.mockResolvedValue({ count: null, error: new Error('rpc failed') })

    const fetchFullFn = vi.fn().mockResolvedValue({ files: files(99, 'unused'), error: null })

    const result = await cacheModule.getFilesWithCache(ORG_ID, VAULT_ID, fetchFullFn)

    expect(fetchFullFn).not.toHaveBeenCalled()
    expect(result.cacheHit).toBe(true)
    expect(result.files).toHaveLength(3)
  })
})
