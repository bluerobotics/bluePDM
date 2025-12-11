import { app, BrowserWindow, ipcMain, Menu, shell, dialog, screen, nativeImage, nativeTheme } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import http from 'http'
import { fileURLToPath } from 'url'
import chokidar from 'chokidar'
import type { AddressInfo } from 'net'
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ============================================
// File-based Logging System
// ============================================
const LOG_MAX_FILES = 100 // Keep max 100 log files (10MB each = 1GB max total)
const LOG_MAX_SIZE = 10 * 1024 * 1024 // 10MB max per log file

interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  data?: unknown
}

// In-memory log buffer (for fast access)
const logBuffer: LogEntry[] = []
const LOG_BUFFER_MAX = 1000 // Keep last 1000 entries in memory

let logFilePath: string | null = null
let logStream: fs.WriteStream | null = null
let currentLogSize = 0 // Track current log file size in bytes

function formatDateForFilename(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`
}

function initializeLogging() {
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs')
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true })
    }
    
    // Create a new log file for this session with timestamp
    const sessionTimestamp = formatDateForFilename(new Date())
    logFilePath = path.join(logsDir, `bluepdm-${sessionTimestamp}.log`)
    
    // Clean up old log files if we have too many
    cleanupOldLogFiles(logsDir)
    
    // Open log file for writing (new file for each session)
    logStream = fs.createWriteStream(logFilePath, { flags: 'w' })
    currentLogSize = 0
    
    // Write startup header
    const startupHeader = `${'='.repeat(60)}\nBluePDM Session Log\nStarted: ${new Date().toISOString()}\nVersion: ${app.getVersion()}\nPlatform: ${process.platform} ${process.arch}\nElectron: ${process.versions.electron}\nNode: ${process.versions.node}\n${'='.repeat(60)}\n\n`
    logStream.write(startupHeader)
    currentLogSize += Buffer.byteLength(startupHeader, 'utf8')
  } catch (err) {
    console.error('Failed to initialize logging:', err)
  }
}

function cleanupOldLogFiles(logsDir: string) {
  try {
    // Get all log files sorted by modified time (newest first)
    const logFiles = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('bluepdm-') && f.endsWith('.log'))
      .map(filename => ({
        name: filename,
        path: path.join(logsDir, filename),
        mtime: fs.statSync(path.join(logsDir, filename)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime)
    
    // Delete files beyond the limit (keeping newest LOG_MAX_FILES - 1 to make room for new one)
    if (logFiles.length >= LOG_MAX_FILES) {
      const filesToDelete = logFiles.slice(LOG_MAX_FILES - 1)
      for (const file of filesToDelete) {
        try {
          fs.unlinkSync(file.path)
          console.log(`Deleted old log file: ${file.name}`)
        } catch (err) {
          console.error(`Failed to delete old log file ${file.name}:`, err)
        }
      }
    }
  } catch (err) {
    console.error('Failed to cleanup old log files:', err)
  }
}

function rotateLogFile() {
  try {
    // Close current log stream
    if (logStream) {
      logStream.end()
      logStream = null
    }
    
    const logsDir = path.join(app.getPath('userData'), 'logs')
    
    // Clean up old log files before creating new one
    cleanupOldLogFiles(logsDir)
    
    // Create new log file with current timestamp
    const newTimestamp = formatDateForFilename(new Date())
    logFilePath = path.join(logsDir, `bluepdm-${newTimestamp}.log`)
    logStream = fs.createWriteStream(logFilePath, { flags: 'w' })
    currentLogSize = 0
    
    // Write continuation header
    const header = `${'='.repeat(60)}\nBluePDM Log (continued)\nRotated: ${new Date().toISOString()}\nVersion: ${app.getVersion()}\n${'='.repeat(60)}\n\n`
    logStream.write(header)
    currentLogSize += Buffer.byteLength(header, 'utf8')
  } catch (err) {
    console.error('Failed to rotate log file:', err)
  }
}

function writeLog(level: LogEntry['level'], message: string, data?: unknown) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data
  }
  
  // Add to memory buffer
  logBuffer.push(entry)
  if (logBuffer.length > LOG_BUFFER_MAX) {
    logBuffer.shift() // Remove oldest
  }
  
  // Format for file/console
  const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : ''
  const logLine = `[${entry.timestamp}] [${level.toUpperCase()}] ${message}${dataStr}\n`
  
  // Write to console
  if (level === 'error') {
    console.error(logLine.trim())
  } else if (level === 'warn') {
    console.warn(logLine.trim())
  } else {
    console.log(logLine.trim())
  }
  
  // Write to file
  if (logStream) {
    const lineBytes = Buffer.byteLength(logLine, 'utf8')
    
    // Check if we need to rotate before writing
    if (currentLogSize + lineBytes > LOG_MAX_SIZE) {
      rotateLogFile()
    }
    
    logStream.write(logLine)
    currentLogSize += lineBytes
  }
}

// Prevent crashes from taking down the whole app
process.on('uncaughtException', (error) => {
  writeLog('error', 'Uncaught exception', { error: error.message, stack: error.stack })
})

process.on('unhandledRejection', (reason) => {
  writeLog('error', 'Unhandled rejection', { reason: String(reason) })
})

let mainWindow: BrowserWindow | null = null

// Local working directory for checked-out files
let workingDirectory: string | null = null
let fileWatcher: chokidar.FSWatcher | null = null

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// Window state persistence
interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized: boolean
}

const windowStateFile = path.join(app.getPath('userData'), 'window-state.json')

function loadWindowState(): WindowState {
  try {
    if (fs.existsSync(windowStateFile)) {
      const data = fs.readFileSync(windowStateFile, 'utf-8')
      return JSON.parse(data)
    }
  } catch (err) {
    console.error('Failed to load window state:', err)
  }
  return { width: 1400, height: 900, isMaximized: false }
}

function saveWindowState() {
  if (!mainWindow) return
  
  try {
    const isMaximized = mainWindow.isMaximized()
    const bounds = mainWindow.getBounds()
    
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized
    }
    
    fs.writeFileSync(windowStateFile, JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('Failed to save window state:', err)
  }
}

// Convenience log functions (use new logging system)
const log = (message: string, data?: unknown) => {
  writeLog('info', `[Main] ${message}`, data)
}

const logDebug = (message: string, data?: unknown) => {
  writeLog('debug', `[Main] ${message}`, data)
}

const logError = (message: string, data?: unknown) => {
  writeLog('error', `[Main] ${message}`, data)
}

const logWarn = (message: string, data?: unknown) => {
  writeLog('warn', `[Main] ${message}`, data)
}

log('BluePDM starting...', { isDev, dirname: __dirname })

// Follow system dark/light mode for web content (like Google sign-in)
nativeTheme.themeSource = 'system'

app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  log('Another instance is running, quitting...')
  app.quit()
} else {
  log('Got single instance lock')
}

function createWindow() {
  log('Creating BrowserWindow...')
  
  // Load saved window state
  const savedState = loadWindowState()
  
  // Validate window position is on a visible display
  let x = savedState.x
  let y = savedState.y
  if (x !== undefined && y !== undefined) {
    const displays = screen.getAllDisplays()
    const isOnDisplay = displays.some(display => {
      const { x: dx, y: dy, width, height } = display.bounds
      return x! >= dx && x! < dx + width && y! >= dy && y! < dy + height
    })
    if (!isOnDisplay) {
      x = undefined
      y = undefined
    }
  }
  
  mainWindow = new BrowserWindow({
    x,
    y,
    width: savedState.width,
    height: savedState.height,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0a1929',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#071320',
      symbolColor: '#e3f2fd',
      height: 36
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  })

  // Restore maximized state
  if (savedState.isMaximized) {
    mainWindow.maximize()
  }

  // Save window state on changes
  mainWindow.on('resize', saveWindowState)
  mainWindow.on('move', saveWindowState)
  mainWindow.on('maximize', saveWindowState)
  mainWindow.on('unmaximize', saveWindowState)

  let windowShown = false
  const showWindow = () => {
    if (!windowShown && mainWindow) {
      windowShown = true
      mainWindow.show()
    }
  }

  mainWindow.once('ready-to-show', showWindow)
  setTimeout(showWindow, 5000)

  mainWindow.webContents.on('crashed', () => log('Renderer process crashed!'))
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log('Failed to load:', errorCode, errorDescription)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    log('Page finished loading')
    // Send titlebar overlay rect to renderer
    if (mainWindow) {
      const overlayRect = mainWindow.getTitleBarOverlayRect?.() || { x: 0, y: 0, width: 138, height: 38 }
      mainWindow.webContents.send('titlebar-overlay-rect', overlayRect)
    }
  })

  const loadPath = isDev 
    ? 'http://localhost:5173' 
    : path.join(__dirname, '../dist/index.html')
  
  log('Loading:', loadPath)
  
  if (isDev) {
    mainWindow.loadURL(loadPath)
  } else {
    mainWindow.loadFile(loadPath).catch(err => log('Error loading file:', err))
  }

  // In production, intercept OAuth redirects to localhost and reload the app with auth tokens
  if (!isDev) {
    mainWindow.webContents.on('will-navigate', (event, navUrl) => {
      if (navUrl.startsWith('http://localhost') && navUrl.includes('access_token')) {
        log('Intercepting OAuth redirect in main window:', navUrl.substring(0, 80) + '...')
        event.preventDefault()
        
        // Extract hash/query from the redirect URL
        const url = new URL(navUrl)
        const hashFragment = url.hash || ''
        const queryString = url.search || ''
        
        // Load the production HTML file with the auth tokens in hash
        const prodPath = path.join(__dirname, '../dist/index.html')
        const normalizedPath = prodPath.replace(/\\/g, '/')
        const fileUrl = `file:///${normalizedPath}${queryString}${hashFragment}`
        log('Reloading with file URL:', fileUrl.substring(0, 100) + '...')
        
        mainWindow?.loadURL(fileUrl)
      }
    })
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  createAppMenu()
}

function createAppMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Set Working Directory...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => mainWindow?.webContents.send('menu:set-working-dir')
        },
        { type: 'separator' },
        {
          label: 'Add Files...',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => mainWindow?.webContents.send('menu:add-files')
        },
        {
          label: 'Add Folder...',
          click: () => mainWindow?.webContents.send('menu:add-folder')
        },
        { type: 'separator' },
        {
          label: 'Check Out Selected',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => mainWindow?.webContents.send('menu:checkout')
        },
        {
          label: 'Check In Selected',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => mainWindow?.webContents.send('menu:checkin')
        },
        { type: 'separator' },
        {
          label: 'Refresh',
          accelerator: 'F5',
          click: () => mainWindow?.webContents.send('menu:refresh')
        },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
          click: () => app.quit()
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { type: 'separator' },
        {
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          role: 'selectAll'
        },
        { type: 'separator' },
        {
          label: 'Find...',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow?.webContents.send('menu:find')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => mainWindow?.webContents.send('menu:toggle-sidebar')
        },
        {
          label: 'Toggle Details Panel',
          accelerator: 'CmdOrCtrl+D',
          click: () => mainWindow?.webContents.send('menu:toggle-details')
        },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', role: 'zoomIn' },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Toggle Full Screen', accelerator: 'F11', role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: process.platform === 'darwin' ? 'Cmd+Alt+I' : 'Ctrl+Shift+I',
          role: 'toggleDevTools'
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About BluePDM',
          click: () => mainWindow?.webContents.send('menu:about')
        }
      ]
    }
  ]

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { label: 'About BluePDM', role: 'about' },
        { type: 'separator' },
        { label: 'Services', role: 'services' },
        { type: 'separator' },
        { label: 'Hide', accelerator: 'Cmd+H', role: 'hide' },
        { label: 'Hide Others', accelerator: 'Cmd+Alt+H', role: 'hideOthers' },
        { label: 'Show All', role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Cmd+Q', role: 'quit' }
      ]
    })
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

// ============================================
// IPC Handlers - OAuth via System Browser
// ============================================

// Active OAuth server (only one at a time)
let activeOAuthServer: http.Server | null = null
let oauthTimeout: NodeJS.Timeout | null = null

// Clean up any active OAuth flow
function cleanupOAuthServer() {
  if (oauthTimeout) {
    clearTimeout(oauthTimeout)
    oauthTimeout = null
  }
  if (activeOAuthServer) {
    try {
      activeOAuthServer.close()
    } catch (e) {
      // Ignore close errors
    }
    activeOAuthServer = null
  }
}

ipcMain.handle('auth:open-oauth-window', async (_, url: string) => {
  return new Promise((resolve) => {
    // Clean up any previous OAuth flow
    cleanupOAuthServer()
    
    log('[OAuth] Starting system browser OAuth flow')
    
    // Track if we've resolved the promise
    let hasResolved = false
    const safeResolve = (result: { success: boolean; canceled?: boolean; error?: string }) => {
      if (!hasResolved) {
        hasResolved = true
        cleanupOAuthServer()
        resolve(result)
      }
    }
    
    // Create a local HTTP server to receive the OAuth callback
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', `http://localhost`)
      
      log('[OAuth] Received callback request:', reqUrl.pathname, { search: reqUrl.search?.substring(0, 50) })
      
      // Handle the OAuth callback
      if (reqUrl.pathname === '/auth/callback' || reqUrl.pathname === '/') {
        // Check for tokens in query params first (some OAuth flows use this)
        const accessToken = reqUrl.searchParams.get('access_token')
        const refreshToken = reqUrl.searchParams.get('refresh_token')
        const expiresIn = reqUrl.searchParams.get('expires_in')
        const expiresAt = reqUrl.searchParams.get('expires_at')
        
        // Check for OAuth errors
        const error = reqUrl.searchParams.get('error')
        const errorDescription = reqUrl.searchParams.get('error_description')
        
        if (error) {
          log('[OAuth] OAuth error in callback:', error, errorDescription)
          const errorHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Sign In Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #0a1929 0%, #1a365d 100%);
      color: #e3f2fd;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      max-width: 400px;
    }
    .error-icon {
      width: 80px;
      height: 80px;
      margin-bottom: 20px;
    }
    h1 { margin: 0 0 10px 0; font-weight: 500; color: #f44336; }
    p { margin: 0; opacity: 0.8; }
  </style>
</head>
<body>
  <div class="container">
    <svg class="error-icon" viewBox="0 0 24 24" fill="none" stroke="#f44336" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
      <path d="M15 9l-6 6M9 9l6 6"/>
    </svg>
    <h1>Sign In Failed</h1>
    <p>${errorDescription || error || 'An error occurred during sign in.'}</p>
    <p style="margin-top: 16px; font-size: 12px;">You can close this window and try again.</p>
  </div>
  <script>setTimeout(() => window.close(), 5000);</script>
</body>
</html>`
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(errorHtml)
          safeResolve({ success: false, error: errorDescription || error || 'OAuth error' })
          return
        }
        
        // If we have tokens directly in query params, process them immediately
        if (accessToken && refreshToken) {
          log('[OAuth] Tokens received in query params, sending to renderer')
          
          const successHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Sign In Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #0a1929 0%, #1a365d 100%);
      color: #e3f2fd;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
    }
    .checkmark {
      width: 80px;
      height: 80px;
      margin-bottom: 20px;
    }
    h1 { margin: 0 0 10px 0; font-weight: 500; }
    p { margin: 0; opacity: 0.8; }
  </style>
</head>
<body>
  <div class="container">
    <svg class="checkmark" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
      <path d="M8 12l3 3 5-6"/>
    </svg>
    <h1>Sign In Successful!</h1>
    <p>You can close this window and return to BluePDM.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(successHtml)
          
          mainWindow?.webContents.send('auth:set-session', {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: expiresIn ? parseInt(expiresIn) : 3600,
            expires_at: expiresAt ? parseInt(expiresAt) : undefined
          })
          
          // Focus the main window
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.focus()
          }
          
          safeResolve({ success: true })
          return
        }
        
        // No tokens in query - tokens are likely in hash fragment (client-side only)
        // Send HTML page that extracts tokens from hash and forwards them
        log('[OAuth] No tokens in query params, serving hash extraction page')
        const hashExtractHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Completing Sign In...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #0a1929 0%, #1a365d 100%);
      color: #e3f2fd;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      max-width: 400px;
    }
    .spinner {
      width: 60px;
      height: 60px;
      border: 4px solid rgba(255,255,255,0.2);
      border-top-color: #4caf50;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .checkmark {
      width: 80px;
      height: 80px;
      margin-bottom: 20px;
      display: none;
    }
    .error-icon {
      width: 80px;
      height: 80px;
      margin-bottom: 20px;
      display: none;
    }
    h1 { margin: 0 0 10px 0; font-weight: 500; }
    p { margin: 0; opacity: 0.8; }
    .status { transition: opacity 0.3s; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div id="loading" class="status">
      <div class="spinner"></div>
      <h1>Completing Sign In...</h1>
      <p>Please wait a moment.</p>
    </div>
    <div id="success" class="status hidden">
      <svg class="checkmark" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2" style="display:block;margin:0 auto 20px;">
        <circle cx="12" cy="12" r="10"/>
        <path d="M8 12l3 3 5-6"/>
      </svg>
      <h1>Sign In Successful!</h1>
      <p>You can close this window and return to BluePDM.</p>
    </div>
    <div id="error" class="status hidden">
      <svg class="error-icon" viewBox="0 0 24 24" fill="none" stroke="#f44336" stroke-width="2" style="display:block;margin:0 auto 20px;">
        <circle cx="12" cy="12" r="10"/>
        <path d="M15 9l-6 6M9 9l6 6"/>
      </svg>
      <h1 style="color:#f44336;">Sign In Issue</h1>
      <p id="errorMsg">Could not complete sign in. Please try again.</p>
    </div>
  </div>
  <script>
    (async function() {
      const showSuccess = () => {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('success').classList.remove('hidden');
        setTimeout(() => window.close(), 2000);
      };
      
      const showError = (msg) => {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('error').classList.remove('hidden');
        if (msg) document.getElementById('errorMsg').textContent = msg;
        setTimeout(() => window.close(), 5000);
      };
      
      try {
        // Extract tokens from hash fragment
        const hash = window.location.hash.substring(1);
        console.log('[OAuth] Hash length:', hash.length);
        
        if (!hash) {
          console.log('[OAuth] No hash fragment found');
          showError('No authentication data received. Please try signing in again.');
          return;
        }
        
        const params = new URLSearchParams(hash);
        
        // Check for errors in hash
        const error = params.get('error');
        const errorDescription = params.get('error_description');
        if (error) {
          console.log('[OAuth] Error in hash:', error, errorDescription);
          showError(errorDescription || error);
          return;
        }
        
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');
        
        if (!accessToken) {
          console.log('[OAuth] No access_token in hash');
          showError('No access token received. Please try signing in again.');
          return;
        }
        
        if (!refreshToken) {
          console.log('[OAuth] No refresh_token in hash');
          showError('No refresh token received. Please try signing in again.');
          return;
        }
        
        console.log('[OAuth] Forwarding tokens to server...');
        
        // Forward tokens to the server with retry logic
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
          attempts++;
          try {
            const response = await fetch('/auth/tokens?' + hash, {
              method: 'GET',
              cache: 'no-cache'
            });
            
            if (response.ok) {
              console.log('[OAuth] Tokens forwarded successfully');
              showSuccess();
              return;
            } else {
              console.log('[OAuth] Server returned error:', response.status);
              if (attempts >= maxAttempts) {
                showError('Server error. Please try again.');
              }
            }
          } catch (fetchErr) {
            console.log('[OAuth] Fetch error (attempt ' + attempts + '):', fetchErr);
            if (attempts >= maxAttempts) {
              showError('Could not connect to app. Please try again.');
            }
            // Wait before retry
            await new Promise(r => setTimeout(r, 500));
          }
        }
      } catch (err) {
        console.error('[OAuth] Exception:', err);
        showError('An unexpected error occurred. Please try again.');
      }
    })();
  </script>
</body>
</html>`
        
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(hashExtractHtml)
        return
      }
      
      // Handle the token forwarding request from hash extraction page
      if (reqUrl.pathname === '/auth/tokens') {
        const accessToken = reqUrl.searchParams.get('access_token')
        const refreshToken = reqUrl.searchParams.get('refresh_token')
        const expiresIn = reqUrl.searchParams.get('expires_in')
        const expiresAt = reqUrl.searchParams.get('expires_at')
        
        log('[OAuth] /auth/tokens request received', { 
          hasAccessToken: !!accessToken, 
          hasRefreshToken: !!refreshToken 
        })
        
        if (accessToken && refreshToken) {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('OK')
          
          log('[OAuth] Tokens received from hash fragment, sending to renderer')
          mainWindow?.webContents.send('auth:set-session', {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: expiresIn ? parseInt(expiresIn) : 3600,
            expires_at: expiresAt ? parseInt(expiresAt) : undefined
          })
          
          // Focus the main window
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.focus()
          }
          
          safeResolve({ success: true })
        } else {
          log('[OAuth] /auth/tokens request missing tokens')
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('Missing tokens')
        }
        return
      }
      
      // Unknown path - redirect to callback
      log('[OAuth] Unknown path, redirecting to /auth/callback')
      res.writeHead(302, { 'Location': '/auth/callback' + (reqUrl.search || '') })
      res.end()
    })
    
    // Listen on a random available port
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      const port = address.port
      const callbackUrl = `http://127.0.0.1:${port}/auth/callback`
      
      log('[OAuth] Local callback server started on port', port)
      
      activeOAuthServer = server
      
      // Modify the OAuth URL to use our local callback
      // Supabase uses 'redirect_to' parameter for the final redirect destination
      try {
        const oauthUrl = new URL(url)
        oauthUrl.searchParams.set('redirect_to', callbackUrl)
        
        const finalUrl = oauthUrl.toString()
        log('[OAuth] Opening system browser with OAuth URL', { 
          port, 
          callbackUrl,
          urlPreview: finalUrl.substring(0, 100) + '...'
        })
        
        shell.openExternal(finalUrl)
        
        // Set a timeout for the OAuth flow (5 minutes)
        oauthTimeout = setTimeout(() => {
          log('[OAuth] Timeout waiting for OAuth callback')
          safeResolve({ success: false, error: 'OAuth timed out. Please try again.' })
        }, 5 * 60 * 1000)
        
      } catch (err) {
        log('[OAuth] Error parsing OAuth URL:', err)
        safeResolve({ success: false, error: String(err) })
      }
    })
    
    server.on('error', (err) => {
      log('[OAuth] Server error:', err)
      safeResolve({ success: false, error: String(err) })
    })
  })
})

// ============================================
// IPC Handlers - App Info
// ============================================
ipcMain.handle('app:get-version', () => app.getVersion())
ipcMain.handle('app:get-platform', () => process.platform)
ipcMain.handle('app:get-titlebar-overlay-rect', () => {
  if (!mainWindow) return { x: 0, y: 0, width: 138, height: 38 }
  // getTitleBarOverlayRect is available in Electron 20+
  return mainWindow.getTitleBarOverlayRect?.() || { x: 0, y: 0, width: 138, height: 38 }
})

// ============================================
// IPC Handlers - Logging
// ============================================
ipcMain.handle('logs:get-entries', () => {
  return logBuffer
})

ipcMain.handle('logs:get-path', () => {
  return logFilePath
})

ipcMain.handle('logs:export', async () => {
  try {
    // Export current session logs from memory buffer
    let sessionLogs = `BluePDM Session Logs\nExported: ${new Date().toISOString()}\nVersion: ${app.getVersion()}\nPlatform: ${process.platform} ${process.arch}\nEntries: ${logBuffer.length}\n${'='.repeat(60)}\n\n`
    
    // Format each log entry
    for (const entry of logBuffer) {
      const dataStr = entry.data !== undefined ? ` ${JSON.stringify(entry.data)}` : ''
      sessionLogs += `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}${dataStr}\n`
    }
    
    // Show save dialog
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export Session Logs',
      defaultPath: `bluepdm-session-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
      filters: [
        { name: 'Text Files', extensions: ['txt'] },
        { name: 'Log Files', extensions: ['log'] }
      ]
    })
    
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true }
    }
    
    fs.writeFileSync(result.filePath, sessionLogs)
    log('Logs exported to: ' + result.filePath)
    
    return { success: true, path: result.filePath }
  } catch (err) {
    logError('Failed to export logs', { error: String(err) })
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('logs:get-dir', () => {
  return path.join(app.getPath('userData'), 'logs')
})

ipcMain.handle('logs:list-files', async () => {
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs')
    if (!fs.existsSync(logsDir)) {
      return { success: true, files: [] }
    }
    
    const files = fs.readdirSync(logsDir)
      .filter(f => f.endsWith('.log'))
      .map(filename => {
        const filePath = path.join(logsDir, filename)
        const stats = fs.statSync(filePath)
        return {
          name: filename,
          path: filePath,
          size: stats.size,
          modifiedTime: stats.mtime.toISOString(),
          isCurrentSession: logFilePath ? path.normalize(filePath) === path.normalize(logFilePath) : false
        }
      })
      .sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime())
    
    return { success: true, files }
  } catch (err) {
    logError('Failed to list log files', { error: String(err) })
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('logs:read-file', async (_, filePath: string) => {
  try {
    // Security check: ensure file is in logs directory
    const logsDir = path.join(app.getPath('userData'), 'logs')
    const normalizedPath = path.normalize(filePath)
    if (!normalizedPath.startsWith(logsDir)) {
      return { success: false, error: 'Access denied: file is not in logs directory' }
    }
    
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' }
    }
    
    const content = fs.readFileSync(filePath, 'utf-8')
    return { success: true, content }
  } catch (err) {
    logError('Failed to read log file', { error: String(err) })
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('logs:open-dir', async () => {
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs')
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true })
    }
    await shell.openPath(logsDir)
    return { success: true }
  } catch (err) {
    logError('Failed to open logs directory', { error: String(err) })
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('logs:delete-file', async (_, filePath: string) => {
  try {
    // Security check: ensure file is in logs directory
    const logsDir = path.join(app.getPath('userData'), 'logs')
    const normalizedPath = path.normalize(filePath)
    if (!normalizedPath.startsWith(logsDir)) {
      return { success: false, error: 'Access denied: file is not in logs directory' }
    }
    
    // Don't allow deleting current session log
    if (normalizedPath === logFilePath) {
      return { success: false, error: 'Cannot delete current session log' }
    }
    
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' }
    }
    
    fs.unlinkSync(filePath)
    log('Deleted log file: ' + filePath)
    return { success: true }
  } catch (err) {
    logError('Failed to delete log file', { error: String(err) })
    return { success: false, error: String(err) }
  }
})

// Log from renderer process
ipcMain.on('logs:write', (_, level: string, message: string, data?: unknown) => {
  const validLevel = ['info', 'warn', 'error', 'debug'].includes(level) ? level as LogEntry['level'] : 'info'
  writeLog(validLevel, `[Renderer] ${message}`, data)
})

// ============================================
// IPC Handlers - Window Controls
// ============================================
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})
ipcMain.on('window:close', () => mainWindow?.close())
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized())

// ============================================
// IPC Handlers - Working Directory
// ============================================
ipcMain.handle('working-dir:select', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Select Working Directory',
    properties: ['openDirectory', 'createDirectory']
  })
  
  if (!result.canceled && result.filePaths.length > 0) {
    workingDirectory = result.filePaths[0]
    hashCache.clear() // Clear hash cache when changing working directory
    log('Working directory set:', workingDirectory)
    startFileWatcher(workingDirectory)
    return { success: true, path: workingDirectory }
  }
  return { success: false, canceled: true }
})

ipcMain.handle('working-dir:get', () => workingDirectory)

ipcMain.handle('working-dir:clear', () => {
  log('Clearing working directory and stopping file watcher')
  stopFileWatcher()
  workingDirectory = null
  hashCache.clear() // Clear hash cache
  return { success: true }
})

ipcMain.handle('working-dir:set', async (_, newPath: string) => {
  if (fs.existsSync(newPath)) {
    workingDirectory = newPath
    hashCache.clear() // Clear hash cache when changing working directory
    startFileWatcher(newPath)
    return { success: true, path: workingDirectory }
  }
  return { success: false, error: 'Path does not exist' }
})

ipcMain.handle('working-dir:create', async (_, newPath: string) => {
  try {
    // Expand ~ to home directory on macOS/Linux
    let expandedPath = newPath
    if (newPath.startsWith('~')) {
      const homedir = require('os').homedir()
      expandedPath = newPath.replace(/^~/, homedir)
    }
    
    // Create the directory if it doesn't exist
    if (!fs.existsSync(expandedPath)) {
      fs.mkdirSync(expandedPath, { recursive: true })
      log('Created working directory:', expandedPath)
    }
    workingDirectory = expandedPath
    hashCache.clear() // Clear hash cache when changing working directory
    startFileWatcher(expandedPath)
    return { success: true, path: workingDirectory }
  } catch (err) {
    log('Error creating working directory:', err)
    return { success: false, error: String(err) }
  }
})

// Stop file watcher
function stopFileWatcher() {
  if (fileWatcher) {
    log('Stopping file watcher')
    fileWatcher.close()
    fileWatcher = null
  }
}

// File watcher for detecting external changes
function startFileWatcher(dirPath: string) {
  // Close existing watcher if any
  stopFileWatcher()
  
  log('Starting file watcher for:', dirPath)
  
  // Debounce timer for batching changes
  let debounceTimer: NodeJS.Timeout | null = null
  const changedFiles = new Set<string>()
  
  fileWatcher = chokidar.watch(dirPath, {
    persistent: true,
    ignoreInitial: true,
    usePolling: false,  // Use native fs events (faster, but may need polling on network drives)
    awaitWriteFinish: {
      stabilityThreshold: 1000,  // Wait for file to be stable for 1 second
      pollInterval: 100
    },
    ignorePermissionErrors: true,  // Ignore EPERM errors
    ignored: [
      /(^|[\/\\])\../,  // Ignore dotfiles
      /node_modules/,
      /\.git/,
      /desktop\.ini/i,  // Windows system files
      /thumbs\.db/i,
      /\$RECYCLE\.BIN/i,
      /System Volume Information/i,
      /~\$/,  // Ignore Office temp files
      /\.tmp$/i,
      /\.swp$/i
    ]
  })
  
  const notifyChanges = () => {
    if (changedFiles.size > 0 && mainWindow) {
      const files = Array.from(changedFiles)
      changedFiles.clear()
      log('File changes detected:', files.length, 'files')
      mainWindow.webContents.send('files-changed', files)
    }
    debounceTimer = null
  }
  
  fileWatcher.on('change', (filePath) => {
    const relativePath = path.relative(dirPath, filePath).replace(/\\/g, '/')
    changedFiles.add(relativePath)
    
    // Debounce to batch rapid changes
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    // Use longer debounce when many files are changing (bulk operations)
    const delay = changedFiles.size > 10 ? 2000 : 1000
    debounceTimer = setTimeout(notifyChanges, delay)
  })
  
  fileWatcher.on('add', (filePath) => {
    const relativePath = path.relative(dirPath, filePath).replace(/\\/g, '/')
    changedFiles.add(relativePath)
    
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    // Use longer debounce when many files are changing (bulk operations)
    const delay = changedFiles.size > 10 ? 2000 : 1000
    debounceTimer = setTimeout(notifyChanges, delay)
  })
  
  fileWatcher.on('unlink', (filePath) => {
    const relativePath = path.relative(dirPath, filePath).replace(/\\/g, '/')
    changedFiles.add(relativePath)
    
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    // Use longer debounce when many files are changing (bulk operations)
    const delay = changedFiles.size > 10 ? 2000 : 1000
    debounceTimer = setTimeout(notifyChanges, delay)
  })
  
  fileWatcher.on('error', (error: NodeJS.ErrnoException) => {
    // Ignore EPERM errors (permission denied) - common on Windows for system files
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      return
    }
    log('File watcher error:', error)
  })
}

// ============================================
// IPC Handlers - Local File Operations
// ============================================

// Calculate SHA-256 hash of a file
function hashFileSync(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath)
  const hashSum = crypto.createHash('sha256')
  hashSum.update(fileBuffer)
  return hashSum.digest('hex')
}

// Get file info
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

ipcMain.handle('fs:read-file', async (_, filePath: string) => {
  try {
    const data = fs.readFileSync(filePath)
    const hash = crypto.createHash('sha256').update(data).digest('hex')
    return { 
      success: true, 
      data: data.toString('base64'), 
      size: data.length,
      hash 
    }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('fs:write-file', async (_, filePath: string, base64Data: string) => {
  try {
    const buffer = Buffer.from(base64Data, 'base64')
    
    // Ensure directory exists
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    
    fs.writeFileSync(filePath, buffer)
    
    // Calculate hash of written file
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')
    
    return { success: true, hash, size: buffer.length }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// Download file directly in main process (bypasses IPC for large files)
ipcMain.handle('fs:download-url', async (event, url: string, destPath: string) => {
  try {
    // Ensure directory exists
    const dir = path.dirname(destPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    
    const https = await import('https')
    const http = await import('http')
    const client = url.startsWith('https') ? https : http
    
    return new Promise((resolve) => {
      const request = client.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          // Handle redirect
          const redirectUrl = response.headers.location
          if (redirectUrl) {
            const redirectClient = redirectUrl.startsWith('https') ? https : http
            redirectClient.get(redirectUrl, (redirectResponse) => {
              handleResponse(redirectResponse)
            }).on('error', (err) => {
              resolve({ success: false, error: String(err) })
            })
            return
          }
        }
        handleResponse(response)
      })
      
      request.on('error', (err) => {
        resolve({ success: false, error: String(err) })
      })
      
      function handleResponse(response: any) {
        if (response.statusCode !== 200) {
          resolve({ success: false, error: `HTTP ${response.statusCode}` })
          return
        }
        
        const contentLength = parseInt(response.headers['content-length'] || '0', 10)
        const writeStream = fs.createWriteStream(destPath)
        const hashStream = crypto.createHash('sha256')
        
        let downloaded = 0
        let lastProgressTime = Date.now()
        let lastDownloaded = 0
        
        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          hashStream.update(chunk)
          
          // Send progress every 100ms
          const now = Date.now()
          if (now - lastProgressTime >= 100) {
            const bytesSinceLast = downloaded - lastDownloaded
            const timeSinceLast = (now - lastProgressTime) / 1000
            const speed = timeSinceLast > 0 ? bytesSinceLast / timeSinceLast : 0
            
            // Send progress to renderer
            event.sender.send('download-progress', {
              loaded: downloaded,
              total: contentLength,
              speed
            })
            
            lastProgressTime = now
            lastDownloaded = downloaded
          }
        })
        
        response.pipe(writeStream)
        
        writeStream.on('finish', () => {
          const hash = hashStream.digest('hex')
          resolve({ success: true, hash, size: downloaded })
        })
        
        writeStream.on('error', (err) => {
          resolve({ success: false, error: String(err) })
        })
      }
    })
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('fs:file-exists', async (_, filePath: string) => {
  return fs.existsSync(filePath)
})

ipcMain.handle('fs:get-hash', async (_, filePath: string) => {
  try {
    const hash = hashFileSync(filePath)
    return { success: true, hash }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// List files from any directory (for multi-vault support)
ipcMain.handle('fs:list-dir-files', async (_, dirPath: string) => {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return { success: false, error: 'Directory does not exist' }
  }
  
  const files: LocalFileInfo[] = []
  
  function walkDir(dir: string, baseDir: string) {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true })
      
      for (const item of items) {
        // Skip hidden files
        if (item.name.startsWith('.')) continue
        
        const fullPath = path.join(dir, item.name)
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/')
        const stats = fs.statSync(fullPath)
        
        if (item.isDirectory()) {
          // Add folder entry
          files.push({
            name: item.name,
            path: fullPath,
            relativePath,
            isDirectory: true,
            extension: '',
            size: 0,
            modifiedTime: stats.mtime.toISOString()
          })
          // Recurse into folder
          walkDir(fullPath, baseDir)
        } else {
          // Add file entry with hash for comparison
          let fileHash: string | undefined
          try {
            // Compute hash for files (needed for diff detection)
            const fileData = fs.readFileSync(fullPath)
            fileHash = crypto.createHash('sha256').update(fileData).digest('hex')
          } catch {
            // Skip hash if file can't be read
          }
          
          files.push({
            name: item.name,
            path: fullPath,
            relativePath,
            isDirectory: false,
            extension: path.extname(item.name).toLowerCase(),
            size: stats.size,
            modifiedTime: stats.mtime.toISOString(),
            hash: fileHash
          })
        }
      }
    } catch (err) {
      log('Error reading directory:', err)
    }
  }
  
  walkDir(dirPath, dirPath)
  
  // Sort: folders first, then by name
  files.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.relativePath.localeCompare(b.relativePath)
  })
  
  return { success: true, files }
})

// Hash cache to avoid recomputing hashes for unchanged files
// Key: relativePath, Value: { size, mtime, hash }
const hashCache = new Map<string, { size: number; mtime: number; hash: string }>()

ipcMain.handle('fs:list-working-files', async () => {
  if (!workingDirectory) {
    return { success: false, error: 'No working directory set' }
  }
  
  const files: LocalFileInfo[] = []
  const seenPaths = new Set<string>() // Track which paths we've seen this scan
  
  function walkDir(dir: string, baseDir: string) {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true })
      
      for (const item of items) {
        // Skip hidden files
        if (item.name.startsWith('.')) continue
        
        const fullPath = path.join(dir, item.name)
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/')
        const stats = fs.statSync(fullPath)
        
        if (item.isDirectory()) {
          // Add folder entry
          files.push({
            name: item.name,
            path: fullPath,
            relativePath,
            isDirectory: true,
            extension: '',
            size: 0,
            modifiedTime: stats.mtime.toISOString()
          })
          // Recurse into folder
          walkDir(fullPath, baseDir)
        } else {
          seenPaths.add(relativePath)
          
          // Check hash cache - reuse if file size and mtime haven't changed
          let fileHash: string | undefined
          const cached = hashCache.get(relativePath)
          const mtimeMs = stats.mtime.getTime()
          
          if (cached && cached.size === stats.size && cached.mtime === mtimeMs) {
            // File unchanged, reuse cached hash
            fileHash = cached.hash
          } else {
            // File changed or new, compute hash
            try {
              const fileData = fs.readFileSync(fullPath)
              fileHash = crypto.createHash('sha256').update(fileData).digest('hex')
              // Update cache
              hashCache.set(relativePath, { size: stats.size, mtime: mtimeMs, hash: fileHash })
            } catch {
              // Skip hash if file can't be read
              hashCache.delete(relativePath)
            }
          }
          
          files.push({
            name: item.name,
            path: fullPath,
            relativePath,
            isDirectory: false,
            extension: path.extname(item.name).toLowerCase(),
            size: stats.size,
            modifiedTime: stats.mtime.toISOString(),
            hash: fileHash
          })
        }
      }
    } catch (err) {
      log('Error reading directory:', err)
    }
  }
  
  walkDir(workingDirectory, workingDirectory)
  
  // Clean up cache entries for files that no longer exist
  for (const cachedPath of hashCache.keys()) {
    if (!seenPaths.has(cachedPath)) {
      hashCache.delete(cachedPath)
    }
  }
  
  // Sort: folders first, then by name
  files.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.relativePath.localeCompare(b.relativePath)
  })
  
  return { success: true, files }
})

ipcMain.handle('fs:create-folder', async (_, folderPath: string) => {
  try {
    fs.mkdirSync(folderPath, { recursive: true })
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('fs:delete', async (_, targetPath: string) => {
  try {
    log('Deleting item:', targetPath)
    // Check if path exists first
    if (!fs.existsSync(targetPath)) {
      log('Path does not exist:', targetPath)
      return { success: false, error: 'Path does not exist' }
    }
    
    // If deleting anything inside the working directory, pause the file watcher
    // to release file handles that might block deletion
    const needsWatcherPause = workingDirectory && (
      targetPath === workingDirectory || 
      workingDirectory.startsWith(targetPath) ||
      targetPath.startsWith(workingDirectory)
    )
    
    if (needsWatcherPause) {
      log('Pausing file watcher before delete')
      stopFileWatcher()
      // Give OS time to release file handles
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    
    try {
      // Move to Recycle Bin instead of permanent delete
      await shell.trashItem(targetPath)
      log('Successfully moved to Recycle Bin:', targetPath)
      return { success: true }
    } finally {
      // Restart the file watcher if we paused it (and we didn't delete the working directory itself)
      if (needsWatcherPause && workingDirectory && fs.existsSync(workingDirectory)) {
        log('Restarting file watcher after delete')
        startFileWatcher(workingDirectory)
      }
    }
  } catch (err) {
    log('Failed to delete:', targetPath, err)
    return { success: false, error: String(err) }
  }
})

// Native file drag - allows dragging files out of the app to Explorer, Chrome, etc.
// Create a simple 32x32 PNG icon for drag operations
const DRAG_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABjSURBVFhH7c0xDQAgDAXQskKxgBUsYAErWMECFv7OwEImXEOTN/wdPwEAAAAAAACU7F0z27sZuweeAAAAAAAAlOzdM9u7GbsHngAAAAAAAJTs3TPbuxm7B56AAAAAgF9mZgO0VARYFxh/1QAAAABJRU5ErkJggg=='
)

// Check if running as admin (which breaks drag-and-drop on Windows)
let warnedAboutAdmin = false

ipcMain.on('fs:start-drag', (event, filePaths: string[]) => {
  log('fs:start-drag received:', filePaths.length, 'files')
  
  // Filter to only existing files
  const validPaths = filePaths.filter(p => {
    try {
      const exists = fs.existsSync(p)
      const isFile = exists && fs.statSync(p).isFile()
      if (!exists) log('  File does not exist:', p)
      if (exists && !isFile) log('  Not a file:', p)
      return isFile
    } catch (err) {
      log('  Error checking file:', p, err)
      return false
    }
  })
  
  if (validPaths.length === 0) {
    log('No valid paths for drag')
    return
  }
  
  log('Valid paths for drag:', validPaths)
  
  try {
    // Use the mainWindow's webContents for more reliable drag
    if (mainWindow && !mainWindow.isDestroyed()) {
      log('Calling startDrag via mainWindow.webContents')
      mainWindow.webContents.startDrag({
        files: validPaths,
        icon: DRAG_ICON
      })
      log('startDrag completed')
    } else {
      log('mainWindow not available, using event.sender')
      event.sender.startDrag({
        files: validPaths,
        icon: DRAG_ICON
      })
      log('startDrag via event.sender completed')
    }
  } catch (err) {
    log('startDrag error:', err)
  }
})

ipcMain.handle('fs:rename', async (_, oldPath: string, newPath: string) => {
  try {
    fs.renameSync(oldPath, newPath)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('fs:copy-file', async (_, sourcePath: string, destPath: string) => {
  try {
    const stats = fs.statSync(sourcePath)
    
    if (stats.isDirectory()) {
      // Recursively copy directory
      copyDirSync(sourcePath, destPath)
      log('Copied directory:', sourcePath, '->', destPath)
    } else {
      // Ensure destination directory exists
      const destDir = path.dirname(destPath)
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true })
      }
      
      fs.copyFileSync(sourcePath, destPath)
      log('Copied file:', sourcePath, '->', destPath)
    }
    
    return { success: true }
  } catch (err) {
    log('Error copying:', err)
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('fs:move-file', async (_, sourcePath: string, destPath: string) => {
  try {
    const stats = fs.statSync(sourcePath)
    
    // Ensure destination directory exists
    const destDir = path.dirname(destPath)
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true })
    }
    
    // Try rename first (fastest, works on same filesystem)
    try {
      fs.renameSync(sourcePath, destPath)
      log('Moved (rename):', sourcePath, '->', destPath)
      return { success: true }
    } catch (renameErr) {
      // If rename fails (cross-filesystem), copy then delete
      log('Rename failed, trying copy+delete:', renameErr)
    }
    
    // Fallback: copy then delete
    if (stats.isDirectory()) {
      copyDirSync(sourcePath, destPath)
      fs.rmSync(sourcePath, { recursive: true, force: true })
      log('Moved (copy+delete) directory:', sourcePath, '->', destPath)
    } else {
      fs.copyFileSync(sourcePath, destPath)
      fs.unlinkSync(sourcePath)
      log('Moved (copy+delete) file:', sourcePath, '->', destPath)
    }
    
    return { success: true }
  } catch (err) {
    log('Error moving:', err)
    return { success: false, error: String(err) }
  }
})

// Helper to recursively copy a directory
function copyDirSync(src: string, dest: string) {
  // Create destination directory
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true })
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

ipcMain.handle('fs:open-in-explorer', async (_, targetPath: string) => {
  shell.showItemInFolder(targetPath)
  return { success: true }
})

ipcMain.handle('fs:open-file', async (_, filePath: string) => {
  // Use exec with 'start' command on Windows for faster file opening
  // shell.openPath() can be slow due to Windows shell association lookup
  if (process.platform === 'win32') {
    const { exec } = require('child_process')
    // Use 'start' with empty title ("") and quoted path for paths with spaces
    // The empty title "" is needed because start treats the first quoted arg as window title
    exec(`start "" "${filePath}"`, { windowsHide: true })
  } else {
    // On macOS/Linux, shell.openPath is fine
    shell.openPath(filePath)
  }
  return { success: true }
})

// Set file read-only attribute
ipcMain.handle('fs:set-readonly', async (_, filePath: string, readonly: boolean) => {
  try {
    const stats = fs.statSync(filePath)
    if (stats.isDirectory()) {
      return { success: true } // Skip directories
    }
    
    // Get current mode
    const currentMode = stats.mode
    
    if (readonly) {
      // Remove write permissions (owner, group, others)
      const newMode = currentMode & ~0o222
      fs.chmodSync(filePath, newMode)
    } else {
      // Add owner write permission
      const newMode = currentMode | 0o200
      fs.chmodSync(filePath, newMode)
    }
    
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// Check if file is read-only
ipcMain.handle('fs:is-readonly', async (_, filePath: string) => {
  try {
    const stats = fs.statSync(filePath)
    // Check if owner write bit is not set
    const isReadonly = (stats.mode & 0o200) === 0
    return { success: true, readonly: isReadonly }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// Helper to recursively get all files in a directory with relative paths
function getAllFilesInDir(dirPath: string, baseFolder: string): Array<{ name: string; path: string; relativePath: string; extension: string; size: number; modifiedTime: string }> {
  const files: Array<{ name: string; path: string; relativePath: string; extension: string; size: number; modifiedTime: string }> = []
  
  function walkDir(currentPath: string) {
    try {
      const items = fs.readdirSync(currentPath, { withFileTypes: true })
      for (const item of items) {
        // Skip hidden files/folders
        if (item.name.startsWith('.')) continue
        
        const fullPath = path.join(currentPath, item.name)
        
        if (item.isDirectory()) {
          walkDir(fullPath)
        } else {
          const stats = fs.statSync(fullPath)
          // Compute relative path from the base folder (includes the folder name itself)
          const relativePath = path.relative(path.dirname(dirPath), fullPath).replace(/\\/g, '/')
          files.push({
            name: item.name,
            path: fullPath,
            relativePath,
            extension: path.extname(item.name).toLowerCase(),
            size: stats.size,
            modifiedTime: stats.mtime.toISOString()
          })
        }
      }
    } catch (err) {
      log('Error walking directory:', err)
    }
  }
  
  walkDir(dirPath)
  return files
}

// Select files to add (returns file paths) - Windows doesn't support openFile + openDirectory together
ipcMain.handle('dialog:select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Select Files to Add',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'CAD Files', extensions: ['sldprt', 'sldasm', 'slddrw', 'step', 'stp', 'iges', 'igs', 'stl', 'pdf'] },
      { name: 'SolidWorks Parts', extensions: ['sldprt'] },
      { name: 'SolidWorks Assemblies', extensions: ['sldasm'] },
      { name: 'SolidWorks Drawings', extensions: ['slddrw'] }
    ]
  })
  
  if (!result.canceled && result.filePaths.length > 0) {
    const allFiles: Array<{ name: string; path: string; extension: string; size: number; modifiedTime: string }> = []
    
    for (const filePath of result.filePaths) {
      try {
        const stats = fs.statSync(filePath)
        allFiles.push({
          name: path.basename(filePath),
          path: filePath,
          extension: path.extname(filePath).toLowerCase(),
          size: stats.size,
          modifiedTime: stats.mtime.toISOString()
        })
      } catch (err) {
        log('Error reading file stats:', filePath, err)
      }
    }
    
    return { success: true, files: allFiles }
  }
  return { success: false, canceled: true }
})

// Select a folder to add (returns all files within the folder with relative paths preserved)
ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Select Folder to Add',
    properties: ['openDirectory']
  })
  
  if (!result.canceled && result.filePaths.length > 0) {
    const folderPath = result.filePaths[0]
    const folderName = path.basename(folderPath)
    
    // Get all files in the folder recursively
    const allFiles = getAllFilesInDir(folderPath, folderName)
    
    log('Selected folder:', folderPath, 'with', allFiles.length, 'files')
    
    return { 
      success: true, 
      folderName,
      folderPath,
      files: allFiles 
    }
  }
  return { success: false, canceled: true }
})

// Save file dialog
ipcMain.handle('dialog:save-file', async (_, defaultName: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Save File',
    defaultPath: defaultName
  })
  
  if (!result.canceled && result.filePath) {
    return { success: true, filePath: result.filePath }
  }
  return { success: false, canceled: true }
})

// ============================================
// eDrawings Preview & SolidWorks Thumbnails
// ============================================

// Try to load native eDrawings module
let edrawingsNative: any = null
try {
  edrawingsNative = require('../native/build/Release/edrawings_preview.node')
  log('[eDrawings] Native module loaded successfully')
} catch (err) {
  log('[eDrawings] Native module not available:', err)
}

// Extract thumbnail or icon from files using Windows Shell API (same as Explorer)
// First tries to get a preview thumbnail, then falls back to the file type icon
async function extractSolidWorksThumbnail(filePath: string): Promise<{ success: boolean; data?: string; error?: string }> {
  try {
    // First, try to get a preview thumbnail (works for images, PDFs with preview, SolidWorks, etc.)
    try {
      const thumbnail = await nativeImage.createThumbnailFromPath(filePath, { 
        width: 256, 
        height: 256 
      })
      
      if (thumbnail && !thumbnail.isEmpty()) {
        const pngData = thumbnail.toPNG()
        if (pngData && pngData.length > 100) {
          log('[Thumbnail] Got OS thumbnail for:', path.basename(filePath), 'size:', pngData.length)
          return { success: true, data: `data:image/png;base64,${pngData.toString('base64')}` }
        }
      }
    } catch (thumbErr) {
      // Thumbnail not available, will try icon below
    }
    
    // Fall back to file type icon (like Explorer shows for PDFs, Excel files, etc.)
    try {
      const icon = await app.getFileIcon(filePath, { size: 'large' })
      if (icon && !icon.isEmpty()) {
        const pngData = icon.toPNG()
        if (pngData && pngData.length > 100) {
          log('[Thumbnail] Got OS file icon for:', path.basename(filePath), 'size:', pngData.length)
          return { success: true, data: `data:image/png;base64,${pngData.toString('base64')}` }
        }
      }
    } catch (iconErr) {
      log('[Thumbnail] Could not get file icon:', String(iconErr))
    }
    
    log('[Thumbnail] No OS thumbnail/icon available for:', path.basename(filePath))
    return { success: false, error: 'No thumbnail or icon available from OS' }
  } catch (err) {
    log('[Thumbnail] OS thumbnail extraction failed:', String(err))
    return { success: false, error: String(err) }
  }
}

// IPC handler for extracting thumbnails
ipcMain.handle('solidworks:extract-thumbnail', async (_, filePath: string) => {
  return extractSolidWorksThumbnail(filePath)
})

// Check if eDrawings is installed
ipcMain.handle('edrawings:check-installed', async () => {
  // Try native module first
  if (edrawingsNative?.checkEDrawingsInstalled) {
    try {
      return edrawingsNative.checkEDrawingsInstalled()
    } catch (err) {
      log('[eDrawings] Native check failed:', err)
    }
  }
  
  // Fallback: Check common eDrawings installation paths
  const paths = [
    'C:\\Program Files\\SOLIDWORKS Corp\\eDrawings\\eDrawings.exe',
    'C:\\Program Files\\eDrawings\\eDrawings.exe',
    'C:\\Program Files (x86)\\eDrawings\\eDrawings.exe',
    'C:\\Program Files\\SOLIDWORKS Corp\\SOLIDWORKS\\eDrawings\\eDrawings.exe'
  ]
  
  for (const ePath of paths) {
    if (fs.existsSync(ePath)) {
      return { installed: true, path: ePath }
    }
  }
  
  return { installed: false, path: null }
})

// Check if native embedding is available
ipcMain.handle('edrawings:native-available', () => {
  return edrawingsNative !== null
})

// Open file in eDrawings
ipcMain.handle('edrawings:open-file', async (_, filePath: string) => {
  // Find eDrawings executable
  const eDrawingsPaths = [
    'C:\\Program Files\\SOLIDWORKS Corp\\eDrawings\\eDrawings.exe',
    'C:\\Program Files\\eDrawings\\eDrawings.exe',
    'C:\\Program Files (x86)\\eDrawings\\eDrawings.exe',
    'C:\\Program Files\\SOLIDWORKS Corp\\SOLIDWORKS\\eDrawings\\eDrawings.exe'
  ]
  
  let eDrawingsPath: string | null = null
  for (const ePath of eDrawingsPaths) {
    if (fs.existsSync(ePath)) {
      eDrawingsPath = ePath
      break
    }
  }
  
  if (!eDrawingsPath) {
    // Fallback to shell open if eDrawings not found
    try {
      await shell.openPath(filePath)
      return { success: true, fallback: true }
    } catch (err) {
      return { success: false, error: 'eDrawings not found' }
    }
  }
  
  try {
    // Launch eDrawings with the file
    const { spawn } = require('child_process')
    spawn(eDrawingsPath, [filePath], { 
      detached: true,
      stdio: 'ignore'
    }).unref()
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

// Get the native window handle for embedding
ipcMain.handle('edrawings:get-window-handle', () => {
  if (!mainWindow) return null
  
  // Get the native window handle (HWND on Windows)
  const handle = mainWindow.getNativeWindowHandle()
  // Return as array of bytes that can be reconstructed
  return Array.from(handle)
})

// Embedded eDrawings preview control management
let edrawingsPreview: any = null

ipcMain.handle('edrawings:create-preview', () => {
  if (!edrawingsNative?.EDrawingsPreview) {
    return { success: false, error: 'Native module not available' }
  }
  
  try {
    edrawingsPreview = new edrawingsNative.EDrawingsPreview()
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('edrawings:attach-preview', () => {
  if (!edrawingsPreview || !mainWindow) {
    return { success: false, error: 'Preview not created or window not available' }
  }
  
  try {
    const handle = mainWindow.getNativeWindowHandle()
    const result = edrawingsPreview.attachToWindow(handle)
    return { success: result }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('edrawings:load-file', async (_, filePath: string) => {
  if (!edrawingsPreview) {
    return { success: false, error: 'Preview not attached' }
  }
  
  try {
    const result = edrawingsPreview.loadFile(filePath)
    return { success: result }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('edrawings:set-bounds', async (_, x: number, y: number, width: number, height: number) => {
  if (!edrawingsPreview) {
    return { success: false }
  }
  
  try {
    edrawingsPreview.setBounds(x, y, width, height)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('edrawings:show-preview', () => {
  if (!edrawingsPreview) return { success: false }
  try {
    edrawingsPreview.show()
    return { success: true }
  } catch { return { success: false } }
})

ipcMain.handle('edrawings:hide-preview', () => {
  if (!edrawingsPreview) return { success: false }
  try {
    edrawingsPreview.hide()
    return { success: true }
  } catch { return { success: false } }
})

ipcMain.handle('edrawings:destroy-preview', () => {
  if (!edrawingsPreview) return { success: true }
  try {
    edrawingsPreview.destroy()
    edrawingsPreview = null
    return { success: true }
  } catch { return { success: false } }
})

// ============================================
// Auto Updater
// ============================================

// Configure auto-updater
autoUpdater.autoDownload = false  // Don't auto-download, let user decide
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.logger = {
  info: (message: string) => writeLog('info', `[AutoUpdater] ${message}`),
  warn: (message: string) => writeLog('warn', `[AutoUpdater] ${message}`),
  error: (message: string) => writeLog('error', `[AutoUpdater] ${message}`),
  debug: (message: string) => writeLog('debug', `[AutoUpdater] ${message}`)
}

// Track update state
let updateAvailable: UpdateInfo | null = null
let updateDownloaded = false
let downloadProgress: ProgressInfo | null = null

// Auto-updater event handlers
autoUpdater.on('checking-for-update', () => {
  log('Checking for updates...')
  mainWindow?.webContents.send('updater:checking')
})

autoUpdater.on('update-available', (info: UpdateInfo) => {
  log('Update available:', info.version)
  updateAvailable = info
  isUserInitiatedCheck = false
  mainWindow?.webContents.send('updater:available', {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: info.releaseNotes
  })
})

autoUpdater.on('update-not-available', (info: UpdateInfo) => {
  log('No update available, current version is latest')
  updateAvailable = null
  isUserInitiatedCheck = false
  mainWindow?.webContents.send('updater:not-available', {
    version: info.version
  })
})

autoUpdater.on('download-progress', (progress: ProgressInfo) => {
  downloadProgress = progress
  mainWindow?.webContents.send('updater:download-progress', {
    percent: progress.percent,
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total
  })
})

autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
  log('Update downloaded:', info.version)
  updateDownloaded = true
  downloadProgress = null
  mainWindow?.webContents.send('updater:downloaded', {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: info.releaseNotes
  })
})

// Track if this is a user-initiated check (vs auto-check on startup)
let isUserInitiatedCheck = false

autoUpdater.on('error', (error: Error) => {
  logError('Auto-updater error', { error: error.message })
  downloadProgress = null
  // Only show error to user if they manually triggered the check
  // Suppress errors from automatic startup checks (network issues, release not ready, etc.)
  if (isUserInitiatedCheck) {
    mainWindow?.webContents.send('updater:error', {
      message: error.message
    })
  }
  isUserInitiatedCheck = false
})

// IPC handlers for update operations
ipcMain.handle('updater:check', async () => {
  try {
    if (isDev) {
      log('Skipping update check in development mode')
      return { success: false, error: 'Updates disabled in development' }
    }
    isUserInitiatedCheck = true  // Mark as user-initiated so errors are shown
    const result = await autoUpdater.checkForUpdates()
    return { success: true, updateInfo: result?.updateInfo }
  } catch (err) {
    logError('Failed to check for updates', { error: String(err) })
    isUserInitiatedCheck = false
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('updater:download', async () => {
  try {
    if (!updateAvailable) {
      return { success: false, error: 'No update available' }
    }
    log('Starting update download...')
    await autoUpdater.downloadUpdate()
    return { success: true }
  } catch (err) {
    logError('Failed to download update', { error: String(err) })
    return { success: false, error: String(err) }
  }
})

ipcMain.handle('updater:install', () => {
  if (!updateDownloaded) {
    return { success: false, error: 'No update downloaded' }
  }
  log('Installing update and restarting...')
  autoUpdater.quitAndInstall(false, true)
  return { success: true }
})

ipcMain.handle('updater:get-status', () => {
  return {
    updateAvailable: updateAvailable ? {
      version: updateAvailable.version,
      releaseDate: updateAvailable.releaseDate,
      releaseNotes: updateAvailable.releaseNotes
    } : null,
    updateDownloaded,
    downloadProgress: downloadProgress ? {
      percent: downloadProgress.percent,
      bytesPerSecond: downloadProgress.bytesPerSecond,
      transferred: downloadProgress.transferred,
      total: downloadProgress.total
    } : null
  }
})

// ============================================
// App Lifecycle
// ============================================

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  // Initialize file-based logging now that app paths are available
  initializeLogging()
  
  log('App ready, creating window...')
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
  
  // Check for updates after a short delay (let the app fully load first)
  if (!isDev) {
    setTimeout(() => {
      log('Auto-checking for updates...')
      autoUpdater.checkForUpdates().catch(err => {
        logError('Auto update check failed', { error: String(err) })
      })
    }, 5000) // 5 second delay
  }
}).catch(err => {
  logError('Error during app ready', { error: String(err) })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
