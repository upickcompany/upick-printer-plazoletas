/// <reference types="vite/client" />
import { createClient } from '@supabase/supabase-js';
import { store } from './store';
import { printOrder } from './printer';
import { parseColombianDate } from './timeUtils';

// Leer variables de entorno (cargadas por Vite en import.meta.env)
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ Faltan variables de entorno de Supabase.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
const scheduledOrders = new Set<string>();

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

    const success = await printOrder(fullOrder);

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
    }
  } catch (err) {
    console.error('Fallo al imprimir la orden:', err);
    await supabase
      .from('PedidoRestaurante')
      .update({ printStatus: 'FAILED' })
      .eq('id', orderId);
  }
}

async function handleOrder(orderId: string) {
  if (scheduledOrders.has(orderId)) {
    return;
  }

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
          estadoPago
        ),
        DetallePedido (
          cantidad,
          notas,
          ProductoMenu ( nombre ),
          EleccionAdicional ( nombreOpcion )
        ),
        Restaurante ( nombreSucursal )
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

    // Si la impresión tiene retardo (aunque para plazoletas usualmente será 0 y no hay pickupSlotStart)
    if (printAdvanceMinutes > 0 && fullOrder.createdAt) {
      // Usaremos el createdAt como base si se quisiera retardar, pero lo ideal es imprimir de inmediato
      // Mantenemos la estructura por compatibilidad
    }

    if (delayMs > 0) {
      console.log(`Orden programada para imprimir en ${Math.round(delayMs / 60000)} minutos.`);
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

export async function setupSupabaseRealtime(onStatusChange: (status: 'connected' | 'disconnected' | 'error') => void) {
  const restaurantId = store.get('restaurantId');

  if (!restaurantId) {
    console.log('No Restaurant ID configured, skipping Realtime setup');
    onStatusChange('disconnected');
    return;
  }

  // Si ya había un canal, lo cerramos antes de abrir uno nuevo
  if (realtimeChannel) {
    await supabase.removeChannel(realtimeChannel);
  }

  console.log(`Setting up Supabase Realtime for Restaurant ID: ${restaurantId}`);

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
        onStatusChange('connected');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        onStatusChange('error');
      } else {
        onStatusChange('disconnected');
      }
    });
}
