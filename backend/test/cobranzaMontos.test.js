// Montos de la cobranza (038): division del traslado, neto, ingreso del equipo con y sin neto y con nota de
// credito, y la fila de la lista de emitidas. Puras, con datos ficticios.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
    validarTraslado, validarNeto, dividirTraslado, validarDivision, resolverTraslado, ingresoSinTraslado,
} = require('../src/utils/trasladoFactura');
const { ingresoFactura, calcularIngreso, calcularRentabilidad } = require('../src/utils/rentabilidad');
const { armarFilaEmitida } = require('../src/utils/facturasEmitidas');
const { armarLineaTiempo } = require('../src/utils/lineaTiempoEquipo');

describe('dividirTraslado', () => {
    test('entrega y retiro: mitades; impar con el peso de mas en entrega', () => {
        assert.deepEqual(dividirTraslado(140000, 'entrega_y_retiro'), { entrega: 70000, retiro: 70000 });
        assert.deepEqual(dividirTraslado(35001, 'entrega_y_retiro'), { entrega: 17501, retiro: 17500 });
        assert.deepEqual(dividirTraslado(1, 'entrega_y_retiro'), { entrega: 1, retiro: 0 });
    });
    test('solo entrega, solo retiro y sin detalle', () => {
        assert.deepEqual(dividirTraslado(5000, 'entrega'), { entrega: 5000, retiro: 0 });
        assert.deepEqual(dividirTraslado(5000, 'retiro'), { entrega: 0, retiro: 5000 });
        assert.equal(dividirTraslado(5000, 'sin_detalle'), null);
        assert.equal(dividirTraslado(-1, 'entrega'), null);
        assert.equal(dividirTraslado('abc', 'entrega'), null);
    });
});

describe('validarDivision y resolverTraslado', () => {
    test('sin partes: sin division', () => {
        assert.deepEqual(validarDivision(1000, null, ''), { entrega: null, retiro: null });
    });
    test('la suma debe cuadrar con el total', () => {
        assert.deepEqual(validarDivision(1000, 600, 400), { entrega: 600, retiro: 400 });
        assert.match(validarDivision(1000, 600, 300).error, /igual al traslado total/);
        assert.deepEqual(validarDivision(null, 600, ''), { entrega: 600, retiro: 0 });
        assert.ok(validarDivision(null, '1.5', 0).error);
        assert.ok(validarDivision(null, 0, -5).error);
        assert.deepEqual(validarDivision(0, 0, 0), { entrega: null, retiro: null });
    });
    test('partes sin total: el total es su suma', () => {
        assert.deepEqual(resolverTraslado({ monto: 249900, monto_traslado: '', traslado_entrega: '70000', traslado_retiro: '70000' }),
            { traslado: 140000, entrega: 70000, retiro: 70000 });
    });
    test('los tres: deben cuadrar', () => {
        assert.deepEqual(resolverTraslado({ monto: 249900, monto_traslado: 140000, traslado_entrega: 70000, traslado_retiro: 70000 }),
            { traslado: 140000, entrega: 70000, retiro: 70000 });
        assert.ok(resolverTraslado({ monto: 249900, monto_traslado: 140000, traslado_entrega: 70000, traslado_retiro: 60000 }).error);
    });
    test('solo el total (panel anterior): igual que antes y sin division', () => {
        assert.deepEqual(resolverTraslado({ monto: 249900, monto_traslado: '140000' }), { traslado: 140000, entrega: null, retiro: null });
        assert.deepEqual(resolverTraslado({ monto: 249900 }), { traslado: 0, entrega: null, retiro: null });
        assert.ok(resolverTraslado({ monto: 1000, monto_traslado: 2000 }).error);
    });
    test('traslado mayor que el neto se rechaza; sin neto rige solo el total', () => {
        assert.match(resolverTraslado({ monto: 249900, neto: 100000, traslado_entrega: 70000, traslado_retiro: 70000 }).error, /neto/);
        assert.match(validarTraslado(249900, 140000, 100000).error, /neto/);
        assert.deepEqual(validarTraslado(249900, 140000, 210000), { traslado: 140000 });
        assert.deepEqual(validarTraslado(249900, 140000), { traslado: 140000 });
        assert.deepEqual(validarTraslado(249900, 140000, null), { traslado: 140000 });
    });
});

describe('validarNeto', () => {
    test('entero y no mayor que el total', () => {
        assert.deepEqual(validarNeto(249900, '210000'), { neto: 210000 });
        assert.deepEqual(validarNeto(249900, ''), { neto: null });
        assert.deepEqual(validarNeto(null, 5000), { neto: 5000 });
        assert.match(validarNeto(1000, 2000).error, /mayor que el monto total/);
        assert.ok(validarNeto(1000, '1.000').error);
        assert.ok(validarNeto(1000, -1).error);
    });
});

describe('ingreso del equipo por factura', () => {
    test('sin neto (facturas ya cargadas): exactamente como antes, total menos traslado', () => {
        // misma cifra que fija trasladoFactura.test.js: no cambia ninguna cifra ya vista
        assert.equal(ingresoFactura({ monto: 249900, monto_traslado: 140000 }), 109900);
        assert.equal(ingresoFactura({ monto: '249900.00', monto_traslado: '140000.00', monto_neto: null }), ingresoSinTraslado(249900, 140000));
        assert.equal(ingresoFactura({ monto: 50000 }), 50000);
    });
    test('con neto (facturas nuevas): neto menos traslado, todo neto', () => {
        assert.equal(ingresoFactura({ monto: 249900, monto_traslado: 140000, monto_neto: 210000 }), 70000);
        assert.equal(ingresoFactura({ monto: '249900.00', monto_traslado: '140000.00', monto_neto: '210000.00' }), 70000);
        assert.equal(ingresoFactura({ monto: 119000, monto_traslado: 0, monto_neto: 100000 }), 100000);
        assert.equal(ingresoFactura({ monto: 119000, monto_traslado: 200000, monto_neto: 100000 }), 0, 'nunca negativo');
    });
    test('anulada con nota de credito: 0', () => {
        assert.equal(ingresoFactura({ monto: 249900, monto_traslado: 140000, anulada_nc: '76' }), 0);
        assert.equal(ingresoFactura({ monto: 249900, monto_neto: 210000, anulada_nc: 'NC-1' }), 0);
        assert.equal(ingresoFactura({ monto: 249900, anulada_nc: '' }), 249900, 'texto vacio no anula');
    });
    test('calcularIngreso mezcla las dos reglas y descuenta las anuladas', () => {
        const facturas = [
            { monto: 249900, monto_traslado: 140000 },                       // antigua: 109900
            { monto: 249900, monto_traslado: 140000, monto_neto: 210000 },   // nueva: 70000
            { monto: 500000, monto_neto: 420168, anulada_nc: '9' },          // anulada: 0
            { monto: null },
        ];
        assert.equal(calcularIngreso(facturas), 179900);
        const r = calcularRentabilidad({ lineas: [{ cantidad: 1, precio_unitario: 30000 }], facturas });
        assert.equal(r.ingreso, 179900);
        assert.equal(r.margen, 149900);
    });
    test('la linea de tiempo usa la misma regla por factura', () => {
        const lt = armarLineaTiempo({ facturas: [
            { id: 1, folio: 'A', monto: '249900.00', monto_traslado: '140000.00', monto_neto: '210000.00', fecha_evento: '2026-08-01T12:00:00Z' },
            { id: 2, folio: 'B', monto: '249900.00', monto_traslado: '140000.00', monto_neto: null, fecha_evento: '2026-07-01T12:00:00Z' },
            { id: 3, folio: 'C', monto: '100000.00', monto_traslado: '0', anulada_nc: '5', fecha_evento: '2026-06-01T12:00:00Z' },
        ] });
        const ev = lt.tramos[0].eventos;
        assert.deepEqual(ev.map((e) => e.ingreso), [70000, 109900, 0]);
        assert.equal(ev[0].monto_neto, 210000);
        assert.equal(ev[2].anulada_nc, '5');
    });
});

describe('fila de la lista de emitidas', () => {
    const fila = {
        id: '7', folio: '123', orden_trabajo_id: null, cliente_id: 3, cliente_nombre: 'Cliente Ficticio',
        ejecutivo_id: null, ejecutivo_nombre: null, maquinaria_id: 9, maquinaria_codigo: 'GH-1',
        periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31',
        monto: '249900.00', monto_neto: '210000.00', monto_traslado: '140000.00', traslado_entrega: '70000.00', traslado_retiro: '70000.00',
        fecha_emision: '2026-10-01', fecha_vencimiento: '2026-11-10', fecha_pago: null, anulada_nc: null,
    };
    test('montos como numero, tipo y estado derivados', () => {
        const r = armarFilaEmitida(fila, '2026-11-17');
        assert.equal(r.id, 7);
        assert.equal(r.tipo, 'arriendo');
        assert.equal(r.monto, 249900);
        assert.equal(r.monto_neto, 210000);
        assert.equal(r.traslado_entrega, 70000);
        assert.equal(r.estado_cobranza, 'vencida');
        assert.equal(r.dias_mora, 7);
        assert.equal(r.dias_para_vencer, null);
        assert.equal('archivo_url' in r, false);
    });
    test('reparacion, pagada y sin vencimiento', () => {
        assert.equal(armarFilaEmitida({ ...fila, orden_trabajo_id: 4 }, '2026-11-17').tipo, 'reparacion');
        const pagada = armarFilaEmitida({ ...fila, fecha_pago: '2026-11-12' }, '2026-11-17');
        assert.equal(pagada.estado_cobranza, 'pagada');
        assert.equal(pagada.dias_mora, 2);
        const sin = armarFilaEmitida({ ...fila, fecha_vencimiento: null, monto_neto: null, traslado_entrega: null, traslado_retiro: null }, '2026-11-17');
        assert.equal(sin.estado_cobranza, 'sin_vencimiento');
        assert.equal(sin.monto_neto, null);
        assert.equal(sin.traslado_entrega, null);
    });
});
