/**
 * Utility Functions Barrel Export
 *
 * Re-exports all utility functions from categorized modules.
 * Import from here for convenience, or import from specific modules
 * for smaller bundles.
 *
 * @example
 * // Barrel import (convenient)
 * import { formatFileSize, truncate, buildFullPath } from '@/lib/utils'
 *
 * // Specific import (tree-shakeable)
 * import { formatFileSize } from '@/lib/utils/format'
 * import { truncate } from '@/lib/utils/string'
 */

// Avatar utilities
export {
  AVATAR_COLORS,
  type AvatarColor,
  getInitials,
  getAvatarColor,
  getEffectiveAvatarUrl,
} from './avatar'

// File utilities
export { getFileType, getFileIconType, isCADFile } from './file'

// Date utilities
export {
  formatDate,
  formatDateTime,
  formatRelativeTime,
  isSameDay,
  startOfDay,
  endOfDay,
  toISODateString,
  isPast,
  isFuture,
} from './date'

// String utilities
export {
  truncate,
  capitalize,
  toTitleCase,
  slugify,
  escapeHtml,
  generateId,
  camelToKebab,
  kebabToCamel,
  pluralize,
  normalizeWhitespace,
  getCountLabel,
  plural,
} from './string'

// Path utilities
export {
  sep,
  normalizePath,
  toForwardSlash,
  getFileName,
  getExtension,
  getBaseName,
  getDirectory,
  getParentDir,
  joinPath,
  buildFullPath,
  getRelativePath,
  isAbsolutePath,
  isPathWithinDirectory,
  ensureTrailingSeparator,
} from './path'

// LIKE pattern utilities
export { escapeLikePattern, folderPrefixLikePattern } from './likePattern'

// Format utilities
export {
  formatFileSize,
  formatBytes,
  formatSpeed,
  formatNumber,
  formatPercent,
  formatDuration,
  formatCompactNumber,
  formatCurrency,
  padNumber,
  formatDecimal,
} from './format'

// Validation utilities
export {
  isValidEmail,
  isBlank,
  isNotBlank,
  isValidUrl,
  sanitizeFileName,
  isSafePath,
  isValidLength,
  isAlphanumeric,
  isValidIdentifier,
  isValidNumber,
  isValidUUID,
  isAllowedExtension,
} from './validation'
