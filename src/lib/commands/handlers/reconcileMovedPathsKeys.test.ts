/**
 * Every locale key this command reads, asserted in all seven locales.
 *
 * `getTranslation` returns the key itself when it cannot find one (`i18n/index.ts:86`), so a key
 * missing from `en.ts` puts `reconcileMovedPaths.refused` on screen where a refusal should be — and
 * this command's output is the only thing telling an operator whether hundreds of rows were written.
 * The counted keys are asserted separately because a key that takes parameters cannot also carry a
 * fallback string: `getTranslation` skips interpolation entirely when given one.
 */

import { describe, expect, it } from 'vitest'

import type { Language } from '../../i18n/types'
import { getTranslation } from '../../i18n'

const LANGUAGES: Language[] = ['en', 'de', 'es', 'fr', 'pt', 'zh-CN', 'zh-TW']

/** Keys that render as-is. */
const PLAIN = [
  'reconcileMovedPaths.offline',
  'reconcileMovedPaths.notSignedIn',
  'reconcileMovedPaths.noOrganization',
  'reconcileMovedPaths.noVault',
  'reconcileMovedPaths.nothingToReconcile',
  'reconcileMovedPaths.unknownHolder',
  'reconcileMovedPaths.dryRunNote',
  'reconcileMovedPaths.confirmUnavailable',
  'reconcileMovedPaths.declined',
  'reconcileMovedPaths.unknownError',
] as const

/** Keys whose sentence carries a single count, so a translator can place it. */
const COUNTED = [
  'reconcileMovedPaths.reportHeading',
  'reconcileMovedPaths.reportEligible',
  'reconcileMovedPaths.reportBlocked',
  'reconcileMovedPaths.reportConflict',
  'reconcileMovedPaths.reportUnverified',
  'reconcileMovedPaths.reportAndMore',
  'reconcileMovedPaths.confirmTitle',
  'reconcileMovedPaths.confirmMessage',
  'reconcileMovedPaths.confirmText',
  'reconcileMovedPaths.progress',
  'reconcileMovedPaths.summaryComplete',
  'reconcileMovedPaths.summaryFailed',
  'reconcileMovedPaths.summaryNotAttempted',
  'reconcileMovedPaths.summaryBlocked',
  'reconcileMovedPaths.summarySkipped',
] as const

/** Keys taking more than one value, each with the full set the command passes. */
const MULTI: Array<[string, Record<string, string | number>]> = [
  ['reconcileMovedPaths.reportHolder', { count: 12, user: 'Ana Ruiz' }],
  ['reconcileMovedPaths.reportItem', { from: 'old/a.sldprt', to: 'new/a.sldprt' }],
  ['reconcileMovedPaths.dryRunSummary', { eligible: 440, total: 455 }],
  ['reconcileMovedPaths.refused', { count: 15, holders: '12 held by Ana Ruiz' }],
  ['reconcileMovedPaths.nothingEligible', { blocked: 15, skipped: 3 }],
  [
    'reconcileMovedPaths.confirmRemainder',
    { count: 18, detail: '15 checked out by others, 3 skipped' },
  ],
  ['reconcileMovedPaths.failureItem', { path: 'new/a.sldprt', error: 'RPC refused' }],
  [
    'reconcileMovedPaths.summaryPartial',
    { succeeded: 440, total: 455, leftovers: '15 checked out by others' },
  ],
]

describe.each(LANGUAGES)('reconcile-moved-paths keys in %s', (language) => {
  it.each(PLAIN)('resolves %s to a sentence rather than to the key', (key) => {
    const text = getTranslation(language, key)

    expect(text).not.toBe(key)
    expect(text.length).toBeGreaterThan(0)
  })

  it.each(COUNTED)('resolves %s and substitutes the count', (key) => {
    const text = getTranslation(language, key, { count: 455 })

    expect(text).not.toBe(key)
    expect(text).toContain('455')
    expect(text).not.toMatch(/\{\{\w+\}\}/)
  })

  it.each(MULTI)('leaves no placeholder unfilled in %s', (key, params) => {
    const text = getTranslation(language, key, params)

    expect(text).not.toBe(key)
    expect(text).not.toMatch(/\{\{\w+\}\}/)
  })
})

describe('translation coverage', () => {
  /**
   * A locale that has not translated these yet must serve the English text rather than the key.
   * `getTranslation` falls back per key, not per file, which is what makes that safe.
   */
  it('serves English to a locale outside the seven', () => {
    expect(getTranslation('ja', 'reconcileMovedPaths.declined')).toBe(
      getTranslation('en', 'reconcileMovedPaths.declined'),
    )
  })

  it('translated the refusal in every locale rather than inheriting English', () => {
    // The refusal is the sentence that stops a 455-row write, so it is the one worth checking is
    // actually present in each dictionary rather than falling through.
    const english = getTranslation('en', 'reconcileMovedPaths.refused', { count: 1, holders: 'x' })

    for (const language of LANGUAGES.filter((l) => l !== 'en')) {
      expect(
        getTranslation(language, 'reconcileMovedPaths.refused', { count: 1, holders: 'x' }),
      ).not.toBe(english)
    }
  })
})
