// Type declarations for Electron API exposed via preload

interface PathResult {
  success: boolean
  path?: string
  error?: string
}

interface FileReadResult {
  success: boolean
  data?: string
  hash?: string
  error?: string
}

interface FileWriteResult {
  success: boolean
  error?: string
  size?: number
}

interface HashResult {
  success: boolean
  hash?: string
  error?: string
}

interface LocalFileInfo {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  extension: string
  size: number
  modifiedTime: string
  hash?: string
}

interface FilesListResult {
  success: boolean
  files?: LocalFileInfo[]
  error?: string
}

interface OperationResult {
  success: boolean
  error?: string
}

interface FileSelectResult {
  success: boolean
  files?: { name: string; path: string; data: string }[]
  canceled?: boolean
  error?: string
}

interface FolderSelectResult {
  success: boolean
  folderName?: string
  folderPath?: string
  files?: { name: string; path: string; relativePath: string; extension: string; size: number; modifiedTime: string }[]
  canceled?: boolean
  error?: string
}

interface SaveDialogResult {
  success: boolean
  path?: string
  canceled?: boolean
  error?: string
}

declare global {
  interface Window {
    electronAPI: {
      // App info
      getVersion: () => Promise<string>
      getPlatform: () => Promise<string>
      getTitleBarOverlayRect: () => Promise<{ x: number; y: number; width: number; height: number }>
      getPathForFile: (file: File) => string
      
      // OAuth
      openOAuthWindow: (url: string) => Promise<{ success: boolean; canceled?: boolean; error?: string }>
      
      // Logging
      getLogs: () => Promise<Array<{ timestamp: string; level: string; message: string; data?: unknown }>>
      getLogPath: () => Promise<string | null>
      exportLogs: () => Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }>
      log: (level: string, message: string, data?: unknown) => void
      getLogsDir: () => Promise<string>
      listLogFiles: () => Promise<{ success: boolean; files?: Array<{ name: string; path: string; size: number; modifiedTime: string; isCurrentSession: boolean }>; error?: string }>
      readLogFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
      openLogsDir: () => Promise<{ success: boolean; error?: string }>
      deleteLogFile: (filePath: string) => Promise<{ success: boolean; error?: string }>
      
      // Window controls
      minimize: () => void
      maximize: () => void
      close: () => void
      isMaximized: () => Promise<boolean>
      
      // Working directory
      selectWorkingDir: () => Promise<PathResult>
      getWorkingDir: () => Promise<string | null>
      setWorkingDir: (path: string) => Promise<PathResult>
      createWorkingDir: (path: string) => Promise<PathResult>
      clearWorkingDir: () => Promise<{ success: boolean }>
      
      // File system operations
      readFile: (path: string) => Promise<FileReadResult>
      writeFile: (path: string, base64Data: string) => Promise<FileWriteResult>
      downloadUrl: (url: string, destPath: string) => Promise<FileWriteResult>
      fileExists: (path: string) => Promise<boolean>
      getFileHash: (path: string) => Promise<HashResult>
      listWorkingFiles: () => Promise<FilesListResult>
      createFolder: (path: string) => Promise<OperationResult>
      deleteItem: (path: string) => Promise<OperationResult>
      renameItem: (oldPath: string, newPath: string) => Promise<OperationResult>
      copyFile: (sourcePath: string, destPath: string) => Promise<OperationResult>
      moveFile: (sourcePath: string, destPath: string) => Promise<OperationResult>
      ensureDir: (path: string) => Promise<OperationResult>
      openInExplorer: (path: string) => Promise<OperationResult>
      showInExplorer: (path: string) => Promise<OperationResult>
      openFile: (path: string) => Promise<OperationResult>
      setReadonly: (path: string, readonly: boolean) => Promise<OperationResult>
      isReadonly: (path: string) => Promise<{ success: boolean; readonly?: boolean; error?: string }>
      startDrag: (filePaths: string[]) => void
      onDownloadProgress: (callback: (progress: { loaded: number; total: number; speed: number }) => void) => () => void
      
      // Dialogs
      selectFiles: () => Promise<FileSelectResult>
      selectFolder: () => Promise<FolderSelectResult>
      showSaveDialog: (defaultName: string) => Promise<SaveDialogResult>
      
      // eDrawings preview
      checkEDrawingsInstalled: () => Promise<{ installed: boolean; path: string | null }>
      openInEDrawings: (filePath: string) => Promise<{ success: boolean; error?: string }>
      getWindowHandle: () => Promise<number[] | null>
      
      // SolidWorks thumbnail extraction  
      extractSolidWorksThumbnail: (filePath: string) => Promise<{ success: boolean; data?: string; error?: string }>
      
      // Embedded eDrawings preview
      isEDrawingsNativeAvailable: () => Promise<boolean>
      createEDrawingsPreview: () => Promise<{ success: boolean; error?: string }>
      attachEDrawingsPreview: () => Promise<{ success: boolean; error?: string }>
      loadEDrawingsFile: (filePath: string) => Promise<{ success: boolean; error?: string }>
      setEDrawingsBounds: (x: number, y: number, w: number, h: number) => Promise<{ success: boolean }>
      showEDrawingsPreview: () => Promise<{ success: boolean }>
      hideEDrawingsPreview: () => Promise<{ success: boolean }>
      destroyEDrawingsPreview: () => Promise<{ success: boolean }>
      
      // Auto Updater
      checkForUpdates: () => Promise<{ success: boolean; updateInfo?: unknown; error?: string }>
      downloadUpdate: () => Promise<{ success: boolean; error?: string }>
      installUpdate: () => Promise<{ success: boolean; error?: string }>
      getUpdateStatus: () => Promise<{
        updateAvailable: { version: string; releaseDate?: string; releaseNotes?: string } | null
        updateDownloaded: boolean
        downloadProgress: { percent: number; bytesPerSecond: number; transferred: number; total: number } | null
      }>
      
      // Update event listeners
      onUpdateChecking: (callback: () => void) => () => void
      onUpdateAvailable: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void) => () => void
      onUpdateNotAvailable: (callback: (info: { version: string }) => void) => () => void
      onUpdateDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => () => void
      onUpdateDownloaded: (callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void) => () => void
      onUpdateError: (callback: (error: { message: string }) => void) => () => void
      
      // Menu events
      onMenuEvent: (callback: (event: string) => void) => () => void
      
      // File change events
      onFilesChanged: (callback: (files: string[]) => void) => () => void
      
      // Auth session events (for OAuth callback in production)
      onSetSession: (callback: (tokens: { access_token: string; refresh_token: string; expires_in?: number; expires_at?: number }) => void) => () => void
    }
  }
}

export {}

