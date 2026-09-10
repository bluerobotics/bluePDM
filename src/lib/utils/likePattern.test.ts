/**
 * What the escaped pattern actually matches.
 *
 * These tests do not compare strings against expected escape sequences - that
 * only says the function is what it is. They interpret the result with LIKE's
 * own semantics, so a wrong escape shows up as the wrong set of paths matching.
 */

import { describe, expect, it } from 'vitest'

import { escapeLikePattern, folderPrefixLikePattern } from './likePattern'

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

function matches(pattern: string, candidate: string): boolean {
  return likeToRegExp(pattern).test(candidate)
}

describe('escapeLikePattern', () => {
  it('does not take PartXFiles for Part_Files', () => {
    // `_` is legal in a Windows name and is LIKE's single-character wildcard,
    // which is how an existence check answered with the wrong row entirely.
    const pattern = escapeLikePattern('Part_Files.sldprt')

    expect(matches(pattern, 'Part_Files.sldprt')).toBe(true)
    expect(matches(pattern, 'PartXFiles.sldprt')).toBe(false)
  })

  it('keeps a literal backslash literal', () => {
    // The escape all three copies of this used to miss. Unescaped, the
    // backslash becomes the pattern's own escape character and swallows the
    // meaning of whatever follows it - here it would turn the `_` back into a
    // wildcard, which is exactly the case the other escapes were added for.
    const pattern = escapeLikePattern('Legacy\\_Parts')

    expect(matches(pattern, 'Legacy\\_Parts')).toBe(true)
    expect(matches(pattern, 'Legacy\\XParts')).toBe(false)
    expect(matches(pattern, 'LegacyX_Parts')).toBe(false)
  })

  it('escapes the backslash before the escapes it introduces', () => {
    // Order matters: escaping `%` first and `\` second doubles the backslash
    // that was just added, and the `%` goes back to being a wildcard.
    const pattern = escapeLikePattern('Reports%')

    expect(matches(pattern, 'Reports%')).toBe(true)
    expect(matches(pattern, 'ReportsArchive')).toBe(false)
  })

  it('leaves an ordinary path alone', () => {
    expect(escapeLikePattern('Parts/Bracket.SLDPRT')).toBe('Parts/Bracket.SLDPRT')
  })
})

describe('folderPrefixLikePattern', () => {
  it('does not reach into PartsOld when asked for Parts', () => {
    // The boundary the two read-only filters were missing: `Parts%` matched
    // every sibling folder that merely started with the same letters.
    const pattern = folderPrefixLikePattern('Parts')

    expect(matches(pattern, 'Parts/Bracket.SLDPRT')).toBe(true)
    expect(matches(pattern, 'Parts/Sub/Bracket.SLDPRT')).toBe(true)
    expect(matches(pattern, 'PartsOld/Bracket.SLDPRT')).toBe(false)
    expect(matches(pattern, 'Parts')).toBe(false)
  })

  it('escapes the folder name as well as bounding it', () => {
    const pattern = folderPrefixLikePattern('Part_Files')

    expect(matches(pattern, 'Part_Files/Sub/a.sldprt')).toBe(true)
    expect(matches(pattern, 'PartXFiles/Sub/a.sldprt')).toBe(false)
  })

  it('adds the separator exactly once whatever the caller passed', () => {
    expect(folderPrefixLikePattern('Parts/')).toBe('Parts/%')
    expect(folderPrefixLikePattern('Parts\\')).toBe('Parts/%')
    expect(folderPrefixLikePattern('Parts')).toBe('Parts/%')
  })

  it('matches nothing rather than everything when the folder is empty', () => {
    // A caller that lost track of which folder it meant should touch no rows.
    // `/%` would have matched every absolute path in the table.
    const pattern = folderPrefixLikePattern('')

    expect(pattern).toBe('')
    expect(matches(pattern, 'Parts/Bracket.SLDPRT')).toBe(false)
  })
})
