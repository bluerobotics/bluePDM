/**
 * LIKE pattern helpers.
 *
 * A deliberate copy of `src/lib/utils/likePattern.ts`, which is the canonical
 * implementation and carries the full rationale. The API is a separate npm
 * package with its own `node_modules`, and `tsconfig.build.json` sets `rootDir`
 * to `api/` so `dist/` mirrors this directory; importing a module from outside
 * it fails the build rather than producing a shared module. Duplicating two
 * pure string functions, tested on both sides, is cheaper than a cross-boundary
 * import path. Change both together.
 */

/**
 * Escape the LIKE metacharacters in `value` so `.like()`/`.ilike()` compares it
 * as text rather than as a pattern.
 *
 * Backslash is LIKE's default escape character and must be doubled first, or the
 * backslashes added for `%` and `_` are themselves escaped. Same order as
 * `like_escape()` in `supabase/core.sql`.
 *
 * `*` is deliberately not escaped: PostgREST rewrites `*` to `%` in `like`/`ilike`
 * patterns unconditionally, so `\*` arrives as `\%` - a literal percent, not a
 * literal asterisk - and no escape survives the rewrite. Harmless here because
 * `*` is an illegal character in a Windows file name.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Build the pattern that matches everything stored beneath `folderPath`.
 *
 * The `/` before the wildcard is what makes this a folder match rather than a
 * string prefix: without it, `Parts%` also answers with `PartsOld/a.sldprt`.
 * Trailing separators are dropped so the boundary is added exactly once, and an
 * empty path yields an empty pattern, which matches nothing.
 */
export function folderPrefixLikePattern(folderPath: string): string {
  const trimmed = folderPath.replace(/[/\\]+$/, '')
  if (!trimmed) return ''

  return `${escapeLikePattern(trimmed)}/%`
}
