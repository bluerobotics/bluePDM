/**
 * Keys added for the 4.3.1 realtime-deletion auto-discard toast
 * (`autoDiscard.removed.generic` / `autoDiscard.removed.fromFolder`), which replaced the
 * 4.3.0 confirmation dialog's `autoDiscard.largeBatch.*` keys. Those old keys are gone
 * outright (see `useLoadFiles.test.ts` and the grep in the release report confirming no
 * remaining references), so nothing needs a fallback test for them.
 *
 * These three keys (plus `autoDiscard.failed.generic`) were originally a single string
 * per key with a `{{plural}}` placeholder, computed by the *caller* as the English
 * suffix `'s'`. That put another language's morphology in the hands of code that only
 * knows English - wrong for German (`Datei`/`Dateien` is not a suffix) and wrong for
 * Spanish at count 1 (the verb and adjective are hardcoded plural). They are now
 * `_one`/`_other` key pairs, so each locale writes its own complete singular and plural
 * sentence and the caller only selects which one to use by count - the same convention
 * as every other count-dependent string added since (see `newKeys.test.ts`'s `COUNTED`
 * keys) would use if they needed distinct plural forms rather than a number placed
 * mid-sentence.
 *
 * Every one of the seven locales was given a real translation rather than left to the
 * English fallback, so — unlike `newKeys.test.ts` — this file also asserts each
 * non-English locale differs from English, to catch a locale file that was accidentally
 * left untouched.
 */

import { describe, expect, it } from 'vitest'

import { getTranslation } from './index'
import { de, en, es, fr, pt, zhCN, zhTW } from './locales'
import type { Language, TranslationDict, TranslationValue } from './types'

const NON_ENGLISH_LOCALES: Language[] = ['de', 'es', 'fr', 'pt', 'zh-CN', 'zh-TW']

/** Locales where the plural form must read differently from the singular form. */
const INFLECTED_LOCALES: Language[] = ['en', 'de', 'es', 'fr', 'pt']

/** Locales where singular and plural are expected to be the same text - no plural inflection. */
const UNINFLECTED_LOCALES: Language[] = ['zh-CN', 'zh-TW']

const KEY_PAIRS = [
  ['autoDiscard.removed.generic_one', 'autoDiscard.removed.generic_other'],
  ['autoDiscard.removed.fromFolder_one', 'autoDiscard.removed.fromFolder_other'],
  ['autoDiscard.failed.generic_one', 'autoDiscard.failed.generic_other'],
] as const

describe('autoDiscard.removed keys', () => {
  it.each(NON_ENGLISH_LOCALES)('resolves autoDiscard.removed.generic_other for %s', (language) => {
    const text = getTranslation(language, 'autoDiscard.removed.generic_other', { count: 3 })

    expect(text).not.toBe('autoDiscard.removed.generic_other')
    expect(text).toContain('3')
    expect(text).not.toMatch(/\{\{\w+\}\}/)
    // Confirms this locale was actually translated, not silently served the English
    // dictionary's text via getTranslation's per-key fallback.
    expect(text).not.toBe(getTranslation('en', 'autoDiscard.removed.generic_other', { count: 3 }))
  })

  it.each(NON_ENGLISH_LOCALES)('resolves autoDiscard.removed.fromFolder_other for %s', (language) => {
    const text = getTranslation(language, 'autoDiscard.removed.fromFolder_other', {
      count: 5,
      folder: 'RADCAM',
    })

    expect(text).not.toBe('autoDiscard.removed.fromFolder_other')
    expect(text).toContain('5')
    expect(text).toContain('RADCAM')
    expect(text).not.toMatch(/\{\{\w+\}\}/)
    expect(text).not.toBe(
      getTranslation('en', 'autoDiscard.removed.fromFolder_other', {
        count: 5,
        folder: 'RADCAM',
      }),
    )
  })

  it('resolves the English singular and plural forms distinctly', () => {
    const singular = getTranslation('en', 'autoDiscard.removed.generic_one', { count: 1 })
    const other = getTranslation('en', 'autoDiscard.removed.generic_other', { count: 2 })

    expect(singular).toBe('Removed 1 file deleted from the vault')
    expect(other).toBe('Removed 2 files deleted from the vault')
  })

  it('names the folder in the English fromFolder form', () => {
    const text = getTranslation('en', 'autoDiscard.removed.fromFolder_other', {
      count: 5,
      folder: 'RADCAM',
    })

    expect(text).toBe('Removed 5 files from RADCAM (deleted from the vault)')
  })

  it('has no leftover reference to the removed largeBatch dialog keys', () => {
    // These resolved to a sentence before 4.3.1 removed the dialog. Now that nothing
    // defines them, getTranslation has no English text to fall back to either, so it
    // returns the raw key - the same signal newKeys.test.ts relies on for a truly
    // missing key.
    expect(getTranslation('en', 'autoDiscard.largeBatch.title')).toBe(
      'autoDiscard.largeBatch.title',
    )
  })

  it('has no leftover reference to the old single-key {{plural}} shape', () => {
    // The pre-fix keys took a `plural` placeholder computed by the caller. If either
    // survived, getTranslation would return raw English text containing `{{plural}}`
    // rather than falling through to the key, since these old keys no longer exist in
    // en.ts and getTranslation only returns the raw key when English has nothing either.
    expect(getTranslation('en', 'autoDiscard.removed.generic')).toBe(
      'autoDiscard.removed.generic',
    )
    expect(getTranslation('en', 'autoDiscard.removed.fromFolder')).toBe(
      'autoDiscard.removed.fromFolder',
    )
    expect(getTranslation('en', 'autoDiscard.failed.generic')).toBe('autoDiscard.failed.generic')
  })
})

describe('autoDiscard plural-form structure across all seven locales', () => {
  const LOCALE_DICTS: Record<Language, TranslationDict> = {
    en,
    de,
    es,
    fr,
    pt,
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    // Unused by these tests - present only because `Language` includes locales that
    // fall back to English rather than having their own dictionary (see index.ts).
    it: en,
    nl: en,
    sv: en,
    pl: en,
    ru: en,
    ja: en,
    ko: en,
    sindarin: en,
  }

  /** Narrows one level of nesting: `autoDiscard` itself is a group of groups, not a leaf string. */
  function asGroup(value: TranslationValue): Record<string, TranslationValue> {
    if (typeof value === 'string') {
      throw new Error('Expected a nested group, got a leaf string')
    }
    return value
  }

  /** Narrows the innermost level: each `removed`/`failed` group is leaf strings only. */
  function asLeaves(value: TranslationValue): Record<string, string> {
    const group = asGroup(value)
    const result: Record<string, string> = {}
    for (const [key, leaf] of Object.entries(group)) {
      if (typeof leaf !== 'string') {
        throw new Error(`Expected ${key} to be a leaf string`)
      }
      result[key] = leaf
    }
    return result
  }

  const keySetFor = (language: Language): string[] => {
    const groups = asGroup(LOCALE_DICTS[language].autoDiscard)
    const keys: string[] = []
    for (const group of Object.keys(groups).sort()) {
      const leaves = asLeaves(groups[group])
      for (const leaf of Object.keys(leaves).sort()) {
        keys.push(`${group}.${leaf}`)
      }
    }
    return keys
  }

  it('exposes exactly the same autoDiscard key set in every locale', () => {
    const expected = keySetFor('en')
    expect(expected).toEqual([
      'failed.generic_one',
      'failed.generic_other',
      'removed.fromFolder_one',
      'removed.fromFolder_other',
      'removed.generic_one',
      'removed.generic_other',
    ])

    for (const language of NON_ENGLISH_LOCALES) {
      expect(keySetFor(language)).toEqual(expected)
    }
  })

  it.each(INFLECTED_LOCALES)('gives %s a plural form distinct from the singular form', (language) => {
    for (const [oneKey, otherKey] of KEY_PAIRS) {
      const singular = getTranslation(language, oneKey, { count: 1, folder: 'RADCAM' })
      const other = getTranslation(language, otherKey, { count: 2, folder: 'RADCAM' })

      expect(other).not.toBe(singular)
    }
  })

  it.each(UNINFLECTED_LOCALES)('gives %s identical singular and plural text', (language) => {
    for (const [oneKey, otherKey] of KEY_PAIRS) {
      const singular = getTranslation(language, oneKey, { count: 1, folder: 'RADCAM' })
      // Compare with the count placeholder held constant, since Chinese has no plural
      // inflection and the count itself is expected to differ between the two calls the
      // real caller makes.
      const other = getTranslation(language, otherKey, { count: 1, folder: 'RADCAM' })

      expect(other).toBe(singular)
    }
  })

  it('gets the German plural noun right (Dateien, not the English-shaped Dateis)', () => {
    expect(getTranslation('de', 'autoDiscard.removed.generic_other', { count: 5 })).toBe(
      '5 Dateien entfernt (aus dem Tresor gelöscht)',
    )
    expect(getTranslation('de', 'autoDiscard.removed.generic_one', { count: 1 })).toBe(
      '1 Datei entfernt (aus dem Tresor gelöscht)',
    )
  })

  it('agrees in number in Spanish, both verb and adjective, in both forms', () => {
    expect(getTranslation('es', 'autoDiscard.removed.generic_one', { count: 1 })).toBe(
      'Se eliminó 1 archivo borrado de la bóveda',
    )
    expect(getTranslation('es', 'autoDiscard.removed.generic_other', { count: 4 })).toBe(
      'Se eliminaron 4 archivos borrados de la bóveda',
    )
  })
})
