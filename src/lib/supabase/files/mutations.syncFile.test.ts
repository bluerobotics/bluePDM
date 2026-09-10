/**
 * Syncing a file onto a path that is already taken in another case.
 *
 * `idx_files_vault_path_unique_active` is unique on `(vault_id,
 * LOWER(file_path))` where `deleted_at IS NULL`, but syncFile's existence check
 * is byte-exact and stays that way: the check runs once per file at
 * CONCURRENT_OPERATIONS concurrency during a first check-in of a whole vault,
 * and paying for a case-insensitive lookup on every file would slow down the
 * overwhelmingly common case that never collides. So the miss is real, the
 * insert is refused with 23505, and the recovery has to happen there - once,
 * on the collision - by calling `get_active_file_by_path` (schema 100)
 * rather than by making the hot path pay for it.
 *
 * The fake client below implements the partial unique index and the RPC's
 * case-insensitive equality match rather than recording call shapes, so these
 * tests fail if the index reasoning is wrong.
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
/** PostgREST: the RPC's target function does not exist - the schema-99 window. */
const RPC_FUNCTION_NOT_FOUND = 'PGRST202'

let table: FileRow[] = []
/** Makes the next files insert raise 23505 with nothing in the table to find. */
let phantomConflict = false
/** Makes `get_active_file_by_path` answer PGRST202, as it does on a schema-99 database. */
let rpcMissing = false
/** Every `get_active_file_by_path` call the run made, so the hot path can be shown to avoid it. */
let activeFileByPathCalls: Array<{ vaultId: string; filePath: string }> = []
/** file_path values passed to `.eq()`, i.e. the byte-exact lookups. */
let exactPathLookups: string[] = []
/** file_path patterns passed to `.ilike()`, i.e. the schema-99 fallback scans. */
let ilikeLookups: string[] = []
let filesInsertAttempts = 0
const logged: Array<{ level: string; message: string; data?: unknown }> = []

/** Turns a LIKE/ILIKE pattern (as `escapeLikePattern` produces it) into a case-insensitive RegExp. */
function likePatternToRegex(pattern: string): RegExp {
  let body = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '\\') {
      const next = pattern[i + 1]
      body += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      i++
    } else if (char === '%') {
      body += '.*'
    } else if (char === '_') {
      body += '.'
    } else {
      body += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${body}$`, 'i')
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

  /** The `.ilike()` fallback's own matcher - not the partial index's, so the test proves the pattern is right. */
  ilike(column: keyof FileRow, pattern: string): this {
    if (column === 'file_path') ilikeLookups.push(pattern)
    const regex = likePatternToRegex(pattern)
    this.predicates.push((row) => regex.test(String(row[column])))
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
  /**
   * `get_active_file_by_path`'s server-side semantics: the active row whose
   * (vault_id, LOWER(file_path)) matches, per idx_files_vault_path_unique_active.
   */
  async rpc(name: string, params: Record<string, unknown>) {
    expect(name).toBe('get_active_file_by_path')
    const vaultId = String(params.p_vault_id)
    const filePath = String(params.p_file_path)
    activeFileByPathCalls.push({ vaultId, filePath })

    // Schema 99: the function this RPC targets does not exist yet.
    if (rpcMissing) {
      return {
        data: null,
        error: {
          code: RPC_FUNCTION_NOT_FOUND,
          message:
            'Could not find the function public.get_active_file_by_path(p_file_path, p_vault_id) in the schema cache',
        },
      }
    }

    const match = table.find(
      (row) =>
        row.vault_id === vaultId &&
        row.deleted_at === null &&
        row.file_path.toLowerCase() === filePath.toLowerCase(),
    )
    return { data: match ? [match] : [], error: null }
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
  rpcMissing = false
  activeFileByPathCalls = []
  exactPathLookups = []
  ilikeLookups = []
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

  it('keeps the primary lookup byte-exact and pays for the RPC only on collision', async () => {
    // The reason this was deferred to the RPC: paying for a case-insensitive
    // lookup on every file during a bulk first check-in would slow down the
    // path that never collides. It must not appear on the path that finds the
    // row, nor on the path that inserts a new one.
    table.push(existingFile('Parts/Bracket.SLDPRT'))

    await sync('Parts/Bracket.SLDPRT')
    await sync('Parts/Other.SLDPRT')

    expect(exactPathLookups).toEqual(['Parts/Bracket.SLDPRT', 'Parts/Other.SLDPRT'])
    expect(activeFileByPathCalls).toHaveLength(0)
  })

  it('matches case-insensitively without treating underscore as a wildcard', async () => {
    // The old `.ilike()` fallback needed to escape `_` or `Part_Files.sldprt`
    // would also match `PartXFiles.sldprt`. get_active_file_by_path matches on
    // `LOWER(file_path) = LOWER($1)`, an equality comparison with no pattern
    // metacharacters to escape at all - this proves the RPC path still tells
    // the two apart.
    table.push(existingFile('PartXFiles.sldprt', { created_at: '2026-01-01T00:00:00.000Z' }))
    table.push(
      existingFile('PART_FILES.SLDPRT', { created_at: '2026-02-01T00:00:00.000Z', version: 7 }),
    )

    const result = await sync('Part_Files.sldprt')

    expect(result.error).toBeNull()
    expect(result.isNew).toBe(false)
    expect(activeFileByPathCalls).toEqual([{ vaultId: VAULT, filePath: 'Part_Files.sldprt' }])
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

describe('a 4.3.1 client against a schema-99 database', () => {
  it('falls back to the ilike scan and still recovers the collision when the RPC is missing', async () => {
    // get_active_file_by_path does not exist until schema 100 is applied.
    // PostgREST answers that with PGRST202, not a query failure, so this must
    // degrade to the pre-4.3.1 recovery rather than fail the check-in.
    rpcMissing = true
    table.push(existingFile('Parts/BRACKET.SLDPRT'))

    const result = await sync('Parts/Bracket.SLDPRT')

    expect(result.error).toBeNull()
    expect(result.isNew).toBe(false)
    expect(table).toHaveLength(1)
    expect(table[0].version).toBe(4)
    expect(table[0].content_hash).toBe('new-hash')
    expect(table[0].file_path).toBe('Parts/BRACKET.SLDPRT')
    // The RPC is still tried first - the fallback is a degrade, not a skip.
    expect(activeFileByPathCalls).toEqual([{ vaultId: VAULT, filePath: 'Parts/Bracket.SLDPRT' }])
    expect(ilikeLookups).toEqual(['Parts/Bracket.SLDPRT'])
    expect(warnings()).toHaveLength(0)
  })

  it('escapes LIKE metacharacters in the fallback so underscore is not a wildcard', async () => {
    rpcMissing = true
    table.push(existingFile('PartXFiles.sldprt', { created_at: '2026-01-01T00:00:00.000Z' }))
    table.push(
      existingFile('PART_FILES.SLDPRT', { created_at: '2026-02-01T00:00:00.000Z', version: 7 }),
    )

    const result = await sync('Part_Files.sldprt')

    expect(result.error).toBeNull()
    expect(result.isNew).toBe(false)
    expect(table.find((row) => row.file_path === 'PART_FILES.SLDPRT')?.version).toBe(8)
    expect(table.find((row) => row.file_path === 'PartXFiles.sldprt')?.content_hash).toBe(
      'old-hash',
    )
  })

  it('still reports a real error when the fallback also finds nothing', async () => {
    // Same failure mode as the healthy-schema case: 23505 said an active row
    // exists, and neither recovery path found it.
    rpcMissing = true
    phantomConflict = true

    const result = await sync('Parts/Bracket.SLDPRT')

    expect(result.file).toBeNull()
    expect(result.error).not.toBeNull()
    expect((result.error as QueryError).code).toBe(UNIQUE_VIOLATION)
    expect(warnings()).toHaveLength(1)
  })
})
