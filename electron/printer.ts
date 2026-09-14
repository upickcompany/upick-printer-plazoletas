import { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const escpos = require('escpos');
const Network = require('escpos-network');
const qr = require('qr-image');
import { store, ImpresoraConfig } from './store';

escpos.Network = Network;

function removeAccents(str: string): string {
  if (!str) return '';
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function formatBogotaDate(dateStr: string): string {
  if (!dateStr) return '';
  let str = dateStr;
  if (!str.match(/(Z|[+-]\d{2}:?\d{2})$/)) {
    str += 'Z';
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) return dateStr;
  
  const bogotaTime = new Date(d.getTime() - (5 * 60 * 60 * 1000));
  
  const day = bogotaTime.getUTCDate().toString().padStart(2, '0');
  const month = (bogotaTime.getUTCMonth() + 1).toString().padStart(2, '0');
  const year = bogotaTime.getUTCFullYear();
  
  let hours = bogotaTime.getUTCHours();
  const minutes = bogotaTime.getUTCMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'p. m.' : 'a. m.';
  
  hours = hours % 12;
  hours = hours ? hours : 12;
  const hoursStr = hours.toString().padStart(2, '0');

  return `${day}/${month}/${year}, ${hoursStr}:${minutes} ${ampm}`;
}

function formatItemRow(desc: string, cant: string): string[] {
  const lineLength = 32;
  const cantStr = cant.toString();
  const maxDescLen = lineLength - cantStr.length - 1; 
  
  let lines: string[] = [];
  let currentDesc = desc;
  
  let firstLineText = currentDesc;
  if (firstLineText.length > maxDescLen) {
    let splitAt = firstLineText.lastIndexOf(' ', maxDescLen);
    if (splitAt === -1 || splitAt === 0) splitAt = maxDescLen;
    firstLineText = firstLineText.substring(0, splitAt);
    currentDesc = currentDesc.substring(splitAt).trim();
  } else {
    currentDesc = '';
  }
  
  const spaces = lineLength - firstLineText.length - cantStr.length;
  lines.push(firstLineText + ' '.repeat(Math.max(0, spaces)) + cantStr);
  
  while (currentDesc.length > 0) {
    if (currentDesc.length > lineLength) {
      let splitAt = currentDesc.lastIndexOf(' ', lineLength);
      if (splitAt === -1 || splitAt === 0) splitAt = lineLength;
      lines.push(currentDesc.substring(0, splitAt));
      currentDesc = currentDesc.substring(splitAt).trim();
    } else {
      lines.push(currentDesc);
      currentDesc = '';
    }
  }
  
  return lines;
}

function getRoleTag(rol: string): string {
  if (rol === 'COCINA') return '[ COPIA COCINA ]';
  if (rol === 'CAJA') return '[ COPIA CAJA ]';
  return '[ COMANDA GENERAL ]';
}

function getReservaInfo(orderData: any) {
  const esReserva = Boolean(orderData.esReserva);
  let fechaProgramadaTexto = '';
  let horaProgramadaTexto = '';

  if (esReserva) {
    if (orderData.fechaProgramada) {
      const hoyStr = new Date().toISOString().split('T')[0];
      const fechaProg = String(orderData.fechaProgramada).split('T')[0];
      fechaProgramadaTexto = (fechaProg === hoyStr) ? 'HOY' : fechaProg;
    } else {
      fechaProgramadaTexto = 'HOY';
    }

    const hInicio = orderData.horaProgramadaInicio ? String(orderData.horaProgramadaInicio).substring(0, 5) : '';
    const hFin = orderData.horaProgramadaFin ? String(orderData.horaProgramadaFin).substring(0, 5) : '';

    if (hInicio && hFin) {
      horaProgramadaTexto = `${hInicio} - ${hFin}`;
    } else if (hInicio) {
      horaProgramadaTexto = hInicio;
    } else {
      horaProgramadaTexto = 'A convenir';
    }
  }

  return { esReserva, fechaProgramadaTexto, horaProgramadaTexto };
}

// -------------------------------------------------------------
// IMPRESIÓN POR WINDOWS SPOOLER (CABLE / USB NATIVO)
// -------------------------------------------------------------
export async function printViaWindowsSpooler(deviceName: string, htmlContent: string): Promise<boolean> {
  return new Promise((resolve) => {
    let printWin: BrowserWindow | null = new BrowserWindow({
      show: false,
      width: 320,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const cleanup = () => {
      if (printWin && !printWin.isDestroyed()) {
        printWin.close();
        printWin = null;
      }
    };

    const timer = setTimeout(() => {
      console.warn(`Timeout imprimiendo en spooler de Windows: ${deviceName}`);
      cleanup();
      resolve(false);
    }, 15000);

    printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent));

    printWin.webContents.on('did-finish-load', () => {
      // Breve espera para que el motor renderice estilos e imágenes base64
      setTimeout(() => {
        if (!printWin || printWin.isDestroyed()) {
          clearTimeout(timer);
          resolve(false);
          return;
        }

        printWin.webContents.print(
          {
            silent: true,
            printBackground: true,
            deviceName: deviceName,
            margins: { marginType: 'none' }
          },
          (success, failureReason) => {
            clearTimeout(timer);
            if (!success) {
              console.error(`Error en spooler de Windows (${deviceName}):`, failureReason);
            }
            cleanup();
            resolve(success);
          }
        );
      }, 350);
    });

    printWin.webContents.on('did-fail-load', (err) => {
      clearTimeout(timer);
      console.error('Fallo al cargar contenido HTML en ventana de impresión:', err);
      cleanup();
      resolve(false);
    });
  });
}

function generateReceiptHtml(orderData: any, printerConfig: ImpresoraConfig): string {
  const roleTag = getRoleTag(printerConfig.rolCopia);
  const { esReserva, fechaProgramadaTexto, horaProgramadaTexto } = getReservaInfo(orderData);

  let transaccionInfo = 'Cliente no identificado';
  let telefonoCliente = '';
  let codigoTicket = 'N/A';
  let tipoPedidoTexto = '';

  if (orderData.TransaccionPago) {
    const tx = orderData.TransaccionPago;
    transaccionInfo = tx.nombreCliente || 'Cliente';
    telefonoCliente = tx.telefonoCliente ? `Tel: ${tx.telefonoCliente}` : '';
    codigoTicket = tx.id ? tx.id.slice(-6).toUpperCase() : 'N/A';

    if (tx.tipoPedido === 'ENTREGA_MESA') {
      tipoPedidoTexto = `ENTREGAR EN: ${tx.ubicacionEntregaTexto || 'Ubicación no especificada'}`;
    } else if (tx.tipoPedido === 'RECOGIDA') {
      tipoPedidoTexto = 'PARA RECOGER';
    }
  }

  const nombreRest = orderData.Restaurante?.nombreSucursal || '';
  const fechaImpresion = orderData.createdAt ? formatBogotaDate(orderData.createdAt) : '';

  let qrBase64 = '';
  try {
    const qrUrl = `https://plazoletas.upickcol.com/qrc/pedido/${orderData.id}`;
    const qrBuffer = qr.imageSync(qrUrl, { type: 'png', size: 4, margin: 1 });
    qrBase64 = 'data:image/png;base64,' + qrBuffer.toString('base64');
  } catch (err) {
    console.error('Error generando QR base64:', err);
  }

  let totalItems = 0;
  let itemsHtml = '';
  if (orderData.DetallePedido && orderData.DetallePedido.length > 0) {
    orderData.DetallePedido.forEach((item: any) => {
      const cant = item.cantidad || 1;
      totalItems += cant;
      const desc = item.ProductoMenu?.nombre || 'Producto';
      
      let extrasHtml = '';
      if (item.notas) {
        extrasHtml += `<div class="item-detail">Nota: ${item.notas}</div>`;
      }
      if (item.EleccionAdicional && item.EleccionAdicional.length > 0) {
        item.EleccionAdicional.forEach((eleccion: any) => {
          extrasHtml += `<div class="item-detail">+ ${eleccion.nombreOpcion}</div>`;
        });
      }

      itemsHtml += `
        <div class="item-row">
          <div class="item-desc">${desc}</div>
          <div class="item-qty">${cant}</div>
        </div>
        ${extrasHtml}
      `;
    });
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {
    margin: 0;
    size: 80mm auto;
  }
  body {
    margin: 0;
    padding: 6px 10px 24px 10px;
    width: 72mm;
    font-family: 'Courier New', Courier, monospace, sans-serif;
    font-size: 13px;
    line-height: 1.25;
    color: #000;
    background: #fff;
    font-weight: 700;
  }
  .center { text-align: center; }
  .right { text-align: right; }
  .title { font-size: 22px; font-weight: 900; line-height: 1.1; margin: 4px 0 2px 0; }
  .subtitle { font-size: 14px; font-weight: 700; margin-bottom: 2px; }
  .badge-role {
    border: 2px dashed #000;
    padding: 3px 6px;
    font-size: 14px;
    font-weight: 900;
    margin: 4px auto;
    display: inline-block;
  }
  .reserva-box {
    border: 3px double #000;
    padding: 6px;
    margin: 8px 0;
    text-align: center;
  }
  .reserva-title {
    font-size: 14px;
    font-weight: 900;
    letter-spacing: 0.5px;
  }
  .reserva-time {
    font-size: 16px;
    font-weight: 900;
    margin-top: 3px;
  }
  .divider {
    border-top: 1px dashed #000;
    margin: 6px 0;
  }
  .table-header {
    display: flex;
    justify-content: space-between;
    border-top: 1px dashed #000;
    border-bottom: 1px dashed #000;
    padding: 3px 0;
    font-weight: 900;
    margin-top: 4px;
  }
  .item-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-top: 5px;
  }
  .item-desc {
    flex: 1;
    padding-right: 8px;
    font-size: 13px;
    word-break: break-word;
  }
  .item-qty {
    font-size: 13px;
    white-space: nowrap;
    font-weight: 900;
  }
  .item-detail {
    font-size: 11px;
    padding-left: 8px;
    color: #111;
    margin-top: 1px;
  }
  .qr-container {
    text-align: center;
    margin-top: 10px;
  }
  .qr-img {
    width: 135px;
    height: 135px;
    display: block;
    margin: 6px auto;
  }
</style>
</head>
<body>
  <div class="center">
    <div class="badge-role">${roleTag}</div>
    <div class="title">UPick</div>
    ${nombreRest ? `<div class="subtitle">${nombreRest}</div>` : ''}
    <div style="font-size: 16px; font-weight: 900; margin: 3px 0;">Pedido #${codigoTicket}</div>
    <div>PAGADO</div>
    ${fechaImpresion ? `<div style="font-size: 12px; margin-top: 2px;">${fechaImpresion}</div>` : ''}
  </div>

  ${esReserva ? `
    <div class="reserva-box">
      <div class="reserva-title">*** COMANDA DE RESERVA ***</div>
      <div>PROGRAMADO PARA: ${fechaProgramadaTexto}</div>
      <div class="reserva-time">HORA ENTREGA: ${horaProgramadaTexto}</div>
    </div>
  ` : ''}

  <div class="divider"></div>
  <div>Cliente: ${transaccionInfo}</div>
  ${telefonoCliente ? `<div>${telefonoCliente}</div>` : ''}
  ${tipoPedidoTexto ? `<div style="font-weight: 900; margin-top: 2px;">${tipoPedidoTexto}</div>` : ''}
  <div class="divider"></div>

  <div class="table-header">
    <div>DESCRIPCION</div>
    <div>CANT</div>
  </div>

  ${itemsHtml}

  <div class="divider"></div>
  <div class="right" style="font-size: 13px; font-weight: 900;">Total articulos: ${totalItems}</div>

  <div class="center" style="margin-top: 8px;">
    <div>Gracias por usar UPick!</div>
    <div style="font-size: 11px; margin-top: 2px;">Para el restaurante:</div>
  </div>

  ${qrBase64 ? `
    <div class="qr-container">
      <img src="${qrBase64}" class="qr-img" />
      <div style="font-size: 11px;">Escanea este QR para</div>
      <div style="font-size: 11px; font-weight: 900;">marcar el pedido como LISTO.</div>
    </div>
  ` : ''}
</body>
</html>`;
}

// -------------------------------------------------------------
// IMPRESIÓN POR RED (TCP RAW SOCKET ESC/POS)
// -------------------------------------------------------------
async function printViaNetworkEscpos(orderData: any, printerConfig: ImpresoraConfig): Promise<boolean> {
  const ip = printerConfig.ip;
  const port = printerConfig.port || 9100;

  if (!ip) {
    console.error(`[${printerConfig.nombre}] No hay IP configurada para impresión en red.`);
    return false;
  }

  return new Promise((resolve, reject) => {
    try {
      const device = new escpos.Network(ip, port);

      // Patch de cierre TCP ordenado para evitar bloqueos
      device.close = function (cb: any) {
        if (this.device) {
          this.device.end();
          setTimeout(() => {
            if (this.device) {
              this.device.destroy();
              this.device = null;
            }
            if (cb) cb(null, this.device);
          }, 500);
        } else {
          if (cb) cb(null, this.device);
        }
        return this;
      };

      const options = { encoding: "GB18030" };
      const printer = new escpos.Printer(device, options);

      let isDone = false;
      device.open((error: any) => {
        if (error) {
          if (isDone) {
            console.warn('Conexión cerrada (ignorado por finalización):', error.message);
            return;
          }
          console.error(`Error conectando a impresora de red (${ip}:${port}):`, error);
          resolve(false);
          return;
        }

        try {
          const roleTag = getRoleTag(printerConfig.rolCopia);
          const { esReserva, fechaProgramadaTexto, horaProgramadaTexto } = getReservaInfo(orderData);

          let fechaImpresion = orderData.createdAt ? formatBogotaDate(orderData.createdAt) : '';
          let transaccionInfo = 'Cliente no identificado';
          let telefonoCliente = '';
          let codigoTicket = 'N/A';
          let tipoPedidoTexto = '';

          if (orderData.TransaccionPago) {
            const tx = orderData.TransaccionPago;
            transaccionInfo = removeAccents(tx.nombreCliente || 'Cliente');
            telefonoCliente = tx.telefonoCliente ? `Tel: ${tx.telefonoCliente}` : '';
            codigoTicket = tx.id ? tx.id.slice(-6).toUpperCase() : 'N/A';

            if (tx.tipoPedido === 'ENTREGA_MESA') {
              tipoPedidoTexto = removeAccents(`ENTREGAR EN: ${tx.ubicacionEntregaTexto || 'Ubicacion no especificada'}`);
            } else if (tx.tipoPedido === 'RECOGIDA') {
              tipoPedidoTexto = 'PARA RECOGER';
            }
          }

          const nombreRest = orderData.Restaurante?.nombreSucursal;

          // ENCABEZADO Y ROL
          printer
            .font('b')
            .align('ct')
            .style('b')
            .size(1, 1)
            .text(roleTag)
            .size(2, 2)
            .text('UPick');

          if (nombreRest) {
            printer.size(1, 1).text(removeAccents(nombreRest));
          }

          printer
            .size(1, 1)
            .text('Pedido #' + codigoTicket)
            .text('PAGADO');

          if (fechaImpresion) {
            printer.text(fechaImpresion);
          }

          // BANNER DE RESERVA
          if (esReserva) {
            printer
              .align('ct')
              .text('================================')
              .style('b')
              .text('*** COMANDA DE RESERVA ***')
              .text(`PROGRAMADO PARA: ${fechaProgramadaTexto}`)
              .text(`HORA ENTREGA: ${horaProgramadaTexto}`)
              .style('normal')
              .text('================================');
          }

          printer
            .align('ct')
            .text('--------------------------------')
            .align('lt')
            .text(`Cliente: ${transaccionInfo}`);

          if (telefonoCliente) {
            printer.text(telefonoCliente);
          }

          if (tipoPedidoTexto) {
            printer.text(tipoPedidoTexto);
          }

          printer
            .align('ct')
            .text('--------------------------------')
            .align('lt')
            .text('DESCRIPCION                 CANT')
            .text('--------------------------------');

          let totalItems = 0;
          if (orderData.DetallePedido && orderData.DetallePedido.length > 0) {
            orderData.DetallePedido.forEach((item: any) => {
              const cantNum = item.cantidad || 1;
              totalItems += cantNum;
              
              const desc = removeAccents(item.ProductoMenu?.nombre || 'Producto');
              const cant = cantNum.toString();
              
              const formattedLines = formatItemRow(desc, cant);
              formattedLines.forEach(line => printer.text(line));

              if (item.notas) {
                printer.text(`   Nota: ${removeAccents(item.notas)}`);
              }

              if (item.EleccionAdicional && item.EleccionAdicional.length > 0) {
                item.EleccionAdicional.forEach((eleccion: any) => {
                  printer.text(`   - ${removeAccents(eleccion.nombreOpcion)}`);
                });
              }
            });
          }

          printer
            .feed(1)
            .align('rt')
            .text(`Total articulos: ${totalItems}`)
            .align('ct')
            .text('--------------------------------')
            .text('Gracias por usar UPick!')
            .feed(1)
            .text('Para el restaurante:')
            .feed(1);

          const qrUrl = `https://plazoletas.upickcol.com/qrc/pedido/${orderData.id}`;

          printer.qrimage(qrUrl, { type: 'png', mode: 'normal', size: 5, margin: 2, ec_level: 'M' }, (err: any) => {
            if (err) {
              console.error('Error generando qrimage escpos:', err);
            }
            printer
              .feed(1)
              .text('Escanea este QR para')
              .text('marcar el pedido como LISTO.')
              .feed(3)
              .cut();

            isDone = true;
            printer.close((closeErr: any) => {
              if (closeErr) console.error('Error al cerrar la impresora:', closeErr);
              resolve(true);
            });
          });
        } catch (printError) {
          console.error('Error en comandos de impresión ESC/POS:', printError);
          device.close();
          resolve(false);
        }
      });
    } catch (err) {
      console.error('Error crítico en socket de red:', err);
      resolve(false);
    }
  });
}

// -------------------------------------------------------------
// IMPRIMIR PEDIDO EN UNA IMPRESORA INDIVIDUAL
// -------------------------------------------------------------
async function printSingleOrder(orderData: any, printerConfig: ImpresoraConfig): Promise<boolean> {
  if (printerConfig.tipoConexion === 'windows_usb') {
    if (!printerConfig.deviceName) {
      console.error(`[${printerConfig.nombre}] No tiene dispositivo de Windows seleccionado.`);
      return false;
    }
    const html = generateReceiptHtml(orderData, printerConfig);
    return await printViaWindowsSpooler(printerConfig.deviceName, html);
  } else {
    return await printViaNetworkEscpos(orderData, printerConfig);
  }
}

// -------------------------------------------------------------
// IMPRESIÓN DE DEPURACIÓN POR TERMINAL / CONSOLA
// -------------------------------------------------------------
export function printOrderToConsole(orderData: any, motivo?: string) {
  let transaccionInfo = 'Cliente no identificado';
  let telefonoCliente = '';
  let codigoTicket = 'N/A';
  let tipoPedidoTexto = '';

  if (orderData.TransaccionPago) {
    const tx = orderData.TransaccionPago;
    transaccionInfo = tx.nombreCliente || 'Cliente';
    telefonoCliente = tx.telefonoCliente ? `Tel: ${tx.telefonoCliente}` : '';
    codigoTicket = tx.id ? tx.id.slice(-6).toUpperCase() : 'N/A';

    if (tx.tipoPedido === 'ENTREGA_MESA') {
      tipoPedidoTexto = `ENTREGAR EN: ${tx.ubicacionEntregaTexto || 'Ubicación no especificada'}`;
    } else if (tx.tipoPedido === 'RECOGIDA') {
      tipoPedidoTexto = 'PARA RECOGER';
    }
  }

  const { esReserva, fechaProgramadaTexto, horaProgramadaTexto } = getReservaInfo(orderData);
  const nombreRest = orderData.Restaurante?.nombreSucursal || 'Restaurante';
  const fechaStr = orderData.createdAt ? formatBogotaDate(orderData.createdAt) : new Date().toLocaleString('es-CO');

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  if (motivo) {
    console.log(`║ ⚠️  [TERMINAL DEBUG] ${motivo}`);
    console.log('╠════════════════════════════════════════════════════════════╣');
  } else {
    console.log('║             🧾 DETALLE DE COMANDA (TERMINAL)               ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
  }
  console.log(`║ UPick - ${nombreRest}`);
  console.log(`║ Pedido #${codigoTicket} | PAGADO | ${fechaStr}`);
  if (esReserva) {
    console.log('║ ────────────────────────────────────────────────────────── ║');
    console.log(`║ 📅 *** COMANDA DE RESERVA ***`);
    console.log(`║    PROGRAMADO: ${fechaProgramadaTexto} | HORA: ${horaProgramadaTexto}`);
    console.log('║ ────────────────────────────────────────────────────────── ║');
  }
  console.log(`║ Cliente: ${transaccionInfo} ${telefonoCliente}`);
  if (tipoPedidoTexto) {
    console.log(`║ Tipo: ${tipoPedidoTexto}`);
  }
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║ ÍTEMS DEL PEDIDO:');

  let totalItems = 0;
  if (orderData.DetallePedido && orderData.DetallePedido.length > 0) {
    orderData.DetallePedido.forEach((item: any) => {
      const cant = item.cantidad || 1;
      totalItems += cant;
      const desc = item.ProductoMenu?.nombre || 'Producto';
      console.log(`║   • ${cant}x ${desc}`);
      if (item.notas) {
        console.log(`║      Nota: ${item.notas}`);
      }
      if (item.EleccionAdicional && item.EleccionAdicional.length > 0) {
        item.EleccionAdicional.forEach((el: any) => {
          console.log(`║      + ${el.nombreOpcion}`);
        });
      }
    });
  } else {
    console.log('║   (Sin artículos registrados)');
  }

  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║ Total artículos: ${totalItems}`);
  console.log(`║ QR URL: https://plazoletas.upickcol.com/qrc/pedido/${orderData.id}`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

// -------------------------------------------------------------
// DESPACHADOR MULTI-IMPRESORA EN PARALELO
// -------------------------------------------------------------
export async function printToAllPrinters(orderData: any, impresoras?: ImpresoraConfig[]): Promise<boolean> {
  const printerList = impresoras || store.get('impresoras') || [];
  const activePrinters = printerList.filter(p => p.activo);

  let codigoTicket = orderData.id ? orderData.id.slice(-6).toUpperCase() : 'N/A';
  if (orderData.TransaccionPago?.id) {
    codigoTicket = orderData.TransaccionPago.id.slice(-6).toUpperCase();
  }

  console.log('\n======================================');
  console.log(` DESPACHANDO PEDIDO #${codigoTicket} EN TIEMPO REAL `);
  console.log(` Total Impresoras Activas: ${activePrinters.length}`);
  console.log('======================================');

  if (activePrinters.length === 0) {
    console.warn('⚠️ No hay impresoras activas configuradas. Mostrando comanda por terminal:');
    printOrderToConsole(orderData, 'SIN IMPRESORAS ACTIVAS');
    return false;
  }

  const results = await Promise.allSettled(
    activePrinters.map(async (p) => {
      const ok = await printSingleOrder(orderData, p);
      return { printer: p.nombre, ok };
    })
  );

  let atLeastOneSuccess = false;
  results.forEach((res, i) => {
    const pName = activePrinters[i].nombre;
    if (res.status === 'fulfilled' && res.value.ok) {
      console.log(`✅ [${pName}] Impresión completada exitosamente.`);
      atLeastOneSuccess = true;
    } else {
      const err = res.status === 'rejected' ? res.reason : 'Error en dispositivo';
      console.error(`❌ [${pName}] Falló la impresión física:`, err);
    }
  });

  if (!atLeastOneSuccess) {
    console.error(`⚠️ ATENCIÓN: No se pudo imprimir en hardware. Mostrando comanda completa por terminal:`);
    printOrderToConsole(orderData, 'FALLO EN TODAS LAS IMPRESORAS');
  } else {
    // Mostrar también la comanda en consola para confirmar datos y debug
    printOrderToConsole(orderData, 'COMANDADA ENVIADA A HARDWARE');
  }

  return atLeastOneSuccess;
}

// Mantener compatibilidad con llamadas existentes a printOrder
export const printOrder = (orderData: any) => printToAllPrinters(orderData);

// -------------------------------------------------------------
// PRUEBA DE CONEXIÓN INDIVIDUAL
// -------------------------------------------------------------
export async function testPrinter(config: any): Promise<boolean> {
  const tipo = config.tipoConexion || config.connectionType;

  if (tipo === 'windows_usb') {
    const deviceName = config.deviceName;
    if (!deviceName) {
      console.error('No se seleccionó una impresora de Windows para la prueba.');
      return false;
    }

    const testHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    font-family: 'Courier New', Courier, monospace;
    text-align: center;
    padding: 12px 6px;
    width: 72mm;
    color: #000;
  }
  h2 { font-size: 16px; margin: 0 0 6px 0; }
  p { font-size: 12px; margin: 3px 0; }
</style>
</head>
<body>
  <h2>PRUEBA DE CONEXION</h2>
  <p><strong>UPick Printer Plazoletas</strong></p>
  <p>Impresora: ${config.nombre || deviceName}</p>
  <p>Dispositivo: ${deviceName}</p>
  <p>Rol: ${config.rolCopia || 'AMBOS'}</p>
  <p>--------------------------------</p>
  <p>¡Conexión USB/Windows Exitosa!</p>
  <p>${new Date().toLocaleString('es-CO')}</p>
</body>
</html>`;

    return await printViaWindowsSpooler(deviceName, testHtml);
  } else {
    // Red TCP ESC/POS
    const ip = config.ip || config.printerIp;
    const port = Number(config.port || config.printerPort) || 9100;

    if (!ip) {
      console.error('No hay IP configurada para la prueba de red.');
      return false;
    }

    return new Promise((resolve) => {
      try {
        const device = new escpos.Network(ip, port);
        device.close = function (cb: any) {
          if (this.device) {
            this.device.end();
            setTimeout(() => {
              if (this.device) {
                this.device.destroy();
                this.device = null;
              }
              if (cb) cb(null, this.device);
            }, 500);
          } else {
            if (cb) cb(null, this.device);
          }
          return this;
        };

        const printer = new escpos.Printer(device);

        device.open((error: any) => {
          if (error) {
            console.error(`Error conectando para prueba de red (${ip}:${port}):`, error);
            resolve(false);
            return;
          }

          try {
            printer
              .align('ct')
              .style('b')
              .text('Prueba de Conexión Exitosa')
              .style('normal')
              .text('UPick Printer Plazoletas')
              .text(`Impresora: ${config.nombre || 'Red'}`)
              .text(`IP: ${ip}:${port}`)
              .text(`Rol: ${config.rolCopia || 'AMBOS'}`)
              .feed(3)
              .cut()
              .close(() => {
                resolve(true);
              });
          } catch (e) {
            resolve(false);
          }
        });
      } catch (err) {
        resolve(false);
      }
    });
  }
}
