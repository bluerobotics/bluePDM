/**
 * Every key `ResolveMovedFilesDialog` reads, asserted to exist in all 7 locales and to
 * interpolate where it takes a count. Follows `newKeys.test.ts`'s pattern and reasoning: a
 * missing key is not a missing translation, it is the literal dotted key rendered on screen,
 * since `getTranslation` only falls back to a string when one was passed at the call site
 * (`index.ts`) — and every call in this dialog passes a params object, not a fallback string.
 */

import { describe, expect, it } from 'vitest'

import { getTranslation } from './index'
import type { Language } from './types'

const LOCALES: Language[] = ['en', 'de', 'es', 'fr', 'pt', 'zh-CN', 'zh-TW']

/** Keys that render as-is, with no `{{placeholder}}`. */
const PLAIN = [
  'resolveMoves.title',
  'resolveMoves.subtitle',
  'resolveMoves.noPendingMoves',
  'resolveMoves.scopeLabel',
  'resolveMoves.scopeFile',
  'resolveMoves.scopeFolder',
  'resolveMoves.scopeVault',
  'resolveMoves.vaultWideNote',
  'resolveMoves.noMovesInScope',
  'resolveMoves.reconcileOptionTitle',
  'resolveMoves.reconcileOptionDescription',
  'resolveMoves.adoptOptionTitle',
  'resolveMoves.adoptOptionDescription',
  'resolveMoves.noEligible',
  'resolveMoves.unknownHolder',
  'resolveMoves.skipCheckedOutLabel_one',
  'resolveMoves.forceLabel_one',
  'resolveMoves.runReconcile',
  'resolveMoves.runAdopt',
  'resolveMoves.contextMenuItem',
] as const

/** Keys whose sentence contains `{{count}}`. */
const COUNTED = [
  'resolveMoves.listHeading_one',
  'resolveMoves.listHeading_other',
  'resolveMoves.moreFiles',
  'resolveMoves.eligibleCount_one',
  'resolveMoves.eligibleCount_other',
  'resolveMoves.blockedCount_one',
  'resolveMoves.blockedCount_other',
  'resolveMoves.conflictCount_one',
  'resolveMoves.conflictCount_other',
  'resolveMoves.unverifiedCount_one',
  'resolveMoves.unverifiedCount_other',
  'resolveMoves.skipCheckedOutLabel_other',
  'resolveMoves.forceLabel_other',
] as const

describe('resolveMoves.* keys exist in every locale', () => {
  it.each(LOCALES)('%s resolves every plain key to a sentence rather than the key', (locale) => {
    for (const key of PLAIN) {
      const text = getTranslation(locale, key)
      expect(text, `${locale}: ${key}`).not.toBe(key)
      expect(text.length, `${locale}: ${key}`).toBeGreaterThan(0)
    }
  })

  it.each(LOCALES)('%s resolves every counted key and substitutes the count', (locale) => {
    for (const key of COUNTED) {
      const text = getTranslation(locale, key, { count: 42 })
      expect(text, `${locale}: ${key}`).not.toBe(key)
      expect(text, `${locale}: ${key}`).toContain('42')
      expect(text, `${locale}: ${key}`).not.toMatch(/\{\{\w+\}\}/)
    }
  })
})
