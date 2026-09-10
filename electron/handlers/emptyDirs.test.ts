import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

// `vi.mock('electron', ...)` is hoisted above these imports by vitest, so anything it
// references must come from `vi.hoisted` rather than a plain module-level `const`.
const { trashItemMock, ipcHandlers } = vi.hoisted(() => ({
  trashItemMock: vi.fn(async (_targetPath: string): Promise<void> => {}),
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
  },
  shell: {
    trashItem: trashItemMock,
  },
}))

import {
  decideEmptyDirRemoval,
  isStrictlyWithinDirectory,
  registerEmptyDirHandlers,
  sortDeepestFirst,
  type EmptyDirHandlerDependencies,
  type TrashEmptyDirsResponse,
} from './emptyDirs'

const currentDir = path.dirname(fileURLToPath(import.meta.url))

function makeDeps(root: string): EmptyDirHandlerDependencies {
  return {
    getWorkingDirectory: () => root,
    stopWatcher: vi.fn(async () => {}),
    startWatcher: vi.fn(async () => {}),
    forgetScanCacheEntry: vi.fn(),
    log: vi.fn(),
  }
}

async function invoke(paths: string[]): Promise<TrashEmptyDirsResponse> {
  const handler = ipcHandlers.get('fs:trash-empty-dirs')
  if (!handler) throw new Error('fs:trash-empty-dirs was never registered')
  return handler(null, paths) as Promise<TrashEmptyDirsResponse>
}

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blueplm-emptydirs-'))
  trashItemMock.mockReset()
  // The production `shell.trashItem` removes the directory from disk once it moves
  // it to the Recycle Bin. Simulating that (rather than leaving the real filesystem
  // untouched) is what lets the "nested empty directories" test prove the parent is
  // re-stat'd *after* the child is actually gone, instead of from a stale read.
  trashItemMock.mockImplementation(async (targetPath: string) => {
    fs.rmdirSync(targetPath)
  })
  ipcHandlers.clear()
  registerEmptyDirHandlers(makeDeps(tmpRoot))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('fs:trash-empty-dirs handler', () => {
  it('never removes a directory containing an untracked file', async () => {
    const dir = path.join(tmpRoot, 'folder')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello')

    const result = await invoke([dir])

    expect(trashItemMock).not.toHaveBeenCalled()
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true)
    expect(result.results[0]).toMatchObject({ path: dir, success: false, skipped: true })
    expect(result.summary).toMatchObject({ total: 1, succeeded: 0, failed: 1, skipped: 1 })
  })

  // These are exactly the files `isIgnoredVaultPath` (fsWatcher.ts) hides from the
  // renderer's model, which is why a filtered "looks empty to BluePLM" check would be
  // unsafe here and an unfiltered `readdirSync` is used instead.
  it.each([['~$lock.sldprt'], ['.hidden'], ['desktop.ini']])(
    'never removes a directory containing only %s',
    async (fileName) => {
      const dir = path.join(tmpRoot, 'folder')
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, fileName), 'x')

      await invoke([dir])

      expect(trashItemMock).not.toHaveBeenCalled()
      expect(fs.existsSync(dir)).toBe(true)
      expect(fs.existsSync(path.join(dir, fileName))).toBe(true)
    },
  )

  it('removes nested empty directories deepest-first', async () => {
    const parent = path.join(tmpRoot, 'a')
    const child = path.join(parent, 'b')
    fs.mkdirSync(child, { recursive: true })

    // Passed in parent-first order on purpose, to prove the handler re-orders rather
    // than relying on caller order.
    const result = await invoke([parent, child])

    expect(trashItemMock.mock.calls.map(([calledPath]) => calledPath)).toEqual([child, parent])
    expect(fs.existsSync(child)).toBe(false)
    expect(fs.existsSync(parent)).toBe(false)
    expect(result.summary).toMatchObject({ total: 2, succeeded: 2, failed: 0, skipped: 0 })
  })

  it('reports a trashItem rejection as skipped and leaves the directory on disk', async () => {
    const dir = path.join(tmpRoot, 'locked')
    fs.mkdirSync(dir)
    trashItemMock.mockImplementation(async () => {
      throw new Error('EBUSY: resource busy or locked')
    })

    const result = await invoke([dir])

    expect(fs.existsSync(dir)).toBe(true)
    expect(result.results[0]).toMatchObject({ path: dir, success: false, skipped: true })
    expect(result.results[0].error).toContain('EBUSY')
  })

  it('refuses to remove the working directory itself', async () => {
    const result = await invoke([tmpRoot])

    expect(trashItemMock).not.toHaveBeenCalled()
    expect(fs.existsSync(tmpRoot)).toBe(true)
    expect(result.results[0]).toMatchObject({ path: tmpRoot, success: false, skipped: true })
  })

  it('refuses a path outside the working directory', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'blueplm-emptydirs-outside-'))
    try {
      const result = await invoke([outside])

      expect(trashItemMock).not.toHaveBeenCalled()
      expect(fs.existsSync(outside)).toBe(true)
      expect(result.results[0]).toMatchObject({ path: outside, success: false, skipped: true })
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('treats an already-absent path as success, not a skip', async () => {
    const gone = path.join(tmpRoot, 'never-existed')

    const result = await invoke([gone])

    expect(trashItemMock).not.toHaveBeenCalled()
    expect(result.results[0]).toEqual({ path: gone, success: true })
  })

  it('never calls a permanent filesystem delete anywhere in this module', () => {
    const source = fs.readFileSync(path.join(currentDir, 'emptyDirs.ts'), 'utf-8')
    expect(source).not.toMatch(/\brmSync\s*\(/)
    expect(source).not.toMatch(/\brmdirSync\s*\(/)
    expect(source).not.toMatch(/\bunlinkSync\s*\(/)
  })
})

describe('sortDeepestFirst', () => {
  it('orders the deepest path first, regardless of input order', () => {
    expect(sortDeepestFirst(['/vault/a', '/vault/a/b/c', '/vault/a/b'])).toEqual([
      '/vault/a/b/c',
      '/vault/a/b',
      '/vault/a',
    ])
  })

  it('breaks a tie in depth by longer string first', () => {
    expect(sortDeepestFirst(['/vault/aa', '/vault/a'])).toEqual(['/vault/aa', '/vault/a'])
  })
})

describe('isStrictlyWithinDirectory', () => {
  it('accepts a path nested inside the root', () => {
    expect(isStrictlyWithinDirectory(path.join(tmpRoot, 'x', 'y'), tmpRoot)).toBe(true)
  })

  it('rejects the root itself', () => {
    expect(isStrictlyWithinDirectory(tmpRoot, tmpRoot)).toBe(false)
  })

  it('rejects a sibling directory that merely shares a prefix', () => {
    expect(isStrictlyWithinDirectory(`${tmpRoot}-sibling`, tmpRoot)).toBe(false)
  })

  it('rejects an ancestor of the root', () => {
    expect(isStrictlyWithinDirectory(path.dirname(tmpRoot), tmpRoot)).toBe(false)
  })
})

describe('decideEmptyDirRemoval', () => {
  it('treats an absent path as already gone, not a skip', () => {
    expect(decideEmptyDirRemoval({ exists: false, isDirectory: false, entryCount: 0 })).toEqual({
      outcome: 'alreadyGone',
    })
  })

  it('refuses a file where a directory was expected', () => {
    expect(decideEmptyDirRemoval({ exists: true, isDirectory: false, entryCount: 0 })).toEqual({
      outcome: 'skip',
      reason: 'not-a-directory',
    })
  })

  it('refuses a non-empty directory', () => {
    expect(decideEmptyDirRemoval({ exists: true, isDirectory: true, entryCount: 3 })).toEqual({
      outcome: 'skip',
      reason: 'not-empty',
    })
  })

  it('allows removal of a genuinely empty directory', () => {
    expect(decideEmptyDirRemoval({ exists: true, isDirectory: true, entryCount: 0 })).toEqual({
      outcome: 'remove',
    })
  })
})
