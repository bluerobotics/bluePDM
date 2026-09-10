// src/features/source/context-menu/items/MovedFileItems.tsx
import { Move } from 'lucide-react'
import { t } from '@/lib/i18n'
import type { LocalFile } from '@/stores/pdmStore'
import type { DialogName } from '../types'

interface MovedFileItemsProps {
  firstFile: LocalFile
  multiSelect: boolean
  openDialog: (name: DialogName) => void
}

/**
 * A single-file entry point into `ResolveMovedFilesDialog`, for the file the user is already
 * looking at rather than the folder-tree badge. `'moved'` and `'moved_away'` are the exact two
 * statuses `FileStatusCell` and `DiffStatusBadge` treat as "this file is part of a pending move"
 * (see `.cursor/plans/pending-move-visibility-agent2-report.md`).
 */
export function MovedFileItems({ firstFile, multiSelect, openDialog }: MovedFileItemsProps) {
  const isMoved = firstFile.diffStatus === 'moved' || firstFile.diffStatus === 'moved_away'

  if (multiSelect || !isMoved) return null

  return (
    <>
      <div className="context-menu-separator" />
      <div
        className="context-menu-item text-plm-info"
        onClick={() => openDialog('resolveMoves')}
      >
        <Move size={14} />
        {t('resolveMoves.contextMenuItem')}
      </div>
    </>
  )
}
