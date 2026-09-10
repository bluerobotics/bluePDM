/**
 * Sync actions for context menu (download, first check in, ignore)
 */
import React from 'react'
import { ArrowDown, ArrowUp, EyeOff, FileX, FolderX, RefreshCw } from 'lucide-react'
import { t } from '@/lib/i18n'
import type { LocalFile } from '@/stores/pdmStore'
import { usePDMStore } from '@/stores/pdmStore'
import { executeCommand, getCloudOnlyFilesFromSelection } from '@/lib/commands'
import { getOutdatedFilesFromSelection } from '@/lib/commands/handlers/getLatest'
import type { RefreshableActionProps, SelectionCounts, SelectionState } from './types'
import { ContextSubmenu } from '../components'

interface SyncActionsProps extends RefreshableActionProps {
  counts: SelectionCounts
  state: SelectionState
  unsyncedFilesInSelection: LocalFile[]
  showIgnoreSubmenu: boolean
  setShowIgnoreSubmenu: (show: boolean) => void
  ignoreSubmenuTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>
}

export function SyncActions({
  contextFiles,
  multiSelect,
  firstFile,
  onClose,
  onRefresh,
  counts,
  state,
  unsyncedFilesInSelection,
  showIgnoreSubmenu,
  setShowIgnoreSubmenu,
  ignoreSubmenuTimeoutRef,
}: SyncActionsProps) {
  const { files, activeVaultId, addIgnorePattern, getIgnorePatterns, addToast } = usePDMStore()

  const anyCloudOnly =
    counts.cloudOnlyCount > 0 || contextFiles.some((f) => f.diffStatus === 'cloud')

  // Cloud-only files drive the Download item; outdated files drive the Get Latest item below.
  // The two sets never overlap - each file is either 'cloud' or 'outdated', never both.
  const cloudOnlyFilesInSelection = getCloudOnlyFilesFromSelection(files, contextFiles)
  const outdatedFilesInSelection = getOutdatedFilesFromSelection(files, contextFiles)
  const anyOutdated =
    outdatedFilesInSelection.length > 0 || contextFiles.some((f) => f.diffStatus === 'outdated')
  const currentVaultId = activeVaultId

  return (
    <>
      {(anyCloudOnly || anyOutdated) && <div className="context-menu-separator" />}

      {/* Download cloud-only files. Never touches outdated files - see Get Latest below. */}
      {anyCloudOnly && (
        <div
          className="context-menu-item text-plm-success"
          onClick={() => {
            onClose()
            // Use command system for consistent incremental store updates
            executeCommand('download', { files: cloudOnlyFilesInSelection }, { onRefresh })
          }}
        >
          <ArrowDown size={14} className="text-plm-success" />
          Download{' '}
          {counts.cloudOnlyCount > 0 ? `${counts.cloudOnlyCount} files` : multiSelect ? '' : ''}
        </div>
      )}

      {/* Get Latest for outdated files. Never touches cloud-only files - see Download above. */}
      {anyOutdated && (
        <div
          className="context-menu-item text-purple-400"
          onClick={() => {
            onClose()
            executeCommand('get-latest', { files: outdatedFilesInSelection }, { onRefresh })
          }}
        >
          <RefreshCw size={14} className="text-purple-400" />
          {t('fileOps.getLatest', 'Get Latest')}{' '}
          {outdatedFilesInSelection.length > 0 ? `${outdatedFilesInSelection.length} files` : ''}
        </div>
      )}

      {/* Keep Local Only (Ignore) - for unsynced files */}
      {state.anyUnsynced && !state.allCloudOnly && currentVaultId && (
        <div
          className="context-menu-item relative"
          onMouseEnter={() => {
            if (ignoreSubmenuTimeoutRef.current) {
              clearTimeout(ignoreSubmenuTimeoutRef.current)
            }
            setShowIgnoreSubmenu(true)
          }}
          onMouseLeave={() => {
            ignoreSubmenuTimeoutRef.current = setTimeout(() => {
              setShowIgnoreSubmenu(false)
            }, 150)
          }}
          onClick={(e) => {
            e.stopPropagation()
            setShowIgnoreSubmenu(!showIgnoreSubmenu)
          }}
        >
          <EyeOff size={14} />
          Keep Local Only
          <span className="text-xs text-plm-fg-muted ml-auto">▶</span>
          {/* Submenu */}
          {showIgnoreSubmenu && (
            <ContextSubmenu
              minWidth={200}
              onMouseEnter={() => {
                if (ignoreSubmenuTimeoutRef.current) {
                  clearTimeout(ignoreSubmenuTimeoutRef.current)
                }
                setShowIgnoreSubmenu(true)
              }}
              onMouseLeave={() => {
                ignoreSubmenuTimeoutRef.current = setTimeout(() => {
                  setShowIgnoreSubmenu(false)
                }, 150)
              }}
            >
              {/* Ignore this specific file/folder */}
              <div
                className="context-menu-item"
                onClick={(e) => {
                  e.stopPropagation()
                  for (const file of contextFiles) {
                    if (file.isDirectory) {
                      addIgnorePattern(currentVaultId, file.relativePath + '/')
                    } else {
                      addIgnorePattern(currentVaultId, file.relativePath)
                    }
                  }
                  addToast(
                    'success',
                    `Added ${contextFiles.length > 1 ? `${contextFiles.length} items` : contextFiles[0].name} to ignore list`,
                  )
                  onClose()
                  onRefresh(true)
                }}
              >
                {state.isFolder ? <FolderX size={14} /> : <FileX size={14} />}
                This {state.isFolder ? 'folder' : 'file'}
                {multiSelect ? ` (${contextFiles.length})` : ''}
              </div>

              {/* Ignore all files with this extension - only for single file */}
              {!state.isFolder && !multiSelect && firstFile.extension && (
                <div
                  className="context-menu-item"
                  onClick={(e) => {
                    e.stopPropagation()
                    const pattern = `*${firstFile.extension}`
                    addIgnorePattern(currentVaultId, pattern)
                    addToast('success', `Now ignoring all ${firstFile.extension} files`)
                    onClose()
                    onRefresh(true)
                  }}
                >
                  <FileX size={14} />
                  All *{firstFile.extension} files
                </div>
              )}

              {/* Show current patterns count */}
              {(() => {
                const currentPatterns = getIgnorePatterns(currentVaultId)
                if (currentPatterns.length > 0) {
                  return (
                    <>
                      <div className="context-menu-separator" />
                      <div className="px-3 py-1.5 text-xs text-plm-fg-muted">
                        {currentPatterns.length} pattern{currentPatterns.length > 1 ? 's' : ''}{' '}
                        configured
                      </div>
                    </>
                  )
                }
                return null
              })()}
            </ContextSubmenu>
          )}
        </div>
      )}

      {/* First Check In - for unsynced items */}
      {state.anyUnsynced && (
        <div
          className="context-menu-item"
          onClick={() => {
            onClose()
            executeCommand('sync', { files: contextFiles }, { onRefresh })
          }}
        >
          <ArrowUp size={14} className="text-plm-info" />
          First Check In{' '}
          {unsyncedFilesInSelection.length > 0
            ? `${unsyncedFilesInSelection.length} file${unsyncedFilesInSelection.length !== 1 ? 's' : ''}`
            : ''}
        </div>
      )}
    </>
  )
}
