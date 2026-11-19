/// <reference types="vite/client" />
import { createClient } from '@supabase/supabase-js';
import { store } from './store';
import { printToAllPrinters, printOrderToConsole } from './printer';
import { parseColombianDate } from './timeUtils';
import { startHeartbeat, stopHeartbeat } from './heartbeat';

// Leer variables de entorno (cargadas por Vite en import.meta.env)
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ Faltan variables de entorno de Supabase.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
const scheduledOrders = new Set<string>();
const processingOrders = new Set<string>();

let pollingInterval: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let tokenRefreshTimer: NodeJS.Timeout | null = null;
let lastStatusCallback: ((status: 'connected' | 'disconnected' | 'error', message?: string) => void) | null = null;
let isSettingUp = false;

const PRINTER_AUTH_URL = "https://plazoletas.upickcol.com/api/printer/auth";

export async function authenticateWithPrinterToken(token: string): Promise<{ success: boolean; error?: string }> {
  try {
    console.log('🔑 [Token Auth] Conectando con servidor de UPick mediante Token de Impresora...');
    const res = await fetch(PRINTER_AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ token })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const errMsg = errData.error || `Error ${res.status}: ${res.statusText}`;
      console.warn(`⚠️ [Token Auth] Respuesta de servidor: ${errMsg}`);
      return { success: false, error: errMsg };
    }

    const data = await res.json();
    if (data.success && data.email && data.password) {
      store.set('email', data.email);
      store.set('password', data.password);
      if (data.restaurantId) store.set('restaurantId', data.restaurantId);
      store.set('printerToken', token);
      console.log(`✅ [Token Auth] Credenciales resueltas exitosamente para: ${data.nombreSucursal || data.restaurantId}`);
      return { success: true };
    }

    return { success: false, error: 'Respuesta inválida del servidor' };
  } catch (err: any) {
    console.warn('⚠️ [Token Auth] Error de red al autenticar con token:', err?.message || err);
    return { success: false, error: err?.message || 'Error de red' };
  }
}

function scheduleReconnect(delayMs = 5000, reason = 'Falla de conexión') {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`⏳ [Auto-Reconnect] Programando reconexión en ${Math.round(delayMs / 1000)}s (${reason})...`);
  reconnectTimer = setTimeout(() => {
    if (lastStatusCallback) {
      setupSupabaseRealtime(lastStatusCallback);
    }
  }, delayMs);
}

function startPolling(restaurantId: string) {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(async () => {
    try {
      await schedulePendingOrders(restaurantId);
    } catch (pollErr) {
      console.warn('⚠️ [Sondeo de Respaldo] Error verificando órdenes pendientes:', pollErr);
    }
  }, 20000); // Doble red de seguridad cada 20 segundos
  console.log('🔄 [Sondeo de Respaldo] Doble red de seguridad activada (cada 20s).');
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function startTokenRefresh() {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = setInterval(async () => {
    try {
      console.log('🔑 [Auth] Verificando y refrescando token de sesión de Supabase...');
      const { data, error } = await supabase.auth.refreshSession();
      if (error) {
        console.warn('⚠️ [Auth] Falló refresco de token, reautenticando con credenciales guardadas...');
        const printerToken = store.get('printerToken');
        if (printerToken) {
          await authenticateWithPrinterToken(printerToken);
        }
        const email = store.get('email');
        const password = store.get('password');
        if (email && password) {
          await supabase.auth.signInWithPassword({ email, password });
        }
      } else if (data?.session) {
        console.log('✅ [Auth] Token de sesión renovado correctamente.');
      }
    } catch (err) {
      console.warn('⚠️ [Auth] Error en refresco de sesión:', err);
    }
  }, 25 * 60 * 1000); // Cada 25 minutos
}

function stopTokenRefresh() {
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }
}

async function processPrint(orderId: string, fullOrder: any) {
  try {
    // Verificamos que la orden siga siendo PENDING en printStatus y consultamos su estado actual
    const { data: checkOrder } = await supabase
      .from('PedidoRestaurante')
      .select('printStatus, estado')
      .eq('id', orderId)
      .single();

    if (!checkOrder || checkOrder.printStatus !== 'PENDING') {
      console.log(`Orden no encontrada o ya no está PENDING en impresión, se omite.`);
      return;
    }

    // Si la orden ya no está en estado 'PENDING' (por ejemplo, pasó manualmente a 'PREPARANDO', 'LISTO', etc.),
    // significa que el restaurante ya la vio y la está gestionando. No debemos imprimirla para no causar confusiones en cocina.
    if (checkOrder.estado !== 'PENDING') {
      console.log(`⏩ [Omitir Impresión] Orden #${orderId.slice(-6)} ya está en estado '${checkOrder.estado}'. Se omite la comanda para no duplicar trabajo en cocina (ya gestionada manualmente).`);
      const nextPrintStatus = checkOrder.estado === 'CANCELADO' ? 'FAILED' : 'PRINTED';
      await supabase
        .from('PedidoRestaurante')
        .update({ printStatus: nextPrintStatus })
        .eq('id', orderId);
      return;
    }

    const isPaused = store.get('isPrintingPaused') || false;
    if (isPaused) {
      console.warn(`⏸️ Las impresiones están PAUSADAS. La orden #${orderId.slice(-6)} se retiene en PENDING.`);
      printOrderToConsole(fullOrder, 'IMPRESIONES PAUSADAS (EN COLA)');
      return;
    }

    const success = await printToAllPrinters(fullOrder);

    if (success) {
      await supabase
        .from('PedidoRestaurante')
        .update({
          printStatus: 'PRINTED',
          estado: 'PREPARANDO',
          printedAt: new Date().toISOString()
        })
        .eq('id', orderId);
      console.log(`Orden #${orderId.slice(-6)} marcada como PRINTED y PREPARANDO`);
    } else {
      console.error(`Ninguna impresora pudo imprimir la orden #${orderId.slice(-6)}. La comanda se mostró en la terminal.`);
    }
  } catch (err) {
    console.error('Fallo al imprimir la orden:', err);
    printOrderToConsole(fullOrder, 'ERROR CRÍTICO AL IMPRIMIR');
    await supabase
      .from('PedidoRestaurante')
      .update({ printStatus: 'FAILED' })
      .eq('id', orderId);
  }
}

async function handleOrder(orderId: string) {
  if (scheduledOrders.has(orderId) || processingOrders.has(orderId)) {
    return;
  }
  processingOrders.add(orderId);

  try {
    const { data: initialOrder, error } = await supabase
      .from('PedidoRestaurante')
      .select(`
        *,
        TransaccionPago (
          id,
          nombreCliente,
          telefonoCliente,
          tipoPedido,
          paraLlevar,
          ubicacionEntregaTexto,
          estadoPago,
          montoTotal,
          montoPropina,
          montoDescuentosCupones,
          solicitaFacturaElectronica,
          tipoDocumentoFacturacion,
          documentoFacturacion,
          nombreFacturacion,
          emailFacturacion,
          DetalleRecaudoCredibanco ( metodoPago, franquicia ),
          DetalleRecaudoBreB ( id, keyValue, estadoLlave ),
          DetalleRecaudoPse ( id, bankName, trazabilityCode ),
          DetalleRecaudoWompi ( metodoPago, referenciaWompi )
        ),
        DetallePedido (
          cantidad,
          notas,
          precioUnitarioCobrado,
          ProductoMenu ( nombre ),
          EleccionAdicional ( nombreOpcion, precioCobrado )
        ),
        Restaurante (
          nombreSucursal,
          tiempoPaseComandaMinutos,
          datosLiquidacion,
          Plazoleta (
            nombre,
            Lugar (
              nombre,
              Ciudad ( nombre )
            )
          )
        )
      `)
      .eq('id', orderId)
      .single();

    let fullOrder = initialOrder;

    if (error || !fullOrder) {
      console.warn(`⚠️ Consulta completa de pedido #${orderId.slice(-6)} falló (${error?.message || 'Sin datos'}). Ejecutando consulta de rescate resiliente sin subtables opcionales...`);
      const { data: fallbackOrder, error: fallbackError } = await supabase
        .from('PedidoRestaurante')
        .select(`
          *,
          TransaccionPago (
            id,
            nombreCliente,
            telefonoCliente,
            tipoPedido,
            paraLlevar,
            ubicacionEntregaTexto,
            estadoPago,
            montoTotal,
            montoPropina,
            montoDescuentosCupones,
            solicitaFacturaElectronica,
            tipoDocumentoFacturacion,
            documentoFacturacion,
            nombreFacturacion,
            emailFacturacion
          ),
          DetallePedido (
            cantidad,
            notas,
            precioUnitarioCobrado,
            ProductoMenu ( nombre ),
            EleccionAdicional ( nombreOpcion, precioCobrado )
          ),
          Restaurante (
            nombreSucursal,
            tiempoPaseComandaMinutos,
            datosLiquidacion,
            Plazoleta (
              nombre,
              Lugar (
                nombre,
                Ciudad ( nombre )
              )
            )
          )
        `)
        .eq('id', orderId)
        .single();

      if (fallbackError || !fallbackOrder) {
        console.error(`❌ Error irrecuperable al consultar pedido #${orderId.slice(-6)}:`, fallbackError || 'No encontrado');
        return;
      }

      console.log(`✅ [Rescate Exitoso] Pedido #${orderId.slice(-6)} recuperado exitosamente con consulta resiliente.`);
      fullOrder = fallbackOrder;
    }

    if (fullOrder.printStatus !== 'PENDING') return;

    // Si la orden ya no está en estado 'PENDING' (fue pasada manualmente a PREPARANDO, LISTO, etc.)
    if (fullOrder.estado && fullOrder.estado !== 'PENDING') {
      console.log(`⏩ [Omitir Impresión] Pedido #${orderId.slice(-6)} ya se encuentra en estado '${fullOrder.estado}'. Omitiendo comanda para no duplicar trabajo en cocina.`);
      const nextPrintStatus = fullOrder.estado === 'CANCELADO' ? 'FAILED' : 'PRINTED';
      await supabase
        .from('PedidoRestaurante')
        .update({ printStatus: nextPrintStatus })
        .eq('id', orderId);
      return;
    }

    // Verificar que el estado del pago sea APROBADO
    if (fullOrder.TransaccionPago?.estadoPago !== 'APROBADO') {
      const estadoPago = fullOrder.TransaccionPago?.estadoPago;
      console.log(`Pedido ${orderId} ignorado por ahora: estadoPago es '${estadoPago}'.`);
      if (['RECHAZADO', 'CANCELADO', 'FALLIDO'].includes(estadoPago)) {
        console.log(`⏹️ Pedido #${orderId.slice(-6)} con pago rechazado/cancelado. Marcando printStatus='FAILED' para limpiar la cola.`);
        await supabase
          .from('PedidoRestaurante')
          .update({ printStatus: 'FAILED' })
          .eq('id', orderId);
      }
      return;
    }

    const printAdvanceMinutes = store.get('printAdvanceMinutes') || 0;
    const now = new Date();
    let delayMs = 0;

    // Si es un pedido de reserva y se configuró anticipación de impresión
    if (fullOrder.esReserva && fullOrder.fechaProgramada && fullOrder.horaProgramadaInicio && printAdvanceMinutes > 0) {
      try {
        const fechaProg = String(fullOrder.fechaProgramada).split('T')[0];
        const horaInicio = String(fullOrder.horaProgramadaInicio).substring(0, 5);
        const scheduledTime = new Date(`${fechaProg}T${horaInicio}:00-05:00`);
        const targetPrintTime = new Date(scheduledTime.getTime() - (printAdvanceMinutes * 60 * 1000));
        const diff = targetPrintTime.getTime() - now.getTime();
        if (diff > 0) {
          delayMs = diff;
        }
      } catch (err) {
        console.warn('Error calculando horario programado de reserva:', err);
      }
    }

    if (delayMs > 0) {
      console.log(`Orden de reserva #${orderId.slice(-6)} programada para imprimir en ${Math.round(delayMs / 60000)} minutos.`);
      scheduledOrders.add(orderId);

      setTimeout(async () => {
        scheduledOrders.delete(orderId);
        await processPrint(orderId, fullOrder);
      }, delayMs);
    } else {
      await processPrint(orderId, fullOrder);
    }
  } catch (err) {
    console.error('Error handling order:', err);
  } finally {
    processingOrders.delete(orderId);
  }
}

async function schedulePendingOrders(restaurantId: string) {
  console.log('Checking for pending orders...');
  const { data: pendingOrders, error } = await supabase
    .from('PedidoRestaurante')
    .select('id, estado')
    .eq('restauranteId', restaurantId)
    .eq('printStatus', 'PENDING');

  if (error || !pendingOrders) {
    console.error('Error fetching pending orders:', error);
    return;
  }

  for (const record of pendingOrders) {
    if (record.estado && record.estado !== 'PENDING') {
      console.log(`⏩ [Sondeo de Respaldo] Orden #${record.id.slice(-6)} pendiente de impresión ya está en '${record.estado}'. Sincronizando printStatus y omitiendo impresión.`);
      const nextPrintStatus = record.estado === 'CANCELADO' ? 'FAILED' : 'PRINTED';
      await supabase
        .from('PedidoRestaurante')
        .update({ printStatus: nextPrintStatus })
        .eq('id', record.id);
      continue;
    }
    await handleOrder(record.id);
  }
}

export async function setupSupabaseRealtime(onStatusChange: (status: 'connected' | 'disconnected' | 'error', message?: string) => void) {
  lastStatusCallback = onStatusChange;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  let email = store.get('email');
  let password = store.get('password');
  const printerToken = store.get('printerToken');

  // Si tenemos un printerToken, aseguramos que las credenciales provengan de la cuenta de impresora
  if (printerToken) {
    if (!email || !password || !email.toLowerCase().startsWith('impresora.')) {
      console.log('🔑 [Setup] Sincronizando credenciales de impresora con printerToken...');
      const authRes = await authenticateWithPrinterToken(printerToken);
      if (authRes.success) {
        email = store.get('email');
        password = store.get('password');
      } else {
        stopHeartbeat();
        stopPolling();
        stopTokenRefresh();
        onStatusChange('error', `Error con token: ${authRes.error}`);
        scheduleReconnect(10000, 'Reintento tras fallo de token');
        return;
      }
    }
  }

  if (!email || !password) {
    console.log('No hay credenciales ni token guardado, omitiendo setup de Realtime');
    stopHeartbeat();
    stopPolling();
    stopTokenRefresh();
    onStatusChange('disconnected');
    return;
  }

  if (isSettingUp) {
    console.log('⏳ Setup de Supabase ya en curso, ignorando llamada simultánea...');
    return;
  }
  isSettingUp = true;

  try {
    // 1. Iniciar sesión
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData.user) {
      console.error('Error de autenticación:', authError?.message);

      // Si tenemos printerToken y falló login, refrescar credenciales frescas con el backend
      if (printerToken) {
        console.log('🔄 [Auth Recovery] Reintentando resolver credenciales frescas con printerToken...');
        const tokenRes = await authenticateWithPrinterToken(printerToken);
        if (tokenRes.success) {
          scheduleReconnect(1000, 'Reintento con credenciales frescas tras rotación');
          return;
        }
      }

      stopHeartbeat();
      stopPolling();
      stopTokenRefresh();

      const errMsg = authError?.message || '';
      const isInvalidCredentials =
        errMsg.toLowerCase().includes('invalid login credentials') ||
        errMsg.toLowerCase().includes('invalid grant') ||
        errMsg.toLowerCase().includes('email not confirmed');

      if (isInvalidCredentials) {
        onStatusChange('error', 'Credenciales incorrectas');
      } else {
        // Error de red, caída temporal de WiFi o timeout
        onStatusChange('error', 'Sin conexión a internet. Reintentando...');
        scheduleReconnect(5000, 'Falla de red en login');
      }
      return;
    }

    // 2. Obtener el restauranteId del usuario
    const { data: userData, error: userError } = await supabase
      .from('Usuario')
      .select('restauranteId, Restaurante(nombreSucursal, printerToken)')
      .eq('id', authData.user.id)
      .single();

    if (userError) {
      console.error('Error al consultar datos del usuario:', userError.message);
      stopHeartbeat();
      stopPolling();
      stopTokenRefresh();
      onStatusChange('error', `Error al consultar datos: ${userError.message}`);
      scheduleReconnect(5000, 'Falla al consultar datos de usuario');
      return;
    }

    if (!userData?.restauranteId) {
      console.error('El usuario no tiene un restaurante asignado.');
      stopHeartbeat();
      stopPolling();
      stopTokenRefresh();
      onStatusChange('error', 'El usuario no tiene un restaurante asignado');
      return;
    }

    const restaurantId = userData.restauranteId;

    // Guardar el restaurantId en el store para compatibilidad con otras funciones
    store.set('restaurantId', restaurantId);

    // Extraer nombre de sucursal
    const restauranteObj = Array.isArray(userData.Restaurante) ? userData.Restaurante[0] : userData.Restaurante;
    const sucursalNombre = (restauranteObj as any)?.nombreSucursal || 'Desconocida';
    console.log(`🟢 Conectado exitosamente a la sucursal: ${sucursalNombre} (${restaurantId})`);
    const printerTokenFromDb = (restauranteObj as any)?.printerToken || null;
    const activeToken = printerToken || printerTokenFromDb;
    if (activeToken) {
      store.set('printerToken', activeToken);
    }

    // Iniciar latidos hacia el backend
    startHeartbeat(restaurantId, activeToken);

    // Iniciar sondeo periódico de respaldo y refresco automático de token
    startPolling(restaurantId);
    startTokenRefresh();

    // Si ya había un canal previo, lo cerramos limpiamente antes de abrir uno nuevo
    if (realtimeChannel) {
      console.log('🧹 Limpiando canal previo de Supabase Realtime...');
      const oldChannel = realtimeChannel;
      realtimeChannel = null;
      await supabase.removeChannel(oldChannel);
    }

    console.log(`Configurando Supabase Realtime para Restaurante ID: ${restaurantId}`);

    // Revisar órdenes pendientes al conectar
    schedulePendingOrders(restaurantId);

    realtimeChannel = supabase.channel(`public:PedidoRestaurante:restauranteId=eq.${restaurantId}`)
      .on(
        'postgres_changes',
        {
          event: '*', // Escuchar INSERT y UPDATE
          schema: 'public',
          table: 'PedidoRestaurante',
          filter: `restauranteId=eq.${restaurantId}`
        },
        async (payload) => {
          console.log('Cambio detectado en PedidoRestaurante:', payload);

          const newRecord = payload.new as any;

          // Solo nos interesa si tiene printStatus = PENDING
          if (newRecord && newRecord.printStatus === 'PENDING') {
            // Si el cambio en el pedido fue que pasó manualmente a PREPARANDO u otro estado
            if (newRecord.estado && newRecord.estado !== 'PENDING') {
              console.log(`⏩ [Realtime] Orden #${newRecord.id?.slice(-6)} en estado '${newRecord.estado}'. Omitiendo impresión automática (gestión manual).`);
              const nextPrintStatus = newRecord.estado === 'CANCELADO' ? 'FAILED' : 'PRINTED';
              await supabase
                .from('PedidoRestaurante')
                .update({ printStatus: nextPrintStatus })
                .eq('id', newRecord.id);
              return;
            }

            console.log(`¡Orden detectada como PENDING!`);
            await handleOrder(newRecord.id);
          }
        }
      )
      .subscribe((status) => {
        console.log('Supabase Subscription status:', status);
        if (status === 'SUBSCRIBED') {
          onStatusChange('connected', sucursalNombre);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`⚠️ [Realtime] Error en canal (${status}). Programando reconexión...`);
          onStatusChange('error', 'Reconectando canal Realtime...');
          scheduleReconnect(5000, `Canal status=${status}`);
        } else if (status === 'CLOSED') {
          console.log('ℹ️ [Realtime] Canal cerrado limpiamente.');
        } else {
          onStatusChange('disconnected');
        }
      });
  } catch (err: any) {
    console.error('Error inesperado durante el setup de Supabase:', err);
    onStatusChange('error', 'Falla de conexión. Reintentando...');
    scheduleReconnect(5000, 'Excepción en setupSupabaseRealtime');
  } finally {
    isSettingUp = false;
  }
}

export async function disconnectSupabase() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopPolling();
  stopTokenRefresh();
  stopHeartbeat();
  if (realtimeChannel) {
    await supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  await supabase.auth.signOut();
}

export async function resumePrintingAndCheckPending() {
  const restaurantId = store.get('restaurantId');
  if (restaurantId) {
    console.log('▶️ Impresiones reanudadas. Verificando pedidos pendientes...');
    await schedulePendingOrders(restaurantId);
  }
}
