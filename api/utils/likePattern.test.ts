/**
 * The API's copy of the LIKE escaping helpers.
 *
 * Duplicated from `src/lib/utils/likePattern.ts` because `api/` builds with
 * `rootDir` set to this directory and cannot import from outside it. The copy
 * is only worth having if it is held to the same behaviour, so these cases
 * mirror `src/lib/utils/likePattern.test.ts` and interpret the result with
 * LIKE's own semantics rather than comparing escape sequences.
 */

import { describe, expect, it } from 'vitest'

import { escapeLikePattern, folderPrefixLikePattern } from './likePattern.js'

/** Translate a LIKE pattern into the equivalent regular expression. */
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

function matches(pattern: string, candidate: string): boolean {
  return likeToRegExp(pattern).test(candidate)
}

describe('escapeLikePattern', () => {
  it('does not take PartXFiles for Part_Files', () => {
    const pattern = escapeLikePattern('Part_Files.sldprt')

    expect(matches(pattern, 'Part_Files.sldprt')).toBe(true)
    expect(matches(pattern, 'PartXFiles.sldprt')).toBe(false)
  })

  it('keeps a literal backslash literal', () => {
    // The escape this copy was missing: unescaped, the backslash becomes the
    // pattern's own escape character and changes what follows it.
    const pattern = escapeLikePattern('Legacy\\_Parts')

    expect(matches(pattern, 'Legacy\\_Parts')).toBe(true)
    expect(matches(pattern, 'Legacy\\XParts')).toBe(false)
    expect(matches(pattern, 'LegacyX_Parts')).toBe(false)
  })

  it('escapes the backslash before the escapes it introduces', () => {
    const pattern = escapeLikePattern('Reports%')

    expect(matches(pattern, 'Reports%')).toBe(true)
    expect(matches(pattern, 'ReportsArchive')).toBe(false)
  })
})

describe('folderPrefixLikePattern', () => {
  it('does not reach into PartsOld when asked for Parts', () => {
    const pattern = folderPrefixLikePattern('Parts')

    expect(matches(pattern, 'Parts/Bracket.SLDPRT')).toBe(true)
    expect(matches(pattern, 'Parts/Sub/Bracket.SLDPRT')).toBe(true)
    expect(matches(pattern, 'PartsOld/Bracket.SLDPRT')).toBe(false)
  })

  it('escapes the folder name as well as bounding it', () => {
    const pattern = folderPrefixLikePattern('Part_Files')

    expect(matches(pattern, 'Part_Files/Sub/a.sldprt')).toBe(true)
    expect(matches(pattern, 'PartXFiles/Sub/a.sldprt')).toBe(false)
  })

  it('adds the separator exactly once, and matches nothing when given nothing', () => {
    expect(folderPrefixLikePattern('Parts/')).toBe('Parts/%')
    expect(folderPrefixLikePattern('')).toBe('')
  })
})
