// Detalle de una OT para el cliente (utils/detalleOtCliente.js): lista blanca de claves, sin datos
// internos y linea de tiempo en palabras del cliente. Puro: no usa base.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { lineaTiempoCliente, armarDetalleOtCliente } = require('../src/utils/detalleOtCliente');

const CLAVES = [
    'id', 'estado', 'maquinaria_codigo', 'maquinaria_tipo', 'motivo', 'diagnostico', 'observacion_final',
    'fecha_creacion', 'fecha_cierre', 'mecanico_nombre', 'cobro', 'linea_tiempo', 'fotos',
].sort();

const ev = (tipo, extra = {}) => ({
    tipo, estado_anterior: null, estado_nuevo: null, rol: 'administrativo',
    ocurrio_en: '2026-03-02T10:00:00.000Z', registrado_en: '2026-03-02T10:00:05.000Z', aplicado: true, hora_dudosa: false, ...extra,
});

const ordenCompleta = () => ({
    id: 5, estado: 'finalizada', maquinaria_codigo: 'GR-3', maquinaria_tipo: 'Grúa', motivo: 'Falla', diagnostico: 'Manguera',
    observacion_final: 'Quedó operativa. Cobrar $45.000 a la factura 77', fecha_creacion: '2026-03-01', fecha_cierre: '2026-03-02',
    mecanico_nombre: 'Pedro', facturable: true, valorizacion: 987654, lineas_pendientes: 0,
    // columnas internas que jamás deben salir
    destino_lat: -38.7, destino_lng: -72.5, eta_segundos: 600, eta_fuente: 'ors', mecanico_id: 9, uuid_cliente: 'u-1', folio_papel: 'P-123',
    cliente_id: 3, maquinaria_id: 8, path: 'ot/5/secreto.jpg',
});

describe('armarDetalleOtCliente', () => {
    test('las claves de salida son exactamente la lista blanca', () => {
        const d = armarDetalleOtCliente({ orden: ordenCompleta(), eventos: [], fotos: [] });
        assert.deepEqual(Object.keys(d).sort(), CLAVES);
        assert.equal(d.observacion_final, 'Quedó operativa. Cobrar $45.000 a la factura 77', 'se muestra tal cual');
        assert.equal(d.cobro, 'con_cobro');
    });

    test('no deja rastro de columnas internas, montos ni detalle de eventos', () => {
        const evento = ev('valorizacion', { detalle: { monto: 987654, usuario_id: 42, linea_id: 31 }, usuario_id: 42, origen: 'panel' });
        const d = armarDetalleOtCliente({
            orden: ordenCompleta(),
            eventos: [ev('creacion', { rol: 'cliente' }), evento],
            fotos: [{ id: 1, tipo: 'antes', url: 'https://f.test/a', created_at: new Date('2026-03-02T09:00:00Z'), path: 'ot/5/secreto.jpg' }],
        });
        const json = JSON.stringify(d);
        for (const prohibido of ['valorizacion', 'facturable', 'lineas_pendientes', 'destino_lat', 'destino_lng', 'eta_', 'mecanico_id',
            'uuid_cliente', 'folio_papel', 'path', 'secreto', '987654', 'usuario_id', 'detalle', 'origen']) {
            assert.ok(!json.includes(prohibido), `no debe aparecer ${prohibido}`);
        }
        assert.deepEqual(Object.keys(d.fotos[0]).sort(), ['id', 'tipo', 'tomada_en', 'url']);
        assert.equal(d.fotos[0].tomada_en, '2026-03-02T09:00:00.000Z');
    });

    test('el cobro sale de cobroParaCliente y una orden abierta no lo trae', () => {
        const base = ordenCompleta();
        assert.equal(armarDetalleOtCliente({ orden: { ...base, estado: 'en_terreno' }, eventos: [], fotos: [] }).cobro, null);
        assert.equal(armarDetalleOtCliente({ orden: { ...base, facturable: false, valorizacion: null }, eventos: [], fotos: [] }).cobro, 'sin_cobro');
        assert.equal(armarDetalleOtCliente({ orden: { ...base, valorizacion: null, lineas_pendientes: 2 }, eventos: [], fotos: [] }).cobro, 'por_definir');
    });
});

describe('lineaTiempoCliente', () => {
    test('cada tipo dice lo que debe', () => {
        const eventos = [
            ev('creacion', { rol: 'cliente' }),
            ev('asignacion'),
            ev('cambio_estado', { estado_nuevo: 'aceptada' }),
            ev('cambio_estado', { estado_nuevo: 'en_camino' }),
            ev('cambio_estado', { estado_nuevo: 'en_terreno' }),
            ev('cierre'),
        ];
        assert.deepEqual(lineaTiempoCliente(eventos).map((p) => [p.paso, p.texto]), [
            ['recibida', 'Solicitud recibida'],
            ['tecnico_asignado', 'Técnico asignado'],
            ['tecnico_acepto', 'Técnico aceptó'],
            ['en_camino', 'Técnico en camino'],
            ['trabajando', 'Trabajando en tu equipo'],
            ['finalizada', 'Finalizada'],
        ]);
    });

    test('creada por otro rol, toma y en_reparacion', () => {
        const l = lineaTiempoCliente([ev('creacion', { rol: 'gerente' }), ev('toma'), ev('cambio_estado', { estado_nuevo: 'en_reparacion' })]);
        assert.deepEqual(l.map((p) => p.texto), ['Orden creada por GOMAQ', 'Técnico asignado', 'Trabajando en tu equipo']);
    });

    test('omite lo interno, lo no aplicado y los cambios a pendiente o asignada', () => {
        const omitidos = [
            ev('valorizacion'), ev('linea_agregada'), ev('linea_modificada'), ev('linea_anulada'), ev('factura_cargada'), ev('factura_anulada'),
            ev('cambio_estado', { estado_nuevo: 'pendiente' }), ev('cambio_estado', { estado_nuevo: 'asignada' }),
            ev('cierre', { aplicado: false }), ev('asignacion', { aplicado: false }),
        ];
        assert.deepEqual(lineaTiempoCliente(omitidos), []);
        assert.deepEqual(lineaTiempoCliente(null), []);
    });

    test('dos pasos seguidos con el mismo texto quedan en uno (reasignación, terreno y reparación)', () => {
        const l = lineaTiempoCliente([
            ev('asignacion', { ocurrio_en: '2026-03-02T10:00:00.000Z' }),
            ev('toma', { ocurrio_en: '2026-03-02T11:00:00.000Z' }),
            ev('cambio_estado', { estado_nuevo: 'en_terreno' }),
            ev('cambio_estado', { estado_nuevo: 'en_reparacion' }),
        ]);
        assert.deepEqual(l.map((p) => p.texto), ['Técnico asignado', 'Trabajando en tu equipo']);
        assert.equal(l[0].ocurrio_en, '2026-03-02T10:00:00.000Z', 'queda el primero');
    });

    test('con hora dudosa se usa la hora en que llegó al servidor', () => {
        const [p] = lineaTiempoCliente([ev('asignacion', { hora_dudosa: true, ocurrio_en: '2030-01-01T00:00:00.000Z' })]);
        assert.equal(p.ocurrio_en, '2026-03-02T10:00:05.000Z');
        const [q] = lineaTiempoCliente([ev('asignacion', { ocurrio_en: new Date('2026-03-02T10:00:00Z') })]);
        assert.equal(q.ocurrio_en, '2026-03-02T10:00:00.000Z');
    });
});
