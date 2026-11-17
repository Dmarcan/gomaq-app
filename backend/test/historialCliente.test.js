const test = require('node:test');
const assert = require('node:assert/strict');
const { armarHistorial, TOPE_LISTA } = require('../src/utils/historialCliente');

const arriendo = (id, extra = {}) => ({
    guia_despacho_id: id, guia_recepcion_id: null, maquinaria_id: id, maquinaria_codigo: `EQ-${id}`,
    inicio_cobro: '2026-01-10', fin: null, en_curso: true, falta_recepcion: false,
    cliente_email: 'no-debe-salir@x.cl', archivo_url: 'secreto', ...extra,
});

test('resumen: equipos arrendados hoy, arriendos, facturas y total', () => {
    const h = armarHistorial({
        cliente: { id: 1, nombre: 'ACME' },
        arriendos: [
            arriendo(1),
            arriendo(2, { en_curso: false, fin: '2026-02-01', guia_recepcion_id: 9 }),
            arriendo(3, { maquinaria_id: 1 }), // mismo equipo en curso dos veces: cuenta una
        ],
        facturas: [
            { id: 1, folio: '10', monto: '1000.00', fecha_emision: '2026-02-01' },
            { id: 2, folio: '11', monto: '500.00', fecha_emision: '2026-03-01' },
        ],
        ordenes: [],
    });
    assert.deepEqual(h.resumen, { equipos_arrendados_hoy: 1, arriendos: 3, facturas: 2, total_facturado: 1500 });
    assert.equal(h.facturas[0].folio, '11', 'la mas reciente primero');
    assert.equal(h.facturas[0].monto, 500);
});

test('un arriendo en curso y uno cerrado se distinguen', () => {
    const h = armarHistorial({
        cliente: {},
        arriendos: [
            arriendo(1, { inicio_cobro: '2026-01-01', en_curso: false, fin: '2026-01-20' }),
            arriendo(2, { inicio_cobro: '2026-03-01' }),
        ],
    });
    assert.equal(h.arriendos[0].maquinaria_codigo, 'EQ-2');
    assert.equal(h.arriendos[0].en_curso, true);
    assert.equal(h.arriendos[0].fin, null);
    assert.equal(h.arriendos[1].fin, '2026-01-20');
});

test('no devuelve correos ni documentos de los arriendos', () => {
    const h = armarHistorial({ cliente: {}, arriendos: [arriendo(1)], facturas: [{ id: 1, folio: '1', archivo_url: 'x' }] });
    assert.equal(JSON.stringify(h).includes('archivo_url'), false);
    assert.equal(JSON.stringify(h).includes('no-debe-salir'), false);
});

test('corta cada lista en el tope y avisa con hay_mas', () => {
    const n = TOPE_LISTA + 1;
    const facturas = Array.from({ length: n }, (_, i) => ({ id: i + 1, folio: String(i), monto: 1, fecha_emision: '2026-01-01' }));
    const ordenes = Array.from({ length: n }, (_, i) => ({ id: i + 1, estado: 'finalizada', maquinaria_id: 1, maquinaria_codigo: 'A', fecha_creacion: '2026-01-01' }));
    const arriendos = Array.from({ length: n }, (_, i) => arriendo(i + 1));
    const h = armarHistorial({ cliente: {}, arriendos, facturas, ordenes, totales: { facturas: 300, total_facturado: 300 } });
    assert.equal(h.facturas.length, TOPE_LISTA);
    assert.equal(h.ordenes.length, TOPE_LISTA);
    assert.equal(h.arriendos.length, TOPE_LISTA);
    assert.deepEqual(h.hay_mas, { arriendos: true, facturas: true, ordenes: true });
    assert.equal(h.resumen.facturas, 300, 'el resumen cuenta todo, no solo lo mostrado');
});

test('sin datos: listas vacias y sin hay_mas', () => {
    const h = armarHistorial({ cliente: { id: 3 } });
    assert.deepEqual(h.resumen, { equipos_arrendados_hoy: 0, arriendos: 0, facturas: 0, total_facturado: 0 });
    assert.deepEqual(h.hay_mas, { arriendos: false, facturas: false, ordenes: false });
});
