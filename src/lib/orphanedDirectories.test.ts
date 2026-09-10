import { describe, expect, it } from 'vitest'

import { getOrphanedDirectoryCandidates } from './orphanedDirectories'

const VAULT = 'C:\\Vaults\\main'

describe('getOrphanedDirectoryCandidates', () => {
  it('nominates every ancestor of a successfully-deleted file, excluding the vault root', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['a/b/c.sldprt'],
      keptRelativePaths: [],
      serverFolderPaths: new Set(),
      vaultPath: VAULT,
    })

    expect(result).toEqual([`${VAULT}\\a\\b`, `${VAULT}\\a`])
  })

  it('never nominates the vault root itself', () => {
    // A top-level file has no ancestor directories at all.
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['root.sldprt'],
      keptRelativePaths: [],
      serverFolderPaths: new Set(),
      vaultPath: VAULT,
    })

    expect(result).toEqual([])
  })

  it('returns nothing when the vault path is empty', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['a/b.sldprt'],
      keptRelativePaths: [],
      serverFolderPaths: new Set(),
      vaultPath: '',
    })

    expect(result).toEqual([])
  })

  it('sorts deepest-first by segment count, then by string length as a tie-break', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['a/b/c/d.sldprt', 'a/longer-sibling/e.sldprt'],
      keptRelativePaths: [],
      serverFolderPaths: new Set(),
      vaultPath: VAULT,
    })

    // 'a/b/c' (3 segments) sorts before 'a/longer-sibling' and 'a/b' (both 2 segments,
    // longer-sibling sorts first as the tie-break), all of which sort before 'a' (1
    // segment).
    expect(result).toEqual([
      `${VAULT}\\a\\b\\c`,
      `${VAULT}\\a\\longer-sibling`,
      `${VAULT}\\a\\b`,
      `${VAULT}\\a`,
    ])
  })

  it('drops a candidate that is the directory of a kept file', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['a/b/gone.sldprt'],
      keptRelativePaths: ['a/b/locked.sldprt'],
      serverFolderPaths: new Set(),
      vaultPath: VAULT,
    })

    // 'a/b' holds a kept file, so it - and its ancestor 'a' - must not be offered.
    expect(result).toEqual([])
  })

  it('drops only the ancestor chain of the kept file, leaving an unrelated branch alone', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['a/b/gone.sldprt', 'a/other/gone2.sldprt'],
      keptRelativePaths: ['a/b/locked.sldprt'],
      serverFolderPaths: new Set(),
      vaultPath: VAULT,
    })

    // 'a/b' is dropped (holds the kept file); 'a' is also dropped because it is an
    // ancestor of the kept file's directory. 'a/other' survives - nothing kept lives
    // under it.
    expect(result).toEqual([`${VAULT}\\a\\other`])
  })

  it('does not drop a sibling directory that merely shares a name prefix with the kept directory', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['Fixed Lens Models/gone.sldprt'],
      keptRelativePaths: ['Fixed Lens/locked.sldprt'],
      serverFolderPaths: new Set(),
      vaultPath: VAULT,
    })

    expect(result).toEqual([`${VAULT}\\Fixed Lens Models`])
  })

  it('drops a candidate still present in serverFolderPaths', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['a/b/gone.sldprt'],
      keptRelativePaths: [],
      serverFolderPaths: new Set(['a/b']),
      vaultPath: VAULT,
    })

    // 'a/b' is still asserted by the server (an empty folder there, say), so only 'a'
    // - which is not - remains a candidate.
    expect(result).toEqual([`${VAULT}\\a`])
  })

  it('matches serverFolderPaths case-insensitively', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['A/B/gone.sldprt'],
      keptRelativePaths: [],
      serverFolderPaths: new Set(['a/b']),
      vaultPath: VAULT,
    })

    expect(result).toEqual([`${VAULT}\\A`])
  })

  it('matches a kept file directory case-insensitively', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['A/B/gone.sldprt'],
      keptRelativePaths: ['a/b/LOCKED.sldprt'],
      serverFolderPaths: new Set(),
      vaultPath: VAULT,
    })

    expect(result).toEqual([])
  })

  it('handles backslash-separated relative paths the same as forward-slash ones', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['a\\b\\gone.sldprt'],
      keptRelativePaths: [],
      serverFolderPaths: new Set(),
      vaultPath: VAULT,
    })

    expect(result).toEqual([`${VAULT}\\a\\b`, `${VAULT}\\a`])
  })

  it('returns an empty list when nothing succeeded', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: [],
      keptRelativePaths: ['a/b/locked.sldprt'],
      serverFolderPaths: new Set(),
      vaultPath: VAULT,
    })

    expect(result).toEqual([])
  })

  it('deduplicates a directory shared by two successfully-deleted files', () => {
    const result = getOrphanedDirectoryCandidates({
      succeededRelativePaths: ['a/one.sldprt', 'a/two.sldprt'],
      keptRelativePaths: [],
      serverFolderPaths: new Set(),
      vaultPath: VAULT,
    })

    expect(result).toEqual([`${VAULT}\\a`])
  })
})
