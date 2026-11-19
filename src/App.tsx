import { useState, useEffect } from 'react'

export interface ImpresoraConfig {
  id: string;
  nombre: string;
  tipoConexion: 'network' | 'windows_usb';
  ip?: string;
  port?: number;
  deviceName?: string;
  rolCopia: 'AMBOS' | 'COCINA' | 'CAJA';
  anchoPapel?: '80mm' | '58mm';
  activo: boolean;
}

export interface SystemPrinter {
  name: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
}

function App() {
  const [printerToken, setPrinterToken] = useState('')
  const [authTab, setAuthTab] = useState<'token' | 'manual'>('token')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [sucursal, setSucursal] = useState('')
  const [printAdvanceMinutes, setPrintAdvanceMinutes] = useState('0')
  const [impresoras, setImpresoras] = useState<ImpresoraConfig[]>([])
  const [systemPrinters, setSystemPrinters] = useState<SystemPrinter[]>([])
  
  const [status, setStatus] = useState<'disconnected' | 'connected' | 'error'>('disconnected')
  const [statusMessage, setStatusMessage] = useState('')
  const [isPrintingPaused, setIsPrintingPaused] = useState(false)
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isRefreshingPrinters, setIsRefreshingPrinters] = useState(false)
  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; msg: string } | null>(null)
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<{
    status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
    version?: string
    percent?: number
    error?: string
  }>({ status: 'idle' })
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [updateFeedback, setUpdateFeedback] = useState<string | null>(null)

  // Cargar impresoras nativas de Windows
  const loadSystemPrinters = async () => {
    setIsRefreshingPrinters(true)
    try {
      const printers = await window.ipcRenderer.invoke('get-system-printers')
      setSystemPrinters(printers || [])
    } catch (err) {
      console.error('Error cargando impresoras del sistema:', err)
    } finally {
      setIsRefreshingPrinters(false)
    }
  }

  useEffect(() => {
    // 1. Cargar configuración guardada
    window.ipcRenderer.invoke('get-config').then((config: any) => {
      if (config.printerToken) {
        setPrinterToken(config.printerToken)
        setAuthTab('token')
      } else if (config.email) {
        setAuthTab('manual')
      }
      if (config.email) setEmail(config.email)
      if (config.printAdvanceMinutes !== undefined) setPrintAdvanceMinutes(String(config.printAdvanceMinutes))
      if (config.isPrintingPaused !== undefined) setIsPrintingPaused(Boolean(config.isPrintingPaused))
      
      if (config.impresoras && Array.isArray(config.impresoras) && config.impresoras.length > 0) {
        setImpresoras(config.impresoras)
      } else {
        // Fallback por defecto si no hay ninguna
        setImpresoras([
          {
            id: 'printer-1',
            nombre: 'Impresora Principal',
            tipoConexion: 'network',
            ip: config.printerIp || '192.168.40.18',
            port: Number(config.printerPort) || 9100,
            deviceName: '',
            rolCopia: 'AMBOS',
            anchoPapel: '80mm',
            activo: true
          }
        ])
      }
    })

    // 2. Cargar impresoras de Windows
    loadSystemPrinters()

    // 3. Escuchar estado de Supabase
    window.ipcRenderer.on('supabase-status', (_event: any, newStatus: any, message?: string) => {
      setStatus(newStatus)
      if (message) setStatusMessage(message)
      if (newStatus === 'connected' && message) {
        setSucursal(message)
      }
    })

    // 4. Logs del backend para depuración en devtools
    window.ipcRenderer.on('main-console-log', (_event: any, ...args: any[]) => {
      console.log('%c[BACKEND]', 'color: #3b82f6; font-weight: bold;', ...args)
    })
    window.ipcRenderer.on('main-console-error', (_event: any, ...args: any[]) => {
      console.error('%c[BACKEND ERROR]', 'color: #ef4444; font-weight: bold;', ...args)
    })

    // 5. Escuchar estado del Auto-Updater
    window.ipcRenderer.on('updater-status', (_event: any, state: any) => {
      setUpdateState(state)
    })
    window.ipcRenderer.invoke('updater-get-state').then((state: any) => {
      if (state) setUpdateState(state)
    })
  }, [])

  // Comprobar manualmente actualizaciones
  const handleCheckForUpdates = async () => {
    setIsCheckingUpdate(true)
    setUpdateFeedback(null)
    try {
      const res = await window.ipcRenderer.invoke('updater-check-now')
      if (res?.isDev) {
        setUpdateFeedback(res.message)
        setTimeout(() => setUpdateFeedback(null), 6000)
      } else if (!res?.success) {
        setUpdateFeedback(`Error al buscar actualizaciones: ${res?.error || 'Desconocido'}`)
        setTimeout(() => setUpdateFeedback(null), 6000)
      } else if (res?.updateInfo) {
        setUpdateFeedback(`Versión disponible: v${res.updateInfo.version}`)
        setTimeout(() => setUpdateFeedback(null), 4000)
      } else {
        setUpdateFeedback('Ya tienes la versión más reciente.')
        setTimeout(() => setUpdateFeedback(null), 4000)
      }
    } catch (err: any) {
      setUpdateFeedback(`Error: ${err?.message || err}`)
      setTimeout(() => setUpdateFeedback(null), 6000)
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  // Reiniciar e instalar actualización descargada
  const handleInstallUpdate = () => {
    window.ipcRenderer.invoke('updater-install-now')
  }

  // Iniciar sesión / vincular mediante Token de Impresora
  const handleTokenLogin = async () => {
    if (!printerToken.trim()) {
      alert('Por favor ingresa el Token de la Impresora (prt_...) obtenido en el panel de UPick.')
      return
    }
    setIsLoggingIn(true)
    setSaveFeedback(null)
    try {
      const res = await window.ipcRenderer.invoke('login-with-token', { token: printerToken.trim() })
      if (res && res.success) {
        setSucursal(res.sucursal || '')
        setSaveFeedback('¡Impresora vinculada y conectada exitosamente!')
        setTimeout(() => setSaveFeedback(null), 4000)
      } else {
        alert('Error al conectar con token: ' + (res?.error || 'Token no válido'))
      }
    } catch (err: any) {
      alert('Error: ' + err.message)
    } finally {
      setIsLoggingIn(false)
    }
  }

  // Iniciar sesión directamente sin necesidad de guardar toda la config
  const handleDirectLogin = async () => {
    if (!email || !password) {
      alert('Por favor ingresa tu correo y contraseña.')
      return
    }
    setIsLoggingIn(true)
    setSaveFeedback(null)
    try {
      const res = await window.ipcRenderer.invoke('login', { email, password })
      if (res && res.success) {
        setSucursal(res.sucursal || '')
        setSaveFeedback('¡Sesión iniciada con éxito!')
        setTimeout(() => setSaveFeedback(null), 4000)
      } else {
        alert('Error de inicio de sesión: ' + (res?.error || 'Credenciales inválidas'))
      }
    } catch (err: any) {
      alert('Error: ' + err.message)
    } finally {
      setIsLoggingIn(false)
    }
  }

  // Cerrar sesión
  const handleLogout = async () => {
    if (!confirm('¿Deseas desconectar esta impresora? Dejará de imprimir comandas hasta que vuelva a conectarse.')) return
    setIsLoggingOut(true)
    try {
      await window.ipcRenderer.invoke('logout')
      setPassword('')
      setPrinterToken('')
      setSucursal('')
      setStatus('disconnected')
      setSaveFeedback('Impresora desconectada.')
      setTimeout(() => setSaveFeedback(null), 3000)
    } catch (err: any) {
      console.error('Error al cerrar sesión:', err)
    } finally {
      setIsLoggingOut(false)
    }
  }

  // Alternar pausa global de impresiones
  const handleTogglePause = async () => {
    try {
      const newState = await window.ipcRenderer.invoke('toggle-pause-printing')
      setIsPrintingPaused(newState)
      if (newState) {
        setSaveFeedback('⏸️ Impresiones en pausa. Los pedidos solo se mostrarán en la terminal.')
      } else {
        setSaveFeedback('▶️ Impresiones reanudadas. Procesando pedidos en cola.')
      }
      setTimeout(() => setSaveFeedback(null), 4000)
    } catch (err: any) {
      console.error('Error alternando pausa:', err)
    }
  }

  // Añadir nueva impresora
  const handleAddPrinter = () => {
    const defaultDevice = systemPrinters.length > 0 ? systemPrinters[0].name : ''
    const defaultType: 'windows_usb' | 'network' = systemPrinters.length > 0 ? 'windows_usb' : 'network'
    
    const newPrinter: ImpresoraConfig = {
      id: 'printer_' + Date.now(),
      nombre: `Impresora ${impresoras.length + 1}`,
      tipoConexion: defaultType,
      deviceName: defaultDevice,
      ip: '192.168.1.100',
      port: 9100,
      rolCopia: impresoras.length === 0 ? 'AMBOS' : (impresoras.length === 1 ? 'COCINA' : 'CAJA'),
      anchoPapel: '80mm',
      activo: true
    }
    setImpresoras(prev => [...prev, newPrinter])
  }

  // Eliminar impresora
  const handleRemovePrinter = (id: string) => {
    if (impresoras.length === 1) {
      alert('Debes mantener al menos una impresora configurada.')
      return
    }
    setImpresoras(prev => prev.filter(p => p.id !== id))
  }

  // Modificar campo de impresora
  const handleUpdatePrinter = (id: string, updates: Partial<ImpresoraConfig>) => {
    setImpresoras(prev => prev.map(p => {
      if (p.id !== id) return p
      const updated = { ...p, ...updates }
      if (updates.tipoConexion === 'windows_usb' && !updated.deviceName && systemPrinters.length > 0) {
        updated.deviceName = systemPrinters[0].name
      }
      return updated
    }))
  }

  // Probar una impresora individual
  const handleTestIndividual = async (printer: ImpresoraConfig) => {
    setTestingPrinterId(printer.id)
    setTestResult(null)

    try {
      const success = await window.ipcRenderer.invoke('test-printer', printer)
      if (success) {
        setTestResult({
          id: printer.id,
          success: true,
          msg: '¡Impresión de prueba exitosa!'
        })
      } else {
        setTestResult({
          id: printer.id,
          success: false,
          msg: printer.tipoConexion === 'windows_usb' 
            ? 'Error al enviar al spooler de Windows. Revisa que la impresora esté encendida.' 
            : 'No se pudo conectar a la IP. Verifica la red y el puerto 9100.'
        })
      }
    } catch (err: any) {
      setTestResult({
        id: printer.id,
        success: false,
        msg: 'Error: ' + (err.message || 'Fallo desconocido')
      })
    } finally {
      setTestingPrinterId(null)
    }
  }

  // Guardar configuración general
  const handleSave = async () => {
    setIsSaving(true)
    setSaveFeedback(null)

    try {
      await window.ipcRenderer.invoke('save-config', {
        printerToken,
        email,
        password,
        printAdvanceMinutes: Number(printAdvanceMinutes) || 0,
        isPrintingPaused,
        impresoras
      })
      setSaveFeedback('Configuración guardada correctamente.')
      setTimeout(() => setSaveFeedback(null), 4000)
    } catch (e: any) {
      setSaveFeedback('Error al guardar: ' + e.message)
    } finally {
      setIsSaving(false)
    }
  }

  const activeCount = impresoras.filter(p => p.activo).length

  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-100 font-sans pb-12 antialiased selection:bg-red-500 selection:text-white">
      {/* Header Bar */}
      <header className="sticky top-0 z-30 bg-neutral-900/90 backdrop-blur-md border-b border-neutral-800 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-red-500 to-red-700 rounded-xl flex items-center justify-center shadow-lg shadow-red-600/30">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight leading-tight flex items-center gap-1.5">
                UPick <span className="text-red-500 font-extrabold">Printer Plazoletas</span>
                <span className="text-[10px] bg-neutral-800 text-neutral-400 font-semibold px-1.5 py-0.5 rounded border border-neutral-700 ml-1">v1.3.1</span>
              </h1>
              <p className="text-xs text-neutral-400">Multi-impresora • Spooler Windows USB • Reservas</p>
            </div>
          </div>

          {/* Action & Status Badges */}
          <div className="flex items-center gap-2.5">
            {/* BOTÓN BUSCAR ACTUALIZACIÓN */}
            <button
              type="button"
              onClick={handleCheckForUpdates}
              disabled={isCheckingUpdate}
              className="px-2.5 py-1.5 rounded-full text-xs font-semibold bg-neutral-800 hover:bg-neutral-750 text-neutral-300 border border-neutral-700 transition-all flex items-center gap-1.5 active:scale-95 shadow-sm"
              title="Buscar actualizaciones en GitHub"
            >
              {isCheckingUpdate ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Buscando...</span>
                </>
              ) : (
                <>
                  <span className="text-xs">🔄</span>
                  <span className="hidden sm:inline">Actualizaciones</span>
                </>
              )}
            </button>

            {/* BOTÓN PAUSAR / REANUDAR IMPRESIONES */}
            <button
              type="button"
              onClick={handleTogglePause}
              className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-1.5 border shadow-sm ${
                isPrintingPaused
                  ? 'bg-amber-500/20 border-amber-500/60 text-amber-300 hover:bg-amber-500/30 animate-pulse'
                  : 'bg-neutral-800 border-neutral-700 text-neutral-300 hover:bg-neutral-750 hover:text-white'
              }`}
              title={isPrintingPaused ? 'Las impresiones están pausadas. Haz clic para reanudar.' : 'Pausar el envío a impresoras físicas'}
            >
              {isPrintingPaused ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-amber-400" />
                  <span>⏸️ En Pausa (Reanudar)</span>
                </>
              ) : (
                <>
                  <span>⏸️</span>
                  <span>Pausar Impresiones</span>
                </>
              )}
            </button>

            {/* Connection Status Badge */}
            <div className={`px-3 py-1.5 rounded-full border text-xs font-bold flex items-center gap-2 ${
              status === 'connected' 
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' 
                : status === 'error'
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-neutral-800 border-neutral-700 text-neutral-400'
            }`}>
              <span className={`w-2 h-2 rounded-full ${
                status === 'connected' ? 'bg-emerald-400 animate-pulse' : status === 'error' ? 'bg-red-400' : 'bg-neutral-500'
              }`} />
              {status === 'connected' ? 'En línea' : status === 'error' ? 'Error' : 'En espera'}
            </div>

            {status === 'connected' && sucursal && (
              <span className="hidden sm:inline-block px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded-full text-xs font-medium text-neutral-300">
                🏢 {sucursal}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-4xl mx-auto px-6 pt-6 space-y-6">

        {/* Global Alerts */}
        {status === 'error' && (
          <div className="bg-red-500/15 border border-red-500/30 rounded-2xl p-4 flex items-start gap-3 text-red-300">
            <svg className="w-5 h-5 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="text-sm">
              <p className="font-bold">Error de conexión:</p>
              <p className="text-red-400/90 text-xs mt-0.5">{statusMessage || 'Verifica el correo y la contraseña ingresados.'}</p>
            </div>
          </div>
        )}

        {/* Banner de Pausa Activa */}
        {isPrintingPaused && (
          <div className="bg-amber-500/15 border border-amber-500/40 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-amber-200 animate-in fade-in">
            <div className="flex items-center gap-3">
              <span className="text-2xl">⏸️</span>
              <div>
                <p className="font-bold text-sm text-amber-100">Impresiones Automáticas en Pausa</p>
                <p className="text-xs text-amber-300/80">Los nuevos pedidos se mostrarán en la terminal y quedarán pendientes hasta que reanudes.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleTogglePause}
              className="w-full sm:w-auto px-4 py-2 bg-amber-500 hover:bg-amber-400 text-neutral-950 font-black rounded-xl text-xs shadow-md transition-all active:scale-95 whitespace-nowrap"
            >
              ▶️ Reanudar Impresiones
            </button>
          </div>
        )}

        {saveFeedback && (
          <div className="bg-emerald-500/15 border border-emerald-500/30 rounded-2xl p-3 px-4 text-emerald-300 text-sm flex items-center justify-between animate-in fade-in">
            <span>{saveFeedback}</span>
            <button onClick={() => setSaveFeedback(null)} className="text-emerald-400 hover:text-white text-xs font-bold ml-2">✕</button>
          </div>
        )}

        {/* Banner de Descarga de Actualización en Progreso */}
        {updateState.status === 'downloading' && (
          <div className="bg-blue-500/15 border border-blue-500/40 rounded-2xl p-4 flex items-center justify-between gap-4 text-blue-200 animate-in fade-in">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-blue-400 shrink-0 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <div>
                <p className="font-bold text-sm">Descargando actualización en segundo plano ({updateState.percent || 0}%)</p>
                <p className="text-xs text-blue-300/80">La aplicación se actualizará automáticamente al reiniciar.</p>
              </div>
            </div>
            <div className="w-28 bg-neutral-800 rounded-full h-2.5 overflow-hidden border border-blue-500/30 shrink-0">
              <div className="bg-blue-500 h-full transition-all duration-300" style={{ width: `${updateState.percent || 0}%` }} />
            </div>
          </div>
        )}

        {/* Banner de Actualización Descargada y Lista */}
        {updateState.status === 'downloaded' && (
          <div className="bg-emerald-500/20 border border-emerald-500/50 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-emerald-200 shadow-lg shadow-emerald-950/40 animate-in fade-in">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🎉</span>
              <div>
                <p className="font-bold text-sm text-emerald-100">
                  ¡Nueva versión {updateState.version ? `v${updateState.version}` : ''} lista para instalar!
                </p>
                <p className="text-xs text-emerald-300/80">
                  Se descargó silenciosamente. Puedes reiniciar ahora para aplicar los cambios o se aplicará al reiniciar la PC.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleInstallUpdate}
              className="w-full sm:w-auto px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-black rounded-xl text-xs shadow-md transition-all active:scale-95 whitespace-nowrap flex items-center justify-center gap-1.5"
            >
              🚀 Reiniciar y Actualizar Ahora
            </button>
          </div>
        )}

        {/* Feedback de Búsqueda de Actualizaciones */}
        {updateFeedback && (
          <div className="bg-neutral-850 border border-neutral-700 rounded-2xl p-3 px-4 text-neutral-300 text-xs flex items-center justify-between animate-in fade-in">
            <span>{updateFeedback}</span>
            <button onClick={() => setUpdateFeedback(null)} className="text-neutral-400 hover:text-white font-bold ml-2">✕</button>
          </div>
        )}

        {/* Credenciales Card con Soporte de Token y Reconexión Automática */}
        <section className="bg-neutral-800/60 border border-neutral-750/80 rounded-2xl p-5 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-400 flex items-center gap-2">
                <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                Conexión y Autenticación del Agente
              </h2>
              <p className="text-xs text-neutral-500 mt-0.5">
                {authTab === 'token'
                  ? 'Modo Desatendido: reconexión remota automática permanente.'
                  : 'Modo Manual con credenciales directas de Supabase.'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {/* Selector de Pestaña */}
              {status !== 'connected' && (
                <div className="flex bg-neutral-900 p-0.5 rounded-xl border border-neutral-700/80 text-xs">
                  <button
                    type="button"
                    onClick={() => setAuthTab('token')}
                    className={`px-3 py-1 rounded-lg font-bold transition-all ${
                      authTab === 'token'
                        ? 'bg-red-600 text-white shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    🔑 Token (Recomendado)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthTab('manual')}
                    className={`px-3 py-1 rounded-lg font-bold transition-all ${
                      authTab === 'manual'
                        ? 'bg-neutral-750 text-white shadow-sm'
                        : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    Usuario / Clave
                  </button>
                </div>
              )}

              {status === 'connected' && (
                <span className="text-xs text-emerald-400 font-bold flex items-center gap-1.5 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/20">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  Conectado {printerToken ? 'vía Token' : 'vía Usuario'}
                </span>
              )}
            </div>
          </div>

          {authTab === 'token' ? (
            /* MODO TOKEN (RECOMENDADO / DESATENDIDO) */
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
              <div className="sm:col-span-6 lg:col-span-7">
                <label className="block text-xs font-semibold text-neutral-300 mb-1.5 flex items-center justify-between">
                  <span>Token de Impresora (Plazoletas)</span>
                  <span className="text-[10px] text-neutral-500 font-normal">Panel Web &gt; Editar Restaurante</span>
                </label>
                <input
                  type="text"
                  value={printerToken}
                  onChange={e => setPrinterToken(e.target.value)}
                  placeholder="prt_xxxxxxxxxxxxxxxxxxxxxxxx..."
                  disabled={status === 'connected'}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3.5 py-2.5 text-sm font-mono text-white placeholder-neutral-600 focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition-all disabled:opacity-70"
                />
              </div>

              <div className="sm:col-span-3 lg:col-span-2">
                <label className="block text-xs font-semibold text-neutral-300 mb-1.5">
                  Anticipación (Min)
                </label>
                <input
                  type="number"
                  min="0"
                  value={printAdvanceMinutes}
                  onChange={e => setPrintAdvanceMinutes(e.target.value)}
                  placeholder="0 = Inmediato"
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition-all"
                />
              </div>

              <div className="sm:col-span-3 lg:col-span-3">
                {status === 'connected' ? (
                  <button
                    type="button"
                    onClick={handleLogout}
                    disabled={isLoggingOut}
                    className="w-full py-2.5 px-4 bg-neutral-800 hover:bg-neutral-750 border border-neutral-700 text-neutral-300 rounded-xl text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5"
                  >
                    {isLoggingOut ? 'Desconectando...' : 'Desconectar Impresora'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleTokenLogin}
                    disabled={isLoggingIn || !printerToken.trim()}
                    className="w-full py-2.5 px-4 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-xl text-xs font-extrabold shadow-lg shadow-red-600/30 transition-all active:scale-95 flex items-center justify-center gap-2"
                  >
                    {isLoggingIn ? (
                      <>
                        <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Vinculando...
                      </>
                    ) : (
                      <>
                        <span>🔗</span>
                        Vincular y Conectar
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* MODO MANUAL (EMAIL / PASSWORD) */
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1.5">Email Administrador</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="admin@sucursal.com"
                  disabled={status === 'connected'}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition-all disabled:opacity-70"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1.5">Contraseña</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  disabled={status === 'connected'}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition-all disabled:opacity-70"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-300 mb-1.5">
                  Anticipación reservas (Min)
                </label>
                <input
                  type="number"
                  min="0"
                  value={printAdvanceMinutes}
                  onChange={e => setPrintAdvanceMinutes(e.target.value)}
                  placeholder="0 = Inmediato"
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition-all"
                />
              </div>

              <div>
                {status === 'connected' ? (
                  <button
                    type="button"
                    onClick={handleLogout}
                    disabled={isLoggingOut}
                    className="w-full py-2.5 px-4 bg-neutral-800 hover:bg-neutral-750 border border-neutral-700 text-neutral-300 rounded-xl text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5"
                  >
                    {isLoggingOut ? 'Cerrando...' : 'Cerrar Sesión'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleDirectLogin}
                    disabled={isLoggingIn || !email || !password}
                    className="w-full py-2.5 px-4 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-xl text-xs font-extrabold shadow-lg shadow-red-600/30 transition-all active:scale-95 flex items-center justify-center gap-2"
                  >
                    {isLoggingIn ? (
                      <>
                        <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Conectando...
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                        </svg>
                        Iniciar Sesión
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Impresoras Section */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                </svg>
                Impresoras Térmicas
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-neutral-800 text-neutral-300 border border-neutral-700">
                {activeCount} {activeCount === 1 ? 'activa' : 'activas'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={loadSystemPrinters}
                disabled={isRefreshingPrinters}
                title="Actualizar impresoras detectadas de Windows"
                className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5"
              >
                <svg className={`w-3.5 h-3.5 ${isRefreshingPrinters ? 'animate-spin text-red-400' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Detectar USB
              </button>

              <button
                type="button"
                onClick={handleAddPrinter}
                className="px-3.5 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-bold shadow-md shadow-red-600/30 transition-all flex items-center gap-1.5 active:scale-95"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                </svg>
                Añadir Impresora
              </button>
            </div>
          </div>

          {/* List of Printer Cards */}
          <div className="grid grid-cols-1 gap-4">
            {impresoras.map((printer, index) => {
              const isTestingThis = testingPrinterId === printer.id
              const currentResult = testResult && testResult.id === printer.id ? testResult : null

              return (
                <div
                  key={printer.id}
                  className={`border rounded-2xl p-5 transition-all bg-neutral-850/80 ${
                    printer.activo 
                      ? 'border-neutral-700 hover:border-neutral-600 shadow-lg' 
                      : 'border-neutral-800 opacity-60 bg-neutral-900/50'
                  }`}
                >
                  {/* Card Header */}
                  <div className="flex items-center justify-between gap-3 mb-4 pb-3 border-b border-neutral-800">
                    <div className="flex items-center gap-3 flex-1">
                      <span className="w-6 h-6 rounded-lg bg-neutral-800 flex items-center justify-center text-xs font-bold text-neutral-400">
                        #{index + 1}
                      </span>
                      <input
                        type="text"
                        value={printer.nombre}
                        onChange={e => handleUpdatePrinter(printer.id, { nombre: e.target.value })}
                        placeholder="Ej: Cocina Caliente, Caja Mostrador"
                        className="bg-transparent font-bold text-white text-base focus:bg-neutral-900 px-2 py-1 rounded-lg border border-transparent focus:border-neutral-700 outline-none transition-all flex-1 max-w-xs"
                      />
                    </div>

                    <div className="flex items-center gap-3">
                      {/* Active toggle */}
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <span className="text-xs font-semibold text-neutral-400">
                          {printer.activo ? 'Habilitada' : 'Pausada'}
                        </span>
                        <input
                          type="checkbox"
                          checked={printer.activo}
                          onChange={e => handleUpdatePrinter(printer.id, { activo: e.target.checked })}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-neutral-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-neutral-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500 relative" />
                      </label>

                      {/* Delete button */}
                      <button
                        type="button"
                        onClick={() => handleRemovePrinter(printer.id)}
                        title="Eliminar impresora"
                        className="p-1.5 text-neutral-500 hover:text-red-400 rounded-lg hover:bg-neutral-800 transition-all"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Card Body: Connection Type, Role & Paper Width */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                    {/* Connection Type Tabs */}
                    <div>
                      <label className="block text-xs font-semibold text-neutral-400 mb-1.5">
                        Tipo de Conexión
                      </label>
                      <div className="grid grid-cols-2 bg-neutral-900 p-1 rounded-xl border border-neutral-750">
                        <button
                          type="button"
                          onClick={() => handleUpdatePrinter(printer.id, { tipoConexion: 'windows_usb' })}
                          className={`py-2 px-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1 ${
                            printer.tipoConexion === 'windows_usb'
                              ? 'bg-neutral-800 text-white shadow-md border border-neutral-700'
                              : 'text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          <svg className="w-3.5 h-3.5 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          <span className="truncate">Cable</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleUpdatePrinter(printer.id, { tipoConexion: 'network' })}
                          className={`py-2 px-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1 ${
                            printer.tipoConexion === 'network'
                              ? 'bg-neutral-800 text-white shadow-md border border-neutral-700'
                              : 'text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                          </svg>
                          <span className="truncate">Red</span>
                        </button>
                      </div>
                    </div>

                    {/* Role selector */}
                    <div>
                      <label className="block text-xs font-semibold text-neutral-400 mb-1.5 flex items-center justify-between">
                        <span>Documentos a Imprimir</span>
                        <span className="text-[10px] text-neutral-400 font-medium">
                          {printer.rolCopia === 'COCINA' 
                            ? 'Solo Cocina' 
                            : printer.rolCopia === 'CAJA' 
                              ? 'Solo Factura Cliente' 
                              : 'Comanda + Factura'}
                        </span>
                      </label>
                      <div className="grid grid-cols-3 bg-neutral-900 p-1 rounded-xl border border-neutral-750 gap-1">
                        {(['COCINA', 'CAJA', 'AMBOS'] as const).map(rol => (
                          <button
                            key={rol}
                            type="button"
                            onClick={() => handleUpdatePrinter(printer.id, { rolCopia: rol })}
                            className={`py-2 px-1 text-xs font-bold rounded-lg transition-all text-center leading-tight ${
                              printer.rolCopia === rol
                                ? 'bg-red-600 text-white shadow-md'
                                : 'text-neutral-400 hover:text-neutral-200'
                            }`}
                          >
                            {rol === 'COCINA' ? 'Cocina' : rol === 'CAJA' ? 'Caja / Factura' : 'Ambos'}
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-neutral-400 mt-1.5 leading-snug">
                        {printer.rolCopia === 'COCINA' && '👨‍🍳 Solo comanda de cocina sin precios, con notas y QR para preparar.'}
                        {printer.rolCopia === 'CAJA' && '🧾 Solo factura formal para el cliente con precios, datos fiscales y pago.'}
                        {printer.rolCopia === 'AMBOS' && '⚡ Imprime comanda de cocina y luego factura de cliente (ideal para 1 sola impresora).'}
                      </p>
                    </div>

                    {/* Paper width selector */}
                    <div>
                      <label className="block text-xs font-semibold text-neutral-400 mb-1.5">
                        Ancho de Papel
                      </label>
                      <div className="grid grid-cols-2 bg-neutral-900 p-1 rounded-xl border border-neutral-750">
                        {(['80mm', '58mm'] as const).map(ancho => (
                          <button
                            key={ancho}
                            type="button"
                            onClick={() => handleUpdatePrinter(printer.id, { anchoPapel: ancho })}
                            className={`py-2 text-xs font-bold rounded-lg transition-all ${
                              (printer.anchoPapel || '80mm') === ancho
                                ? 'bg-neutral-800 text-white shadow-md border border-neutral-700'
                                : 'text-neutral-400 hover:text-neutral-200'
                            }`}
                          >
                            {ancho === '80mm' ? '80 mm' : '58 mm'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Connection Specific Inputs */}
                  {printer.tipoConexion === 'windows_usb' ? (
                    <div className="bg-neutral-900/80 border border-neutral-800 rounded-xl p-3 mb-4">
                      <label className="block text-xs font-semibold text-neutral-300 mb-1.5 flex items-center justify-between">
                        <span>Impresora instalada en Windows</span>
                        {systemPrinters.length === 0 && (
                          <span className="text-amber-400 text-xs font-normal">
                            No se detectaron impresoras de Windows
                          </span>
                        )}
                      </label>

                      <div className="flex gap-2">
                        <select
                          value={printer.deviceName || ''}
                          onChange={e => handleUpdatePrinter(printer.id, { deviceName: e.target.value })}
                          className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-3.5 py-2.5 text-sm text-white focus:ring-2 focus:ring-red-500 outline-none"
                        >
                          <option value="">-- Selecciona tu impresora térmica --</option>
                          {systemPrinters.map(sp => (
                            <option key={sp.name} value={sp.name}>
                              {sp.name} {sp.isDefault ? '(Predeterminada)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>

                      <p className="text-[11px] text-neutral-400 mt-2 flex items-center gap-1.5">
                        <span className="text-emerald-400">✓</span>
                        Compatible con cualquier impresora térmica USB por cable usando el driver nativo de Windows (sin Zadig).
                      </p>
                    </div>
                  ) : (
                    <div className="bg-neutral-900/80 border border-neutral-800 rounded-xl p-3 mb-4 grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <label className="block text-xs font-semibold text-neutral-300 mb-1">
                          Dirección IP Local
                        </label>
                        <input
                          type="text"
                          value={printer.ip || ''}
                          onChange={e => handleUpdatePrinter(printer.id, { ip: e.target.value })}
                          placeholder="192.168.1.100"
                          className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-3 py-2 text-sm text-white focus:ring-2 focus:ring-red-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-neutral-300 mb-1">
                          Puerto
                        </label>
                        <input
                          type="number"
                          value={printer.port || 9100}
                          onChange={e => handleUpdatePrinter(printer.id, { port: Number(e.target.value) || 9100 })}
                          placeholder="9100"
                          className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-3 py-2 text-sm text-white text-center focus:ring-2 focus:ring-red-500 outline-none"
                        />
                      </div>
                    </div>
                  )}

                  {/* Card Action & Feedback Footer */}
                  <div className="flex items-center justify-between pt-2">
                    <div>
                      {currentResult && (
                        <div className={`text-xs font-medium px-2.5 py-1 rounded-lg flex items-center gap-1.5 ${
                          currentResult.success 
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' 
                            : 'bg-red-500/15 text-red-300 border border-red-500/30'
                        }`}>
                          <span>{currentResult.success ? '✓' : '⚠️'}</span>
                          {currentResult.msg}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleTestIndividual(printer)}
                      disabled={isTestingThis}
                      className="px-4 py-2 bg-neutral-800 hover:bg-neutral-750 text-neutral-200 border border-neutral-700 rounded-xl text-xs font-bold transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {isTestingThis ? (
                        <>
                          <svg className="w-3.5 h-3.5 animate-spin text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          Imprimiendo prueba...
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                          </svg>
                          Probar Impresora
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* Bottom Sticky Save Bar */}
        <div className="pt-4 border-t border-neutral-800 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-neutral-400 text-center sm:text-left">
            Al guardar, los cambios de impresoras y configuración se sincronizan inmediatamente.
          </p>

          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="w-full sm:w-auto px-8 py-3.5 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 text-white rounded-xl font-extrabold text-sm shadow-xl shadow-red-600/30 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isSaving ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Guardando...
              </>
            ) : (
              'Guardar Configuración'
            )}
          </button>
        </div>

      </main>
    </div>
  )
}

export default App
