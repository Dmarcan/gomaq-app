// Pruebas del armado de la hoja CLIENTES (utils/exportarFacturacion.js) con datos FICTICIOS.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
    ENCABEZADOS, armarHoja, armarFila, textoPeriodo, textoFolio, numeroInterno,
} = require('../src/utils/exportarFacturacion');

const HOY = '2026-11-17';

/** Fila de la consulta con valores por defecto de un arriendo normal; `c` pisa lo que se quiera. */
const fila = (c = {}) => ({
    id: 1, folio: '1500', orden_trabajo_id: null,
    cliente_rut: '11111111-1', cliente_nombre: 'Cliente Ficticio Ltda', cliente_direccion: 'Calle Falsa 123',
    cliente_giro: 'Servicios de prueba', cliente_email: 'cliente@ficticio.test', ejecutivo_nombre: 'Vendedor Uno',
    categoria_equipo: 'grua_horquilla', tipo_equipo: 'Grúa horquilla', modelo: 'M-100', marca: 'MarcaX', maquinaria_codigo: 'GH-1540',
    periodo_desde: '2026-10-01', periodo_hasta: '2026-10-31',
    monto: '119000', monto_neto: '100000', monto_traslado: '0', traslado_entrega: null, traslado_retiro: null,
    fecha_emision: '2026-11-02', fecha_ref: '2026-11-02', fecha_vencimiento: '2026-12-02', fecha_pago: null, anulada_nc: null,
    ...c,
});

const col = (nombre) => ENCABEZADOS.indexOf(nombre);
const celda = (f, nombre, hoy = HOY) => armarFila(f, hoy).celdas[col(nombre)];

describe('estructura de la hoja', () => {
    test('encabezados exactos, en orden, 25 columnas', () => {
        assert.equal(ENCABEZADOS.length, 25);
        assert.deepEqual(ENCABEZADOS, [
            'Rut', 'Razon Social', 'CONTACTO', 'Dirección', 'Giro', 'e-mail', 'CATEGORIA', 'Equipo', 'Modelo', 'Marca',
            'N° Interno', 'Periodo Arriendo', '$ Neto equipo', 'Traslado Entrega', 'Traslado Retiro', 'Devol / Adicional',
            'Factura N°', 'Total $', 'Comision', 'Pagada comision', 'MES ARRIENDO', 'Emision', 'Vcto', 'Pago', 'DIAS MORA',
        ]);
    });

    test('A2, Y1, Y3, encabezados en la fila 4 y datos desde la 5', () => {
        const { matriz, filas, sin_neto: sinNeto } = armarHoja([fila(), fila({ id: 2 })], { hoy: HOY });
        assert.deepEqual(matriz[1], ['CLIENTES MENSUALES']); // A2
        assert.deepEqual(matriz[0][24], { fecha: HOY }); // Y1
        assert.deepEqual(matriz[2][24], { fecha: HOY }); // Y3
        assert.equal(matriz[0].length, 25);
        assert.deepEqual(matriz[3], ENCABEZADOS); // fila 4
        assert.equal(matriz.length, 6);
        assert.equal(matriz[4].length, 25);
        assert.equal(filas, 2);
        assert.equal(sinNeto, 0);
    });

    test('sin facturas: solo la cabecera', () => {
        const { matriz, filas } = armarHoja([], { hoy: HOY });
        assert.equal(matriz.length, 4);
        assert.equal(filas, 0);
    });

    test('Devol / Adicional, Comision y Pagada comision van vacias; todo son valores', () => {
        const celdas = armarFila(fila(), HOY).celdas;
        for (const n of ['Devol / Adicional', 'Comision', 'Pagada comision']) assert.equal(celdas[col(n)], null, n);
        for (const c of celdas) assert.ok(c === null || ['string', 'number', 'object'].includes(typeof c));
        assert.ok(!celdas.some((c) => typeof c === 'string' && c.startsWith('=')));
    });
});

describe('datos del cliente, equipo y factura', () => {
    test('arriendo completo', () => {
        const f = fila();
        assert.equal(celda(f, 'Rut'), '11111111-1');
        assert.equal(celda(f, 'Razon Social'), 'Cliente Ficticio Ltda');
        assert.equal(celda(f, 'CONTACTO'), 'Vendedor Uno');
        assert.equal(celda(f, 'Dirección'), 'Calle Falsa 123');
        assert.equal(celda(f, 'Giro'), 'Servicios de prueba');
        assert.equal(celda(f, 'e-mail'), 'cliente@ficticio.test');
        assert.equal(celda(f, 'CATEGORIA'), 'GRUA HORQUILLA');
        assert.equal(celda(f, 'Equipo'), 'ARRIENDO GRÚA HORQUILLA');
        assert.equal(celda(f, 'Modelo'), 'M-100');
        assert.equal(celda(f, 'Marca'), 'MarcaX');
        assert.equal(celda(f, 'N° Interno'), 1540);
        assert.equal(celda(f, 'Periodo Arriendo'), '01 AL 31 OCT 2026');
        assert.equal(celda(f, 'Factura N°'), 'F/1500');
        assert.equal(celda(f, 'Total $'), 119000);
        assert.deepEqual(celda(f, 'Emision'), { fecha: '2026-11-02' });
        assert.deepEqual(celda(f, 'Vcto'), { fecha: '2026-12-02' });
    });

    test('cliente sin ejecutivo (directo): CONTACTO vacio', () => {
        assert.equal(celda(fila({ ejecutivo_nombre: null }), 'CONTACTO'), null);
    });

    test('categorias', () => {
        const c = (k) => celda(fila({ categoria_equipo: k }), 'CATEGORIA');
        assert.equal(c('alzahombre'), 'PLATAFORMA');
        assert.equal(c('transpaleta'), 'TRANSPALETA');
        assert.equal(c('apilador'), 'APILADOR');
        assert.equal(c(null), null);
    });

    test('reparacion: Equipo con la OT y sin periodo', () => {
        const f = fila({ orden_trabajo_id: 77, periodo_desde: null, periodo_hasta: null });
        assert.equal(celda(f, 'Equipo'), 'REPARACION OT 77');
        assert.equal(celda(f, 'Periodo Arriendo'), null);
    });

    test('N° Interno: digitos finales del codigo', () => {
        assert.equal(numeroInterno('PL-1232'), 1232);
        assert.equal(numeroInterno('2013'), 2013);
        assert.equal(numeroInterno('SIN-NUMERO'), null);
        assert.equal(numeroInterno(null), null);
    });

    test('periodo: un mes, cruce de mes y cruce de anio', () => {
        assert.equal(textoPeriodo('2025-12-01', '2025-12-31'), '01 AL 31 DIC 2025');
        assert.equal(textoPeriodo('2025-01-12', '2025-02-11'), '12 ENE AL 11 FEB 2025');
        assert.equal(textoPeriodo('2025-12-12', '2026-01-11'), '12 DIC 2025 AL 11 ENE 2026');
        assert.equal(textoPeriodo(null, '2025-01-01'), null);
    });

    test('folio: con prefijo F/ solo si son digitos', () => {
        assert.equal(textoFolio('1512'), 'F/1512');
        assert.equal(textoFolio('F-2205'), 'F-2205');
        assert.equal(textoFolio('A123'), 'A123');
        assert.equal(textoFolio(null), null);
    });

    test('MES ARRIENDO: dia 1 del mes del periodo; si no hay, de la emision; si no, del dia de referencia', () => {
        const mes = (c) => celda(fila(c), 'MES ARRIENDO');
        assert.deepEqual(mes({ periodo_desde: '2026-10-15' }), { fecha: '2026-10-01' });
        assert.deepEqual(mes({ periodo_desde: null, fecha_emision: '2026-11-20' }), { fecha: '2026-11-01' });
        assert.deepEqual(mes({ periodo_desde: null, fecha_emision: null, fecha_ref: '2026-09-09' }), { fecha: '2026-09-01' });
    });
});

describe('montos y traslados', () => {
    test('con monto_neto y sin traslado: neto equipo = neto', () => {
        const f = fila();
        assert.equal(celda(f, '$ Neto equipo'), 100000);
        assert.equal(celda(f, 'Traslado Entrega'), null);
        assert.equal(celda(f, 'Traslado Retiro'), null);
        assert.equal(armarHoja([f], { hoy: HOY }).sin_neto, 0);
    });

    test('sin monto_neto: round(monto / 1,19) y se cuenta en el resumen', () => {
        const f = fila({ monto: '249900', monto_neto: null, monto_traslado: '0' });
        assert.equal(celda(f, '$ Neto equipo'), 210000);
        const g = fila({ id: 2, monto: '100000', monto_neto: null });
        assert.equal(celda(g, '$ Neto equipo'), 84034);
        const r = armarHoja([f, g, fila({ id: 3 })], { hoy: HOY });
        assert.equal(r.sin_neto, 2);
        assert.equal(r.filas, 3);
    });

    test('sin monto ni neto: vacio y no cuenta como estimada', () => {
        const f = fila({ monto: null, monto_neto: null });
        assert.equal(celda(f, '$ Neto equipo'), null);
        assert.equal(celda(f, 'Total $'), null);
        assert.equal(armarHoja([f], { hoy: HOY }).sin_neto, 0);
    });

    test('traslado dividido: cada parte a su columna y neto menos el total', () => {
        const f = fila({ monto: '249900', monto_neto: '210000', monto_traslado: '140000', traslado_entrega: '70000', traslado_retiro: '70000' });
        assert.equal(celda(f, '$ Neto equipo'), 70000);
        assert.equal(celda(f, 'Traslado Entrega'), 70000);
        assert.equal(celda(f, 'Traslado Retiro'), 70000);
    });

    test('traslado dividido desigual y solo retiro', () => {
        const f = fila({ monto_neto: '100000', monto_traslado: '30001', traslado_entrega: '15001', traslado_retiro: '15000' });
        assert.equal(celda(f, 'Traslado Entrega'), 15001);
        assert.equal(celda(f, 'Traslado Retiro'), 15000);
        const g = fila({ monto_neto: '100000', monto_traslado: '20000', traslado_entrega: '0', traslado_retiro: '20000' });
        assert.equal(celda(g, 'Traslado Entrega'), null);
        assert.equal(celda(g, 'Traslado Retiro'), 20000);
    });

    test('traslado sin dividir: todo a Traslado Entrega', () => {
        const f = fila({ monto_neto: '100000', monto_traslado: '40000' });
        assert.equal(celda(f, 'Traslado Entrega'), 40000);
        assert.equal(celda(f, 'Traslado Retiro'), null);
        assert.equal(celda(f, '$ Neto equipo'), 60000);
    });

    test('traslado con neto estimado', () => {
        const f = fila({ monto: '119000', monto_neto: null, monto_traslado: '40000' });
        assert.equal(celda(f, '$ Neto equipo'), 60000);
    });

    test('nota de credito con monto negativo se conserva', () => {
        const f = fila({ monto: '-119000', monto_neto: '-100000' });
        assert.equal(celda(f, 'Total $'), -119000);
        assert.equal(celda(f, '$ Neto equipo'), -100000);
    });
});

describe('Pago y DIAS MORA (misma regla que cobranza.js)', () => {
    test('pagada: fecha de pago y sin mora', () => {
        const f = fila({ fecha_vencimiento: '2026-10-01', fecha_pago: '2026-10-20' });
        assert.deepEqual(celda(f, 'Pago'), { fecha: '2026-10-20' });
        assert.equal(celda(f, 'DIAS MORA'), null);
    });

    test('vencida: texto vencido y dias de mora', () => {
        const f = fila({ fecha_vencimiento: '2026-11-07' });
        assert.equal(celda(f, 'Pago'), 'vencido');
        assert.equal(celda(f, 'DIAS MORA'), 10);
    });

    test('vence hoy no es vencida: es proxima', () => {
        const f = fila({ fecha_vencimiento: HOY });
        assert.equal(celda(f, 'Pago'), 'proximo a vencer');
        assert.equal(celda(f, 'DIAS MORA'), null);
    });

    test('proxima a vencer: faltan 7 dias; con 8 no marca nada', () => {
        assert.equal(celda(fila({ fecha_vencimiento: '2026-11-24' }), 'Pago'), 'proximo a vencer');
        assert.equal(celda(fila({ fecha_vencimiento: '2026-11-25' }), 'Pago'), null);
    });

    test('anulada con nota de credito: texto con el folio, sin mora aunque este vencida', () => {
        const f = fila({ fecha_vencimiento: '2026-01-01', anulada_nc: '76' });
        assert.equal(celda(f, 'Pago'), 'Anulada NC/76');
        assert.equal(celda(f, 'DIAS MORA'), null);
    });

    test('sin vencimiento: sin texto ni mora y Vcto vacio', () => {
        const f = fila({ fecha_vencimiento: null });
        assert.equal(celda(f, 'Pago'), null);
        assert.equal(celda(f, 'Vcto'), null);
        assert.equal(celda(f, 'DIAS MORA'), null);
    });

    test('las fechas imposibles o ausentes no rompen la fila', () => {
        const f = fila({ fecha_emision: null, periodo_desde: null, periodo_hasta: null, fecha_ref: '2026-11-03' });
        assert.equal(celda(f, 'Emision'), null);
        assert.equal(celda(f, 'Periodo Arriendo'), null);
        assert.deepEqual(celda(f, 'MES ARRIENDO'), { fecha: '2026-11-01' });
    });

    test('un dia que no existe en el calendario no arma periodo', () => {
        assert.equal(textoPeriodo('2026-02-31', '2026-03-10'), null);
        assert.equal(textoPeriodo('2026-02-01', '2026-02-30'), null);
    });
});
