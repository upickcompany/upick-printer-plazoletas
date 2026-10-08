import Store from 'electron-store';

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

export interface AppConfig {
  restaurantId: string;
  email?: string;
  password?: string;
  printAdvanceMinutes?: number;
  impresoras: ImpresoraConfig[];
  isPrintingPaused?: boolean;
  // Legacy fields for backward compatibility
  printerIp?: string;
  printerPort?: number;
  connectionType?: string;
  printerVid?: string;
  printerPid?: string;
}

export const store = new Store<AppConfig>({
  defaults: {
    restaurantId: '',
    email: '',
    password: '',
    printAdvanceMinutes: 0,
    isPrintingPaused: false,
    impresoras: [
      {
        id: 'default-impresora-1',
        nombre: 'Impresora Principal',
        tipoConexion: 'network',
        ip: '192.168.40.18',
        port: 9100,
        deviceName: '',
        rolCopia: 'AMBOS',
        anchoPapel: '80mm',
        activo: true
      }
    ]
  }
});

// Retrocompatibilidad: si el usuario ya tenía configurada una sola impresora legacy
try {
  const existingImpresoras = store.get('impresoras');
  if (!existingImpresoras || !Array.isArray(existingImpresoras) || existingImpresoras.length === 0) {
    const legacyIp = store.get('printerIp');
    const legacyPort = store.get('printerPort');
    const legacyType = store.get('connectionType');

    const migratedPrinter: ImpresoraConfig = {
      id: 'migrated-default',
      nombre: 'Impresora Principal',
      tipoConexion: legacyType === 'usb' ? 'windows_usb' : 'network',
      ip: legacyIp || '192.168.40.18',
      port: Number(legacyPort) || 9100,
      deviceName: '',
      rolCopia: 'AMBOS',
      anchoPapel: '80mm',
      activo: true
    };
    store.set('impresoras', [migratedPrinter]);
  }
} catch (e) {
  console.warn('Error en la migración de impresoras en el store:', e);
}
