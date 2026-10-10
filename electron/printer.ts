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

function formatCOP(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || isNaN(Number(amount))) return '$ 0';
  return '$ ' + Math.round(Number(amount)).toLocaleString('es-CO');
}

function formatPriceRow(desc: string, priceStr: string, lineLength = 32): string[] {
  const cleanPrice = removeAccents(priceStr);
  const maxDescLen = lineLength - cleanPrice.length - 1; 
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
  
  const spaces = lineLength - firstLineText.length - cleanPrice.length;
  lines.push(firstLineText + ' '.repeat(Math.max(0, spaces)) + cleanPrice);
  
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

function getRestauranteFiscalInfo(orderData: any) {
  const rest = orderData.Restaurante || {};
  const liq = (typeof rest.datosLiquidacion === 'object' && rest.datosLiquidacion !== null) ? rest.datosLiquidacion : {};

  const nombreComercial = rest.nombreSucursal || 'Restaurante';
  const razonSocial = liq.razonSocial || liq.titular || liq.nombreTitular || '';
  const nit = liq.nit || liq.numeroDocumento || liq.documento || '';
  const regimen = liq.regimen || liq.responsabilidadTributaria || 'No responsable de IVA';
  const direccion = liq.direccion || '';
  const telefono = liq.telefono || '';

  const plazoletaNombre = rest.Plazoleta?.nombre || '';
  const lugarNombre = rest.Plazoleta?.Lugar?.nombre || '';
  const ciudadNombre = rest.Plazoleta?.Lugar?.Ciudad?.nombre || '';

  let ubicacionTexto = '';
  if (plazoletaNombre && lugarNombre) {
    ubicacionTexto = `${plazoletaNombre} - ${lugarNombre}`;
  } else if (plazoletaNombre || lugarNombre) {
    ubicacionTexto = plazoletaNombre || lugarNombre;
  }
  if (ciudadNombre) {
    ubicacionTexto = ubicacionTexto ? `${ubicacionTexto}, ${ciudadNombre}` : ciudadNombre;
  }

  return {
    nombreComercial,
    razonSocial,
    nit,
    regimen,
    direccion,
    telefono,
    ubicacionTexto
  };
}

function getClienteInvoiceInfo(orderData: any) {
  const tx = orderData.TransaccionPago || {};
  let nombreCliente = tx.nombreCliente || 'Cliente';
  let documentoCliente = '222222222222 (Consumidor Final)';
  let emailCliente = '';
  let telefonoCliente = tx.telefonoCliente ? `Tel: ${tx.telefonoCliente}` : '';

  if (tx.documentoFacturacion) {
    const tipoDoc = tx.tipoDocumentoFacturacion || 'CC';
    documentoCliente = `${tipoDoc} ${tx.documentoFacturacion}`;
    if (tx.nombreFacturacion) {
      nombreCliente = tx.nombreFacturacion;
    }
    if (tx.emailFacturacion) {
      emailCliente = tx.emailFacturacion;
    }
  }

  let tipoPedidoTexto = '';
  if (tx.tipoPedido === 'ENTREGA_MESA') {
    tipoPedidoTexto = `ENTREGAR EN: ${tx.ubicacionEntregaTexto || 'Mesa no especificada'}`;
  } else if (tx.tipoPedido === 'RECOGIDA') {
    tipoPedidoTexto = 'PARA LLEVAR / RECOGER';
  }

  return {
    nombreCliente,
    documentoCliente,
    emailCliente,
    telefonoCliente,
    tipoPedidoTexto
  };
}

function getFinancialTotals(orderData: any) {
  const subtotal = Number(orderData.subtotalRestaurante || 0);
  const descuento = Number(orderData.montoDescuentoCupon || 0);
  const cuponCodigo = orderData.cuponCodigo || '';
  const feeServicio = Number(orderData.montoFeeServicio || 0);
  const propina = Number(orderData.montoPropina || 0);
  
  const total = Math.max(0, subtotal - descuento + feeServicio + propina);

  return {
    subtotal,
    descuento,
    cuponCodigo,
    feeServicio,
    propina,
    total
  };
}

function getMedioPagoTexto(orderData: any): string {
  const tx = orderData.TransaccionPago || {};

  const breb = Array.isArray(tx.DetalleRecaudoBreB)
    ? tx.DetalleRecaudoBreB[0]
    : (tx.DetalleRecaudoBreB || tx.detalleBreB);

  const pse = Array.isArray(tx.DetalleRecaudoPse)
    ? tx.DetalleRecaudoPse[0]
    : (tx.DetalleRecaudoPse || tx.detallePse);

  const credi = Array.isArray(tx.DetalleRecaudoCredibanco)
    ? tx.DetalleRecaudoCredibanco[0]
    : (tx.DetalleRecaudoCredibanco || tx.detalleCredibanco);

  const wompi = Array.isArray(tx.DetalleRecaudoWompi)
    ? tx.DetalleRecaudoWompi[0]
    : (tx.DetalleRecaudoWompi || tx.detalleWompi);

  // 1. Kamin: Bre-B
  if (breb) {
    return 'BRE-B';
  }

  // 2. Kamin o Wompi: PSE
  if (pse) {
    return 'PSE';
  }

  // 3. Credibanco: Tarjeta
  if (credi) {
    if (credi.franquicia) {
      return `TARJETA (${String(credi.franquicia).trim().toUpperCase()})`;
    }
    return 'TARJETA';
  }

  // 4. Wompi
  if (wompi) {
    const mp = (wompi.metodoPago || '').toUpperCase();
    if (mp === 'CARD') return 'TARJETA';
    if (mp === 'PSE') return 'PSE';
    if (mp === 'BANCOLOMBIA_TRANSFER' || mp === 'NEQUI') return 'NEQUI / BANCOLOMBIA';
    return mp || 'TARJETA';
  }

  // 5. Fallback por texto
  const metodoGeneral = String(tx.metodoPago || '').toUpperCase();
  if (metodoGeneral.includes('BRE_B') || metodoGeneral.includes('BREB')) return 'BRE-B';
  if (metodoGeneral.includes('PSE')) return 'PSE';
  if (metodoGeneral.includes('CARD') || metodoGeneral.includes('TARJETA') || metodoGeneral.includes('CREDI')) return 'TARJETA';

  return 'PAGO EN LINEA';
}

function formatItemRow(desc: string, cant: string, lineLength = 32): string[] {
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
  if (!deviceName) {
    console.error('❌ [Spooler Windows] Error: No se especificó el dispositivo de impresión.');
    return false;
  }

  return new Promise((resolve) => {
    let printWin: BrowserWindow | null = new BrowserWindow({
      show: false,
      width: 350,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false
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

    let isPrinted = false;
    const executePrint = () => {
      if (isPrinted || !printWin || printWin.isDestroyed()) return;
      isPrinted = true;

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
            usePrinterDefaultPageSize: true,
            margins: { marginType: 'none' }
          },
          (success, failureReason) => {
            clearTimeout(timer);
            if (!success) {
              console.error(`❌ Error en spooler de Windows (${deviceName}):`, failureReason);
              cleanup();
              resolve(false);
            } else {
              console.log(`✅ [Spooler Windows] Documento enviado exitosamente a "${deviceName}".`);
              // Dejamos 2 segundos para que el spooler de Windows termine de transmitir el raster a la impresora
              setTimeout(() => {
                cleanup();
              }, 2000);
              resolve(true);
            }
          }
        );
      }, 450);
    };

    printWin.once('ready-to-show', executePrint);

    printWin.webContents.on('did-finish-load', () => {
      setTimeout(executePrint, 400);
    });

    printWin.webContents.on('did-fail-load', (err) => {
      clearTimeout(timer);
      console.error('Fallo al cargar contenido HTML en ventana de impresión:', err);
      cleanup();
      resolve(false);
    });

    printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent));
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

  const is58mm = printerConfig.anchoPapel === '58mm';
  const bodyWidth = is58mm ? '48mm' : '66mm';
  const bodyPadding = is58mm ? '4px 3px 20px 3px' : '4px 4px 24px 4px';
  const fontSize = is58mm ? '11px' : '12px';
  const qtyWidth = is58mm ? '28px' : '36px';

  let qrBase64 = '';
  try {
    const qrUrl = `https://plazoletas.upickcol.com/qrc/pedido/${orderData.id}`;
    const qrBuffer = qr.imageSync(qrUrl, { type: 'png', size: is58mm ? 3 : 4, margin: 1 });
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
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  @page {
    margin: 0;
  }
  body {
    margin: 0;
    padding: ${bodyPadding};
    width: ${bodyWidth};
    max-width: 100%;
    font-family: 'Courier New', Courier, monospace, sans-serif;
    font-size: ${fontSize};
    line-height: 1.25;
    color: #000 !important;
    background: #fff !important;
    font-weight: 500;
    word-wrap: break-word;
    overflow: visible !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  .center { text-align: center; }
  .right { text-align: right; }
  .title { font-size: ${is58mm ? '15px' : '17px'}; font-weight: 800; line-height: 1.1; margin: 3px 0 2px 0; }
  .subtitle { font-size: ${is58mm ? '11px' : '13px'}; font-weight: 600; margin-bottom: 2px; }
  .badge-role {
    border: 2px dashed #000;
    padding: 2px 5px;
    font-size: ${is58mm ? '11px' : '12px'};
    font-weight: 800;
    margin: 3px auto;
    display: inline-block;
  }
  .reserva-box {
    border: 3px double #000;
    padding: 5px;
    margin: 6px 0;
    text-align: center;
  }
  .reserva-title {
    font-size: ${is58mm ? '11px' : '13px'};
    font-weight: 900;
    letter-spacing: 0.5px;
  }
  .reserva-time {
    font-size: ${is58mm ? '13px' : '15px'};
    font-weight: 900;
    margin-top: 2px;
  }
  .divider {
    border-top: 1px dashed #000;
    margin: 5px 0;
  }
  .table-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px dashed #000;
    border-bottom: 1px dashed #000;
    padding: 3px 0;
    font-weight: 800;
    margin-top: 4px;
    font-size: ${fontSize};
  }
  .table-header-desc {
    flex: 1;
  }
  .table-header-qty {
    min-width: ${qtyWidth};
    text-align: right;
  }
  .item-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-top: 4px;
  }
  .item-desc {
    flex: 1;
    padding-right: 6px;
    font-size: ${fontSize};
    font-weight: 700;
    word-break: break-word;
  }
  .item-qty {
    font-size: ${fontSize};
    white-space: nowrap;
    font-weight: 800;
    min-width: ${qtyWidth};
    text-align: right;
  }
  .item-detail {
    font-size: ${is58mm ? '10px' : '11px'};
    padding-left: 6px;
    color: #222;
    margin-top: 1px;
    word-break: break-word;
  }
  .qr-container {
    text-align: center;
    margin-top: 8px;
  }
  .qr-img {
    width: ${is58mm ? '105px' : '130px'};
    height: ${is58mm ? '105px' : '130px'};
    display: block;
    margin: 4px auto;
  }
</style>
</head>
<body>
  <div class="center">
    <div class="badge-role">${roleTag}</div>
    <div class="title">UPick</div>
    ${nombreRest ? `<div class="subtitle">${nombreRest}</div>` : ''}
    <div style="font-size: ${is58mm ? '13px' : '15px'}; font-weight: 800; margin: 3px 0;">Pedido #${codigoTicket}</div>
    <div>PAGADO</div>
    ${fechaImpresion ? `<div style="font-size: ${is58mm ? '10px' : '12px'}; margin-top: 2px;">${fechaImpresion}</div>` : ''}
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
    <div class="table-header-desc">DESCRIPCION</div>
    <div class="table-header-qty">CANT</div>
  </div>

  ${itemsHtml}

  <div class="divider"></div>
  <div class="right" style="font-size: ${is58mm ? '11px' : '13px'}; font-weight: 900;">Total articulos: ${totalItems}</div>

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
// GENERADOR DE FACTURA FORMAL PARA EL CLIENTE (HTML / SPOOLER WINDOWS)
// -------------------------------------------------------------
function generateCustomerInvoiceHtml(orderData: any, printerConfig: ImpresoraConfig): string {
  const is58mm = printerConfig.anchoPapel === '58mm';
  const bodyWidth = is58mm ? '48mm' : '66mm';
  const bodyPadding = is58mm ? '4px 3px 20px 3px' : '4px 4px 24px 4px';
  const fontSize = is58mm ? '11px' : '12px';
  const qtyWidth = is58mm ? '24px' : '30px';
  const priceWidth = is58mm ? '60px' : '75px';

  const fiscal = getRestauranteFiscalInfo(orderData);
  const cliente = getClienteInvoiceInfo(orderData);
  const totales = getFinancialTotals(orderData);
  const fechaStr = orderData.createdAt ? formatBogotaDate(orderData.createdAt) : '';

  let codigoTicket = 'N/A';
  if (orderData.TransaccionPago?.id) {
    codigoTicket = orderData.TransaccionPago.id.slice(-6).toUpperCase();
  } else if (orderData.id) {
    codigoTicket = orderData.id.slice(-6).toUpperCase();
  }

  let itemsHtml = '';
  let totalItems = 0;

  if (orderData.DetallePedido && orderData.DetallePedido.length > 0) {
    orderData.DetallePedido.forEach((item: any) => {
      const cant = item.cantidad || 1;
      totalItems += cant;
      const desc = item.ProductoMenu?.nombre || 'Producto';
      const unitPrice = Number(item.precioUnitarioCobrado || 0);
      const lineTotal = cant * unitPrice;

      let extrasHtml = '';
      if (item.notas) {
        extrasHtml += `<div class="item-extra">Nota: ${item.notas}</div>`;
      }
      if (item.EleccionAdicional && item.EleccionAdicional.length > 0) {
        item.EleccionAdicional.forEach((eleccion: any) => {
          const precioExtra = Number(eleccion.precioCobrado || 0);
          const precioExtraStr = precioExtra > 0 ? ` (+${formatCOP(precioExtra)})` : '';
          extrasHtml += `<div class="item-extra">+ ${eleccion.nombreOpcion}${precioExtraStr}</div>`;
        });
      }

      itemsHtml += `
        <div class="item-row">
          <div class="item-qty">${cant}</div>
          <div class="item-desc">
            <div>${desc}</div>
            ${extrasHtml}
          </div>
          <div class="item-price">${formatCOP(lineTotal)}</div>
        </div>
      `;
    });
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { margin: 0; }
  body {
    margin: 0;
    padding: ${bodyPadding};
    width: ${bodyWidth};
    max-width: 100%;
    font-family: 'Courier New', Courier, monospace, sans-serif;
    font-size: ${fontSize};
    line-height: 1.25;
    color: #000 !important;
    background: #fff !important;
    font-weight: normal;
    word-wrap: break-word;
    overflow: visible !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  .center { text-align: center; }
  .right { text-align: right; }
  .title { font-size: ${is58mm ? '15px' : '18px'}; font-weight: 800; line-height: 1.1; margin: 2px 0; }
  .brand { font-size: ${is58mm ? '12px' : '14px'}; font-weight: 700; margin-bottom: 2px; }
  .badge-invoice {
    border: 1.5px solid #000;
    padding: 2px 5px;
    font-size: ${is58mm ? '10px' : '12px'};
    font-weight: 700;
    margin: 3px auto;
    display: inline-block;
  }
  .divider { border-top: 1px dashed #000; margin: 5px 0; }
  .fiscal-info { font-size: ${is58mm ? '10px' : '11px'}; margin: 1px 0; line-height: 1.2; font-weight: normal; }
  .client-box { font-size: ${is58mm ? '10px' : '11.5px'}; margin: 4px 0; line-height: 1.25; font-weight: normal; }
  .table-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px dashed #000;
    border-bottom: 1px dashed #000;
    padding: 3px 0;
    font-weight: 700;
    margin-top: 4px;
    font-size: ${fontSize};
  }
  .th-qty { width: ${qtyWidth}; }
  .th-desc { flex: 1; padding: 0 4px; }
  .th-price { width: ${priceWidth}; text-align: right; }
  .item-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-top: 4px;
    font-size: ${fontSize};
    font-weight: normal;
  }
  .item-qty { width: ${qtyWidth}; font-weight: 600; }
  .item-desc { flex: 1; padding: 0 4px; word-break: break-word; font-weight: normal; }
  .item-price { width: ${priceWidth}; text-align: right; font-weight: 600; white-space: nowrap; }
  .item-extra { font-size: ${is58mm ? '9.5px' : '10.5px'}; color: #333; margin-top: 1px; font-weight: normal; }
  .totals-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 2px 0;
    font-size: ${fontSize};
    font-weight: normal;
  }
  .total-highlight {
    font-size: ${is58mm ? '13px' : '15px'};
    font-weight: 800;
    border-top: 1px dashed #000;
    border-bottom: 1px dashed #000;
    padding: 4px 0;
    margin-top: 4px;
  }
  .pay-box {
    border: 1px dashed #000;
    padding: 4px;
    margin: 6px 0;
    font-size: ${is58mm ? '10px' : '11px'};
    text-align: center;
    font-weight: normal;
  }
</style>
</head>
<body>
  <div class="center">
    <div class="badge-invoice">COMPROBANTE DE VENTA</div>
    <div class="brand">${fiscal.nombreComercial}</div>
    ${fiscal.razonSocial ? `<div class="fiscal-info">${fiscal.razonSocial}</div>` : ''}
    ${fiscal.nit ? `<div class="fiscal-info">NIT: ${fiscal.nit}</div>` : ''}
    <div class="fiscal-info">${fiscal.regimen}</div>
    ${fiscal.ubicacionTexto ? `<div class="fiscal-info">${fiscal.ubicacionTexto}</div>` : ''}
    ${fiscal.telefono ? `<div class="fiscal-info">Tel: ${fiscal.telefono}</div>` : ''}
    <div style="font-size: ${is58mm ? '13px' : '15px'}; font-weight: 900; margin-top: 4px;">Pedido UPick #${codigoTicket}</div>
    ${fechaStr ? `<div style="font-size: ${is58mm ? '10px' : '11px'};">${fechaStr}</div>` : ''}
  </div>

  <div class="divider"></div>

  <div class="client-box">
    <div><strong>Cliente:</strong> ${cliente.nombreCliente}</div>
    <div><strong>Doc/NIT:</strong> ${cliente.documentoCliente}</div>
    ${cliente.telefonoCliente ? `<div><strong>Tel:</strong> ${cliente.telefonoCliente}</div>` : ''}
    ${cliente.emailCliente ? `<div><strong>Email:</strong> ${cliente.emailCliente}</div>` : ''}
    ${cliente.tipoPedidoTexto ? `<div style="font-weight: 900; margin-top: 2px;">${cliente.tipoPedidoTexto}</div>` : ''}
  </div>

  <div class="table-header">
    <div class="th-qty">CANT</div>
    <div class="th-desc">DESCRIPCION</div>
    <div class="th-price">TOTAL</div>
  </div>

  ${itemsHtml}

  <div class="divider"></div>

  <div class="totals-row">
    <div>Subtotal Alimentos:</div>
    <div>${formatCOP(totales.subtotal)}</div>
  </div>

  ${totales.descuento > 0 ? `
    <div class="totals-row">
      <div>Descuento ${totales.cuponCodigo ? `(${totales.cuponCodigo})` : ''}:</div>
      <div>-${formatCOP(totales.descuento)}</div>
    </div>
  ` : ''}

  ${totales.feeServicio > 0 ? `
    <div class="totals-row">
      <div>Tarifa Servicio:</div>
      <div>${formatCOP(totales.feeServicio)}</div>
    </div>
  ` : ''}

  ${totales.propina > 0 ? `
    <div class="totals-row">
      <div>Propina Voluntaria:</div>
      <div>${formatCOP(totales.propina)}</div>
    </div>
  ` : ''}

  <div class="totals-row total-highlight">
    <div>TOTAL PAGADO:</div>
    <div>${formatCOP(totales.total)}</div>
  </div>

  <div class="pay-box">
    <div><strong>ESTADO:</strong> PAGADO / APROBADO</div>
    <div><strong>MEDIO:</strong> ${getMedioPagoTexto(orderData)}</div>
    <div>Ref: #${orderData.id ? orderData.id.slice(-8).toUpperCase() : 'UPICK'}</div>
  </div>

  <div class="center" style="font-size: ${is58mm ? '10px' : '11px'}; margin-top: 6px;">
    <div>*** GRACIAS POR SU COMPRA ***</div>
    <div>Conserve este comprobante</div>
    <div style="font-size: 9.5px; margin-top: 2px; color: #333;">Plataforma UPick Plazoletas</div>
  </div>
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
      const timeoutTimer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          console.error(`Timeout (6s) conectando a impresora de red (${ip}:${port})`);
          try { device.close(); } catch (_) {}
          resolve(false);
        }
      }, 6000);

      device.open((error: any) => {
        if (error) {
          clearTimeout(timeoutTimer);
          if (isDone) {
            return;
          }
          isDone = true;
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

          // INICIALIZACIÓN, FUENTE ESTÁNDAR Y ENCABEZADO
          printer
            .hardware('init')
            .font('a')
            .size(0, 0)
            .style('normal');

          if (printer.buffer && typeof printer.buffer.write === 'function') {
            printer.buffer.write('\x1b\x45\x00\x1b\x47\x00\x1b\x21\x00\x1d\x21\x00');
          }

          printer
            .align('ct')
            .style('b')
            .size(0, 0)
            .text(roleTag)
            .text('UPick')
            .style('normal');

          if (nombreRest) {
            printer.size(0, 0).style('normal').text(removeAccents(nombreRest));
          }

          printer
            .size(1, 1)
            .style('b')
            .text('Pedido #' + codigoTicket)
            .size(0, 0)
            .style('normal')
            .text('PAGADO');

          if (fechaImpresion) {
            printer.size(0, 0).style('normal').text(fechaImpresion);
          }

          const is58mm = printerConfig.anchoPapel === '58mm';
          const lineLength = is58mm ? 32 : 42;
          const dividerLine = '-'.repeat(lineLength);
          const reservaDivider = '='.repeat(lineLength);
          const headerLine = 'DESCRIPCION'.padEnd(lineLength - 4) + 'CANT';

          // BANNER DE RESERVA
          if (esReserva) {
            printer
              .align('ct')
              .size(0, 0)
              .style('normal')
              .text(reservaDivider)
              .style('b')
              .text('*** COMANDA DE RESERVA ***')
              .text(`PROGRAMADO PARA: ${fechaProgramadaTexto}`)
              .text(`HORA ENTREGA: ${horaProgramadaTexto}`)
              .style('normal')
              .text(reservaDivider);
          }

          printer
            .align('ct')
            .size(0, 0)
            .style('normal')
            .text(dividerLine)
            .align('lt');

          if (tipoPedidoTexto) {
            printer.size(0, 0).style('b').text(tipoPedidoTexto).style('normal');
          }

          printer.size(0, 0).style('normal').text(`Cliente: ${transaccionInfo}`);

          if (telefonoCliente) {
            printer.size(0, 0).style('normal').text(telefonoCliente);
          }

          printer
            .align('ct')
            .size(0, 0)
            .style('normal')
            .text(dividerLine)
            .align('lt')
            .style('b')
            .text(headerLine)
            .style('normal')
            .align('ct')
            .text(dividerLine)
            .align('lt');

          let totalItems = 0;
          if (orderData.DetallePedido && orderData.DetallePedido.length > 0) {
            orderData.DetallePedido.forEach((item: any) => {
              const cantNum = item.cantidad || 1;
              totalItems += cantNum;
              
              const desc = removeAccents(item.ProductoMenu?.nombre || 'Producto');
              const cant = cantNum.toString();
              
              printer.size(0, 0).style('b');
              const formattedLines = formatItemRow(desc, cant, lineLength);
              formattedLines.forEach(line => printer.text(line));
              printer.style('normal');

              if (item.notas) {
                printer.size(0, 0).style('normal').text(`   Nota: ${removeAccents(item.notas)}`);
              }

              if (item.EleccionAdicional && item.EleccionAdicional.length > 0) {
                item.EleccionAdicional.forEach((eleccion: any) => {
                  printer.size(0, 0).style('normal').text(`   - ${removeAccents(eleccion.nombreOpcion)}`);
                });
              }
            });
          }

          printer
            .feed(1)
            .align('rt')
            .size(0, 0)
            .style('b')
            .text(`Total articulos: ${totalItems}`)
            .style('normal')
            .align('ct')
            .text(dividerLine)
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
              .size(0, 0)
              .style('normal')
              .text('Escanea este QR para')
              .text('marcar el pedido como LISTO.')
              .feed(3)
              .cut();

            isDone = true;
            clearTimeout(timeoutTimer);
            printer.close((closeErr: any) => {
              if (closeErr) console.error('Error al cerrar la impresora:', closeErr);
              resolve(true);
            });
          });
        } catch (printError) {
          clearTimeout(timeoutTimer);
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
// IMPRESIÓN DE FACTURA FORMAL POR RED (TCP RAW SOCKET ESC/POS)
// -------------------------------------------------------------
async function printCustomerInvoiceViaNetworkEscpos(orderData: any, printerConfig: ImpresoraConfig): Promise<boolean> {
  const ip = printerConfig.ip;
  const port = printerConfig.port || 9100;

  if (!ip) {
    console.error(`[${printerConfig.nombre}] No hay IP configurada para impresión de factura en red.`);
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

      const options = { encoding: "GB18030" };
      const printer = new escpos.Printer(device, options);

      let isDone = false;
      const timeoutTimer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          console.error(`Timeout (6s) imprimiendo factura de red (${ip}:${port})`);
          try { device.close(); } catch (_) {}
          resolve(false);
        }
      }, 6000);

      device.open((error: any) => {
        if (error) {
          clearTimeout(timeoutTimer);
          if (isDone) return;
          isDone = true;
          console.error(`Error conectando a impresora para factura (${ip}:${port}):`, error);
          resolve(false);
          return;
        }

        try {
          const fiscal = getRestauranteFiscalInfo(orderData);
          const cliente = getClienteInvoiceInfo(orderData);
          const totales = getFinancialTotals(orderData);
          const fechaStr = orderData.createdAt ? formatBogotaDate(orderData.createdAt) : '';

          let codigoTicket = 'N/A';
          if (orderData.TransaccionPago?.id) {
            codigoTicket = orderData.TransaccionPago.id.slice(-6).toUpperCase();
          } else if (orderData.id) {
            codigoTicket = orderData.id.slice(-6).toUpperCase();
          }

          const is58mm = printerConfig.anchoPapel === '58mm';
          const lineLength = is58mm ? 32 : 42;
          const dividerLine = '-'.repeat(lineLength);
          const doubleDivider = '='.repeat(lineLength);

          // 1. INICIALIZACIÓN Y ENCABEZADO FISCAL (FUENTE ESTÁNDAR 'A', TAMAÑO NORMAL)
          printer
            .hardware('init')
            .font('a')
            .size(0, 0)
            .style('normal');

          if (printer.buffer && typeof printer.buffer.write === 'function') {
            printer.buffer.write('\x1b\x45\x00\x1b\x47\x00\x1b\x21\x00\x1d\x21\x00');
          }

          printer
            .align('ct')
            .style('b')
            .size(0, 0)
            .text('COMPROBANTE DE VENTA')
            .size(1, 1)
            .text('UPick')
            .size(0, 0)
            .text(removeAccents(fiscal.nombreComercial))
            .style('normal');

          if (fiscal.razonSocial) {
            printer.text(removeAccents(fiscal.razonSocial));
          }
          if (fiscal.nit) {
            printer.text(`NIT: ${removeAccents(fiscal.nit)}`);
          }
          if (fiscal.regimen) {
            printer.text(removeAccents(fiscal.regimen));
          }
          if (fiscal.ubicacionTexto) {
            printer.text(removeAccents(fiscal.ubicacionTexto));
          }
          if (fiscal.telefono) {
            printer.text(`Tel: ${removeAccents(fiscal.telefono)}`);
          }

          printer
            .style('b')
            .text(`Pedido UPick #${codigoTicket}`)
            .style('normal');

          if (fechaStr) {
            printer.text(fechaStr);
          }

          // 2. DATOS DEL CLIENTE (TEXTO NORMAL)
          printer
            .align('ct')
            .text(dividerLine)
            .align('lt')
            .style('normal')
            .text(`Cliente: ${removeAccents(cliente.nombreCliente)}`)
            .text(`Doc/NIT: ${removeAccents(cliente.documentoCliente)}`);

          if (cliente.telefonoCliente) {
            printer.text(removeAccents(cliente.telefonoCliente));
          }
          if (cliente.emailCliente) {
            printer.text(removeAccents(cliente.emailCliente));
          }
          if (cliente.tipoPedidoTexto) {
            printer.style('b').text(removeAccents(cliente.tipoPedidoTexto)).style('normal');
          }

          // 3. TABLA DE ÍTEMS Y PRECIOS
          printer
            .align('ct')
            .text(dividerLine)
            .align('lt')
            .style('b');

          const headerDesc = 'CANT / DESCRIPCION';
          const headerPrice = 'TOTAL';
          const spacesH = lineLength - headerDesc.length - headerPrice.length;
          printer.text(headerDesc + ' '.repeat(Math.max(0, spacesH)) + headerPrice);

          printer
            .style('normal')
            .align('ct')
            .text(dividerLine)
            .align('lt');

          if (orderData.DetallePedido && orderData.DetallePedido.length > 0) {
            orderData.DetallePedido.forEach((item: any) => {
              const cantNum = item.cantidad || 1;
              const desc = removeAccents(item.ProductoMenu?.nombre || 'Producto');
              const unitPrice = Number(item.precioUnitarioCobrado || 0);
              const lineTotal = cantNum * unitPrice;

              printer.style('normal');
              const itemRows = formatPriceRow(`${cantNum}x ${desc}`, formatCOP(lineTotal), lineLength);
              itemRows.forEach(row => printer.text(row));

              if (item.notas) {
                printer.text(`   Nota: ${removeAccents(item.notas)}`);
              }

              if (item.EleccionAdicional && item.EleccionAdicional.length > 0) {
                item.EleccionAdicional.forEach((eleccion: any) => {
                  const pExtra = Number(eleccion.precioCobrado || 0);
                  const extraPriceStr = pExtra > 0 ? ` (+${formatCOP(pExtra)})` : '';
                  printer.text(`   + ${removeAccents(eleccion.nombreOpcion)}${extraPriceStr}`);
                });
              }
            });
          }

          // 4. TOTALES FINANCIEROS
          printer
            .align('ct')
            .text(dividerLine)
            .align('lt')
            .style('normal');

          const subtotalRows = formatPriceRow('Subtotal Alimentos:', formatCOP(totales.subtotal), lineLength);
          subtotalRows.forEach(row => printer.text(row));

          if (totales.descuento > 0) {
            const descLabel = `Descuento ${totales.cuponCodigo ? `(${totales.cuponCodigo})` : ''}:`;
            const descRows = formatPriceRow(descLabel, `-${formatCOP(totales.descuento)}`, lineLength);
            descRows.forEach(row => printer.text(row));
          }

          if (totales.feeServicio > 0) {
            const feeRows = formatPriceRow('Tarifa Servicio:', formatCOP(totales.feeServicio), lineLength);
            feeRows.forEach(row => printer.text(row));
          }

          if (totales.propina > 0) {
            const tipRows = formatPriceRow('Propina Voluntaria:', formatCOP(totales.propina), lineLength);
            tipRows.forEach(row => printer.text(row));
          }

          printer
            .align('ct')
            .text(doubleDivider)
            .align('lt')
            .style('b');

          const totalRows = formatPriceRow('TOTAL PAGADO:', formatCOP(totales.total), lineLength);
          totalRows.forEach(row => printer.text(row));

          printer
            .style('normal')
            .align('ct')
            .text(doubleDivider)
            .text('ESTADO: PAGADO / APROBADO')
            .text(`MEDIO: ${getMedioPagoTexto(orderData)}`)
            .text(`Ref: #${orderData.id ? orderData.id.slice(-8).toUpperCase() : 'UPICK'}`)
            .feed(1)
            .text('*** GRACIAS POR SU COMPRA ***')
            .text('Conserve este comprobante')
            .text('Plataforma UPick Plazoletas')
            .feed(3)
            .cut();

          isDone = true;
          clearTimeout(timeoutTimer);
          printer.close((closeErr: any) => {
            if (closeErr) console.error('Error al cerrar la impresora tras factura:', closeErr);
            resolve(true);
          });
        } catch (printError) {
          clearTimeout(timeoutTimer);
          console.error('Error en comandos de factura ESC/POS:', printError);
          device.close();
          resolve(false);
        }
      });
    } catch (err) {
      console.error('Error crítico en socket de red para factura:', err);
      resolve(false);
    }
  });
}

// -------------------------------------------------------------
// COLA SECUENCIAL POR IMPRESORA (MUTEX ANTI-BLOQUEO)
// -------------------------------------------------------------
// Las impresoras térmicas solo admiten 1 conexión socket/driver a la vez.
// Esta cola asegura que las órdenes a un mismo dispositivo se procesen
// una después de otra, dejando tiempo para corte de papel y liberación de socket.
const printerQueues = new Map<string, Promise<any>>();

async function enqueuePrintJob<T>(printerKey: string, job: () => Promise<T>): Promise<T> {
  const previousJob = printerQueues.get(printerKey) || Promise.resolve();

  let finishCurrentJob: () => void;
  const currentJobPromise = new Promise<void>((resolve) => {
    finishCurrentJob = resolve;
  });

  printerQueues.set(printerKey, previousJob.catch(() => {}).then(() => currentJobPromise));

  await previousJob.catch(() => {});

  try {
    const result = await job();
    // Pausa técnica (400ms) para que el firmware de la impresora complete el corte y libere buffers
    await new Promise((r) => setTimeout(r, 400));
    return result;
  } finally {
    finishCurrentJob!();
    if (printerQueues.get(printerKey) === currentJobPromise) {
      printerQueues.delete(printerKey);
    }
  }
}

// -------------------------------------------------------------
// IMPRIMIR PEDIDO EN UNA IMPRESORA INDIVIDUAL
// -------------------------------------------------------------
async function printSingleOrder(orderData: any, printerConfig: ImpresoraConfig): Promise<boolean> {
  const printerKey = printerConfig.tipoConexion === 'windows_usb'
    ? `usb:${printerConfig.deviceName || 'default'}`
    : `net:${printerConfig.ip}:${printerConfig.port || 9100}`;

  return await enqueuePrintJob(printerKey, async () => {
    const rol = printerConfig.rolCopia || 'AMBOS';
    let overallSuccess = true;

    if (printerConfig.tipoConexion === 'windows_usb') {
      if (!printerConfig.deviceName) {
        console.error(`[${printerConfig.nombre}] No tiene dispositivo de Windows seleccionado.`);
        return false;
      }

      // 1. Si el rol es COCINA o AMBOS -> Imprimir comanda de cocina
      if (rol === 'COCINA' || rol === 'AMBOS') {
        console.log(`[${printerConfig.nombre}] Imprimiendo COMANDA DE COCINA (USB)...`);
        const htmlComanda = generateReceiptHtml(orderData, printerConfig);
        const okComanda = await printViaWindowsSpooler(printerConfig.deviceName, htmlComanda);
        if (!okComanda) overallSuccess = false;
      }

      // Pausa técnica entre documentos si se imprimen ambos en la misma máquina
      if (rol === 'AMBOS') {
        await new Promise((r) => setTimeout(r, 600));
      }

      // 2. Si el rol es CAJA o AMBOS -> Imprimir factura de cliente
      if (rol === 'CAJA' || rol === 'AMBOS') {
        console.log(`[${printerConfig.nombre}] Imprimiendo FACTURA DE CLIENTE (USB)...`);
        const htmlFactura = generateCustomerInvoiceHtml(orderData, printerConfig);
        const okFactura = await printViaWindowsSpooler(printerConfig.deviceName, htmlFactura);
        if (!okFactura) overallSuccess = false;
      }

      return overallSuccess;
    } else {
      // Impresión por Red TCP ESC/POS
      if (rol === 'COCINA' || rol === 'AMBOS') {
        console.log(`[${printerConfig.nombre}] Imprimiendo COMANDA DE COCINA (RED)...`);
        const okComanda = await printViaNetworkEscpos(orderData, printerConfig);
        if (!okComanda) overallSuccess = false;
      }

      if (rol === 'AMBOS') {
        await new Promise((r) => setTimeout(r, 600));
      }

      if (rol === 'CAJA' || rol === 'AMBOS') {
        console.log(`[${printerConfig.nombre}] Imprimiendo FACTURA DE CLIENTE (RED)...`);
        const okFactura = await printCustomerInvoiceViaNetworkEscpos(orderData, printerConfig);
        if (!okFactura) overallSuccess = false;
      }

      return overallSuccess;
    }
  });
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
    transaccionInfo = removeAccents(tx.nombreCliente || 'Cliente');
    telefonoCliente = tx.telefonoCliente ? `Tel: ${tx.telefonoCliente}` : '';
    codigoTicket = tx.id ? tx.id.slice(-6).toUpperCase() : 'N/A';

    if (tx.tipoPedido === 'ENTREGA_MESA') {
      tipoPedidoTexto = removeAccents(`ENTREGAR EN: ${tx.ubicacionEntregaTexto || 'Ubicacion no especificada'}`);
    } else if (tx.tipoPedido === 'RECOGIDA') {
      tipoPedidoTexto = 'PARA RECOGER';
    }
  }

  const { esReserva, fechaProgramadaTexto, horaProgramadaTexto } = getReservaInfo(orderData);
  const nombreRest = removeAccents(orderData.Restaurante?.nombreSucursal || 'Restaurante');
  const fechaStr = orderData.createdAt ? formatBogotaDate(orderData.createdAt) : new Date().toLocaleString('es-CO');

  const width = 58;
  const border = '+' + '-'.repeat(width) + '+';
  const separator = '|' + '='.repeat(width) + '|';
  const subSep = '|' + '-'.repeat(width) + '|';

  const formatLine = (text: string) => {
    const cleanText = removeAccents(text);
    const content = ' ' + cleanText;
    if (content.length > width) {
      return '|' + content.slice(0, width) + '|';
    }
    return '|' + content.padEnd(width) + '|';
  };

  const centerLine = (text: string) => {
    const cleanText = removeAccents(text);
    const totalPad = width - cleanText.length;
    if (totalPad <= 0) return '|' + cleanText.slice(0, width) + '|';
    const leftPad = Math.floor(totalPad / 2);
    const rightPad = totalPad - leftPad;
    return '|' + ' '.repeat(leftPad) + cleanText + ' '.repeat(rightPad) + '|';
  };

  const lines: string[] = [];
  lines.push('');
  lines.push(border);
  if (motivo) {
    lines.push(centerLine(`[AVISO] ${motivo}`));
    lines.push(separator);
  } else {
    lines.push(centerLine('DETALLE DE COMANDA (TERMINAL)'));
    lines.push(separator);
  }
  lines.push(formatLine(`UPick - ${nombreRest}`));
  lines.push(formatLine(`Pedido #${codigoTicket} | PAGADO | ${fechaStr}`));

  if (esReserva) {
    lines.push(subSep);
    lines.push(centerLine('*** COMANDA DE RESERVA ***'));
    lines.push(formatLine(`PROGRAMADO: ${fechaProgramadaTexto} | HORA: ${horaProgramadaTexto}`));
    lines.push(subSep);
  }

  lines.push(formatLine(`Cliente: ${transaccionInfo} ${telefonoCliente}`.trim()));
  if (tipoPedidoTexto) {
    lines.push(formatLine(`Tipo: ${tipoPedidoTexto}`));
  }

  lines.push(separator);
  lines.push(formatLine('ITEMS DEL PEDIDO:'));

  let totalItems = 0;
  if (orderData.DetallePedido && orderData.DetallePedido.length > 0) {
    orderData.DetallePedido.forEach((item: any) => {
      const cant = item.cantidad || 1;
      totalItems += cant;
      const desc = item.ProductoMenu?.nombre || 'Producto';
      lines.push(formatLine(`  * ${cant}x ${desc}`));
      if (item.notas) {
        lines.push(formatLine(`     Nota: ${item.notas}`));
      }
      if (item.EleccionAdicional && item.EleccionAdicional.length > 0) {
        item.EleccionAdicional.forEach((el: any) => {
          lines.push(formatLine(`     + ${el.nombreOpcion}`));
        });
      }
    });
  } else {
    lines.push(formatLine('  (Sin articulos registrados)'));
  }

  lines.push(separator);
  lines.push(formatLine(`Total articulos: ${totalItems}`));
  lines.push(formatLine(`QR URL: https://plazoletas.upickcol.com/qrc/pedido/${orderData.id}`));
  lines.push(border);

  // -----------------------------------------------------------
  // VISTA PREVIA DE FACTURA FORMAL PARA CLIENTE
  // -----------------------------------------------------------
  const fiscal = getRestauranteFiscalInfo(orderData);
  const cliente = getClienteInvoiceInfo(orderData);
  const totales = getFinancialTotals(orderData);

  lines.push('');
  lines.push(border);
  lines.push(centerLine('COMPROBANTE / FACTURA CLIENTE (TERMINAL)'));
  lines.push(separator);
  lines.push(formatLine(`UPick - ${fiscal.nombreComercial}`));
  if (fiscal.razonSocial) lines.push(formatLine(`Razon Social: ${fiscal.razonSocial}`));
  if (fiscal.nit) lines.push(formatLine(`NIT: ${fiscal.nit}`));
  if (fiscal.regimen) lines.push(formatLine(`Regimen: ${fiscal.regimen}`));
  if (fiscal.ubicacionTexto) lines.push(formatLine(`Ubicacion: ${fiscal.ubicacionTexto}`));
  lines.push(formatLine(`Pedido #${codigoTicket} | ${fechaStr}`));
  lines.push(subSep);
  lines.push(formatLine(`Cliente: ${cliente.nombreCliente}`));
  lines.push(formatLine(`Doc/NIT: ${cliente.documentoCliente}`));
  if (cliente.telefonoCliente) lines.push(formatLine(cliente.telefonoCliente));
  if (cliente.emailCliente) lines.push(formatLine(`Email: ${cliente.emailCliente}`));
  if (cliente.tipoPedidoTexto) lines.push(formatLine(cliente.tipoPedidoTexto));
  lines.push(separator);
  lines.push(formatLine('DETALLE DE PRODUCTOS:'));

  if (orderData.DetallePedido && orderData.DetallePedido.length > 0) {
    orderData.DetallePedido.forEach((item: any) => {
      const cant = item.cantidad || 1;
      const desc = item.ProductoMenu?.nombre || 'Producto';
      const unitPrice = Number(item.precioUnitarioCobrado || 0);
      const lineTotal = cant * unitPrice;
      lines.push(formatLine(`  * ${cant}x ${desc} -> ${formatCOP(lineTotal)}`));
      if (item.EleccionAdicional && item.EleccionAdicional.length > 0) {
        item.EleccionAdicional.forEach((el: any) => {
          const pExtra = Number(el.precioCobrado || 0);
          const extraStr = pExtra > 0 ? ` (+${formatCOP(pExtra)})` : '';
          lines.push(formatLine(`     + ${el.nombreOpcion}${extraStr}`));
        });
      }
    });
  }

  lines.push(subSep);
  lines.push(formatLine(`Subtotal Alimentos: ${formatCOP(totales.subtotal)}`));
  if (totales.descuento > 0) {
    lines.push(formatLine(`Descuento ${totales.cuponCodigo ? `(${totales.cuponCodigo})` : ''}: -${formatCOP(totales.descuento)}`));
  }
  if (totales.feeServicio > 0) {
    lines.push(formatLine(`Tarifa Servicio: ${formatCOP(totales.feeServicio)}`));
  }
  if (totales.propina > 0) {
    lines.push(formatLine(`Propina Voluntaria: ${formatCOP(totales.propina)}`));
  }
  lines.push(separator);
  lines.push(formatLine(`TOTAL PAGADO: ${formatCOP(totales.total)}`));
  lines.push(formatLine('ESTADO: PAGADO / APROBADO'));
  lines.push(formatLine(`MEDIO: ${getMedioPagoTexto(orderData)}`));
  lines.push(border);
  lines.push('');

  console.log(lines.join('\n'));
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
  const printerKey = tipo === 'windows_usb'
    ? `usb:${config.deviceName || 'test'}`
    : `net:${config.ip || config.printerIp}:${config.port || config.printerPort || 9100}`;

  return await enqueuePrintJob(printerKey, async () => {
    if (tipo === 'windows_usb') {
      const deviceName = config.deviceName;
      if (!deviceName) {
        console.error('No se seleccionó una impresora de Windows para la prueba.');
        return false;
      }

      const is58mm = config.anchoPapel === '58mm';
      const bodyWidth = is58mm ? '48mm' : '66mm';
      const rolDesc = config.rolCopia === 'COCINA' 
        ? 'Solo Cocina (Comanda)' 
        : (config.rolCopia === 'CAJA' ? 'Solo Caja (Factura Cliente)' : 'Ambos (Comanda + Factura)');

      const testHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  @page {
    margin: 0;
  }
  body {
    font-family: 'Courier New', Courier, monospace;
    text-align: center;
    padding: 10px 4px 18px 4px;
    width: ${bodyWidth};
    max-width: 100%;
    font-size: ${is58mm ? '11px' : '12px'};
    color: #000 !important;
    background: #fff !important;
    word-wrap: break-word;
    overflow: visible !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  h2 { font-size: ${is58mm ? '14px' : '16px'}; margin: 0 0 6px 0; }
  p { font-size: ${is58mm ? '11px' : '12px'}; margin: 3px 0; }
</style>
</head>
<body>
  <h2>PRUEBA DE CONEXION</h2>
  <p><strong>UPick Printer Plazoletas</strong></p>
  <p>Impresora: ${config.nombre || deviceName}</p>
  <p>Dispositivo: ${deviceName}</p>
  <p>Rol: ${rolDesc}</p>
  <p>Papel: ${is58mm ? '58 mm (Mini)' : '80 mm (Estándar)'}</p>
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

      const rolDesc = config.rolCopia === 'COCINA' 
        ? 'Solo Cocina (Comanda)' 
        : (config.rolCopia === 'CAJA' ? 'Solo Caja (Factura Cliente)' : 'Ambos (Comanda + Factura)');

      return new Promise<boolean>((resolve) => {
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

          let isDone = false;
          const timeoutTimer = setTimeout(() => {
            if (!isDone) {
              isDone = true;
              console.error(`Timeout (5s) en prueba de impresora de red (${ip}:${port})`);
              try { device.close(); } catch (_) {}
              resolve(false);
            }
          }, 5000);

          device.open((error: any) => {
            if (error) {
              clearTimeout(timeoutTimer);
              if (isDone) return;
              isDone = true;
              console.error(`Error conectando para prueba de red (${ip}:${port}):`, error);
              resolve(false);
              return;
            }

            try {
              printer
                .hardware('init')
                .font('a')
                .size(0, 0)
                .align('ct')
                .style('b')
                .text('Prueba de Conexion Exitosa')
                .style('normal')
                .text('UPick Printer Plazoletas')
                .text(`Impresora: ${config.nombre || 'Red'}`)
                .text(`IP: ${ip}:${port}`)
                .text(`Rol: ${rolDesc}`)
                .feed(3)
                .cut()
                .close(() => {
                  clearTimeout(timeoutTimer);
                  isDone = true;
                  resolve(true);
                });
            } catch (e) {
              clearTimeout(timeoutTimer);
              resolve(false);
            }
          });
        } catch (err) {
          resolve(false);
        }
      });
    }
  });
}
