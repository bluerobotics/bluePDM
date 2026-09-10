/**
 * File path utilities - platform-aware
 *
 * Pure utility functions for file path manipulation.
 * Works on both Windows (backslash) and macOS/Linux (forward slash).
 * No side effects, no API calls, no store access.
 */

/**
 * Platform-specific path separator
 * Detected at runtime based on navigator.platform
 */
export const sep: string =
  typeof window !== 'undefined' && navigator.platform.includes('Win') ? '\\' : '/'

/**
 * Normalize path separators to the platform default
 *
 * @param path - File path with mixed separators
 * @returns Path with platform-native separators
 *
 * @example
 * // On Windows:
 * normalizePath("foo/bar/baz") // "foo\\bar\\baz"
 * // On macOS:
 * normalizePath("foo\\bar\\baz") // "foo/bar/baz"
 */
export function normalizePath(path: string): string {
  if (!path) return path
  return path.replace(/[/\\]/g, sep)
}

/**
 * Normalize path separators to forward slashes
 * Useful for URLs, storage paths, and cross-platform storage
 *
 * @param path - File path
 * @returns Path with forward slashes only
 *
 * @example
 * toForwardSlash("C:\\Users\\name\\file.txt") // "C:/Users/name/file.txt"
 */
export function toForwardSlash(path: string): string {
  if (!path) return path
  return path.replace(/\\/g, '/')
}

/**
 * Get the file name from a path (last segment)
 *
 * @param path - Full file path
 * @returns File name including extension
 *
 * @example
 * getFileName("C:\\Users\\name\\file.txt") // "file.txt"
 * getFileName("/home/user/document.pdf") // "document.pdf"
 */
export function getFileName(path: string): string {
  if (!path) return ''
  const normalized = toForwardSlash(path)
  return normalized.split('/').pop() || ''
}

/**
 * Get the file extension (including the dot)
 *
 * @param path - File path or file name
 * @returns Extension with leading dot, lowercase (e.g., ".txt")
 *
 * @example
 * getExtension("document.PDF") // ".pdf"
 * getExtension("archive.tar.gz") // ".gz"
 * getExtension("no-extension") // ""
 */
export function getExtension(path: string): string {
  const fileName = getFileName(path)
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

/**
 * Get the file name without extension (basename)
 *
 * @param path - File path or file name
 * @returns File name without the extension
 *
 * @example
 * getBaseName("document.pdf") // "document"
 * getBaseName("/path/to/file.txt") // "file"
 */
export function getBaseName(path: string): string {
  const fileName = getFileName(path)
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName
}

/**
 * Get the parent directory path
 *
 * @param path - Full file or directory path
 * @returns Parent directory path
 *
 * @example
 * getDirectory("C:\\Users\\name\\file.txt") // "C:/Users/name"
 * getDirectory("/home/user/docs/file.pdf") // "/home/user/docs"
 */
export function getDirectory(path: string): string {
  if (!path) return ''
  const normalized = toForwardSlash(path)
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : ''
}

/**
 * Get the parent directory path (alias for getDirectory)
 * Preserves original separator style
 *
 * @param fullPath - Full file or directory path
 * @returns Parent directory path
 *
 * @example
 * getParentDir("C:\\Users\\name\\file.txt") // "C:\\Users\\name"
 * getParentDir("/home/user/file.txt") // "/home/user"
 */
export function getParentDir(fullPath: string): string {
  if (!fullPath) return fullPath
  const lastSlash = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'))
  return lastSlash > 0 ? fullPath.substring(0, lastSlash) : fullPath
}

/**
 * Join path segments with the platform separator
 *
 * @param segments - Path segments to join
 * @returns Joined path with platform separators
 *
 * @example
 * joinPath("C:\\Users", "name", "file.txt") // "C:\\Users\\name\\file.txt" (Windows)
 * joinPath("/home", "user", "file.txt") // "/home/user/file.txt" (macOS)
 */
export function joinPath(...segments: string[]): string {
  return segments
    .filter(Boolean)
    .map((s) => s.replace(/^[/\\]+|[/\\]+$/g, ''))
    .join(sep)
}

/**
 * Build a full path from vault path and relative path
 * Handles cross-platform path separators (Windows vs macOS/Linux)
 *
 * @param vaultPath - Base vault directory path
 * @param relativePath - Relative path within the vault
 * @returns Full combined path
 *
 * @example
 * buildFullPath("C:\\Vaults\\main", "parts/assembly.sldasm")
 * // "C:\\Vaults\\main\\parts\\assembly.sldasm"
 */
export function buildFullPath(vaultPath: string, relativePath: string): string {
  if (!relativePath) return vaultPath
  if (!vaultPath) return relativePath

  const isWindows = vaultPath.includes('\\')
  const pathSep = isWindows ? '\\' : '/'
  const normalizedRelative = relativePath.replace(/[/\\]/g, pathSep)

  // Remove leading separator from relative path if present
  const cleanRelative = normalizedRelative.replace(/^[/\\]+/, '')

  return `${vaultPath}${pathSep}${cleanRelative}`
}

/**
 * Get relative path from a full path given a base vault path
 *
 * @param fullPath - Full file path
 * @param vaultPath - Base vault directory path
 * @returns Relative path from vault, or original path if not inside vault
 *
 * @example
 * getRelativePath("C:\\Vaults\\main\\parts\\file.txt", "C:\\Vaults\\main")
 * // "parts\\file.txt"
 */
export function getRelativePath(fullPath: string, vaultPath: string): string {
  if (!fullPath || !vaultPath) return fullPath || ''

  const normalizedFull = toForwardSlash(fullPath).toLowerCase()
  const normalizedVault = toForwardSlash(vaultPath).toLowerCase()

  if (normalizedFull.startsWith(normalizedVault)) {
    const relative = fullPath.slice(vaultPath.length)
    return relative.replace(/^[/\\]+/, '')
  }
  return fullPath
}

/**
 * Check whether a path is a directory or something beneath it.
 *
 * Matching is on a separator boundary, never a bare prefix, so deleting "Fixed Lens"
 * leaves "Fixed Lens Models" alone. Separators and case are normalised because vault
 * paths reach here in both spellings and Windows treats them as the same file.
 *
 * An empty directory matches nothing rather than everything: a caller that lost track
 * of which folder it meant should touch no rows at all.
 *
 * @param candidate - Path to test
 * @param directory - Directory path the candidate may live in
 * @returns True when candidate is the directory itself or a descendant of it
 *
 * @example
 * isPathWithinDirectory("Fixed Lens/a.sldprt", "Fixed Lens") // true
 * isPathWithinDirectory("Fixed Lens Models/a.sldprt", "Fixed Lens") // false
 */
export function isPathWithinDirectory(candidate: string, directory: string): boolean {
  if (!candidate || !directory) return false

  const normalizedCandidate = toForwardSlash(candidate).toLowerCase()
  const normalizedDirectory = toForwardSlash(directory).toLowerCase().replace(/\/+$/, '')
  if (!normalizedDirectory) return false

  return (
    normalizedCandidate === normalizedDirectory ||
    normalizedCandidate.startsWith(normalizedDirectory + '/')
  )
}

/**
 * Check if a path is absolute (starts with drive letter or root)
 *
 * @param path - Path to check
 * @returns True if path is absolute
 *
 * @example
 * isAbsolutePath("C:\\Users\\name") // true
 * isAbsolutePath("/home/user") // true
 * isAbsolutePath("relative/path") // false
 */
export function isAbsolutePath(path: string): boolean {
  if (!path) return false
  // Windows: starts with drive letter (C:\)
  if (/^[a-zA-Z]:[\\/]/.test(path)) return true
  // Unix: starts with /
  if (path.startsWith('/')) return true
  return false
}

/**
 * Ensure a path ends with a separator
 *
 * @param path - Directory path
 * @returns Path with trailing separator
 *
 * @example
 * ensureTrailingSeparator("C:\\Users") // "C:\\Users\\"
 */
export function ensureTrailingSeparator(path: string): string {
  if (!path) return path
  if (path.endsWith('/') || path.endsWith('\\')) return path
  return path + sep
}
