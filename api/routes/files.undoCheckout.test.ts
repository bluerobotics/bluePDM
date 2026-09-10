/**
 * Releasing a lock whose checkout-time path is no longer free.
 *
 * POST /files/:id/undo-checkout reverts file_path/file_name from the checkout
 * snapshot. `files` is unique on (vault_id, LOWER(file_path)) among active rows,
 * so if another row has taken that path since, the revert is refused with 23505
 * and the lock stays. Nothing the caller can do clears it: every retry attempts
 * the same revert. The lock has to come off even when the revert cannot.
 *
 * The same fallback exists in undoCheckout() in src/lib/supabase/files/checkout.ts.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'

type FileRoutes = typeof import('./files.js')

let fileRoutes: FileRoutes

beforeAll(async () => {
  // The route module reaches the API env schema, which exits the process when
  // the Supabase settings are missing, so it cannot be imported at the top.
  process.env.SUPABASE_URL ||= 'https://example.supabase.co'
  process.env.SUPABASE_KEY ||= 'test-anon-key'
  fileRoutes = await import('./files.js')
})

const FILE_ID = '00000000-0000-0000-0000-0000000000f1'
const USER_ID = '00000000-0000-0000-0000-0000000000d1'
const ORG_ID = '00000000-0000-0000-0000-0000000000c1'
const CHECKED_OUT_PATH = 'Parts/Bracket.SLDPRT'
const CHECKED_OUT_NAME = 'Bracket.SLDPRT'
const UNIQUE_VIOLATION = '23505'

interface QueryError {
  code?: string
  message: string
}

type UpdateAnswer = { data: unknown; error: QueryError | null }

/** The row the route reads before releasing. */
let fileRow: Record<string, unknown> | null = null
/** Every update payload the release path sent, in call order. */
let updatePayloads: Array<Record<string, unknown>> = []
/** Answers for successive update calls; a missing entry answers plain success. */
let updateAnswers: UpdateAnswer[] = []
/** Warnings the route logged, so the fallback can be shown to be recorded. */
let warnings: Array<{ context: unknown; message: unknown }> = []

const fakeSupabase = {
  from: () => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          single: async () => ({ data: fileRow, error: null }),
        }),
      }),
    }),
    update: (payload: Record<string, unknown>) => {
      updatePayloads.push(payload)
      return {
        eq: () => ({
          select: () => ({
            single: async () => updateAnswers.shift() ?? { data: { id: FILE_ID }, error: null },
          }),
        }),
      }
    },
  }),
}

/**
 * A logger Fastify accepts that keeps the warnings where a test can read them.
 * Everything else is dropped: this suite asserts on one call. The methods are
 * variadic because Pino's LogFn is overloaded on (obj, msg) and (msg, ...args),
 * and a fixed two-parameter signature satisfies neither.
 */
function createLogger(): FastifyBaseLogger {
  const ignore = (..._args: unknown[]) => {}
  const logger: FastifyBaseLogger = {
    level: 'warn',
    fatal: ignore,
    error: ignore,
    warn: (context: unknown, message?: unknown) => {
      warnings.push({ context, message })
    },
    info: ignore,
    debug: ignore,
    trace: ignore,
    silent: ignore,
    child: () => logger,
  }
  return logger
}

async function buildApp(role: 'admin' | 'engineer' = 'engineer'): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: createLogger() })

  // The real authenticate hook resolves the bearer token into these two; the
  // route only reads them, so the test supplies them directly.
  app.decorate('authenticate', async () => {})
  app.decorateRequest('user', null)
  app.decorateRequest('supabase', null)
  app.decorateRequest('accessToken', null)
  app.addHook('onRequest', async (request) => {
    request.user = { id: USER_ID, email: 'someone@example.com', full_name: null, role, org_id: ORG_ID }
    request.supabase = fakeSupabase as unknown as NonNullable<typeof request.supabase>
  })

  await app.register(fileRoutes.default)
  await app.ready()
  return app
}

function undoCheckout(app: FastifyInstance) {
  return app.inject({ method: 'POST', url: `/files/${FILE_ID}/undo-checkout` })
}

/** A checked-out row as the route reads it, with or without a path snapshot. */
function checkedOutRow(snapshot: { path: string | null; name: string | null }) {
  return {
    id: FILE_ID,
    checked_out_by: USER_ID,
    checked_out_file_path: snapshot.path,
    checked_out_file_name: snapshot.name,
  }
}

beforeEach(() => {
  fileRow = checkedOutRow({ path: CHECKED_OUT_PATH, name: CHECKED_OUT_NAME })
  updatePayloads = []
  updateAnswers = []
  warnings = []
})

describe('POST /files/:id/undo-checkout', () => {
  it('reverts file_path/file_name from the snapshot while clearing the lock', async () => {
    const app = await buildApp()

    const response = await undoCheckout(app)

    expect(response.statusCode).toBe(200)
    expect(updatePayloads).toHaveLength(1)
    expect(updatePayloads[0]).toMatchObject({
      checked_out_by: null,
      checked_out_file_path: null,
      checked_out_file_name: null,
      file_path: CHECKED_OUT_PATH,
      file_name: CHECKED_OUT_NAME,
    })
    await app.close()
  })

  it('falls back to clearing the lock alone when the revert hits a unique violation', async () => {
    updateAnswers = [
      {
        data: null,
        error: { code: UNIQUE_VIOLATION, message: 'duplicate key value violates unique constraint' },
      },
    ]
    const app = await buildApp()

    const response = await undoCheckout(app)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ success: true })
    expect(updatePayloads).toHaveLength(2)
    expect(updatePayloads[1]).not.toHaveProperty('file_path')
    expect(updatePayloads[1]).not.toHaveProperty('file_name')
    expect(updatePayloads[1]).toMatchObject({
      checked_out_by: null,
      checked_out_at: null,
      checked_out_file_path: null,
      checked_out_file_name: null,
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].context).toMatchObject({ fileId: FILE_ID, checkedOutFilePath: CHECKED_OUT_PATH })
    await app.close()
  })

  it('does not retry a unique violation that was not caused by the path revert', async () => {
    // An older lock, taken before the snapshot columns existed, reverts no path.
    // A 23505 with nothing of ours in flight came from somewhere else and is not
    // ours to swallow.
    fileRow = checkedOutRow({ path: null, name: null })
    updateAnswers = [{ data: null, error: { code: UNIQUE_VIOLATION, message: 'some other clash' } }]
    const app = await buildApp()

    const response = await undoCheckout(app)

    expect(response.statusCode).toBe(500)
    expect(updatePayloads).toHaveLength(1)
    expect(warnings).toHaveLength(0)
    await app.close()
  })

  it('does not retry an error that is not a unique violation', async () => {
    updateAnswers = [{ data: null, error: { code: '42501', message: 'permission denied' } }]
    const app = await buildApp()

    const response = await undoCheckout(app)

    expect(response.statusCode).toBe(500)
    expect(updatePayloads).toHaveLength(1)
    await app.close()
  })

  it('refuses to release a lock held by someone else', async () => {
    fileRow = { ...checkedOutRow({ path: null, name: null }), checked_out_by: 'someone-else' }
    const app = await buildApp()

    const response = await undoCheckout(app)

    expect(response.statusCode).toBe(403)
    expect(updatePayloads).toHaveLength(0)
    await app.close()
  })
})
