import { HardDrive, Trash2, ArrowUp, AlertTriangle, Move, ArrowUpRight } from 'lucide-react'
import { t } from '@/lib/i18n'

export interface DiffStatusBadgeProps {
  diffStatus: string | undefined
  statusIconSize: number
  hasCheckoutUsers: boolean
  /**
   * For a `moved_away` stub only: the vault-relative path where the file's content now
   * actually lives locally. Stamped in at merge time by `useLoadFiles` — see
   * `LocalFile.movedToRelativePath`.
   */
  movedToRelativePath?: string
}

/**
 * Badge showing file diff status (modified, deleted, outdated, etc.)
 */
export function DiffStatusBadge({
  diffStatus,
  statusIconSize,
  hasCheckoutUsers,
  movedToRelativePath,
}: DiffStatusBadgeProps) {
  // Don't show if there are checkout users displayed
  if (hasCheckoutUsers) return null

  switch (diffStatus) {
    case 'added':
    case 'ignored':
      return (
        <span title={t('diffStatus.added')}>
          <HardDrive size={statusIconSize} className="text-plm-fg-muted" />
        </span>
      )
    case 'deleted_remote':
      return (
        <span title={t('fileStatus.deletedFromServer')}>
          <Trash2 size={statusIconSize} className="text-plm-error" />
        </span>
      )
    case 'modified':
      return (
        <span title={t('diffStatus.modified')}>
          <ArrowUp size={statusIconSize} className="text-yellow-400" />
        </span>
      )
    case 'outdated':
      return (
        <span title={t('diffStatus.outdated')}>
          <AlertTriangle size={statusIconSize} className="text-purple-400" />
        </span>
      )
    case 'moved':
      // This file's content lives here locally, but the vault still records it under a
      // different path - a pending move waiting to be resolved.
      return (
        <span title={t('fileStatus.movedTooltip')}>
          <Move size={statusIconSize} className="text-blue-400" />
        </span>
      )
    case 'moved_away':
      // A signpost, not a file: nothing lives here locally. Deliberately muted relative to
      // 'moved' so it never reads as a second problem alongside its partner row.
      return (
        <span
          title={
            movedToRelativePath
              ? t('fileStatus.movedAwayTooltipTo', { path: movedToRelativePath })
              : t('fileStatus.movedAwayTooltip')
          }
        >
          <ArrowUpRight size={statusIconSize} className="text-blue-400/60" />
        </span>
      )
    default:
      return null
  }
}
