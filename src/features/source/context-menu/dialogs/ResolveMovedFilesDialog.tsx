// src/features/source/context-menu/dialogs/ResolveMovedFilesDialog.tsx
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, Check, Cloud, HardDrive, Loader2, Move, X } from 'lucide-react'

import { t } from '@/lib/i18n'
import { executeCommand, type CommandResult } from '@/lib/commands'
import {
  classifyMovedFiles,
  type BlockedHolder,
  type ReconcilePreflight,
} from '@/lib/commands/handlers/reconcileMovedPathsPreflight'
import {
  classifyAdoptTargets,
  type AdoptServerPathsPreflight,
  type BlockedAdoptHolder,
} from '@/lib/commands/handlers/adoptServerPathsPreflight'
import { usePDMStore } from '@/stores/pdmStore'
import type { LocalFile } from '@/stores/pdmStore'

import {
  buildMovedPairs,
  buildScope,
  filterByScope,
  inferDefaultScopeType,
  type ResolveScopeType,
} from './resolveMovedFiles.utils'

/** From/to pairs shown before the list collapses to "…and N more". */
const PREVIEW_LIMIT = 25

type ResolveDirection = 'reconcile' | 'adopt'

interface ResolveMovedFilesDialogProps {
  isOpen: boolean
  onClose: () => void
  /**
   * The file or folder the dialog was opened from. A directory (the folder-tree badge) defaults
   * the scope to that folder; a file (the context-menu item) defaults it to that file. `null`
   * defaults to the whole vault.
   */
  contextFile: LocalFile | null
  onRefresh?: (silent?: boolean) => void
}

function pluralSuffix(count: number): '_one' | '_other' {
  return count === 1 ? '_one' : '_other'
}

function formatHolders(holders: Array<{ holderName: string | null; count: number }>): string {
  return holders
    .map((holder) => `${holder.holderName ?? t('resolveMoves.unknownHolder')} (${holder.count})`)
    .join(', ')
}

export function ResolveMovedFilesDialog({
  isOpen,
  onClose,
  contextFile,
  onRefresh,
}: ResolveMovedFilesDialogProps) {
  const files = usePDMStore((state) => state.files)
  const serverFiles = usePDMStore((state) => state.serverFiles)
  const userId = usePDMStore((state) => state.user?.id)

  const [scopeType, setScopeType] = useState<ResolveScopeType>(() =>
    inferDefaultScopeType(contextFile),
  )
  const [skipCheckedOut, setSkipCheckedOut] = useState(false)
  const [force, setForce] = useState(false)
  const [runningDirection, setRunningDirection] = useState<ResolveDirection | null>(null)
  const [result, setResult] = useState<{ direction: ResolveDirection; value: CommandResult } | null>(
    null,
  )

  // Every open is a fresh review: re-derive the default scope from whatever the dialog was
  // opened against this time, and drop any result/toggle state left over from the last run.
  useEffect(() => {
    if (!isOpen) return
    setScopeType(inferDefaultScopeType(contextFile))
    setSkipCheckedOut(false)
    setForce(false)
    setResult(null)
  }, [isOpen, contextFile])

  const scope = useMemo(() => buildScope(scopeType, contextFile), [scopeType, contextFile])

  const allPairs = useMemo(() => buildMovedPairs(files), [files])
  const scopedPairs = useMemo(() => filterByScope(allPairs, scope), [allPairs, scope])

  // Both preflights are deliberately vault-wide, matching what `reconcile-moved-paths` and
  // `adopt-server-paths` actually act on — neither command takes a selection. Scoping these
  // counts to the folder/file the dialog was opened from would show numbers that disagree with
  // what clicking "run" does; the scope selector below only ever filters the preview list.
  const reconcilePreflight: ReconcilePreflight = useMemo(
    () => classifyMovedFiles({ files, serverFiles, userId: userId ?? '' }),
    [files, serverFiles, userId],
  )
  const adoptPreflight: AdoptServerPathsPreflight = useMemo(
    () => classifyAdoptTargets({ files, userId: userId ?? '' }),
    [files, userId],
  )

  if (!isOpen) return null

  const isRunning = runningDirection !== null
  const hasAnyPendingMoves = allPairs.length > 0

  const handleClose = () => {
    if (isRunning) return
    onClose()
  }

  const handleRun = async (direction: ResolveDirection) => {
    setRunningDirection(direction)
    setResult(null)
    try {
      const value =
        direction === 'reconcile'
          ? await executeCommand(
              'reconcile-moved-paths',
              { apply: true, skipCheckedOut },
              { onRefresh },
            )
          : await executeCommand('adopt-server-paths', { apply: true, force }, { onRefresh })
      setResult({ direction, value })
    } finally {
      setRunningDirection(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm flex items-center justify-center"
      onClick={handleClose}
    >
      <div
        className="bg-plm-bg-light border border-plm-border rounded-lg shadow-2xl w-[640px] max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-plm-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-plm-info/20 flex items-center justify-center">
              <Move size={20} className="text-plm-info" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-plm-fg">{t('resolveMoves.title')}</h3>
              <p className="text-sm text-plm-fg-muted">{t('resolveMoves.subtitle')}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            disabled={isRunning}
            className="text-plm-fg-muted hover:text-plm-fg disabled:opacity-50"
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {!hasAnyPendingMoves ? (
            <p className="text-sm text-plm-fg-muted">{t('resolveMoves.noPendingMoves')}</p>
          ) : (
            <>
              {/* Scope selector */}
              <div>
                <div className="text-xs text-plm-fg-muted uppercase tracking-wide mb-2">
                  {t('resolveMoves.scopeLabel')}
                </div>
                <div className="flex gap-2">
                  {(
                    [
                      ['file', t('resolveMoves.scopeFile')],
                      ['folder', t('resolveMoves.scopeFolder')],
                      ['vault', t('resolveMoves.scopeVault')],
                    ] as Array<[ResolveScopeType, string]>
                  ).map(([type, label]) => {
                    const disabled = type === 'file' && !contextFile?.pdmData?.id
                    return (
                      <button
                        key={type}
                        onClick={() => setScopeType(type)}
                        disabled={disabled}
                        className={`px-3 py-1.5 text-sm rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                          scopeType === type
                            ? 'bg-plm-accent/20 border-plm-accent text-plm-accent'
                            : 'border-plm-border text-plm-fg-muted hover:text-plm-fg'
                        }`}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* From -> to preview, scoped */}
              <div>
                <div className="text-xs text-plm-fg-muted uppercase tracking-wide mb-2">
                  {t(`resolveMoves.listHeading${pluralSuffix(scopedPairs.length)}`, {
                    count: scopedPairs.length,
                  })}
                </div>
                <div className="bg-plm-bg rounded border border-plm-border p-2 max-h-40 overflow-y-auto font-mono text-xs">
                  {scopedPairs.length === 0 ? (
                    <div className="text-plm-fg-muted p-2">{t('resolveMoves.noMovesInScope')}</div>
                  ) : (
                    <>
                      {scopedPairs.slice(0, PREVIEW_LIMIT).map((pair) => (
                        <div
                          key={pair.fileId}
                          className="flex items-center gap-2 py-0.5 text-plm-fg-dim"
                        >
                          <span className="truncate">{pair.serverPath}</span>
                          <ArrowRight size={10} className="shrink-0 text-plm-fg-muted" />
                          <span className="truncate text-plm-fg">{pair.localPath}</span>
                        </div>
                      ))}
                      {scopedPairs.length > PREVIEW_LIMIT && (
                        <div className="text-plm-fg-muted pt-1">
                          {t('resolveMoves.moreFiles', {
                            count: scopedPairs.length - PREVIEW_LIMIT,
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {scopeType !== 'vault' && (
                  <p className="text-xs text-plm-fg-muted mt-1">{t('resolveMoves.vaultWideNote')}</p>
                )}
              </div>

              {/* The two directions */}
              <div className="grid grid-cols-2 gap-3">
                <DirectionCard
                  icon={<Cloud size={16} />}
                  title={t('resolveMoves.reconcileOptionTitle')}
                  description={t('resolveMoves.reconcileOptionDescription')}
                  eligible={reconcilePreflight.eligible.length}
                  blocked={reconcilePreflight.blocked.length}
                  holders={reconcilePreflight.holders}
                  conflicts={countSkipped(reconcilePreflight, 'conflict')}
                  unverified={countSkipped(reconcilePreflight, 'unverified')}
                  toggle={
                    reconcilePreflight.blocked.length > 0 ? (
                      <label className="flex items-start gap-2 text-xs text-plm-fg-muted cursor-pointer">
                        <input
                          type="checkbox"
                          checked={skipCheckedOut}
                          onChange={(e) => setSkipCheckedOut(e.target.checked)}
                          disabled={isRunning}
                          className="mt-0.5 accent-plm-accent"
                        />
                        <span>
                          {t(
                            `resolveMoves.skipCheckedOutLabel${pluralSuffix(reconcilePreflight.blocked.length)}`,
                            { count: reconcilePreflight.blocked.length },
                          )}
                        </span>
                      </label>
                    ) : null
                  }
                  runLabel={t('resolveMoves.runReconcile')}
                  onRun={() => handleRun('reconcile')}
                  isRunning={runningDirection === 'reconcile'}
                  disabled={isRunning || reconcilePreflight.total === 0}
                />

                <DirectionCard
                  icon={<HardDrive size={16} />}
                  title={t('resolveMoves.adoptOptionTitle')}
                  description={t('resolveMoves.adoptOptionDescription')}
                  eligible={adoptPreflight.eligible.length}
                  blocked={adoptPreflight.blocked.length}
                  holders={adoptPreflight.holders}
                  conflicts={countSkipped(adoptPreflight, 'conflict')}
                  unverified={countSkipped(adoptPreflight, 'unverified')}
                  toggle={
                    adoptPreflight.blocked.length > 0 ? (
                      <label className="flex items-start gap-2 text-xs text-plm-fg-muted cursor-pointer">
                        <input
                          type="checkbox"
                          checked={force}
                          onChange={(e) => setForce(e.target.checked)}
                          disabled={isRunning}
                          className="mt-0.5 accent-plm-accent"
                        />
                        <span>
                          {t(`resolveMoves.forceLabel${pluralSuffix(adoptPreflight.blocked.length)}`, {
                            count: adoptPreflight.blocked.length,
                          })}
                        </span>
                      </label>
                    ) : null
                  }
                  runLabel={t('resolveMoves.runAdopt')}
                  onRun={() => handleRun('adopt')}
                  isRunning={runningDirection === 'adopt'}
                  disabled={isRunning || adoptPreflight.total === 0}
                />
              </div>

              {/* Result summary */}
              {result && (
                <div
                  className={`rounded border p-3 text-sm flex items-start gap-2 ${
                    result.value.success
                      ? 'border-plm-success/40 bg-plm-success/10 text-plm-success'
                      : 'border-plm-warning/40 bg-plm-warning/10 text-plm-warning'
                  }`}
                >
                  {result.value.success ? (
                    <Check size={16} className="shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  )}
                  <span className="text-plm-fg">{result.value.message}</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-4 border-t border-plm-border flex justify-end">
          <button onClick={handleClose} disabled={isRunning} className="btn btn-ghost">
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

function countSkipped(
  preflight: ReconcilePreflight | AdoptServerPathsPreflight,
  reason: 'conflict' | 'unverified',
): number {
  return preflight.skipped.filter((target) => target.reason === reason).length
}

interface DirectionCardProps {
  icon: React.ReactNode
  title: string
  description: string
  eligible: number
  blocked: number
  holders: BlockedHolder[] | BlockedAdoptHolder[]
  conflicts: number
  unverified: number
  toggle: React.ReactNode
  runLabel: string
  onRun: () => void
  isRunning: boolean
  disabled: boolean
}

/**
 * One resolution option, in plain language rather than a command name. Both directions render
 * through this so their counts and hazards read the same way — the honesty requirement is that
 * neither ever looks safer than its own preflight says it is.
 */
function DirectionCard({
  icon,
  title,
  description,
  eligible,
  blocked,
  holders,
  conflicts,
  unverified,
  toggle,
  runLabel,
  onRun,
  isRunning,
  disabled,
}: DirectionCardProps) {
  return (
    <div className="border border-plm-border rounded-lg p-3 flex flex-col gap-2 bg-plm-bg">
      <div className="flex items-center gap-2 text-plm-fg font-medium">
        <span className="text-plm-accent">{icon}</span>
        <span>{title}</span>
      </div>
      <p className="text-xs text-plm-fg-muted">{description}</p>

      <div className="text-xs space-y-1 mt-1">
        {eligible > 0 && (
          <div className="text-plm-success">
            {t(`resolveMoves.eligibleCount${pluralSuffix(eligible)}`, { count: eligible })}
          </div>
        )}
        {blocked > 0 && (
          <div className="text-plm-warning">
            {t(`resolveMoves.blockedCount${pluralSuffix(blocked)}`, { count: blocked })}
            {holders.length > 0 && (
              <span className="text-plm-fg-muted"> — {formatHolders(holders)}</span>
            )}
          </div>
        )}
        {conflicts > 0 && (
          <div className="text-plm-fg-muted">
            {t(`resolveMoves.conflictCount${pluralSuffix(conflicts)}`, { count: conflicts })}
          </div>
        )}
        {unverified > 0 && (
          <div className="text-plm-fg-muted">
            {t(`resolveMoves.unverifiedCount${pluralSuffix(unverified)}`, { count: unverified })}
          </div>
        )}
        {eligible === 0 && blocked === 0 && conflicts === 0 && unverified === 0 && (
          <div className="text-plm-fg-muted">{t('resolveMoves.noEligible')}</div>
        )}
      </div>

      {toggle && <div className="mt-1">{toggle}</div>}

      <button
        onClick={onRun}
        disabled={disabled}
        className="btn btn-primary w-full justify-center mt-2 disabled:opacity-50"
      >
        {isRunning ? <Loader2 size={14} className="animate-spin" /> : null}
        {runLabel}
      </button>
    </div>
  )
}
