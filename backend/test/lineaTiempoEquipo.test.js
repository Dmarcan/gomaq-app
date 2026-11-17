const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { armarLineaTiempo, TOPE_EVENTOS, OBSERVACION_MANTENCION_PANEL } = require('../src/utils/lineaTiempoEquipo');

const guia = (id, tipo, fecha, cliente, extra = {}) => ({
    id, tipo, fecha, cliente_id: cliente, cliente_nombre: cliente ? `Cliente ${cliente}` : null,
    fallido: false, sin_documento: false, inicio_cobro: null, fin_cobro: null, ...extra,
});
const ot = (id, fecha, cliente, extra = {}) => ({
    id, fecha_creacion: fecha, cliente_id: cliente, cliente_nombre: cliente ? `Cliente ${cliente}` : null,
    estado: 'finalizada', motivo: 'Revision', tipo_servicio: null, ...extra,
});
const factura = (id, fecha, cliente, extra = {}) => ({
    id, folio: `F${id}`, monto: '100000', monto_traslado: '0', orden_trabajo_id: null, fecha_evento: fecha,
    periodo_desde: null, periodo_hasta: null, cliente_id: cliente, cliente_nombre: cliente ? `Cliente ${cliente}` : null, ...extra,
});
const lectura = (id, fecha, valor, cliente = null, extra = {}) => ({
    id, valor, origen: 'movil', observacion: null, fecha, cliente_id: cliente, cliente_nombre: cliente ? `Cliente ${cliente}` : null, ...extra,
});
const todos = (r) => r.tramos.flatMap((t) => t.eventos);

describe('armarLineaTiempo', () => {
    test('sin datos devuelve una linea vacia', () => {
        const r = armarLineaTiempo({});
        assert.deepEqual(r, { tramos: [], total_eventos: 0, hay_mas: false, tope: TOPE_EVENTOS });
    });

    test('ordena de lo mas reciente a lo mas antiguo mezclando las fuentes', () => {
        const r = armarLineaTiempo({
            guias: [guia(1, 'despacho', '2026-01-02T12:00:00Z', 7), guia(2, 'recepcion', '2026-01-20T12:00:00Z', 7)],
            ordenes: [ot(5, '2026-01-10T12:00:00Z', 7)],
            facturas: [factura(9, '2026-01-25T12:00:00Z', 7)],
            lecturas: [lectura(3, '2026-01-15T12:00:00Z', 100, 7)],
        });
        assert.deepEqual(todos(r).map((e) => `${e.tipo}:${e.id}`), [
            'factura:9', 'guia_recepcion:2', 'lectura_horometro:3', 'orden_trabajo:5', 'guia_despacho:1',
        ]);
        assert.equal(r.total_eventos, 5);
    });

    test('a igual fecha el orden es estable sin importar el orden de entrada', () => {
        const f = '2026-02-01T12:00:00Z';
        const a = armarLineaTiempo({ guias: [guia(1, 'despacho', f, 1), guia(2, 'despacho', f, 1)], ordenes: [ot(3, f, 1)] });
        const b = armarLineaTiempo({ ordenes: [ot(3, f, 1)], guias: [guia(2, 'despacho', f, 1), guia(1, 'despacho', f, 1)] });
        assert.deepEqual(todos(a).map((e) => e.id), todos(b).map((e) => e.id));
    });

    test('agrupa en tramos por cliente: el mismo cliente separado por otro forma dos tramos', () => {
        const r = armarLineaTiempo({
            guias: [
                guia(1, 'despacho', '2026-01-02T12:00:00Z', 1), guia(2, 'recepcion', '2026-01-20T12:00:00Z', 1),
                guia(3, 'despacho', '2026-02-02T12:00:00Z', 2), guia(4, 'recepcion', '2026-02-10T12:00:00Z', 2),
                guia(5, 'despacho', '2026-04-02T12:00:00Z', 1),
            ],
        });
        assert.deepEqual(r.tramos.map((t) => [t.cliente_id, t.eventos.length]), [[1, 1], [2, 2], [1, 2]]);
        const t2 = r.tramos[1];
        assert.equal(t2.cliente_nombre, 'Cliente 2');
        assert.equal(t2.hasta, '2026-02-10T12:00:00.000Z');
        assert.equal(t2.desde, '2026-02-02T12:00:00.000Z');
    });

    test('los eventos sin cliente forman su propio tramo (en bodega) con cliente_id null', () => {
        const r = armarLineaTiempo({
            guias: [guia(1, 'despacho', '2026-01-02T12:00:00Z', 1)],
            ordenes: [ot(2, '2026-01-10T12:00:00Z', null)],
            facturas: [factura(3, '2026-01-12T12:00:00Z', 1)],
        });
        assert.deepEqual(r.tramos.map((t) => t.cliente_id), [1, null, 1]);
        assert.equal(r.tramos[1].cliente_nombre, null);
    });

    test('el cliente sale del propio evento', () => {
        const r = armarLineaTiempo({
            ordenes: [ot(1, '2026-01-10T12:00:00Z', 4)],
            facturas: [factura(2, '2026-01-11T12:00:00Z', 4, { orden_trabajo_id: 1 })],
        });
        assert.equal(r.tramos.length, 1);
        assert.equal(r.tramos[0].cliente_id, 4);
    });

    test('guias: fallida, sin documento y dia de cobro segun el tipo', () => {
        const r = armarLineaTiempo({
            guias: [
                guia(1, 'despacho', '2026-01-02T12:00:00Z', 1, { inicio_cobro: '2026-01-03', fin_cobro: '2026-01-09' }),
                guia(2, 'recepcion', '2026-01-20T12:00:00Z', 1, { fin_cobro: '2026-01-20', sin_documento: true, fallido: true }),
            ],
        });
        const [rec, desp] = todos(r);
        assert.equal(desp.tipo, 'guia_despacho');
        assert.equal(desp.inicio_cobro, '2026-01-03');
        assert.equal('fin_cobro' in desp, false);
        assert.equal(rec.tipo, 'guia_recepcion');
        assert.equal(rec.fin_cobro, '2026-01-20');
        assert.equal(rec.sin_documento, true);
        assert.equal(rec.fallido, true);
    });

    test('orden de trabajo: costo de repuestos con la regla de rentabilidad (lineas sin precio aparte)', () => {
        const r = armarLineaTiempo({
            ordenes: [ot(10, '2026-03-01T12:00:00Z', 1), ot(11, '2026-03-02T12:00:00Z', 1)],
            lineas: [
                { orden_trabajo_id: 10, cantidad: '2', precio_unitario: '1500' },
                { orden_trabajo_id: 10, cantidad: '1', precio_unitario: '500.50' },
                { orden_trabajo_id: 10, cantidad: '3', precio_unitario: null },
                { orden_trabajo_id: 99, cantidad: '1', precio_unitario: '9999' }, // de otra orden: no cuenta
            ],
        });
        const o10 = todos(r).find((e) => e.id === 10);
        const o11 = todos(r).find((e) => e.id === 11);
        assert.equal(o10.costo_repuestos, 3500.5);
        assert.equal(o10.lineas_sin_precio, 1);
        assert.equal(o11.costo_repuestos, 0);
        assert.equal(o11.lineas_sin_precio, 0);
    });

    test('orden de trabajo: solo la preventiva se marca como mantencion', () => {
        const r = armarLineaTiempo({
            ordenes: [
                ot(1, '2026-03-01T12:00:00Z', 1, { tipo_servicio: 'preventivo' }),
                ot(2, '2026-03-02T12:00:00Z', 1, { tipo_servicio: 'correctivo' }),
                ot(3, '2026-03-03T12:00:00Z', 1),
            ],
        });
        const porId = Object.fromEntries(todos(r).map((e) => [e.id, e]));
        assert.equal(porId[1].es_mantencion, true);
        assert.equal(porId[2].es_mantencion, false);
        assert.equal(porId[3].es_mantencion, false);
        assert.equal(porId[3].tipo_servicio, null);
    });

    test('factura: monto, traslado e ingreso sin traslado, como numeros', () => {
        const r = armarLineaTiempo({
            facturas: [
                factura(1, '2026-03-01T12:00:00Z', 1, { monto: '210000.00', monto_traslado: '140000.00', orden_trabajo_id: 5 }),
                factura(2, '2026-03-02T12:00:00Z', 1, { monto: null, monto_traslado: null }),
            ],
        });
        const [sinMonto, con] = todos(r);
        assert.equal(con.monto, 210000);
        assert.equal(con.monto_traslado, 140000);
        assert.equal(con.ingreso, 70000);
        assert.equal(con.orden_trabajo_id, 5);
        assert.equal(sinMonto.monto, null);
        assert.equal(sinMonto.ingreso, null);
    });

    test('no hay totales en la respuesta (los totales salen de rentabilidad)', () => {
        const r = armarLineaTiempo({ facturas: [factura(1, '2026-03-01T12:00:00Z', 1)], ordenes: [ot(2, '2026-03-02T12:00:00Z', 1)] });
        assert.deepEqual(Object.keys(r).sort(), ['hay_mas', 'tope', 'total_eventos', 'tramos']);
        for (const t of r.tramos) assert.deepEqual(Object.keys(t).sort(), ['cliente_id', 'cliente_nombre', 'desde', 'eventos', 'hasta']);
    });

    test('lecturas: horas desde la anterior; null en la primera y si el contador baja', () => {
        const r = armarLineaTiempo({
            lecturas: [
                lectura(1, '2026-01-01T12:00:00Z', '100.0'),
                lectura(2, '2026-02-01T12:00:00Z', '160.5'),
                lectura(3, '2026-03-01T12:00:00Z', '20.0'), // horometro reemplazado
                lectura(4, '2026-04-01T12:00:00Z', '45.0'),
            ],
        });
        const porId = Object.fromEntries(todos(r).map((e) => [e.id, e]));
        assert.equal(porId[1].horas_desde_anterior, null);
        assert.equal(porId[2].horas_desde_anterior, 60.5);
        assert.equal(porId[3].horas_desde_anterior, null);
        assert.equal(porId[4].horas_desde_anterior, 25);
        assert.equal(porId[4].valor, 45);
    });

    test('lecturas: es mantencion solo con la observacion que deja el panel', () => {
        const r = armarLineaTiempo({
            lecturas: [
                lectura(1, '2026-01-01T12:00:00Z', 100, null, { origen: 'panel', observacion: OBSERVACION_MANTENCION_PANEL }),
                lectura(2, '2026-01-02T12:00:00Z', 101, null, { observacion: 'cambio de aceite' }),
                lectura(3, '2026-01-03T12:00:00Z', 102),
            ],
        });
        const porId = Object.fromEntries(todos(r).map((e) => [e.id, e]));
        assert.equal(porId[1].es_mantencion, true);
        assert.equal(porId[2].es_mantencion, false);
        assert.equal(porId[3].es_mantencion, false);
    });

    test('la observacion de mantencion coincide con la que escribe routes/horometro.js', () => {
        const fuente = fs.readFileSync(path.join(__dirname, '../src/routes/horometro.js'), 'utf8');
        assert.ok(fuente.includes(`'${OBSERVACION_MANTENCION_PANEL}'`), 'si cambia el texto en horometro.js, cambiarlo tambien en lineaTiempoEquipo.js');
    });

    test('tope: recorta lo mas antiguo y avisa hay_mas', () => {
        const guias = Array.from({ length: 12 }, (_, i) => guia(i + 1, 'despacho', `2026-01-${String(i + 1).padStart(2, '0')}T12:00:00Z`, 1));
        const r = armarLineaTiempo({ guias }, { tope: 10 });
        assert.equal(r.hay_mas, true);
        assert.equal(r.tope, 10);
        assert.equal(r.total_eventos, 10);
        assert.deepEqual(todos(r).map((e) => e.id), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
        const justo = armarLineaTiempo({ guias: guias.slice(0, 10) }, { tope: 10 });
        assert.equal(justo.hay_mas, false);
        assert.equal(justo.total_eventos, 10);
    });

    test('no entrega rutas de archivo ni URLs', () => {
        const r = armarLineaTiempo({
            guias: [guia(1, 'despacho', '2026-01-02T12:00:00Z', 1, { archivo_url: 'guias/x.pdf' })],
            facturas: [factura(2, '2026-01-03T12:00:00Z', 1, { archivo_url: 'facturas/x.pdf' })],
        });
        assert.doesNotMatch(JSON.stringify(r), /archivo|\.pdf|http/);
    });
});
