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

    // Checkoutable: synced, not checked out, not cloud-only, not deleted
    if (pdmData && !pdmData.checked_out_by && diffStatus !== 'cloud' && diffStatus !== 'deleted') {
      result.checkoutable.push(file)
    }

    // Checkinable: checked out by current user
    if (pdmData?.checked_out_by === userId && diffStatus !== 'deleted') {
      result.checkinable.push(file)
    }

    // Uploadable: local-only (no pdmData or added status)
    if ((!pdmData || diffStatus === 'added') && diffStatus !== 'cloud') {
      result.uploadable.push(file)
    }
  }

  return result
}
