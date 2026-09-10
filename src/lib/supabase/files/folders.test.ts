/**
 * Finding the folder that is already there.
 *
 * Schema 99 makes `idx_folders_unique_active` unique on `(vault_id,
 * LOWER(folder_path))`, which turns a byte-exact existence check into a silent
 * failure rather than a duplicate row: syncing `Radcam` while `RADCAM` is
 * stored no longer inserts a second row, it raises 23505, and a byte-exact
 * re-fetch then finds nothing and reports success with no folder.
 *
 * The fake client below is not a stub that records arguments - it implements
 * LIKE's own semantics (`%`, `_`, backslash escapes, case-insensitive) and the
 * partial unique index, so these tests fail if the escaping is wrong rather
 * than if the call shape changes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FolderRow {
  id: string
  org_id: string
  vault_id: string
  folder_path: string
  created_by: string | null
  created_at: string
  deleted_at: string | null
  deleted_by: string | null
}

interface QueryError {
  code?: string
  message: string
}

type SelectResult = { data: FolderRow[]; error: QueryError | null }

type InsertResult = { data: FolderRow | null; error: QueryError | null }

type FolderValues = Pick<FolderRow, 'org_id' | 'vault_id' | 'folder_path' | 'created_by'>

const ORG = '00000000-0000-0000-0000-000000000001'
const VAULT = '00000000-0000-0000-0000-000000000002'
const USER = '00000000-0000-0000-0000-000000000003'

let table: FolderRow[] = []
/** Makes the next insert raise 23505 with nothing in the table to find. */
let phantomConflict = false
/** A row another client commits between our existence check and our insert. */
let concurrentInsert: FolderRow | null = null
const logged: Array<{ level: string; message: string; data?: unknown }> = []

/**
 * Translate a LIKE pattern into the equivalent regular expression, honouring
 * backslash as the escape character exactly as PostgreSQL does. An escaped `_`
 * matches an underscore; an unescaped one matches any single character.
 */
function likeToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '\\') {
      index += 1
      source += (pattern[index] ?? '\\').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    } else if (char === '%') {
      source += '[\\s\\S]*'
    } else if (char === '_') {
      source += '[\\s\\S]'
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`, 'i')
}

class SelectQuery {
  private predicates: Array<(row: FolderRow) => boolean> = []
  private orderBy: Array<{ column: keyof FolderRow; ascending: boolean }> = []
  private rowLimit: number | null = null

  eq(column: keyof FolderRow, value: string): this {
    this.predicates.push((row) => row[column] === value)
    return this
  }

  ilike(column: keyof FolderRow, pattern: string): this {
    const matcher = likeToRegExp(pattern)
    this.predicates.push((row) => matcher.test(String(row[column] ?? '')))
    return this
  }

  is(column: keyof FolderRow, value: null): this {
    this.predicates.push((row) => row[column] === value)
    return this
  }

  order(column: keyof FolderRow, options?: { ascending?: boolean }): this {
    this.orderBy.push({ column, ascending: options?.ascending !== false })
    return this
  }

  limit(count: number): this {
    this.rowLimit = count
    return this
  }

  private run(): Promise<SelectResult> {
    let rows = table.filter((row) => this.predicates.every((predicate) => predicate(row)))
    if (this.orderBy.length > 0) {
      rows = [...rows].sort((left, right) => {
        for (const { column, ascending } of this.orderBy) {
          const leftValue = String(left[column] ?? '')
          const rightValue = String(right[column] ?? '')
          if (leftValue !== rightValue) {
            return (leftValue < rightValue ? -1 : 1) * (ascending ? 1 : -1)
          }
        }
        return 0
      })
    }
    if (this.rowLimit !== null) rows = rows.slice(0, this.rowLimit)
    return Promise.resolve({ data: rows, error: null })
  }

  then<TResult1 = SelectResult, TResult2 = never>(
    onFulfilled?: ((value: SelectResult) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onFulfilled, onRejected)
  }
}

class InsertQuery {
  constructor(private values: FolderValues) {}

  select(): this {
    return this
  }

  /** The insert PostgREST would perform, under the schema 99 unique index. */
  async single(): Promise<InsertResult> {
    if (concurrentInsert) {
      table.push(concurrentInsert)
      concurrentInsert = null
    }
    const collides = table.some(
      (row) =>
        row.vault_id === this.values.vault_id &&
        row.deleted_at === null &&
        row.folder_path.toLowerCase() === this.values.folder_path.toLowerCase(),
    )
    if (collides || phantomConflict) {
      phantomConflict = false
      return {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "idx_folders_unique_active"',
        },
      }
    }
    const inserted: FolderRow = {
      id: `id-${table.length + 1}`,
      created_at: `2026-09-09T00:00:0${table.length}.000Z`,
      deleted_at: null,
      deleted_by: null,
      ...this.values,
    }
    table.push(inserted)
    return { data: inserted, error: null }
  }
}

const fakeClient = {
  from(name: string) {
    expect(name).toBe('folders')
    return {
      select: () => new SelectQuery(),
      insert: (values: FolderValues) => new InsertQuery(values),
    }
  },
}

vi.mock('../client', () => ({
  getSupabaseClient: () => fakeClient,
}))

const { syncFolder } = await import('./folders')

/** A row as an older database holds it, before the dedupe kept one spelling. */
function existingFolder(folderPath: string, overrides: Partial<FolderRow> = {}): FolderRow {
  return {
    id: `id-${folderPath.toLowerCase()}`,
    org_id: ORG,
    vault_id: VAULT,
    folder_path: folderPath,
    created_by: USER,
    created_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  }
}

function warnings(): Array<{ message: string; data?: unknown }> {
  return logged.filter((entry) => entry.level === 'warn')
}

beforeEach(() => {
  table = []
  phantomConflict = false
  concurrentInsert = null
  logged.length = 0
  // syncFolder logs through window.electronAPI when it is there; the test
  // environment is node, so it has to be supplied to read the warn back.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        log: (level: string, message: string, data?: unknown) => {
          logged.push({ level, message, data })
        },
      },
    },
  })
})

describe('syncing a folder whose stored spelling differs by case', () => {
  it('returns the existing row instead of inserting a second one', async () => {
    table.push(existingFolder('RADCAM'))

    const result = await syncFolder(ORG, VAULT, USER, 'Radcam')

    expect(result.error).toBeNull()
    expect(result.folder?.id).toBe('id-radcam')
    expect(result.folder?.folder_path).toBe('RADCAM')
    expect(table).toHaveLength(1)
  })

  it('matches the ancestors it walks, not only the leaf', async () => {
    // syncFolder syncs every parent path, so a case-differing ancestor used to
    // fail on each sync of anything beneath it.
    table.push(existingFolder('RADCAM'))

    const result = await syncFolder(ORG, VAULT, USER, 'Radcam/Assemblies')

    expect(result.error).toBeNull()
    expect(result.folder?.folder_path).toBe('Radcam/Assemblies')
    expect(table.map((row) => row.folder_path)).toEqual(['RADCAM', 'Radcam/Assemblies'])
  })

  it('picks the same row every time when two spellings are still active', async () => {
    // A database that predates the unique index, or has drifted since. A
    // case-insensitive lookup legitimately matches both rows here, which is why
    // the query orders and limits rather than asking for exactly one row:
    // .maybeSingle() would report two rows as PGRST116, the code the caller
    // reads as "no folder", and the insert that followed would fail on 23505.
    table.push(existingFolder('Radcam', { id: 'id-newer', created_at: '2026-02-01T00:00:00.000Z' }))
    table.push(existingFolder('RADCAM', { id: 'id-older', created_at: '2026-01-01T00:00:00.000Z' }))

    const first = await syncFolder(ORG, VAULT, USER, 'radcam')
    const second = await syncFolder(ORG, VAULT, USER, 'RadCam')

    expect(first.error).toBeNull()
    expect(first.folder?.id).toBe('id-older')
    expect(second.folder?.id).toBe('id-older')
    expect(table).toHaveLength(2)
  })
})

describe('folder names containing LIKE wildcards', () => {
  it('does not take PartXFiles for Part_Files', async () => {
    // `_` is legal in a Windows folder name and is LIKE's single-character
    // wildcard, so an unescaped pattern would answer with PartXFiles and the
    // real folder would never be created.
    table.push(existingFolder('PartXFiles'))

    const result = await syncFolder(ORG, VAULT, USER, 'Part_Files')

    expect(result.error).toBeNull()
    expect(result.folder?.folder_path).toBe('Part_Files')
    expect(table.map((row) => row.folder_path)).toEqual(['PartXFiles', 'Part_Files'])
  })

  it('still matches an escaped name case-insensitively', async () => {
    // Escaping must not cost the case-insensitivity this fix is for.
    table.push(existingFolder('Part_Files'))

    const result = await syncFolder(ORG, VAULT, USER, 'part_files')

    expect(result.folder?.id).toBe('id-part_files')
    expect(table).toHaveLength(1)
  })

  it('does not take ReportsArchive for Reports%', async () => {
    table.push(existingFolder('ReportsArchive'))

    const result = await syncFolder(ORG, VAULT, USER, 'Reports%')

    expect(result.folder?.folder_path).toBe('Reports%')
    expect(table).toHaveLength(2)
  })
})

describe('a unique violation with no folder behind it', () => {
  it('reports the failure instead of answering with no folder and no error', async () => {
    // The insert is refused for a row the re-fetch cannot see - trashed in
    // between, or a failing fetch. Callers key on `result.error`: the directory
    // watcher logs nothing without it, and fileOps carries an undefined folder
    // forward until a later delete needs its id.
    phantomConflict = true

    const result = await syncFolder(ORG, VAULT, USER, 'Radcam')

    expect(result.folder).toBeNull()
    expect(result.error).not.toBeNull()
    expect(result.error.code).toBe('23505')
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0].data).toMatchObject({ folderPath: 'Radcam', vaultId: VAULT })
  })

  it('says nothing extra when the race really was a race', async () => {
    // Another client commits `RADCAM` after our existence check and before our
    // insert. The re-fetch reads it back case-insensitively, which is the
    // ordinary concurrent-create path and must stay quiet.
    concurrentInsert = existingFolder('RADCAM')

    const result = await syncFolder(ORG, VAULT, USER, 'Radcam')

    expect(result.error).toBeNull()
    expect(result.folder?.id).toBe('id-radcam')
    expect(warnings()).toHaveLength(0)
    expect(table).toHaveLength(1)
  })
})
