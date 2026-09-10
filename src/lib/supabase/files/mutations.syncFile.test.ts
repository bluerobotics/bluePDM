/**
 * Syncing a file onto a path that is already taken in another case.
 *
 * `idx_files_vault_path_unique_active` is unique on `(vault_id,
 * LOWER(file_path))` where `deleted_at IS NULL`, but syncFile's existence check
 * is byte-exact and stays that way: `.ilike()` on `files` is not index-backed,
 * and the check runs once per file at CONCURRENT_OPERATIONS concurrency during a
 * first check-in of a whole vault. So the miss is real, the insert is refused
 * with 23505, and the recovery has to happen there - once, on the collision -
 * rather than by making the hot path a scan.
 *
 * The fake client below implements LIKE's semantics and the partial unique
 * index rather than recording call shapes, so these tests fail if the escaping
 * or the index reasoning is wrong.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FileRow {
  id: string
  org_id: string
  vault_id: string
  file_path: string
  file_name: string
  version: number
  content_hash: string
  file_size: number
  revision: string
  workflow_state_id: string | null
  state: string | null
  deleted_at: string | null
  created_at: string
}

interface QueryError {
  code?: string
  message: string
}

type Row = Record<string, unknown>

const ORG = '00000000-0000-0000-0000-000000000001'
const VAULT = '00000000-0000-0000-0000-000000000002'
const USER = '00000000-0000-0000-0000-000000000003'
const NO_ROWS = 'PGRST116'
const UNIQUE_VIOLATION = '23505'

let table: FileRow[] = []
/** Makes the next files insert raise 23505 with nothing in the table to find. */
let phantomConflict = false
/** Every `.ilike()` the run performed, so the hot path can be shown to avoid it. */
let ilikeCalls: Array<{ column: string; pattern: string }> = []
/** file_path values passed to `.eq()`, i.e. the byte-exact lookups. */
let exactPathLookups: string[] = []
let filesInsertAttempts = 0
const logged: Array<{ level: string; message: string; data?: unknown }> = []

/**
 * Translate a LIKE pattern into the equivalent regular expression, honouring
 * backslash as the escape character exactly as PostgreSQL does.
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
  private predicates: Array<(row: FileRow) => boolean> = []
  private orderBy: Array<{ column: keyof FileRow; ascending: boolean }> = []
  private rowLimit: number | null = null

  eq(column: keyof FileRow, value: string): this {
    if (column === 'file_path') exactPathLookups.push(value)
    this.predicates.push((row) => row[column] === value)
    return this
  }

  ilike(column: keyof FileRow, pattern: string): this {
    ilikeCalls.push({ column, pattern })
    const matcher = likeToRegExp(pattern)
    this.predicates.push((row) => matcher.test(String(row[column] ?? '')))
    return this
  }

  is(column: keyof FileRow, value: null): this {
    this.predicates.push((row) => row[column] === value)
    return this
  }

  order(column: keyof FileRow, options?: { ascending?: boolean }): this {
    this.orderBy.push({ column, ascending: options?.ascending !== false })
    return this
  }

  limit(count: number): this {
    this.rowLimit = count
    return this
  }

  private run(): FileRow[] {
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
    return rows
  }

  /** PostgREST reports both "no rows" and "more than one row" as PGRST116. */
  async single(): Promise<{ data: FileRow | null; error: QueryError | null }> {
    const rows = this.run()
    if (rows.length === 1) return { data: rows[0], error: null }
    return {
      data: null,
      error: { code: NO_ROWS, message: 'JSON object requested, multiple (or no) rows returned' },
    }
  }

  then<TResult1 = { data: FileRow[]; error: null }, TResult2 = never>(
    onFulfilled?:
      | ((value: { data: FileRow[]; error: null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ data: this.run(), error: null }).then(onFulfilled, onRejected)
  }
}

class FilesInsertQuery {
  constructor(private values: Row) {}

  select(): this {
    return this
  }

  /** The insert PostgREST would perform, under idx_files_vault_path_unique_active. */
  async single(): Promise<{ data: FileRow | null; error: QueryError | null }> {
    filesInsertAttempts++
    const filePath = String(this.values.file_path)
    const collides = table.some(
      (row) =>
        row.vault_id === this.values.vault_id &&
        row.deleted_at === null &&
        row.file_path.toLowerCase() === filePath.toLowerCase(),
    )
    if (collides || phantomConflict) {
      phantomConflict = false
      return {
        data: null,
        error: {
          code: UNIQUE_VIOLATION,
          message: 'duplicate key value violates unique constraint "idx_files_vault_path_unique_active"',
        },
      }
    }
    const inserted: FileRow = {
      id: `id-${table.length + 1}`,
      org_id: String(this.values.org_id),
      vault_id: String(this.values.vault_id),
      file_path: filePath,
      file_name: String(this.values.file_name),
      version: Number(this.values.version),
      content_hash: String(this.values.content_hash),
      file_size: Number(this.values.file_size),
      revision: String(this.values.revision ?? ''),
      workflow_state_id: null,
      state: String(this.values.state ?? 'not_tracked'),
      deleted_at: null,
      created_at: `2026-09-09T00:00:0${table.length}.000Z`,
    }
    table.push(inserted)
    return { data: inserted, error: null }
  }
}

class UpdateQuery {
  private targetId: string | null = null

  constructor(private payload: Row) {}

  eq(column: string, value: string): this {
    if (column === 'id') this.targetId = value
    return this
  }

  select(): this {
    return this
  }

  async single(): Promise<{ data: FileRow | null; error: QueryError | null }> {
    const row = table.find((candidate) => candidate.id === this.targetId)
    if (!row) return { data: null, error: { code: NO_ROWS, message: 'no rows' } }
    Object.assign(row, this.payload)
    return { data: row, error: null }
  }
}

/** file_versions accepts everything; nothing under test reads it back. */
const versionsInsert = {
  then<T>(onFulfilled?: ((value: { data: null; error: null }) => T) | null) {
    return Promise.resolve({ data: null, error: null }).then(onFulfilled)
  },
}

const fakeClient = {
  storage: {
    from: () => ({
      // Report the content as already stored so the upload path is skipped -
      // this suite is about the database write, not about storage.
      list: async () => ({ data: [{ name: 'hash' }], error: null }),
      upload: async () => ({ data: null, error: null }),
    }),
  },
  from(name: string) {
    if (name === 'file_versions') {
      return { insert: () => versionsInsert }
    }
    expect(name).toBe('files')
    return {
      select: () => new SelectQuery(),
      insert: (values: Row) => new FilesInsertQuery(values),
      update: (payload: Row) => new UpdateQuery(payload),
    }
  },
}

vi.mock('../client', () => ({
  getSupabaseClient: () => fakeClient,
}))

vi.mock('../auth', () => ({
  getCurrentUser: async () => ({ user: { id: USER } }),
  getCurrentUserEmail: async () => 'someone@example.com',
}))

const { syncFile } = await import('./mutations')

function existingFile(filePath: string, overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: `id-${filePath.toLowerCase()}`,
    org_id: ORG,
    vault_id: VAULT,
    file_path: filePath,
    file_name: filePath.split('/').pop() ?? filePath,
    version: 3,
    content_hash: 'old-hash',
    file_size: 10,
    revision: 'A',
    workflow_state_id: null,
    state: 'wip',
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function sync(filePath: string) {
  const fileName = filePath.split('/').pop() ?? filePath
  return syncFile(ORG, VAULT, USER, filePath, fileName, '.sldprt', 42, 'new-hash', '')
}

function warnings(): Array<{ message: string; data?: unknown }> {
  return logged.filter((entry) => entry.level === 'warn')
}

beforeEach(() => {
  table = []
  phantomConflict = false
  ilikeCalls = []
  exactPathLookups = []
  filesInsertAttempts = 0
  logged.length = 0
  // syncFile logs through window.electronAPI when it is there; the test
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

describe('syncing onto a path an active row already holds in another case', () => {
  it('updates that row instead of failing on every retry', async () => {
    // Before the fallback the insert was refused, the error propagated, the file
    // was counted as failed, and the next attempt repeated the same three steps
    // for as long as the two spellings existed.
    table.push(existingFile('Parts/BRACKET.SLDPRT'))

    const result = await sync('Parts/Bracket.SLDPRT')

    expect(result.error).toBeNull()
    expect(result.isNew).toBe(false)
    expect(table).toHaveLength(1)
    expect(table[0].version).toBe(4)
    expect(table[0].content_hash).toBe('new-hash')
    // The stored spelling is left alone; the row is the file, whatever case it
    // was first checked in under.
    expect(table[0].file_path).toBe('Parts/BRACKET.SLDPRT')
  })

  it('keeps the primary lookup byte-exact and pays for the scan only on collision', async () => {
    // The reason this was deferred: `.ilike()` on files is not index-backed and
    // this runs per file during a bulk first check-in. It must not appear on the
    // path that finds the row, nor on the path that inserts a new one.
    table.push(existingFile('Parts/Bracket.SLDPRT'))

    await sync('Parts/Bracket.SLDPRT')
    await sync('Parts/Other.SLDPRT')

    expect(exactPathLookups).toEqual(['Parts/Bracket.SLDPRT', 'Parts/Other.SLDPRT'])
    expect(ilikeCalls).toHaveLength(0)
  })

  it('escapes the re-fetch, so Part_Files does not update PartXFiles', async () => {
    // PartXFiles is older, so an unescaped pattern would order it first and the
    // sync would overwrite an unrelated file's content hash and version.
    table.push(existingFile('PartXFiles.sldprt', { created_at: '2026-01-01T00:00:00.000Z' }))
    table.push(
      existingFile('PART_FILES.SLDPRT', { created_at: '2026-02-01T00:00:00.000Z', version: 7 }),
    )

    const result = await sync('Part_Files.sldprt')

    expect(result.error).toBeNull()
    expect(result.isNew).toBe(false)
    expect(ilikeCalls).toEqual([{ column: 'file_path', pattern: 'Part\\_Files.sldprt' }])
    expect(table.find((row) => row.file_path === 'PART_FILES.SLDPRT')?.version).toBe(8)
    expect(table.find((row) => row.file_path === 'PartXFiles.sldprt')?.content_hash).toBe('old-hash')
  })

  it('inserts once and does not retry the refused insert', async () => {
    table.push(existingFile('Parts/BRACKET.SLDPRT'))

    await sync('Parts/Bracket.SLDPRT')

    expect(filesInsertAttempts).toBe(1)
  })
})

describe('a unique violation with no file behind it', () => {
  it('reports a real error rather than a null file with a null error', async () => {
    // The index is partial on `deleted_at IS NULL`, so 23505 said an active row
    // exists. Not reading it back means something else is wrong, and check-in
    // counts `{ file: null, error: null }` as a success it never got.
    phantomConflict = true

    const result = await sync('Parts/Bracket.SLDPRT')

    expect(result.file).toBeNull()
    expect(result.error).not.toBeNull()
    expect((result.error as QueryError).code).toBe(UNIQUE_VIOLATION)
    expect(result.isNew).toBe(false)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0].data).toMatchObject({
      filePath: 'Parts/Bracket.SLDPRT',
      vaultId: VAULT,
      orgId: ORG,
    })
  })

  it('stays quiet when the collision really was a collision', async () => {
    table.push(existingFile('Parts/BRACKET.SLDPRT'))

    await sync('Parts/Bracket.SLDPRT')

    expect(warnings()).toHaveLength(0)
  })
})
