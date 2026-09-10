/**
 * Pack and Go Command
 *
 * Creates a ZIP archive of an assembly and all its associated files:
 * - The root assembly file
 * - All recursive children (parts and sub-assemblies)
 * - All associated drawings
 *
 * This provides a portable package that can be shared externally
 * or used for archival purposes.
 */

import type { Command, CommandResult, PackAndGoParams } from '../types'
import { hasLocalContent, resolveAssociatedFiles } from '../../fileOperations/assemblyResolver'
import { log } from '@/lib/logger'
import { formatBytes } from '@/lib/utils'

// ============================================
// Logging Helpers
// ============================================

function logPackAndGo(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  context: Record<string, unknown>,
): void {
  log[level]('[PackAndGo]', message, context)
}

// ============================================
// Command Implementation
// ============================================

/**
 * Pack and Go command handler.
 *
 * Exports an assembly and all its associated files (children, drawings) to a ZIP archive.
 * Can be invoked from context menu or command registry.
 */
export const packAndGoCommand: Command<PackAndGoParams> = {
  id: 'pack-and-go',
  name: 'Pack and Go',
  description: 'Export assembly and all associated files to a ZIP archive',
  usage: 'pack-and-go <assembly-path>',

  validate({ file }, ctx) {
    // Must be in Electron environment
    if (!window.electronAPI) {
      return 'Pack and Go requires the desktop application'
    }

    // Must have a file
    if (!file) {
      return 'No file selected'
    }

    // Must be an assembly file
    if (!file.name.toLowerCase().endsWith('.sldasm')) {
      return 'Pack and Go is only available for assembly files (.sldasm)'
    }

    // Must be synced (have PDM data)
    if (!file.pdmData?.id) {
      return 'File must be synced to the vault before using Pack and Go'
    }

    // A 'moved_away' row is a stub at the server's recorded path for a file whose content now
    // lives elsewhere on disk (see its 'moved' partner's relativePath, carried here directly as
    // `movedToRelativePath`) - there is no local assembly at this row's own path to pack.
    if (file.diffStatus === 'moved_away') {
      return file.movedToRelativePath
        ? `This file moved to "${file.movedToRelativePath}" - use Pack and Go from there`
        : 'This file is not at this location anymore'
    }

    // Must have organization context (for resolver)
    if (!ctx.organization?.id) {
      return 'No organization connected'
    }

    return null
  },

  async execute({ file }, ctx): Promise<CommandResult> {
    const operationId = `pack-and-go-${Date.now()}`
    const toastId = operationId

    logPackAndGo('info', 'Starting Pack and Go operation', {
      operationId,
      fileName: file.name,
      fileId: file.pdmData?.id,
    })

    try {
      // Step 1: Show save dialog for output location
      const defaultName = file.name.replace(/\.sldasm$/i, '_PackAndGo.zip')
      const saveResult = await window.electronAPI.showSaveDialog(defaultName, [
        { name: 'ZIP Archives', extensions: ['zip'] },
      ])

      if (!saveResult.success || saveResult.canceled || !saveResult.path) {
        logPackAndGo('info', 'Pack and Go cancelled by user', { operationId })
        return {
          success: true,
          message: 'Pack and Go cancelled',
          total: 0,
          succeeded: 0,
          failed: 0,
        }
      }

      const outputPath = saveResult.path

      // Step 2: Resolve all associated files
      ctx.addToast('info', 'Resolving assembly references...', 5000)

      logPackAndGo('debug', 'Resolving associated files', {
        operationId,
        rootFileId: file.pdmData!.id,
        orgId: ctx.organization!.id,
      })

      const resolveResult = await resolveAssociatedFiles(
        file.pdmData!.id,
        ctx.organization!.id,
        ctx.files,
        (message) => logPackAndGo('debug', message, { operationId }),
      )

      if (resolveResult.error) {
        const errorMsg =
          resolveResult.error instanceof Error
            ? resolveResult.error.message
            : String(resolveResult.error)
        logPackAndGo('error', 'Failed to resolve associated files', {
          operationId,
          error: errorMsg,
        })
        ctx.addToast('error', `Failed to resolve files: ${errorMsg}`)
        return {
          success: false,
          message: `Failed to resolve files: ${errorMsg}`,
          total: 0,
          succeeded: 0,
          failed: 1,
          errors: [errorMsg],
        }
      }

      // Build list of files to include in ZIP
      const filesToZip: Array<{ path: string; relativePath: string }> = []

      // Add root file if it exists locally
      const rootLocalFile = resolveResult.allFiles.get(file.pdmData!.id)
      if (rootLocalFile && hasLocalContent(rootLocalFile)) {
        filesToZip.push({
          path: rootLocalFile.path,
          relativePath: rootLocalFile.relativePath,
        })
      }

      // Add all children that exist locally
      for (const child of resolveResult.children) {
        const childLocalFile = resolveResult.allFiles.get(child.id)
        if (childLocalFile && hasLocalContent(childLocalFile)) {
          filesToZip.push({
            path: childLocalFile.path,
            relativePath: childLocalFile.relativePath,
          })
        }
      }

      // Add all drawings that exist locally
      for (const drawing of resolveResult.drawings) {
        const drawingLocalFile = resolveResult.allFiles.get(drawing.id)
        if (drawingLocalFile && hasLocalContent(drawingLocalFile)) {
          filesToZip.push({
            path: drawingLocalFile.path,
            relativePath: drawingLocalFile.relativePath,
          })
        }
      }

      // Deduplicate by path (in case root file was also in children)
      const uniqueFiles = [...new Map(filesToZip.map((f) => [f.path, f])).values()]

      logPackAndGo('info', 'Files to include in ZIP', {
        operationId,
        totalFiles: uniqueFiles.length,
        rootFile: rootLocalFile?.name,
        children: resolveResult.stats.totalChildren,
        drawings: resolveResult.stats.drawings,
        cloudOnlyFiles: filesToZip.length - uniqueFiles.length,
      })

      if (uniqueFiles.length === 0) {
        logPackAndGo('warn', 'No local files to package', { operationId })
        ctx.addToast('warning', 'No local files found. Download the files first.')
        return {
          success: false,
          message: 'No local files to package. Download the files first.',
          total: 0,
          succeeded: 0,
          failed: 0,
        }
      }

      // Step 3: Create ZIP with progress tracking
      const startTime = Date.now()
      ctx.addProgressToast(
        toastId,
        `Creating ZIP (${uniqueFiles.length} files)...`,
        uniqueFiles.length,
      )

      // Subscribe to progress events
      let unsubscribeProgress: (() => void) | null = null
      if (window.electronAPI.archive.onProgress) {
        unsubscribeProgress = window.electronAPI.archive.onProgress((progressEvent) => {
          const percent = Math.round(
            (progressEvent.filesProcessed / progressEvent.filesTotal) * 100,
          )
          const phaseLabel =
            progressEvent.phase === 'reading'
              ? 'Reading files'
              : progressEvent.phase === 'compressing'
                ? 'Compressing'
                : 'Writing ZIP'

          const label = progressEvent.currentFile
            ? `${phaseLabel}: ${progressEvent.currentFile}`
            : phaseLabel

          ctx.updateProgressToast(toastId, progressEvent.filesProcessed, percent, undefined, label)
        })
      }

      try {
        logPackAndGo('debug', 'Creating ZIP archive', {
          operationId,
          outputPath,
          fileCount: uniqueFiles.length,
        })

        const zipResult = await window.electronAPI.archive.createZip(uniqueFiles, outputPath)

        // Cleanup progress listener
        if (unsubscribeProgress) {
          unsubscribeProgress()
        }

        if (!zipResult.success) {
          logPackAndGo('error', 'ZIP creation failed', {
            operationId,
            error: zipResult.error,
          })
          ctx.removeToast(toastId)
          ctx.addToast('error', `ZIP creation failed: ${zipResult.error}`)
          return {
            success: false,
            message: zipResult.error || 'ZIP creation failed',
            total: uniqueFiles.length,
            succeeded: 0,
            failed: uniqueFiles.length,
            errors: [zipResult.error || 'Unknown error'],
          }
        }

        ctx.removeToast(toastId)
        const duration = Date.now() - startTime

        // Format size for display
        const sizeFormatted = zipResult.totalSize
          ? formatBytes(zipResult.totalSize)
          : 'unknown size'

        logPackAndGo('info', 'Pack and Go complete', {
          operationId,
          fileCount: zipResult.fileCount,
          totalSize: zipResult.totalSize,
          outputPath,
          duration,
        })

        ctx.addToast('success', `Created ZIP with ${zipResult.fileCount} files (${sizeFormatted})`)

        return {
          success: true,
          message: `Exported ${zipResult.fileCount} files to ZIP (${sizeFormatted})`,
          total: uniqueFiles.length,
          succeeded: zipResult.fileCount || uniqueFiles.length,
          failed: 0,
          duration,
        }
      } catch (error) {
        // Cleanup progress listener on error
        if (unsubscribeProgress) {
          unsubscribeProgress()
        }
        throw error
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logPackAndGo('error', 'Pack and Go failed with exception', {
        operationId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      })
      ctx.addToast('error', `Pack and Go failed: ${errorMessage}`)
      return {
        success: false,
        message: errorMessage,
        total: 0,
        succeeded: 0,
        failed: 1,
        errors: [errorMessage],
      }
    }
  },
}
