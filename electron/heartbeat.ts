let heartbeatInterval: NodeJS.Timeout | null = null;

const HEARTBEAT_URL = "https://plazoletas.upickcol.com/api/printer/heartbeat";

export function startHeartbeat(restaurantId: string, printerToken?: string | null) {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  const enviarPulso = async () => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (printerToken) {
        headers['Authorization'] = `Bearer ${printerToken}`;
      }

      const res = await fetch(HEARTBEAT_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          restaurantId,
          restauranteId: restaurantId,
          token: printerToken || undefined,
          status: 'ONLINE',
          version: '1.2.1',
        }),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.reactivadoAutomaticamente) {
          console.log('🟢 [Heartbeat] ¡Restaurante reactivado automáticamente en UPick Plazoletas!');
        }
      } else {
        const errorData = await res.json().catch(() => ({}));
        console.warn('⚠️ [Heartbeat] Respuesta de backend:', res.status, errorData.error || errorData.message || res.statusText);
      }
    } catch (err: any) {
      console.warn('⚠️ [Heartbeat] Sin conexión con UPick (falla de internet/red local):', err?.message || err);
    }
  };

  // Enviar el primer latido inmediatamente tras conectar
  enviarPulso();

  // Y programar cada 30 segundos
  heartbeatInterval = setInterval(enviarPulso, 30000);
  console.log(`💓 [Heartbeat] Monitoreo activado cada 30s hacia ${HEARTBEAT_URL}`);
}

export function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('🛑 [Heartbeat] Monitoreo detenido.');
  }
}
