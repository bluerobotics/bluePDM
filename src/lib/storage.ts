/**
 * BluePDM Storage Service
 * 
 * Handles file storage using Supabase Storage with content-addressable storage.
 * Each file version is stored by its SHA-256 hash, enabling deduplication.
 * 
 * Storage structure:
 *   vault/{org_id}/{hash}           - Actual file content (deduplicated)
 *   
 * Database tracks:
 *   files table                     - Current file metadata
 *   file_versions table             - All versions with hash references
 */
// @ts-nocheck - TODO: Fix Supabase type inference issues

import { supabase } from './supabase'

const BUCKET_NAME = 'vault'

// Hash a file using SHA-256
export async function hashFile(file: File | Blob | ArrayBuffer): Promise<string> {
  let buffer: ArrayBuffer
  
  if (file instanceof ArrayBuffer) {
    buffer = file
  } else {
    buffer = await file.arrayBuffer()
  }
  
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

// Get storage path for a content hash
function getStoragePath(orgId: string, hash: string): string {
  // Store in subdirectories based on first 2 chars of hash (like Git)
  // This prevents having millions of files in one directory
  return `${orgId}/${hash.substring(0, 2)}/${hash}`
}

/**
 * Upload a file to storage
 * Returns the content hash
 */
export async function uploadFile(
  orgId: string,
  fileData: File | Blob | ArrayBuffer,
  _onProgress?: (progress: number) => void
): Promise<{ hash: string; size: number; error?: string }> {
  try {
    // Calculate hash
    const hash = await hashFile(fileData)
    const storagePath = getStoragePath(orgId, hash)
    
    // Check if this content already exists (deduplication)
    const { data: existing } = await supabase.storage
      .from(BUCKET_NAME)
      .list(`${orgId}/${hash.substring(0, 2)}`, {
        search: hash
      })
    
    if (existing && existing.length > 0) {
      // File already exists, no need to upload again
      const size = fileData instanceof ArrayBuffer 
        ? fileData.byteLength 
        : (fileData as Blob).size
      return { hash, size }
    }
    
    // Convert to Blob if needed
    let blob: Blob
    if (fileData instanceof ArrayBuffer) {
      blob = new Blob([fileData])
    } else if (fileData instanceof File) {
      blob = fileData
    } else {
      blob = fileData
    }
    
    // Upload to storage
    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(storagePath, blob, {
        cacheControl: '31536000', // Cache for 1 year (content-addressed = immutable)
        upsert: false // Don't overwrite (shouldn't happen with content-addressing)
      })
    
    if (error) {
      // Ignore "already exists" errors (race condition)
      if (!error.message.includes('already exists')) {
        return { hash: '', size: 0, error: error.message }
      }
    }
    
    return { hash, size: blob.size }
  } catch (err) {
    return { hash: '', size: 0, error: String(err) }
  }
}

/**
 * Download a file from storage by hash
 */
export async function downloadFile(
  orgId: string,
  hash: string
): Promise<{ data: Blob | null; error?: string }> {
  try {
    // Try old flat structure first (most existing files use this)
    const flatPath = `${orgId}/${hash}`
    console.log('[Storage] Trying flat path:', flatPath)
    
    let { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .download(flatPath)
    
    // If not found, try new subdirectory structure
    if (error) {
      console.log('[Storage] Flat path failed, trying subdirectory:', error.message)
      const storagePath = getStoragePath(orgId, hash)
      const result = await supabase.storage
        .from(BUCKET_NAME)
        .download(storagePath)
      
      if (!result.error && result.data) {
        console.log('[Storage] Subdirectory path worked')
        return { data: result.data }
      }
      
      // Both failed
      console.error('[Storage] Both paths failed')
      return { data: null, error: error.message }
    }
    
    console.log('[Storage] Flat path worked')
    return { data }
  } catch (err) {
    console.error('[Storage] Download exception:', err)
    return { data: null, error: String(err) }
  }
}

/**
 * Progress callback for download
 */
export interface DownloadProgress {
  loaded: number
  total: number
  speed: number // bytes per second
}

/**
 * Download a file with real-time progress tracking
 * Uses signed URLs and fetch with readable streams for progress
 */
export async function downloadFileWithProgress(
  orgId: string,
  hash: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<{ data: Blob | null; error?: string }> {
  try {
    // Try flat path first for signed URL
    const flatPath = `${orgId}/${hash}`
    let signedUrlResult = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(flatPath, 3600) // 1 hour expiry
    
    // If flat path fails, try subdirectory structure
    if (signedUrlResult.error) {
      const storagePath = getStoragePath(orgId, hash)
      signedUrlResult = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(storagePath, 3600)
      
      if (signedUrlResult.error) {
        return { data: null, error: signedUrlResult.error.message }
      }
    }
    
    const url = signedUrlResult.data.signedUrl
    
    // Use fetch with readable stream for progress tracking
    const response = await fetch(url)
    
    if (!response.ok) {
      return { data: null, error: `HTTP ${response.status}: ${response.statusText}` }
    }
    
    const contentLength = response.headers.get('content-length')
    const total = contentLength ? parseInt(contentLength, 10) : 0
    
    if (!response.body) {
      // Fallback if no body (shouldn't happen)
      const blob = await response.blob()
      return { data: blob }
    }
    
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0
    const startTime = Date.now()
    let lastProgressTime = startTime
    let lastLoaded = 0
    
    while (true) {
      const { done, value } = await reader.read()
      
      if (done) break
      
      chunks.push(value)
      loaded += value.length
      
      // Calculate speed (use rolling average over last 500ms for smoother display)
      const now = Date.now()
      const timeSinceLastProgress = now - lastProgressTime
      
      if (timeSinceLastProgress >= 100 && onProgress) { // Update every 100ms
        const bytesSinceLastProgress = loaded - lastLoaded
        const speed = timeSinceLastProgress > 0 
          ? (bytesSinceLastProgress / timeSinceLastProgress) * 1000 
          : 0
        
        onProgress({
          loaded,
          total,
          speed
        })
        
        lastProgressTime = now
        lastLoaded = loaded
      }
    }
    
    // Final progress update
    if (onProgress) {
      const elapsed = Date.now() - startTime
      const speed = elapsed > 0 ? (loaded / elapsed) * 1000 : 0
      onProgress({ loaded, total: loaded, speed })
    }
    
    // Combine chunks into blob
    const blob = new Blob(chunks)
    return { data: blob }
  } catch (err) {
    console.error('[Storage] Download with progress exception:', err)
    return { data: null, error: String(err) }
  }
}

/**
 * Get a signed URL for direct download (faster for large files)
 * Tries flat path first, then subdirectory structure
 */
export async function getDownloadUrl(
  orgId: string,
  hash: string,
  expiresInSeconds: number = 3600
): Promise<{ url: string | null; error?: string }> {
  try {
    // Try flat path first (most existing files use this)
    const flatPath = `${orgId}/${hash}`
    let result = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(flatPath, expiresInSeconds)
    
    if (!result.error && result.data) {
      return { url: result.data.signedUrl }
    }
    
    // Try subdirectory structure
    const storagePath = getStoragePath(orgId, hash)
    result = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(storagePath, expiresInSeconds)
    
    if (result.error) {
      return { url: null, error: result.error.message }
    }
    
    return { url: result.data.signedUrl }
  } catch (err) {
    return { url: null, error: String(err) }
  }
}

/**
 * Check if a file exists in storage
 */
export async function fileExists(orgId: string, hash: string): Promise<boolean> {
  const dir = `${orgId}/${hash.substring(0, 2)}`
  
  const { data } = await supabase.storage
    .from(BUCKET_NAME)
    .list(dir, { search: hash })
  
  return data !== null && data.length > 0
}

/**
 * Delete a file from storage (admin only, use with caution)
 * Only delete if no file_versions reference this hash
 */
export async function deleteFile(
  orgId: string,
  hash: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const storagePath = getStoragePath(orgId, hash)
    
    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .remove([storagePath])
    
    if (error) {
      return { success: false, error: error.message }
    }
    
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * Get storage usage for an organization
 */
export async function getStorageUsage(orgId: string): Promise<{
  totalBytes: number
  fileCount: number
  error?: string
}> {
  try {
    // List all files in org's storage
    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .list(orgId, {
        limit: 10000,
        sortBy: { column: 'created_at', order: 'desc' }
      })
    
    if (error) {
      return { totalBytes: 0, fileCount: 0, error: error.message }
    }
    
    // This only lists directories at first level, need to go deeper
    // For accurate count, query the database instead
    const { data: dbData, error: dbError } = await supabase
      .from('file_versions')
      .select('file_size')
      .eq('org_id', orgId)
    
    if (dbError) {
      return { totalBytes: 0, fileCount: 0, error: dbError.message }
    }
    
    const totalBytes = dbData?.reduce((sum, v) => sum + (v.file_size || 0), 0) || 0
    const fileCount = dbData?.length || 0
    
    return { totalBytes, fileCount }
  } catch (err) {
    return { totalBytes: 0, fileCount: 0, error: String(err) }
  }
}

