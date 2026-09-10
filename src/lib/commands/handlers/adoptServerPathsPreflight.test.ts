/**
 * The pre-flight decides what gets renamed on disk, so every bucket is asserted here rather than
 * inferred from the command's behaviour. A file that reaches `eligible` by mistake is a file
 * renamed onto the wrong path.
 */

import { describe, expect, it } from 'vitest'

import type { PDMFile } from '../../../types/pdm'
import type { LocalFile } from '../types'

import { classifyAdoptTargets, groupHolders, type BlockedAdoptTarget } from './adoptServerPathsPreflight'

const ME = 'user-me'

interface MovedOptions {
  /** Path the server records. Defaults to `server/${name}`. */
  serverPath?: string
  serverName?: string
  checkedOutBy?: string
  /** Given only when the checkout profile has been hydrated into the row. */
  holderName?: string | null
  holderEmail?: string
  serverHash?: string
  localHash?: string
  fileId?: string
  ino?: number
}

/** A file sitting at `localPath` whose row records `serverPath` instead. */
function moved(localPath: string, options: MovedOptions = {}): LocalFile {
  const name = localPath.split('/').pop()!
  const fileId = options.fileId ?? `row-${localPath}`
  const serverPath = options.serverPath ?? `server/${name}`

  const pdmData = {
    id: fileId,
    file_path: serverPath,
    file_name: options.serverName ?? serverPath.split('/').pop(),
    content_hash: options.serverHash ?? null,
    checked_out_by: options.checkedOutBy ?? null,
    checked_out_user:
      options.checkedOutBy && (options.holderName !== undefined || options.holderEmail)
        ? {
            id: options.checkedOutBy,
            email: options.holderEmail ?? `${options.checkedOutBy}@example.com`,
            full_name: options.holderName ?? null,
            avatar_url: null,
          }
        : null,
  } as unknown as PDMFile

  return {
    name,
    path: `C:/vault/${localPath}`,
    relativePath: localPath,
    isDirectory: false,
    diffStatus: 'moved',
    localHash: options.localHash,
    ino: options.ino,
    pdmData,
  } as LocalFile
}

/** A file whose row already matches where it sits. */
function synced(localPath: string, fileId = `row-${localPath}`): LocalFile {
  const file = moved(localPath, { serverPath: localPath, fileId })
  return { ...file, diffStatus: undefined }
}

function classify(files: LocalFile[]) {
  return classifyAdoptTargets({ files, userId: ME })
}

describe('candidate selection', () => {
  it('takes a moved file whose row records a different path', () => {
    const result = classify([moved('local/part.sldprt')])

    expect(result.eligible.map((t) => t.serverPath)).toEqual(['server/part.sldprt'])
    expect(result.eligible[0].localPath).toBe('local/part.sldprt')
    expect(result.total).toBe(1)
  })

  it('uses the server-recorded name, not the local one, as the rename target', () => {
    const result = classify([moved('local/old-name.sldprt', { serverName: 'new-name.sldprt' })])

    expect(result.eligible[0].name).toBe('new-name.sldprt')
  })

  it('ignores files that are not marked moved', () => {
    expect(classify([synced('a/part.sldprt')]).total).toBe(0)
  })

  it('ignores directories and rows with no server record', () => {
    const folder = { ...moved('a'), isDirectory: true } as LocalFile
    const unsynced = { ...moved('b/part.sldprt'), pdmData: undefined } as LocalFile

    expect(classify([folder, unsynced]).total).toBe(0)
  })

  /**
   * Resumability. A row an earlier run already adopted keeps its `moved` badge until the next
   * load, and selecting on the badge alone would offer to rename it again.
   */
  it('ignores a row already sitting at the path the server records', () => {
    const reconciled = moved('server/part.sldprt', { serverPath: 'server/part.sldprt' })

    expect(classify([reconciled]).total).toBe(0)
  })

  it('treats a path differing only in separators or case as already adopted', () => {
    const backslashes = moved('Server/Part.sldprt', { serverPath: 'server\\part.sldprt' })

    expect(classify([backslashes]).total).toBe(0)
  })
})

describe('blocked by another user', () => {
  it('blocks a row held by somebody else and names the holder', () => {
    const result = classify([
      moved('local/one.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
    ])

    expect(result.eligible).toHaveLength(0)
    expect(result.blocked).toHaveLength(1)
    expect(result.holders).toEqual([{ holderId: 'user-ana', holderName: 'Ana Ruiz', count: 1 }])
  })

  it('does not block a row the acting user holds — the rename only touches their own disk', () => {
    const result = classify([moved('local/one.sldprt', { checkedOutBy: ME })])

    expect(result.blocked).toHaveLength(0)
    expect(result.eligible).toHaveLength(1)
  })

  it('groups holders by user rather than by file, biggest holder first', () => {
    const result = classify([
      moved('a/1.sldprt', { checkedOutBy: 'user-sam', holderName: 'Sam Lee' }),
      moved('a/2.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('a/3.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
      moved('a/4.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
    ])

    expect(result.blocked).toHaveLength(4)
    expect(result.holders).toEqual([
      { holderId: 'user-ana', holderName: 'Ana Ruiz', count: 3 },
      { holderId: 'user-sam', holderName: 'Sam Lee', count: 1 },
    ])
  })

  it('reports a holder whose profile was never hydrated as unnamed rather than dropping them', () => {
    const result = classify([moved('a/one.sldprt', { checkedOutBy: 'user-ana' })])

    expect(result.blocked).toHaveLength(1)
    expect(result.holders).toEqual([{ holderId: 'user-ana', holderName: null, count: 1 }])
  })

  it('falls back to the holder’s email when the profile carries no name', () => {
    const result = classify([
      moved('a/one.sldprt', {
        checkedOutBy: 'user-ana',
        holderName: null,
        holderEmail: 'ana@example.com',
      }),
    ])

    expect(result.holders).toEqual([
      { holderId: 'user-ana', holderName: 'ana@example.com', count: 1 },
    ])
  })

  it('takes a name from whichever of a holder’s rows carries one', () => {
    const unnamed: BlockedAdoptTarget = {
      fileId: 'row-1',
      name: '1.sldprt',
      serverPath: 'server/1.sldprt',
      localPath: 'a/1.sldprt',
      path: 'C:/vault/a/1.sldprt',
      holderId: 'user-ana',
      holderName: null,
    }

    expect(
      groupHolders([unnamed, { ...unnamed, fileId: 'row-2', holderName: 'Ana Ruiz' }]),
    ).toEqual([{ holderId: 'user-ana', holderName: 'Ana Ruiz', count: 2 }])
  })
})

describe('destination-occupied guard', () => {
  it('skips a rename onto a path another loaded row already occupies on disk', () => {
    const target = moved('local/part.sldprt', { fileId: 'row-moving', serverPath: 'shared/part.sldprt' })
    const occupant = synced('shared/part.sldprt', 'row-sitting')

    const result = classify([target, occupant])

    expect(result.eligible).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toMatchObject({ reason: 'conflict', occupiedBy: 'row-sitting' })
  })

  it('flags an untracked stray file at the destination as an occupant too', () => {
    const target = moved('local/part.sldprt', { fileId: 'row-moving', serverPath: 'shared/part.sldprt' })
    // A file with no server record at all - the auto-created-folder stale-copy case.
    const stray: LocalFile = {
      name: 'part.sldprt',
      path: 'C:/vault/shared/part.sldprt',
      relativePath: 'shared/part.sldprt',
      isDirectory: false,
    } as LocalFile

    const result = classify([target, stray])

    expect(result.eligible).toHaveLength(0)
    expect(result.skipped[0]).toMatchObject({
      reason: 'conflict',
      occupiedBy: 'shared/part.sldprt',
    })
  })

  it('does not mistake the row’s own destination for an occupant', () => {
    // Nothing else sits at the destination; the row being classified never appears there itself
    // since its local entry is at its *current* path, not its target.
    const target = moved('local/part.sldprt', { fileId: 'row-moving', serverPath: 'server/part.sldprt' })

    const result = classify([target])

    expect(result.eligible).toHaveLength(1)
  })
})

describe('hash verification guard', () => {
  it('skips a file whose content disagrees with what the server recorded', () => {
    const target = moved('local/part.sldprt', { serverHash: 'aaa', localHash: 'bbb' })

    const result = classify([target])

    expect(result.eligible).toHaveLength(0)
    expect(result.skipped[0]).toMatchObject({ reason: 'unverified' })
  })

  it('accepts a file whose hashes agree', () => {
    const target = moved('local/part.sldprt', { serverHash: 'aaa', localHash: 'aaa' })

    expect(classify([target]).eligible).toHaveLength(1)
  })

  /**
   * The common case for this command: the hash pass that would populate `localHash` never ran
   * for a file the merge renders only at its local path, so most real candidates carry no hash
   * at all. There is nothing to contradict, so they are accepted.
   */
  it('accepts a file with no hash to compare, since there is nothing to contradict', () => {
    expect(classify([moved('local/part.sldprt', { serverHash: 'aaa' })]).eligible).toHaveLength(1)
    expect(classify([moved('local/other.sldprt', { localHash: 'bbb' })]).eligible).toHaveLength(1)
    expect(classify([moved('local/neither.sldprt')]).eligible).toHaveLength(1)
  })
})

describe('bucket precedence', () => {
  /**
   * A held row is reported as held even when it also conflicts. The operator's next action is to
   * ask the holder, and a conflict line would send them somewhere else.
   */
  it('reports a row that is both held and conflicting as blocked', () => {
    const target = moved('local/part.sldprt', {
      fileId: 'row-moving',
      serverPath: 'shared/part.sldprt',
      checkedOutBy: 'user-ana',
      holderName: 'Ana Ruiz',
    })
    const occupant = synced('shared/part.sldprt', 'row-sitting')

    const result = classify([target, occupant])

    expect(result.blocked).toHaveLength(1)
    expect(result.skipped).toHaveLength(0)
  })

  it('counts every candidate exactly once across the buckets', () => {
    const result = classify([
      moved('a/eligible.sldprt'),
      moved('a/held.sldprt', { checkedOutBy: 'user-ana' }),
      moved('a/unverified.sldprt', { serverHash: 'aaa', localHash: 'bbb' }),
    ])

    expect(result.total).toBe(3)
    expect(result.eligible).toHaveLength(1)
    expect(result.blocked).toHaveLength(1)
    expect(result.skipped).toHaveLength(1)
  })
})

describe('fields carried through for the rename and the sync-index re-key', () => {
  it('carries the inode, local version and local hash onto the target', () => {
    const target = moved('local/part.sldprt', { ino: 42, localHash: 'aaa', serverHash: 'aaa' })
    target.localVersion = 3

    const result = classify([target])

    expect(result.eligible[0]).toMatchObject({ ino: 42, localVersion: 3, localHash: 'aaa' })
  })
})
