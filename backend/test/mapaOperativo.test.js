const test = require('node:test');
const assert = require('node:assert/strict');
const { ubicacionEquipo, armarEquipo, armarFurgon, armarBodega, armarRespuestaMapa } = require('../src/utils/mapaOperativo');

const BODEGA = { id: 1, nombre: 'Bodega central', latitud: '-33.500000', longitud: '-70.700000' };

const filaEquipo = (extra = {}) => ({
    id: 7, codigo: 'GH-999', tipo: 'Grua', marca: 'Genie', modelo: 'Z-45', estado: 'operativa',
    cliente_id: 3, cliente_nombre: 'Acsa', direccion: 'Av. Siempre Viva 1',
    c_lat: '-33.400000', c_lng: '-70.600000',
    g_tipo: 'despacho', g_cliente_id: 3, g_lat: '-33.450000', g_lng: '-70.650000',
    ...extra,
});

test('equipo arrendado: la guia vigente gana sobre el cliente', () => {
    const e = armarEquipo(filaEquipo(), { bodega: BODEGA, idsConAlerta: new Set() });
    assert.equal(e.situacion, 'arrendado');
    assert.equal(e.origen_ubicacion, 'guia');
    assert.equal(e.latitud, -33.45);
    assert.equal(e.cliente.nombre, 'Acsa');
});

test('equipo arrendado: sin coordenadas en la guia cae a la ubicacion del cliente', () => {
    const e = armarEquipo(filaEquipo({ g_lat: null, g_lng: null }), { bodega: BODEGA, idsConAlerta: new Set() });
    assert.equal(e.origen_ubicacion, 'cliente');
    assert.equal(e.longitud, -70.6);
});

test('una guia de otro cliente o que no es despacho no cuenta', () => {
    for (const extra of [{ g_cliente_id: 99 }, { g_tipo: 'retiro' }]) {
        const e = armarEquipo(filaEquipo(extra), { bodega: BODEGA, idsConAlerta: new Set() });
        assert.equal(e.origen_ubicacion, 'cliente');
    }
});

test('arrendado sin ninguna coordenada: queda sin ubicacion (va a la lista)', () => {
    const e = armarEquipo(
        filaEquipo({ g_lat: null, g_lng: null, c_lat: null, c_lng: null }),
        { bodega: BODEGA, idsConAlerta: new Set() }
    );
    assert.equal(e.latitud, null);
    assert.equal(e.origen_ubicacion, null);
});

test('equipo en bodega usa las coordenadas de la bodega, o ninguna si no estan cargadas', () => {
    const fila = filaEquipo({ cliente_id: null, cliente_nombre: null, direccion: null, g_tipo: null });
    const con = armarEquipo(fila, { bodega: BODEGA, idsConAlerta: new Set() });
    assert.equal(con.situacion, 'bodega');
    assert.equal(con.origen_ubicacion, 'bodega');
    assert.equal(con.latitud, -33.5);
    assert.equal(con.cliente, null);
    const sin = armarEquipo(fila, { bodega: { id: 1, nombre: 'B', latitud: null, longitud: null }, idsConAlerta: new Set() });
    assert.equal(sin.latitud, null);
    assert.equal(ubicacionEquipo({ situacion: 'bodega', bodega: null }), null);
});

test('alerta_mantencion sale de la lista de alertas', () => {
    const e = armarEquipo(filaEquipo(), { bodega: BODEGA, idsConAlerta: new Set([7]) });
    assert.equal(e.alerta_mantencion, true);
});

test('furgon con posicion y ETA; sin posicion queda sin coordenadas pero listado', () => {
    const base = {
        orden_trabajo_id: 12, mecanico_nombre: 'Pedro', vehiculo_patente: 'AB1234', vehiculo_marca: 'Hyundai',
        vehiculo_modelo: 'H100', cliente_nombre: 'Acsa', maquinaria_codigo: 'GH-999',
        eta_llegada_at: new Date('2026-11-08T15:00:00Z'), eta_fuente: 'aproximada',
    };
    const con = armarFurgon({ ...base, latitud: '-33.4', longitud: '-70.6', posicion_at: new Date('2026-11-08T14:40:00Z') });
    assert.equal(con.latitud, -33.4);
    assert.equal(con.eta_aproximada, true);
    assert.ok(con.posicion_at);
    const sin = armarFurgon({ ...base, latitud: null, longitud: null, posicion_at: null, eta_llegada_at: null });
    assert.equal(sin.latitud, null);
    assert.equal(sin.posicion_at, null);
    assert.equal(sin.eta_llegada_at, null);
    assert.equal(sin.eta_aproximada, null);
    assert.equal(armarFurgon({ ...base, vehiculo_patente: null, eta_fuente: 'ors' }).vehiculo, null);
    assert.equal(armarFurgon({ ...base, eta_fuente: 'ors' }).eta_aproximada, false);
});

test('lista blanca: nada de RUT, correo, telefono, precision ni datos internos de la ETA', () => {
    const resp = armarRespuestaMapa({
        bodega: BODEGA,
        equipos: [filaEquipo({ rut: '1-9', email: 'a@b.cl', telefono: '123' })],
        furgones: [{
            orden_trabajo_id: 1, mecanico_nombre: 'P', vehiculo_patente: 'X', latitud: '-33', longitud: '-70',
            posicion_at: new Date(), maquinaria_codigo: 'C', cliente_nombre: 'A', precision_m: 5, mecanico_rut: '2-7',
            eta_origen_lat: '-33', destino_lat: '-33', eta_consultas: 3, eta_llegada_at: null, eta_fuente: null,
        }],
    });
    assert.deepEqual(Object.keys(resp).sort(), ['bodega', 'equipos', 'furgones', 'generado_at']);
    assert.deepEqual(Object.keys(resp.equipos[0]).sort(), [
        'alerta_mantencion', 'cliente', 'codigo', 'direccion', 'estado', 'id', 'latitud', 'longitud',
        'marca', 'modelo', 'origen_ubicacion', 'situacion', 'tipo',
    ]);
    assert.deepEqual(Object.keys(resp.furgones[0]).sort(), [
        'cliente_nombre', 'eta_aproximada', 'eta_llegada_at', 'latitud', 'longitud', 'maquinaria_codigo',
        'mecanico_nombre', 'orden_trabajo_id', 'posicion_at', 'vehiculo',
    ]);
    assert.deepEqual(Object.keys(resp.bodega).sort(), ['id', 'latitud', 'longitud', 'nombre']);
    const texto = JSON.stringify(resp);
    for (const prohibido of ['rut', 'email', 'telefono', 'precision', 'eta_origen', 'destino_', 'eta_consultas', '1-9', '2-7']) {
        assert.ok(!texto.includes(prohibido), `no debe aparecer ${prohibido}`);
    }
});

test('sin fila de bodega, bodega es null y los equipos en bodega salen sin ubicacion', () => {
    assert.equal(armarBodega(null), null);
    const resp = armarRespuestaMapa({
        bodega: null,
        equipos: [filaEquipo({ cliente_id: null, g_tipo: null })],
        furgones: [],
    });
    assert.equal(resp.bodega, null);
    assert.equal(resp.equipos[0].latitud, null);
});
