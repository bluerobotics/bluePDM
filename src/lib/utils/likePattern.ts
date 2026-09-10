/**
 * LIKE pattern helpers - the canonical implementation.
 *
 * PostgREST has no case-insensitive equality operator, so every case-insensitive
 * path comparison in this codebase goes through `.ilike()`, which reads its
 * argument as a LIKE pattern. Vault paths routinely contain LIKE metacharacters
 * (`_` is legal and common in a Windows file name), so the value has to be
 * escaped before it is used as a pattern or the comparison quietly widens.
 *
 * `api/utils/likePattern.ts` carries a copy of these two functions. The API is a
 * separate npm package with its own `node_modules` and a build whose `rootDir`
 * is `api/`, so a file outside that directory cannot be imported without either
 * breaking `npm run build` in `api/` or inventing a shared package; a duplicate
 * with tests on both sides is the cheaper trade. Change both together.
 */

/**
 * Escape the LIKE metacharacters in `value` so `.like()`/`.ilike()` compares it
 * as text rather than as a pattern.
 *
 * Backslash is LIKE's default escape character and must be doubled first, or the
 * backslashes added for `%` and `_` are themselves escaped and the pattern means
 * something else again. This is the same order `like_escape()` uses in
 * `supabase/core.sql`.
 *
 * `*` is deliberately not escaped. PostgREST rewrites `*` to `%` in `like`/`ilike`
 * patterns before PostgreSQL sees them, and it does so unconditionally - sending
 * `\*` yields `\%`, a literal percent, not a literal asterisk - so there is no
 * escape that survives the rewrite. It costs nothing today because `*` is an
 * illegal character in a Windows file name, which is the only kind of path
 * reaching these queries.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Build the pattern that matches everything stored beneath `folderPath`.
 *
 * The `/` before the wildcard is what makes this a folder match rather than a
 * string prefix: without it, `Parts%` also answers with `PartsOld/a.sldprt`, and
 * a rename or a folder listing built on that pattern reaches into a sibling
 * folder. Any trailing separators the caller happens to hold are dropped so the
 * boundary is added exactly once.
 *
 * An empty path yields an empty pattern, which matches nothing: a caller that
 * lost track of which folder it meant should touch no rows rather than all of
 * them.
 */
export function folderPrefixLikePattern(folderPath: string): string {
  const trimmed = folderPath.replace(/[/\\]+$/, '')
  if (!trimmed) return ''

  return `${escapeLikePattern(trimmed)}/%`
}
