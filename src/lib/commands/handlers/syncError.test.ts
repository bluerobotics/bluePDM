/**
 * The sentence a failed first check-in puts in front of the user.
 *
 * `syncFile` hands back the path collision exactly as Postgres phrased it — `duplicate key value
 * violates unique constraint "idx_files_vault_path_unique_active"` — which names an index the user
 * has never heard of and suggests nothing to do about it. The collision is on letter case, so the
 * file being synced and the row already on the server look identical in every listing, and a retry
 * cannot help: the file only stops being offered for sync once the colliding row has been read into
 * the local list. So the remedy is a refresh, and the message has to say so.
 *
 * The passthrough half matters just as much. A raw message the user can quote into a support
 * request is worth more than a generic failure, so anything unrecognised is handed on untouched.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Language } from '@/lib/i18n'

vi.mock('../../supabase', () => ({
  syncFile: vi.fn(),
  upsertFileReferences: vi.fn(),
}))

// Delegates to the real English dictionary rather than echoing the key, so the assertions below are
// made against the sentence the user actually reads. `t` itself cannot be used directly here: it
// resolves the active language through the store, which this suite does not stand up.
vi.mock('@/lib/i18n', async () => {
  const { getTranslation } = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n')
  return {
    t: (key: string, fallbackOrParams?: string | Record<string, string | number>) =>
      getTranslation('en', key, fallbackOrParams),
  }
})

const { translateSyncError } = await import('./sync')

const FILE_NAME = 'Bracket.SLDPRT'

/** What the server actually returns when the case-differing path is already taken. */
const UNIQUE_VIOLATION =
  'duplicate key value violates unique constraint "idx_files_vault_path_unique_active"'

describe('translateSyncError', () => {
  it('restates the unique-constraint violation as something the user can act on', () => {
    const message = translateSyncError(UNIQUE_VIOLATION, FILE_NAME)

    expect(message).toContain(FILE_NAME)
    expect(message).toContain('letter case')
    expect(message).toContain('Refresh the file list')
    expect(message).not.toContain('idx_files_vault_path_unique_active')
    expect(message).not.toContain('duplicate key')
  })

  it('recognises the collision from the SQLSTATE alone', () => {
    expect(translateSyncError('23505', FILE_NAME)).toBe(
      translateSyncError(UNIQUE_VIOLATION, FILE_NAME),
    )
  })

  it('recognises the collision from the index name alone', () => {
    expect(translateSyncError('conflict on idx_files_vault_path_unique_active', FILE_NAME)).toBe(
      translateSyncError(UNIQUE_VIOLATION, FILE_NAME),
    )
  })

  it('passes an unrecognised error through so the user can quote it', () => {
    expect(translateSyncError('Network request failed', FILE_NAME)).toBe(
      `${FILE_NAME}: Network request failed`,
    )
  })

  it('names the file even when the server said nothing at all', () => {
    for (const empty of [null, undefined, '']) {
      expect(translateSyncError(empty, FILE_NAME)).toBe(`${FILE_NAME}: Sync failed`)
    }
  })
})

describe('the syncError dictionary', () => {
  const KEYS = [
    'syncError.toast',
    'syncError.toastWithMore',
    'syncError.failed',
    'syncError.unknown',
    'syncError.pathCaseConflict',
  ] as const

  /** Every locale that ships its own dictionary; the rest resolve through the English fallback. */
  const TRANSLATED: Language[] = ['fr', 'de', 'es', 'pt', 'zh-CN', 'zh-TW']

  it.each(TRANSLATED)(
    '%s carries its own wording rather than the English fallback',
    async (language) => {
      const { getTranslation } = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n')

      for (const key of KEYS) {
        expect(getTranslation(language, key)).not.toBe(key)
        expect(getTranslation(language, key)).not.toBe(getTranslation('en', key))
      }
    },
  )

  it('leaves no placeholder unfilled in the toast that counts the remaining errors', async () => {
    const { getTranslation } = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n')

    for (const language of ['en', ...TRANSLATED] as Language[]) {
      const text = getTranslation(language, 'syncError.toastWithMore', {
        reason: `${FILE_NAME}: boom`,
        count: 4,
      })

      expect(text).toContain('boom')
      expect(text).toContain('4')
      expect(text).not.toMatch(/\{\{\w+\}\}/)
    }
  })
})
