import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()

/** The row `undoCheckout` reads before releasing, as the fake database holds it. */
const maybeSingle = vi.fn()

/** Every update payload the release path sent, in call order. */
const updatePayloads: Array<Record<string, unknown>> = []

/** Answers for successive update calls; a missing entry answers plain success. */
let updateAnswers: Array<{
  data: unknown
  error: { code?: string; message: string } | null
}> = []

vi.mock('../client', () => ({
  getSupabaseClient: () => ({
    rpc,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      update: (payload: Record<string, unknown>) => {
        updatePayloads.push(payload)
        return {
          eq: () => ({
            select: () => ({
              single: async () =>
                updateAnswers.shift() ?? { data: { id: FILE_ID }, error: null },
            }),
          }),
        }
      },
    }),
  }),
}))

vi.mock('../auth', () => ({
  getCurrentUserEmail: async () => 'someone@example.com',
}))

const logWarn = vi.fn()
vi.mock('@/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: logWarn, error: vi.fn() },
}))

const { checkinFile, checkoutFile, undoCheckout } = await import('./checkout')

const FILE_ID = '00000000-0000-0000-0000-0000000000f1'
const USER_ID = '00000000-0000-0000-0000-0000000000u1'
const CHECKED_OUT_PATH = 'Parts/Bracket.SLDPRT'
const CHECKED_OUT_NAME = 'Bracket.SLDPRT'
const UNIQUE_VIOLATION = '23505'

/** Arguments of the single `checkin_file` call made by the test. */
function rpcArguments(): Record<string, unknown> {
  expect(rpc).toHaveBeenCalledTimes(1)
  const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>]
  expect(name).toBe('checkin_file')
  return args
}

/** A checked-out row as `undoCheckout` reads it, with or without a path snapshot. */
function checkedOutRow(snapshot: { path: string | null; name: string | null }) {
  return {
    id: FILE_ID,
    org_id: 'org-1',
    checked_out_by: USER_ID,
    file_path: 'Parts/Bracket-Rev2.SLDPRT',
    file_name: 'Bracket-Rev2.SLDPRT',
    checked_out_file_path: snapshot.path,
    checked_out_file_name: snapshot.name,
  }
}

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({ data: { success: true, file: { id: FILE_ID } }, error: null })
  maybeSingle.mockReset()
  logWarn.mockReset()
  updatePayloads.length = 0
  updateAnswers = []
})

describe('checkinFile configuration maps', () => {
  // The payload the bug produced: one edited configuration, sent as the whole map.
  it('sends every committed configuration alongside the edited one', async () => {
    const committed: Record<string, string> = {}
    for (let index = 0; index < 68; index++) committed[`AS568-${index}`] = String(100 + index)

    await checkinFile(FILE_ID, USER_ID, {
      skipMachineMismatchCheck: true,
      pendingMetadata: { config_tabs: { 'AS568-14': '999' } },
      committedCustomProperties: { _config_tabs: committed },
    })

    const sent = rpcArguments().p_custom_properties as { _config_tabs: Record<string, string> }
    expect(Object.keys(sent._config_tabs)).toHaveLength(68)
    expect(sent._config_tabs['AS568-14']).toBe('999')
    expect(sent._config_tabs['AS568-0']).toBe('100')
  })

  it('sends no custom_properties patch when no configuration was edited', async () => {
    await checkinFile(FILE_ID, USER_ID, {
      skipMachineMismatchCheck: true,
      pendingMetadata: { part_number: 'PN-1' },
      committedCustomProperties: { _config_tabs: { A: '1' } },
    })

    expect(rpcArguments().p_custom_properties).toBeNull()
  })

  // A caller that does not know the committed side must not have its edit silently widened into a
  // replacement either; it sends what it has, and the RPC's entry-by-entry merge covers the rest.
  it('sends the edit alone when the committed properties were not supplied', async () => {
    await checkinFile(FILE_ID, USER_ID, {
      skipMachineMismatchCheck: true,
      pendingMetadata: { config_descriptions: { A: 'edited' } },
    })

    expect(rpcArguments().p_custom_properties).toEqual({ _config_descriptions: { A: 'edited' } })
  })
})

describe('checkoutFile path snapshot', () => {
  // The store write in checkout.ts reads the snapshot off this result, so discard can
  // restore a rename without waiting for realtime to deliver the two columns.
  it('returns the snapshot columns the RPC recorded at lock time', async () => {
    rpc.mockResolvedValue({
      data: {
        success: true,
        file: {
          id: FILE_ID,
          checked_out_file_path: CHECKED_OUT_PATH,
          checked_out_file_name: CHECKED_OUT_NAME,
        },
      },
      error: null,
    })

    const result = await checkoutFile(FILE_ID, USER_ID, 'someone@example.com', {
      machineId: 'machine-1',
      machineName: 'Machine One',
    })

    expect(result.success).toBe(true)
    expect(result.file).toEqual({
      checked_out_file_path: CHECKED_OUT_PATH,
      checked_out_file_name: CHECKED_OUT_NAME,
    })
  })

  it('reports no snapshot when the returned row does not carry both columns', async () => {
    rpc.mockResolvedValue({
      data: { success: true, file: { id: FILE_ID, checked_out_file_path: CHECKED_OUT_PATH } },
      error: null,
    })

    const result = await checkoutFile(FILE_ID, USER_ID, 'someone@example.com', {
      machineId: 'machine-1',
      machineName: 'Machine One',
    })

    expect(result.success).toBe(true)
    expect(result.file).toBeUndefined()
  })
})

describe('undoCheckout path revert', () => {
  it('reverts file_path/file_name from the snapshot while clearing the lock', async () => {
    maybeSingle.mockResolvedValue({
      data: checkedOutRow({ path: CHECKED_OUT_PATH, name: CHECKED_OUT_NAME }),
      error: null,
    })

    const result = await undoCheckout(FILE_ID, USER_ID)

    expect(result.success).toBe(true)
    expect(updatePayloads).toHaveLength(1)
    expect(updatePayloads[0]).toMatchObject({
      checked_out_by: null,
      checked_out_file_path: null,
      checked_out_file_name: null,
      file_path: CHECKED_OUT_PATH,
      file_name: CHECKED_OUT_NAME,
    })
  })

  // A cloud-only row another user created at the snapshot path makes the revert
  // violate files' unique (vault_id, LOWER(file_path)) index. By this point discard
  // has already renamed and re-downloaded the local file, so refusing to release
  // would leave a lock that retrying can never clear.
  it('falls back to clearing the lock alone when the revert hits a unique violation', async () => {
    maybeSingle.mockResolvedValue({
      data: checkedOutRow({ path: CHECKED_OUT_PATH, name: CHECKED_OUT_NAME }),
      error: null,
    })
    updateAnswers = [
      {
        data: null,
        error: { code: UNIQUE_VIOLATION, message: 'duplicate key value violates unique constraint' },
      },
    ]

    const result = await undoCheckout(FILE_ID, USER_ID)

    expect(result.success).toBe(true)
    expect(updatePayloads).toHaveLength(2)
    expect(updatePayloads[1]).not.toHaveProperty('file_path')
    expect(updatePayloads[1]).not.toHaveProperty('file_name')
    expect(updatePayloads[1]).toMatchObject({
      checked_out_by: null,
      checked_out_file_path: null,
      checked_out_file_name: null,
    })
    expect(logWarn).toHaveBeenCalledTimes(1)
  })

  it('does not retry a unique violation that was not caused by the path revert', async () => {
    maybeSingle.mockResolvedValue({ data: checkedOutRow({ path: null, name: null }), error: null })
    updateAnswers = [{ data: null, error: { code: UNIQUE_VIOLATION, message: 'some other clash' } }]

    const result = await undoCheckout(FILE_ID, USER_ID)

    expect(result.success).toBe(false)
    expect(updatePayloads).toHaveLength(1)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('does not retry an error that is not a unique violation', async () => {
    maybeSingle.mockResolvedValue({
      data: checkedOutRow({ path: CHECKED_OUT_PATH, name: CHECKED_OUT_NAME }),
      error: null,
    })
    updateAnswers = [{ data: null, error: { code: '42501', message: 'permission denied' } }]

    const result = await undoCheckout(FILE_ID, USER_ID)

    expect(result.success).toBe(false)
    expect(result.error).toBe('permission denied')
    expect(updatePayloads).toHaveLength(1)
  })
})
