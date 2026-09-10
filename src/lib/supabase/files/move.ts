import { getSupabaseClient } from '../client'
import { CONCURRENT_OPERATIONS, processWithConcurrency } from '../../concurrency'

// ============================================
// File Move Operations
// ============================================

/**
 * Move a file to a new location on the server using atomic RPC.
 *
 * This function:
 * - Validates the file exists
 * - Blocks if file is checked out by another user
 * - Updates file_path and file_name atomically
 * - Logs a 'move' activity
 *
 * @param fileId - UUID of the file to move
 * @param userId - UUID of the user performing the move
 * @param newFilePath - New relative path for the file (e.g., "folder/subfolder/file.sldprt")
 * @param newFileName - Optional new file name (if not provided, keeps current name)
 */
export async function moveFileOnServer(
  fileId: string,
  userId: string,
  newFilePath: string,
  newFileName?: string,
): Promise<{ success: boolean; file?: unknown; error?: string }> {
  const client = getSupabaseClient()

  // Use atomic RPC to prevent race conditions and ensure proper validation
  const { data, error } = await client.rpc('move_file', {
    p_file_id: fileId,
    p_user_id: userId,
    p_new_file_path: newFilePath,
    p_new_file_name: newFileName,
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // RPC returns JSONB with { success, error?, file? }
  const result = (data ?? { success: false }) as {
    success: boolean
    error?: string
    file?: unknown
  }

  if (!result.success) {
    return { success: false, error: result.error }
  }

  return { success: true, file: result.file }
}

/** One file for `moveFilesOnServer` to relocate. */
export interface ServerMove {
  fileId: string
  newFilePath: string
  newFileName?: string
}

export interface MoveFilesOptions {
  /** Parallel `move_file` calls. Defaults to `CONCURRENT_OPERATIONS`. */
  concurrency?: number

  /** Invoked after each call settles, for a progress toast. */
  onProgress?: (completed: number, total: number) => void

  /**
   * Consulted immediately before each call. Once it returns true the remaining files are left
   * untouched rather than half-written, and `stopped` says so. Every call is one `move_file`, so
   * stopping is safe: the files already written are complete and the rest are unchanged.
   */
  shouldStop?: () => boolean
}

/** One file's outcome. `attempted: false` means the run stopped before reaching it. */
export interface ServerMoveOutcome {
  fileId: string
  attempted: boolean
  success: boolean
  error?: string
}

export interface MoveFilesResult {
  succeeded: number
  failed: number
  errors: string[]
  /** Per-file outcomes in the order the files were given. */
  results: ServerMoveOutcome[]
  /** True when `shouldStop` ended the run before every file was attempted. */
  stopped: boolean
}

/**
 * Move multiple files on the server, one `move_file` call each.
 *
 * Per-file rather than set-based on purpose. `move_file` already carries the row lock, the
 * "checked out by somebody else" refusal and the activity insert, and a failure on one row says
 * which row and why — which is what makes a partial run reportable and re-runnable.
 *
 * @param files - The moves to apply
 * @param userId - UUID of the user performing the moves
 */
export async function moveFilesOnServer(
  files: ServerMove[],
  userId: string,
  options?: MoveFilesOptions,
): Promise<MoveFilesResult> {
  const concurrency = options?.concurrency ?? CONCURRENT_OPERATIONS
  let completed = 0

  const results = await processWithConcurrency(
    files,
    concurrency,
    async (file): Promise<ServerMoveOutcome> => {
      if (options?.shouldStop?.()) {
        return { fileId: file.fileId, attempted: false, success: false }
      }

      const result = await moveFileOnServer(file.fileId, userId, file.newFilePath, file.newFileName)

      completed++
      options?.onProgress?.(completed, files.length)

      return {
        fileId: file.fileId,
        attempted: true,
        success: result.success,
        error: result.success ? undefined : (result.error ?? undefined),
      }
    },
  )

  const errors: string[] = []
  let succeeded = 0
  let failed = 0

  for (const result of results) {
    if (!result.attempted) continue
    if (result.success) {
      succeeded++
    } else {
      failed++
      if (result.error) {
        errors.push(`${result.fileId}: ${result.error}`)
      }
    }
  }

  return {
    succeeded,
    failed,
    errors,
    results,
    stopped: results.some((result) => !result.attempted),
  }
}
