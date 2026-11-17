// Lector de la factura para cobranza (utils/parsearDocumento.js): neto, emision, vencimiento y traslado.
// Todos los textos son FICTICIOS, armados con el formato que entrega pdf-parse de un DTE: ningun nombre,
// RUT ni folio de un cliente real.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    parsearMontoNeto, parsearVencimiento, parsearTraslado, parsearFactura, parsearGuia,
} = require('../src/utils/parsearDocumento');

/** Factura ficticia. `detalle` son los bloques del detalle; `pagos` las lineas despues de "Pagos:". */
function factura({ detalle, pagos = ['2026-09-30 $ 119.000'], neto = '100.000', total = '119.000', referencias = true } = {}) {
    return [
        'EMPRESA EMISORA DE PRUEBA SPA',
        'SEÑOR(ES): CLIENTE FICTICIO DE PRUEBA LTDA',
        'R.U.T.: 11.111.111- 1',
        'FACTURA ELECTRONICA',
        'Nº900001',
        'Fecha Emision: 31 de Agosto del 2026',
        'Codigo Descripcion Cantidad Precio %Impto',
        'Adic.* %Desc. Valor',
        ...detalle,
        ...(referencias ? ['Referencias:', '- Orden Compra N° 555 del 2026-08-20'] : []),
        'Pagos:',
        ...pagos,
        'Forma de Pago:Crédito',
        'Timbre Electrónico SII',
        `MONTO NETO $ ${neto}`,
        'I.V.A. 19% $ 19.000',
        `TOTAL $ ${total}`,
    ].join('\n');
}

const ARRIENDO = ['- ARRIENDO GRUA HORQUILLA', 'N° INTERNO: 0001', '1 MES 60.000 60.000'];

describe('monto neto', () => {
    test('lee el neto con separador de miles', () => {
        assert.equal(parsearMontoNeto(factura({ detalle: ARRIENDO, neto: '1.234.567' })), 1234567);
        assert.equal(parsearMontoNeto('MONTO NETO: 45000'), 45000);
    });
    test('sin neto o con decimales distintos de cero: null', () => {
        assert.equal(parsearMontoNeto('TOTAL $ 119.000'), null);
        assert.equal(parsearMontoNeto('MONTO NETO $ 1.000,50'), null);
        assert.equal(parsearMontoNeto(''), null);
        assert.equal(parsearMontoNeto(null), null);
    });
});

describe('vencimiento', () => {
    test('una fecha en Pagos: es el vencimiento, no la de la orden de compra', () => {
        assert.deepEqual(parsearVencimiento(factura({ detalle: ARRIENDO })), { fecha: '2026-09-30', varias_cuotas: false });
    });
    test('varias cuotas: la ultima y el aviso', () => {
        const t = factura({ detalle: ARRIENDO, pagos: ['2026-09-30 $ 59.500', '2026-10-30 $ 59.500'] });
        assert.deepEqual(parsearVencimiento(t), { fecha: '2026-10-30', varias_cuotas: true });
    });
    test('acepta DD-MM-AAAA y DD/MM/AAAA', () => {
        assert.equal(parsearVencimiento(factura({ detalle: ARRIENDO, pagos: ['15-10-2026 $ 119.000'] })).fecha, '2026-10-15');
        assert.equal(parsearVencimiento(factura({ detalle: ARRIENDO, pagos: ['15/10/2026 $ 119.000'] })).fecha, '2026-10-15');
    });
    test('sin Pagos: o con fecha imposible: null', () => {
        assert.deepEqual(parsearVencimiento('MONTO NETO $ 100.000'), { fecha: null, varias_cuotas: false });
        assert.equal(parsearVencimiento(factura({ detalle: ARRIENDO, pagos: ['2026-02-30 $ 1'] })).fecha, null);
        assert.equal(parsearVencimiento(factura({ detalle: ARRIENDO, pagos: ['$ 119.000'] })).fecha, null);
    });
    test('"Forma de Pago" no se confunde con "Pagos:"', () => {
        assert.equal(parsearVencimiento('Forma de Pago: Contado 2026-01-01').fecha, null);
    });
});

describe('traslado', () => {
    test('entrega y retiro: mitad y mitad', () => {
        const t = factura({ detalle: [...ARRIENDO, '- TRASLADO', 'ENTREGA Y RETIRO DE EQUIPO', '1 UN 40.000 40.000'] });
        assert.deepEqual(parsearTraslado(t), { total: 40000, entrega: 20000, retiro: 20000, concepto: 'entrega_y_retiro', lineas: 1 });
    });
    test('monto impar: entrega lleva el peso que sobra', () => {
        const t = factura({ detalle: ['- TRASLADO ENTREGA Y RETIRO', '1 UN 35.001 35.001'] });
        assert.deepEqual(parsearTraslado(t), { total: 35001, entrega: 17501, retiro: 17500, concepto: 'entrega_y_retiro', lineas: 1 });
    });
    test('solo entrega o solo retiro: todo a ese concepto', () => {
        const e = parsearTraslado(factura({ detalle: ['- TRASLADO DE ENTREGA', 'Despacho: Comuna Ficticia', '1 UN 25.000 25.000'] }));
        assert.deepEqual(e, { total: 25000, entrega: 25000, retiro: 0, concepto: 'entrega', lineas: 1 });
        const r = parsearTraslado(factura({ detalle: ['- TRASLADO', 'RETIRO DE EQUIPO', '1 UN 25.000 25.000'] }));
        assert.deepEqual(r, { total: 25000, entrega: 0, retiro: 25000, concepto: 'retiro', lineas: 1 });
    });
    test('sin detalle: un solo monto, sin dividir', () => {
        const t = parsearTraslado(factura({ detalle: ['- TRASLADO DE EQUIPO', '1 UN 30.000 30.000'] }));
        assert.deepEqual(t, { total: 30000, entrega: null, retiro: null, concepto: 'sin_detalle', lineas: 1 });
    });
    test('dos lineas de traslado se suman por concepto', () => {
        const t = parsearTraslado(factura({ detalle: [
            '- TRASLADO ENTREGA', '1 UN 20.000 20.000',
            ...ARRIENDO,
            '- TRASLADO RETIRO', '1 UN 15.000 15.000',
        ] }));
        assert.deepEqual(t, { total: 35000, entrega: 20000, retiro: 15000, concepto: 'varias_lineas', lineas: 2 });
        const iguales = parsearTraslado(factura({ detalle: ['- TRASLADO ENTREGA', '1 UN 10.000 10.000', '- TRASLADO ENTREGA', '2 UN 5.000 10.000'] }));
        assert.deepEqual(iguales, { total: 20000, entrega: 20000, retiro: 0, concepto: 'entrega', lineas: 2 });
    });
    test('una linea sin detalle junto a otra con detalle: todo sin dividir', () => {
        const t = parsearTraslado(factura({ detalle: ['- TRASLADO ENTREGA', '1 UN 20.000 20.000', '- TRASLADO ADICIONAL', '1 UN 5.000 5.000'] }));
        assert.deepEqual(t, { total: 25000, entrega: null, retiro: null, concepto: 'sin_detalle', lineas: 2 });
    });
    test('sin traslado: null', () => {
        assert.equal(parsearTraslado(factura({ detalle: ARRIENDO })), null);
        assert.equal(parsearTraslado(''), null);
    });
    test('una linea de traslado sin valor legible: null (no se inventa)', () => {
        assert.equal(parsearTraslado(factura({ detalle: ['- TRASLADO ENTREGA Y RETIRO', 'segun cotizacion'] })), null);
    });
    test('la palabra traslado dentro de otra descripcion no cuenta', () => {
        assert.equal(parsearTraslado(factura({ detalle: ['- ARRIENDO CON TRASLADO INCLUIDO', '1 MES 60.000 60.000'] })), null);
    });
    test('las referencias y los pagos no se leen como detalle', () => {
        const t = factura({ detalle: ARRIENDO, referencias: true });
        assert.equal(parsearTraslado(`${t}\n- TRASLADO ENTREGA\n1 UN 9.000 9.000`), null);
    });
});

describe('parsearFactura completa', () => {
    test('devuelve lo nuevo junto a lo de siempre', () => {
        const t = factura({ detalle: [...ARRIENDO, '- TRASLADO', 'ENTREGA Y RETIRO DE EQUIPO', '1 UN 40.000 40.000'] });
        assert.deepEqual(parsearFactura(t), {
            monto_detectado: 119000,
            folio_detectado: '900001',
            rut_detectado: '11111111-1',
            monto_neto_detectado: 100000,
            fecha_emision_detectada: '2026-08-31',
            vencimiento_detectado: '2026-09-30',
            varias_cuotas: false,
            traslado_detectado: { total: 40000, entrega: 20000, retiro: 20000, concepto: 'entrega_y_retiro', lineas: 1 },
        });
    });
    test('un texto vacio no rompe: todo null', () => {
        const r = parsearFactura('');
        assert.equal(r.monto_neto_detectado, null);
        assert.equal(r.vencimiento_detectado, null);
        assert.equal(r.varias_cuotas, false);
        assert.equal(r.traslado_detectado, null);
    });
    test('la guia de despacho no pasa por el lector de traslado de la factura', () => {
        const guia = fs.readFileSync(path.join(__dirname, 'fixtures', 'guia_despacho.txt'), 'utf8');
        const r = parsearGuia(guia);
        assert.equal('traslado_detectado' in r, false);
        assert.equal('monto_neto_detectado' in r, false);
    });
});
