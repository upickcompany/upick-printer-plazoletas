import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const escpos = require('escpos');
const Network = require('escpos-network');
const USB = require('escpos-usb');
import { store } from './store';
import { parseColombianDate } from './timeUtils';

// We need to polyfill some things for escpos if needed, but usually it works fine in Node
// We attach the network and usb adapters to escpos
escpos.Network = Network;
escpos.USB = USB;

function removeAccents(str: string): string {
  if (!str) return '';
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function formatBogotaDate(dateStr: string): string {
  if (!dateStr) return '';
  let str = dateStr;
  // Solo agregar Z si no termina en Z, ni en un offset como -05:00 o +00:00
  if (!str.match(/(Z|[+-]\d{2}:?\d{2})$/)) {
    str += 'Z';
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) return dateStr;
  
  // Restamos 5 horas al tiempo UTC para forzar hora Colombia siempre
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
  
  // Primera línea con cantidad
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
  
  // Resto de líneas si el texto es muy largo
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

export async function printOrder(orderData: any): Promise<boolean> {
  const connectionType = store.get('connectionType') || 'network';
  const printerIp = store.get('printerIp');
  const printerPort = store.get('printerPort') || 9100;
  const printerVid = store.get('printerVid');
  const printerPid = store.get('printerPid');

  let transaccionInfo = 'Cliente no identificado';
  let codigoTicket = 'N/A';
  let tipoPedidoTexto = '';

  if (orderData.TransaccionPago) {
    const tx = orderData.TransaccionPago;
    transaccionInfo = tx.nombreCliente || tx.telefonoCliente || 'Cliente';
    codigoTicket = tx.id ? tx.id.slice(-6).toUpperCase() : 'N/A';

    if (tx.tipoPedido === 'ENTREGA_MESA') {
      tipoPedidoTexto = `ENTREGAR EN: ${tx.ubicacionEntregaTexto || 'Ubicación no especificada'}`;
    } else if (tx.tipoPedido === 'RECOGIDA') {
      tipoPedidoTexto = 'PARA RECOGER';
    }
  }

  console.log('\n======================================');
  console.log('         NUEVA COMANDA (MOCK)         ');
  console.log('======================================');
  console.log('UPick');
  console.log('Pedido #' + codigoTicket);
  console.log('PAGADO');
  console.log('--------------------------------------');
  console.log(`Cliente: ${transaccionInfo}`);

  if (tipoPedidoTexto) {
    console.log(tipoPedidoTexto);
  }

  console.log('--------------------------------------');

  if (orderData.DetallePedido && orderData.DetallePedido.length > 0) {
    orderData.DetallePedido.forEach((item: any) => {
      console.log(`${item.cantidad}x ${item.ProductoMenu?.nombre || 'Producto'}`);
      if (item.notas) {
        console.log(`   Nota: ${item.notas}`);
      }
      if (item.EleccionAdicional && item.EleccionAdicional.length > 0) {
        item.EleccionAdicional.forEach((eleccion: any) => {
          console.log(`   + ${eleccion.nombreOpcion}`);
        });
      }
    });
  }

  console.log('--------------------------------------');
  console.log('Gracias por usar UPick!');
  console.log('Para el restaurante:');
  console.log(`[QR: https://plazoletas.upickcol.com/qrc/pedido/${orderData.id}]`);
  console.log('======================================\n');

  // --- LÓGICA DE IMPRESIÓN REAL ---
  if (connectionType === 'network' && !printerIp) {
    console.error('No printer IP configured');
    return false;
  }

  return new Promise((resolve, reject) => {
    try {
      let device: any;
      if (connectionType === 'usb') {
        if (printerVid && printerPid) {
          device = new escpos.USB(printerVid, printerPid);
        } else {
          device = new escpos.USB();
        }
      } else {
        device = new escpos.Network(printerIp, printerPort);

        // Patch para evitar que la impresora se bloquee en Red
        // Usamos .end() para cerrar la conexión TCP correctamente en lugar de .destroy() brusco
        device.close = function (cb: any) {
          if (this.device) {
            this.device.end(); // Cierre ordenado (envía FIN)
            setTimeout(() => {
              if (this.device) {
                this.device.destroy();
                this.device = null;
              }
              if (cb) cb(null, this.device);
            }, 500); // Dar un poco de tiempo para asegurar que se enviaron los datos
          } else {
            if (cb) cb(null, this.device);
          }
          return this;
        };
      }

      const options = { encoding: "GB18030" /* default */ };
      const printer = new escpos.Printer(device, options);

      let isDone = false;
      device.open((error: any) => {
        if (error) {
          if (isDone) {
            console.warn('Conexión cerrada por la impresora (ignorado por estar terminando):', error.message);
            return;
          }
          console.error('Error connecting to printer:', error);
          reject(error);
          return;
        }

        try {
          let fechaImpresion = '';
          if (orderData.createdAt) {
            fechaImpresion = formatBogotaDate(orderData.createdAt);
          }

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

          // FORMATTING THE RECEIPT
          const nombreRest = orderData.Restaurante?.nombreSucursal;

          printer
            .font('b')
            .align('ct')
            .style('b')
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
            .align('lt');

          // ITEMS HEADER
          printer.text('DESCRIPCION                 CANT');
          printer.text('--------------------------------');

          let totalItems = 0;
          if (orderData.DetallePedido && orderData.DetallePedido.length > 0) {
            orderData.DetallePedido.forEach((item: any) => {
              totalItems += (item.cantidad || 1);
              
              const desc = removeAccents(item.ProductoMenu?.nombre || 'Producto');
              const cant = (item.cantidad || 1).toString();
              
              const formattedLines = formatItemRow(desc, cant);
              formattedLines.forEach(line => printer.text(line));

              // Notas del item
              if (item.notas) {
                printer.text(`   Nota: ${removeAccents(item.notas)}`);
              }

              // Adiciones
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
            .feed(1); // Espacio extra antes del QR

          const qrUrl = `https://plazoletas.upickcol.com/qrc/pedido/${orderData.id}`;

          printer.qrimage(qrUrl, { type: 'png', mode: 'normal', size: 5, margin: 2, ec_level: 'M' }, (err: any) => {
            if (err) {
              console.error('Error generando qrimage:', err);
            }
            printer
              .feed(1) // Espacio extra después del QR
              .text('Escanea este QR para')
              .text('marcar el pedido como LISTO.')
              .feed(3) // Avanzamos 3 líneas para que no corte el texto
              .cut();

            isDone = true;
            printer.close((closeErr: any) => {
              if (closeErr) console.error('Error al cerrar la impresora:', closeErr);
              resolve(true);
            });
          });
        } catch (printError) {
          console.error('Error during printing commands:', printError);
          device.close();
          reject(printError);
        }
      });
    } catch (err) {
      console.error('Critical printer error:', err);
      reject(err);
    }
  });
}

export async function testPrinter(config: any): Promise<boolean> {
  return new Promise((resolve, reject) => {
    try {
      let device: any;
      if (config.connectionType === 'usb') {
        if (config.vid && config.pid) {
          device = new escpos.USB(config.vid, config.pid);
        } else {
          device = new escpos.USB();
        }
      } else {
        device = new escpos.Network(config.ip, config.port || 9100);

        // Patch para el test también
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
      }

      const printer = new escpos.Printer(device);

      device.open((error: any) => {
        if (error) {
          console.error('Error testing printer connection:', error);
          resolve(false);
          return;
        }

        try {
          printer
            .align('ct')
            .text('Prueba de Conexión Exitosa')
            .text('UPick Printer Plazoletas')
            .feed(3)
            .cut()
            .close((err: any) => {
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
