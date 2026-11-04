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

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
const scheduledOrders = new Set<string>();
const processingOrders = new Set<string>();

async function processPrint(orderId: string, fullOrder: any) {
  try {
    // Verificamos que la orden siga siendo PENDING en printStatus
    const { data: checkOrder } = await supabase
      .from('PedidoRestaurante')
      .select('printStatus, estado')
      .eq('id', orderId)
      .single();

    if (!checkOrder || checkOrder.printStatus !== 'PENDING') {
      console.log(`Orden no encontrada o ya no está PENDING en impresión, se omite.`);
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
    const { data: fullOrder, error } = await supabase
      .from('PedidoRestaurante')
      .select(`
        *,
        TransaccionPago (
          id,
          nombreCliente,
          telefonoCliente,
          tipoPedido,
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

    if (error || !fullOrder) {
      console.error('Error fetching full order details:', error);
      return;
    }

    if (fullOrder.printStatus !== 'PENDING') return;
    
    // Verificar que el estado del pago sea APROBADO
    if (fullOrder.TransaccionPago?.estadoPago !== 'APROBADO') {
      console.log(`Pedido ${orderId} ignorado por ahora: estadoPago es '${fullOrder.TransaccionPago?.estadoPago}'.`);
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
    .select('id')
    .eq('restauranteId', restaurantId)
    .eq('printStatus', 'PENDING');

  if (error || !pendingOrders) {
    console.error('Error fetching pending orders:', error);
    return;
  }

  for (const record of pendingOrders) {
    await handleOrder(record.id);
  }
}

export async function setupSupabaseRealtime(onStatusChange: (status: 'connected' | 'disconnected' | 'error', message?: string) => void) {
  const email = store.get('email');
  const password = store.get('password');

  if (!email || !password) {
    console.log('No hay credenciales guardadas, omitiendo setup de Realtime');
    stopHeartbeat();
    onStatusChange('disconnected');
    return;
  }

  try {
    // 1. Iniciar sesión
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData.user) {
      console.error('Error de autenticación:', authError?.message);
      stopHeartbeat();
      onStatusChange('error', 'Credenciales incorrectas');
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
      onStatusChange('error', `Error de base de datos: ${userError.message}`);
      return;
    }

    if (!userData?.restauranteId) {
      console.error('El usuario no tiene un restaurante asignado.');
      stopHeartbeat();
      onStatusChange('error', 'El usuario no tiene un restaurante asignado');
      return;
    }

    const restaurantId = userData.restauranteId;
    
    // Guardar el restaurantId en el store para compatibilidad con otras funciones
    store.set('restaurantId', restaurantId);
    
    // Opcional: imprimir el nombre de la sucursal
    const restauranteObj = Array.isArray(userData.Restaurante) ? userData.Restaurante[0] : userData.Restaurante;
    const sucursalNombre = (restauranteObj as any)?.nombreSucursal || 'Desconocida';
    console.log(`Conectado exitosamente a la sucursal: ${sucursalNombre} (${restaurantId})`);
    const printerToken = (restauranteObj as any)?.printerToken || null;
    startHeartbeat(restaurantId, printerToken);

    // Si ya había un canal, lo cerramos antes de abrir uno nuevo
    if (realtimeChannel) {
      await supabase.removeChannel(realtimeChannel);
    }

    console.log(`Configurando Supabase Realtime para Restaurante ID: ${restaurantId}`);

    // Fetch pending orders on startup
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
          onStatusChange('error', 'Error en canal de realtime');
        } else {
          onStatusChange('disconnected');
        }
      });
  } catch (err) {
    console.error('Error inesperado durante el setup de Supabase:', err);
    onStatusChange('error', 'Error inesperado de conexión');
  }
}

export async function disconnectSupabase() {
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
