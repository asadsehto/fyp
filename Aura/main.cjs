const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { spawn, execSync } = require('child_process')

// Determine if we are in development mode based on the environment variable
const isDev = process.env.NODE_ENV === 'development'

const fs = require('fs')
const os = require('os')

const logFile = path.join(os.homedir(), 'aura-debug.log')
function logMsg(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
}

let backendProcess = null

function killPort8000() {
  // Kill any stale process on port 8000 before starting our own
  try {
    const result = execSync(
      'netstat -aon | findstr ":8000"',
      { encoding: 'utf-8', timeout: 5000 }
    )
    const lines = result.trim().split('\n')
    const pids = new Set()
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      const pid = parts[parts.length - 1]
      if (pid && pid !== '0' && /^\d+$/.test(pid)) {
        pids.add(pid)
      }
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 })
        logMsg(`Killed stale process on port 8000: PID ${pid}`)
      } catch (e) {
        // Process may already be gone
      }
    }
  } catch (e) {
    // No process on port 8000 — that's fine
  }
}

function startBackend() {
  logMsg("=== Starting Aura App ===")

  // Always kill stale port 8000 processes first
  killPort8000()

  const backendCwd = isDev 
    ? __dirname 
    : path.join(process.resourcesPath, 'app.asar.unpacked')
  
  logMsg(`isDev: ${isDev}`)
  logMsg(`backendCwd: ${backendCwd}`)

  // Check if backend folder exists
  const backendDir = path.join(backendCwd, 'backend')
  logMsg(`backend directory exists: ${fs.existsSync(backendDir)}`)

  // Use python -m uvicorn to be safer with PATH
  logMsg("Spawning: python -m uvicorn backend.server:app --host 127.0.0.1 --port 8000")
  backendProcess = spawn('python', ['-m', 'uvicorn', 'backend.server:app', '--host', '127.0.0.1', '--port', '8000'], {
    shell: true,
    cwd: backendCwd
  })

  backendProcess.stdout.on('data', (data) => {
    logMsg(`[Backend STDOUT]: ${data.toString()}`)
  })

  backendProcess.stderr.on('data', (data) => {
    logMsg(`[Backend STDERR]: ${data.toString()}`)
  })

  backendProcess.on('error', (err) => {
    logMsg(`[Backend ERROR]: ${err}`)
  })

  backendProcess.on('close', (code) => {
    logMsg(`[Backend EXITED] code: ${code}`)
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0a0a0c',
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.center()
  win.focus()
  win.setMenu(null)

  if (isDev) {
    // Load the Vite dev server in development
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    // Load the built dist directory in production
    win.loadFile(path.join(__dirname, 'dist', 'index.html'))
  }
}

app.whenReady().then(() => {
  startBackend()
  createWindow()
})

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill()
  }
  // Also kill the port just in case
  killPort8000()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('quit', () => {
  if (backendProcess) {
    backendProcess.kill()
  }
  killPort8000()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
