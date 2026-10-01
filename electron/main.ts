import { app, BrowserWindow, ipcMain, Tray, Menu } from 'electron'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT!, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT!, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT!, 'public') : RENDERER_DIST

let win: BrowserWindow | null
let tray: Tray | null = null
let isQuitting = false

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args) => {
  originalConsoleLog(...args);
  if (win && !win.isDestroyed()) {
    const serializedArgs = args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      return typeof a === 'object' && a !== null ? JSON.stringify(a, null, 2) : a;
    });
    win.webContents.send('main-console-log', ...serializedArgs);
  }
};

console.error = (...args) => {
  originalConsoleError(...args);
  if (win && !win.isDestroyed()) {
    const serializedArgs = args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      return typeof a === 'object' && a !== null ? JSON.stringify(a, null, 2) : a;
    });
    win.webContents.send('main-console-error', ...serializedArgs);
  }
};

import { setupSupabaseRealtime, disconnectSupabase, resumePrintingAndCheckPending } from './supabase'
import { testPrinter } from './printer'
import { store } from './store'

function createWindow() {
  const iconPath = path.join(process.env.VITE_PUBLIC!, 'icon.png')

  const startHidden = app.isPackaged && process.argv.includes('--hidden')

  win = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 600,
    minHeight: 700,
    icon: iconPath,
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // Set up auto-launch on system startup
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: app.getPath('exe'),
      args: ['--hidden']
    })
  } else {
    // Si estamos en desarrollo, nos aseguramos de que no esté activado
    // para limpiar cualquier registro previo
    app.setLoginItemSettings({
      openAtLogin: false,
      path: app.getPath('exe')
    })
  }

  // Prevent app from quitting when window is closed
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win?.hide()
    }
    return false
  })

  // Create System Tray
  tray = new Tray(iconPath)
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir UPick Printer Plazoletas', click: () => win?.show() },
    { type: 'separator' },
    {
      label: 'Salir Completamente', click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setToolTip('UPick Printer Plazoletas')
  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => {
    win?.show()
  })

  // Set up IPC Handlers
  ipcMain.handle('get-system-printers', async (event) => {
    try {
      const targetWin = BrowserWindow.fromWebContents(event.sender) || win
      if (!targetWin) return []
      return await targetWin.webContents.getPrintersAsync()
    } catch (err) {
      console.error('Error al obtener impresoras de Windows:', err)
      return []
    }
  })

  ipcMain.handle('get-config', () => {
    return {
      email: store.get('email') || '',
      restaurantId: store.get('restaurantId') || '',
      printAdvanceMinutes: store.get('printAdvanceMinutes') || 0,
      isPrintingPaused: store.get('isPrintingPaused') || false,
      impresoras: store.get('impresoras') || [],
      // Compatibilidad legacy
      connectionType: store.get('connectionType') || 'network',
      printerIp: store.get('printerIp') || '',
      printerPort: store.get('printerPort') || 9100
    }
  })

  ipcMain.handle('login', async (_, { email, password }) => {
    store.set('email', email)
    store.set('password', password)
    return new Promise((resolve) => {
      setupSupabaseRealtime((status, message) => {
        win?.webContents.send('supabase-status', status, message)
        if (status === 'connected') resolve({ success: true, sucursal: message })
        else if (status === 'error') resolve({ success: false, error: message })
      })
    })
  })

  ipcMain.handle('logout', async () => {
    store.set('password', '')
    await disconnectSupabase()
    win?.webContents.send('supabase-status', 'disconnected')
    return true
  })

  ipcMain.handle('toggle-pause-printing', async (_, paused?: boolean) => {
    const current = store.get('isPrintingPaused') || false
    const newState = paused !== undefined ? paused : !current
    store.set('isPrintingPaused', newState)
    if (!newState) {
      resumePrintingAndCheckPending()
    }
    return newState
  })

  ipcMain.handle('save-config', async (_, config) => {
    if (config.email !== undefined) store.set('email', config.email)
    if (config.password) store.set('password', config.password)
    if (config.printAdvanceMinutes !== undefined) {
      store.set('printAdvanceMinutes', Number(config.printAdvanceMinutes) || 0)
    }
    if (config.impresoras && Array.isArray(config.impresoras)) {
      store.set('impresoras', config.impresoras)
    }
    if (config.isPrintingPaused !== undefined) {
      store.set('isPrintingPaused', Boolean(config.isPrintingPaused))
    }

    // Restart supabase listener, which will now login and fetch the new restaurantId
    setupSupabaseRealtime((status, message) => {
      win?.webContents.send('supabase-status', status, message)
    })

    return true
  })

  ipcMain.handle('test-printer', async (_, printerConfig) => {
    return await testPrinter(printerConfig)
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    // Initial setup
    setupSupabaseRealtime((status, message) => {
      win?.webContents.send('supabase-status', status, message)
    })
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(createWindow)
