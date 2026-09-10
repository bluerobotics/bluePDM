/**
 * The pre-flight decides what gets written to the `files` table, so every bucket is asserted here
 * rather than inferred from the command's behaviour. A file that reaches `eligible` by mistake is a
 * row written to the wrong path.
 */

import { describe, expect, it } from 'vitest'

import type { ServerFile } from '../../../stores/types'
import type { PDMFile } from '../../../types/pdm'
import type { LocalFile } from '../types'

import {
  classifyMovedFiles,
  groupHolders,
  type BlockedTarget,
} from './reconcileMovedPathsPreflight'

const ME = 'user-me'

interface MovedOptions {
  /** Path the server still records. Defaults to `old/${name}`. */
  serverPath?: string
  checkedOutBy?: string
  /** Given only when the checkout profile has been hydrated into the row. */
  holderName?: string | null
  holderEmail?: string
  serverHash?: string
  localHash?: string
  fileId?: string
}

/** A file sitting at `localPath` whose row still records `serverPath`. */
function moved(localPath: string, options: MovedOptions = {}): LocalFile {
  const name = localPath.split('/').pop()!
  const fileId = options.fileId ?? `row-${localPath}`

  const pdmData = {
    id: fileId,
    file_path: options.serverPath ?? `old/${name}`,
    file_name: name,
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
    pdmData,
  } as LocalFile
}

/** A file whose row already matches where it sits. */
function synced(localPath: string, fileId = `row-${localPath}`): LocalFile {
  const file = moved(localPath, { serverPath: localPath, fileId })
  return { ...file, diffStatus: undefined }
}

function serverRow(filePath: string, id = `row-${filePath}`): ServerFile {
  return {
    id,
    file_path: filePath,
    name: filePath.split('/').pop()!,
    extension: '.sldprt',
    content_hash: '',
  }
}

function classify(files: LocalFile[], serverFiles: ServerFile[] = []) {
  return classifyMovedFiles({ files, serverFiles, userId: ME })
}

describe('candidate selection', () => {
  it('takes a moved file whose row records a different path', () => {
    const result = classify([moved('new/part.sldprt')])

    expect(result.eligible.map((t) => t.localPath)).toEqual(['new/part.sldprt'])
    expect(result.eligible[0].serverPath).toBe('old/part.sldprt')
    expect(result.total).toBe(1)
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
   * Resumability. A row written by an earlier run keeps its `moved` badge until the next load, and
   * selecting on the badge alone would offer to write it again.
   */
  it('ignores a row already recorded at the path the file occupies', () => {
    const reconciled = moved('new/part.sldprt', { serverPath: 'new/part.sldprt' })

    expect(classify([reconciled]).total).toBe(0)
  })

  it('treats a path differing only in separators or case as already reconciled', () => {
    const backslashes = moved('New/Part.sldprt', { serverPath: 'new\\part.sldprt' })

    expect(classify([backslashes]).total).toBe(0)
  })
})

describe('blocked by another user', () => {
  it('blocks a row held by somebody else and names the holder', () => {
    const result = classify([
      moved('a/one.sldprt', { checkedOutBy: 'user-ana', holderName: 'Ana Ruiz' }),
    ])

    expect(result.eligible).toHaveLength(0)
    expect(result.blocked).toHaveLength(1)
    expect(result.holders).toEqual([{ holderId: 'user-ana', holderName: 'Ana Ruiz', count: 1 }])
  })

  it('does not block a row the acting user holds — move_file allows that one', () => {
    const result = classify([moved('a/one.sldprt', { checkedOutBy: ME })])

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
    const unnamed: BlockedTarget = {
      fileId: 'row-1',
      name: '1.sldprt',
      serverPath: 'old/1.sldprt',
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
  /**
   * Two loaded rows on one path is reachable on Windows through case alone, which is why every
   * comparison in the pre-flight is case-insensitive.
   */
  it('skips a move onto a path another loaded row already holds', () => {
    const target = moved('shared/part.sldprt', { fileId: 'row-moving' })
    const occupant = synced('shared/Part.sldprt', 'row-sitting')

    const result = classify([target, occupant])

    expect(result.eligible).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toMatchObject({ reason: 'conflict', occupiedBy: 'row-sitting' })
  })

  it('skips a move onto a path a server row holds with no local copy', () => {
    const target = moved('shared/part.sldprt', { fileId: 'row-moving' })

    const result = classify([target], [serverRow('shared/part.sldprt', 'row-cloud-only')])

    expect(result.skipped[0]).toMatchObject({ reason: 'conflict', occupiedBy: 'row-cloud-only' })
  })

  it('does not mistake the row’s own server record for an occupant', () => {
    const target = moved('new/part.sldprt', { fileId: 'row-moving' })

    // The row's own record is at the old path, and after the write it will be at the new one.
    const result = classify([target], [serverRow('old/part.sldprt', 'row-moving')])

    expect(result.eligible).toHaveLength(1)
  })

  it('catches two moved files targeting the same path', () => {
    // Only reachable through case, since one filesystem cannot hold both spellings at once.
    const first = moved('shared/Part.sldprt', { fileId: 'row-a' })
    const second = moved('shared/part.sldprt', { fileId: 'row-b' })

    const result = classify([first, second])

    expect(result.eligible).toHaveLength(0)
    expect(result.skipped.map((s) => s.reason)).toEqual(['conflict', 'conflict'])
  })
})

describe('hash verification guard', () => {
  it('skips a file whose content disagrees with what the server recorded', () => {
    const target = moved('new/part.sldprt', { serverHash: 'aaa', localHash: 'bbb' })

    const result = classify([target])

    expect(result.eligible).toHaveLength(0)
    expect(result.skipped[0]).toMatchObject({ reason: 'unverified' })
  })

  it('accepts a file whose hashes agree', () => {
    const target = moved('new/part.sldprt', { serverHash: 'aaa', localHash: 'aaa' })

    expect(classify([target]).eligible).toHaveLength(1)
  })

  it('accepts a file with no hash to compare, since there is nothing to contradict', () => {
    expect(classify([moved('new/part.sldprt', { serverHash: 'aaa' })]).eligible).toHaveLength(1)
    expect(classify([moved('new/other.sldprt', { localHash: 'bbb' })]).eligible).toHaveLength(1)
  })
})

describe('bucket precedence', () => {
  /**
   * A held row is reported as held even when it also conflicts. The operator's next action is to
   * ask the holder, and a conflict line would send them somewhere else.
   */
  it('reports a row that is both held and conflicting as blocked', () => {
    const target = moved('shared/part.sldprt', {
      fileId: 'row-moving',
      checkedOutBy: 'user-ana',
      holderName: 'Ana Ruiz',
    })

    const result = classify([target], [serverRow('shared/part.sldprt', 'row-sitting')])

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
