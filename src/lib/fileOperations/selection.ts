import type { LocalFile } from '@/stores/pdmStore'
import type { SelectionCategories } from './types'

/**
 * Calculate all selection categories in a single pass (O(n) instead of O(5n))
 */
export function getSelectionCategories(
  files: LocalFile[],
  selectedPaths: string[],
  userId?: string,
): SelectionCategories {
  // Return empty if not multi-select
  if (selectedPaths.length <= 1) {
    return {
      downloadable: [],
      cloudOnly: [],
      checkoutable: [],
      checkinable: [],
      uploadable: [],
      updatable: [],
    }
  }

  const selectedSet = new Set(selectedPaths)
  const result: SelectionCategories = {
    downloadable: [],
    cloudOnly: [],
    checkoutable: [],
    checkinable: [],
    uploadable: [],
    updatable: [],
  }

  for (const file of files) {
    if (!selectedSet.has(file.path) || file.isDirectory) continue

    const { diffStatus, pdmData } = file

    // Downloadable: cloud-only or outdated
    if (diffStatus === 'cloud' || diffStatus === 'outdated') {
      result.downloadable.push(file)
    }

    // Cloud-only: subset of downloadable, drives the download button specifically
    if (diffStatus === 'cloud') {
      result.cloudOnly.push(file)
    }

    // Updatable: outdated only
    if (diffStatus === 'outdated') {
      result.updatable.push(file)
    }

    // Checkoutable: synced, not checked out, not cloud-only, not deleted.
    // A 'moved_away' stub has no local file behind it, so it is excluded the
    // same way 'cloud' is - checking it out would lock the server row from
    // under the file that actually claimed it at its new location.
    if (
      pdmData &&
      !pdmData.checked_out_by &&
      diffStatus !== 'cloud' &&
      diffStatus !== 'deleted' &&
      diffStatus !== 'moved_away'
    ) {
      result.checkoutable.push(file)
    }

    // Checkinable: checked out by current user. Excludes 'moved_away' for the
    // same reason as checkoutable - the stub is not the file's real location.
    if (
      pdmData?.checked_out_by === userId &&
      diffStatus !== 'deleted' &&
      diffStatus !== 'moved_away'
    ) {
      result.checkinable.push(file)
    }

    // Uploadable: local-only (no pdmData or added status)
    if ((!pdmData || diffStatus === 'added') && diffStatus !== 'cloud') {
      result.uploadable.push(file)
    }
  }

  return result
}
