import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

let mainWindow: BrowserWindow | null = null
let checkInterval: NodeJS.Timeout | null = null

// Estado actual del actualizador
export interface UpdateStatusState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  error?: string
}

let currentState: UpdateStatusState = { status: 'idle' }

export function getUpdateState(): UpdateStatusState {
  return currentState
}

function notifyRenderer(state: UpdateStatusState) {
  currentState = state
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-status', state)
  }
}

export function initAutoUpdater(win: BrowserWindow) {
  mainWindow = win

  // No ejecutar en entorno de desarrollo local con Vite
  if (!app.isPackaged) {
    console.log('ℹ️ [Auto-Updater] Deshabilitado en entorno de desarrollo. Solo se activará en la versión instalada (.exe).')
    return
  }

  // Configuración de electron-updater
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // Configurar logger interno
  autoUpdater.logger = {
    info(message: any) {
      console.log(`📦 [Auto-Updater] ${typeof message === 'object' ? JSON.stringify(message) : message}`)
    },
    warn(message: any) {
      console.warn(`⚠️ [Auto-Updater] ${typeof message === 'object' ? JSON.stringify(message) : message}`)
    },
    error(message: any) {
      console.error(`❌ [Auto-Updater] ${typeof message === 'object' ? JSON.stringify(message) : message}`)
    }
  }

  // Eventos de ciclo de vida del actualizador
  autoUpdater.on('checking-for-update', () => {
    notifyRenderer({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`📦 [Auto-Updater] ¡Nueva versión ${info.version} disponible! Descargando en segundo plano...`)
    notifyRenderer({ status: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', (info) => {
    console.log(`📦 [Auto-Updater] La app está al día (versión: ${info.version || app.getVersion()}).`)
    notifyRenderer({ status: 'not-available', version: info.version || app.getVersion() })
  })

  autoUpdater.on('download-progress', (progressObj) => {
    const percent = Math.round(progressObj.percent)
    notifyRenderer({ status: 'downloading', percent })
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`🎉 [Auto-Updater] Actualización v${info.version} descargada exitosamente. Lista para instalar.`)
    notifyRenderer({ status: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    const errorMsg = err?.message || String(err)
    console.error(`❌ [Auto-Updater] Error durante verificación/descarga:`, errorMsg)
    notifyRenderer({ status: 'error', error: errorMsg })
  })

  // Primer chequeo 15 segundos después del arranque
  setTimeout(() => {
    checkForUpdatesSilently()
  }, 15000)

  // Chequeo periódico cada 2 horas (sin interrumpir las impresiones)
  if (checkInterval) clearInterval(checkInterval)
  checkInterval = setInterval(() => {
    checkForUpdatesSilently()
  }, 2 * 60 * 60 * 1000)
}

export async function checkForUpdatesSilently() {
  if (!app.isPackaged) return
  try {
    console.log('🔍 [Auto-Updater] Comprobando si hay nuevas versiones en GitHub Releases...')
    await autoUpdater.checkForUpdates()
  } catch (err: any) {
    console.error('❌ [Auto-Updater] Fallo en comprobación periódica:', err?.message || err)
  }
}

// Configuración de IPC Handlers para que la UI pueda consultar y accionar
export function setupUpdaterIpc() {
  ipcMain.handle('updater-get-state', () => {
    return currentState
  })

  ipcMain.handle('updater-check-now', async () => {
    if (!app.isPackaged) {
      return {
        success: false,
        isDev: true,
        message: 'El sistema de auto-actualización solo funciona en la versión instalada (.exe), no en npm run dev.'
      }
    }
    try {
      notifyRenderer({ status: 'checking' })
      const res = await autoUpdater.checkForUpdates()
      return { success: true, updateInfo: res?.updateInfo }
    } catch (err: any) {
      const errorMsg = err?.message || String(err)
      notifyRenderer({ status: 'error', error: errorMsg })
      return { success: false, error: errorMsg }
    }
  })

  ipcMain.handle('updater-install-now', () => {
    console.log('🔄 [Auto-Updater] El usuario solicitó reiniciar e instalar la actualización ahora.')
    // Cierra la app y ejecuta el instalador silenciosamente, luego vuelve a abrir la app
    autoUpdater.quitAndInstall(false, true)
    return true
  })
}
