// Pruebas de escritura contra una base de datos local.
//
// Verifican las reglas que solo se pueden comprobar escribiendo: que un reintento de la cola
// offline no duplique datos, que anular una linea devuelva el stock y que las transiciones de
// la OT se respeten. Por eso NO corren contra el servidor real: levantan las rutas en memoria,
// sobre la base de `DATABASE_URL`, crean sus propios datos y los borran al terminar.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test
//
// Sin esa variable se omiten con el motivo, igual que la bateria de integracion.
//
// Los tokens se firman con un secreto propio de la prueba: no se usa ninguna credencial real.

require('dotenv').config();
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-escritura';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
const datos = { ordenes: [], insumos: [], equipos: [], ubicaciones: [], solicitudes: [], storage: { subidos: [], borrados: [] } };
const tokens = {};

function requiereBase(t) {
    if (!HABILITADO) {
        t.skip('pruebas de escritura deshabilitadas: usar GOMAQ_TEST_ESCRITURA=1 con una base local');
        return false;
    }
    return true;
}

async function pedir(metodo, ruta, rol, cuerpo, cabeceras = {}) {
    const r = await fetch(`${base}${ruta}`, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[rol]}`, ...cabeceras },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body: json };
}

before(async () => {
    if (!HABILITADO) return;
    const express = require('express');
    pool = require('../src/config/db');

    const app = express();
    app.use(express.json());
    app.use('/api/ordenes-trabajo', require('../src/routes/ordenes'));
    app.use('/api/ordenes-trabajo', require('../src/routes/evidencias'));
    app.use('/api/ordenes-trabajo', require('../src/routes/facturas'));
    app.use('/api/solicitudes', require('../src/routes/solicitudes'));
    app.use('/api/insumos', require('../src/routes/insumos'));
    app.use('/api/horometro', require('../src/routes/horometro').router);
    app.use('/api/facturacion', require('../src/routes/facturacion'));
    app.use('/api/rentabilidad', require('../src/routes/rentabilidad'));
    app.use('/api/maquinarias', require('../src/routes/maquinarias'));
    app.use('/api/maquinarias', require('../src/routes/guias'));
    // la subida de la factura no toca Supabase de verdad: se anotan los archivos que se suben y borran
    const { supabase } = require('../src/config/supabase');
    supabase.storage.from = () => ({
        upload: async (ruta) => { datos.storage.subidos.push(ruta); return { data: {}, error: null }; },
        remove: async (rutas) => { datos.storage.borrados.push(...rutas); return { data: [], error: null }; },
    });
    await new Promise((resolve) => { servidor = app.listen(0, resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;

    const usuarios = await pool.query(
        `SELECT id, rol, email FROM usuarios
         WHERE email IN ('administrativo@gomaq.test', 'mecanico@gomaq.test', 'mecanico2@gomaq.test', 'admin@gomaq.test', 'cliente@gomaq.test')`
    );
    const porEmail = Object.fromEntries(usuarios.rows.map((u) => [u.email, u]));
    const firmar = (u) => jwt.sign({ id: u.id, rol: u.rol, cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokens.administrativo = firmar(porEmail['administrativo@gomaq.test']);
    tokens.gerente = firmar(porEmail['admin@gomaq.test']);
    tokens.mecanico = firmar(porEmail['mecanico@gomaq.test']);
    tokens.mecanicoDos = firmar(porEmail['mecanico2@gomaq.test']);
    tokens.cliente = firmar(porEmail['cliente@gomaq.test']);
    datos.mecanicoId = porEmail['mecanico@gomaq.test'].id;
    datos.mecanicoDosId = porEmail['mecanico2@gomaq.test'].id;

    const maquinaria = await pool.query(
        'SELECT id, estado, estado_origen, alerta_mantencion_enviada, horometro_ultima_mantencion FROM maquinarias ORDER BY id LIMIT 1'
    );
    datos.maquinariaId = maquinaria.rows[0].id;
    // la lectura de horometro de las pruebas puede disparar el aviso de mantencion: se guarda
    // el estado del equipo para dejarlo como estaba
    datos.maquinariaOriginal = maquinaria.rows[0];
    datos.inicio = new Date();
});

/**
 * Borra OT de prueba junto con sus eventos. Los triggers de ordenes_eventos rechazan el DELETE
 * salvo que la transaccion active `gomaq.purga`; SET LOCAL la limita a este BEGIN/COMMIT.
 */
async function purgarOrdenes(ids) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL gomaq.purga = 'on'");
        await client.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = ANY($1)', [ids]);
        await client.query('DELETE FROM ordenes_trabajo WHERE id = ANY($1)', [ids]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

after(async () => {
    if (!HABILITADO) return;
    const ots = datos.ordenes;
    if (datos.solicitudes.length) {
        await pool.query('DELETE FROM solicitudes WHERE id = ANY($1)', [datos.solicitudes]);
    }
    if (ots.length) {
        await pool.query('DELETE FROM notificaciones_pendientes WHERE (payload->>\'orden_trabajo_id\')::int = ANY($1)', [ots]);
        await pool.query('DELETE FROM lecturas_horometro WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM tramos_trabajo WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM evidencias_fotograficas WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM firmas_recepcion WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM movimientos_insumo WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM facturas WHERE orden_trabajo_id = ANY($1)', [ots]);
        // ordenes_eventos es de solo insercion (migracion 020): borrar las OT de prueba y su
        // historial exige la via de purga, que vale solo dentro de esta transaccion
        await purgarOrdenes(ots);
    }
    if (datos.equipos.length) {
        await pool.query('DELETE FROM facturas WHERE maquinaria_id = ANY($1)', [datos.equipos]);
        await pool.query('DELETE FROM guias WHERE maquinaria_id = ANY($1)', [datos.equipos]);
        await pool.query('DELETE FROM lecturas_horometro WHERE maquinaria_id = ANY($1)', [datos.equipos]);
        await pool.query('DELETE FROM maquinarias WHERE id = ANY($1)', [datos.equipos]);
    }
    await pool.query(
        `DELETE FROM notificaciones_pendientes
         WHERE created_at >= $1 AND payload->>'tipo' = 'mantencion_proxima'
           AND (payload->>'maquinaria_id')::int = $2`,
        [datos.inicio, datos.maquinariaId]
    );
    await pool.query(
        'UPDATE maquinarias SET alerta_mantencion_enviada = $1, horometro_ultima_mantencion = $2, estado = $4, estado_origen = $5 WHERE id = $3',
        [datos.maquinariaOriginal.alerta_mantencion_enviada, datos.maquinariaOriginal.horometro_ultima_mantencion, datos.maquinariaId,
         datos.maquinariaOriginal.estado, datos.maquinariaOriginal.estado_origen]
    );
    if (datos.insumos.length) {
        await pool.query('DELETE FROM movimientos_insumo WHERE insumo_id = ANY($1)', [datos.insumos]);
        await pool.query('DELETE FROM stock_ubicacion WHERE insumo_id = ANY($1)', [datos.insumos]);
        await pool.query('DELETE FROM insumos WHERE id = ANY($1)', [datos.insumos]);
    }
    if (datos.ubicaciones.length) {
        await pool.query('DELETE FROM stock_ubicacion WHERE ubicacion_id = ANY($1)', [datos.ubicaciones]);
        await pool.query('DELETE FROM ubicaciones_stock WHERE id = ANY($1)', [datos.ubicaciones]);
    }
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

/** OT de prueba asignada al mecanico, creada directo en la base. */
async function crearOt(estado = 'en_terreno', mecanicoId = datos.mecanicoId, maquinariaId = datos.maquinariaId) {
    // con el cliente del equipo, para que cerrar o asignar encolen el aviso como en la realidad
    const r = await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
         SELECT id, cliente_id, $2, $3, 'OT de prueba automatizada' FROM maquinarias WHERE id = $1
         RETURNING id`,
        [maquinariaId, mecanicoId, estado]
    );
    datos.ordenes.push(r.rows[0].id);
    return r.rows[0].id;
}

/** Insumo de prueba con stock en la bodega central. */
async function crearInsumoConStock(cantidad) {
    const r = await pool.query(
        `INSERT INTO insumos (nombre, unidad_medida) VALUES ($1, 'unidad') RETURNING id`,
        [`Insumo de prueba ${crypto.randomUUID()}`]
    );
    const id = r.rows[0].id;
    datos.insumos.push(id);
    const ingreso = await pedir('POST', `/api/insumos/${id}/ingreso`, 'administrativo', { cantidad });
    assert.equal(ingreso.status, 200);
    return id;
}

/** Ubicacion de stock tipo furgon sin vehiculo, solo para recibir transferencias en las pruebas. */
async function crearFurgonDePrueba() {
    const r = await pool.query(
        `INSERT INTO ubicaciones_stock (nombre, tipo) VALUES ($1, 'furgon') RETURNING id`,
        [`Furgon de prueba ${crypto.randomUUID()}`]
    );
    datos.ubicaciones.push(r.rows[0].id);
    return r.rows[0].id;
}

async function stockBodega(insumoId) {
    const r = await pool.query(
        `SELECT su.cantidad FROM stock_ubicacion su
         JOIN ubicaciones_stock u ON u.id = su.ubicacion_id
         WHERE u.tipo = 'bodega' AND su.insumo_id = $1`,
        [insumoId]
    );
    return r.rows[0] ? Number(r.rows[0].cantidad) : 0;
}

const MOTIVO_VALIDO = { motivo_codigo: 'error_registro', motivo: 'Se registró mal el repuesto en el talonario' };

describe('reintentos de la cola offline', () => {
    test('una linea de repuesto reintentada se registra y descuenta una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const uuid = crypto.randomUUID();
        const cuerpo = { insumo_id: insumo, cantidad: 3, facturable: 'si', uuid_cliente: uuid };

        const primera = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', cuerpo);
        const segunda = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', cuerpo);

        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200, 'el reintento responde la linea existente');
        assert.equal(segunda.body.id, primera.body.id);
        const lineas = await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(lineas.rows.length, 1);
        assert.equal(await stockBodega(insumo), 7, 'el stock se descuenta una sola vez');
    });

    test('dos reintentos simultaneos tampoco duplican', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const cuerpo = { insumo_id: insumo, cantidad: 2, uuid_cliente: crypto.randomUUID() };

        const respuestas = await Promise.all([1, 2, 3].map(() =>
            pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', cuerpo)));

        assert.ok(respuestas.every((r) => r.status === 200 || r.status === 201));
        const lineas = await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(lineas.rows.length, 1);
        assert.equal(await stockBodega(insumo), 8);
    });

    test('una carga de furgon reintentada descuenta la bodega una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const destino = await crearFurgonDePrueba();
        const cuerpo = { insumo_id: insumo, cantidad: 4, ubicacion_destino_id: destino, uuid_cliente: crypto.randomUUID() };

        const primera = await pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo);
        const segunda = await pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo);

        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200, 'el reintento responde lo ya hecho');
        assert.equal(segunda.body.ya_registrada, true);
        assert.equal(await stockBodega(insumo), 6, 'la bodega se descuenta una sola vez');
        const movimientos = await pool.query(
            'SELECT id FROM movimientos_insumo WHERE insumo_id = $1 AND ubicacion_destino_id = $2', [insumo, destino]);
        assert.equal(movimientos.rows.length, 1);
    });

    test('tres cargas de furgon simultaneas con el mismo uuid no duplican', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const destino = await crearFurgonDePrueba();
        const cuerpo = { insumo_id: insumo, cantidad: 2, ubicacion_destino_id: destino, uuid_cliente: crypto.randomUUID() };

        const respuestas = await Promise.all([1, 2, 3].map(() =>
            pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo)));

        assert.ok(respuestas.every((r) => r.status === 200 || r.status === 201), JSON.stringify(respuestas.map((r) => r.status)));
        assert.equal(await stockBodega(insumo), 8);
    });

    test('una carga de furgon con uuid malformado se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(5);
        const r = await pedir('POST', '/api/insumos/transferencia', 'administrativo',
            { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: await crearFurgonDePrueba(), uuid_cliente: 'no-es-un-uuid' });
        assert.equal(r.status, 400);
    });

    test('el catalogo de insumos trae el stock de bodega', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(7);
        const r = await pedir('GET', '/api/insumos', 'mecanico');
        assert.equal(r.status, 200);
        const fila = r.body.find((i) => i.id === insumo);
        assert.equal(fila.stock_bodega, 7);
        assert.equal(fila.stock_furgon, 0);
    });

    test('rechaza un uuid_cliente malformado', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const r = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', {
            descripcion: 'Filtro', cantidad: 1, uuid_cliente: 'no-es-un-uuid',
        });
        assert.equal(r.status, 400);
    });

    test('un tramo reintentado se registra una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const cuerpo = { inicio: new Date().toISOString(), uuid_cliente: crypto.randomUUID() };
        const primera = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', cuerpo);
        const segunda = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        const tramos = await pool.query('SELECT id FROM tramos_trabajo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(tramos.rows.length, 1);
    });

    test('cerrar un tramo abierto lo completa en vez de crear otro', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const inicio = new Date(Date.now() - 3600 * 1000).toISOString();
        await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', { inicio, uuid_cliente: crypto.randomUUID() });
        const termino = new Date().toISOString();
        const uuidCierre = crypto.randomUUID();
        const cierre = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', {
            inicio, termino, uuid_cliente: uuidCierre,
        });
        assert.equal(cierre.status, 200);
        // reintento del mismo cierre (se perdio la respuesta): tampoco debe crear otro tramo
        const reintento = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', {
            inicio, termino, uuid_cliente: uuidCierre,
        });
        assert.equal(reintento.status, 200);
        const tramos = await pool.query('SELECT termino FROM tramos_trabajo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(tramos.rows.length, 1, 'un solo tramo, ya cerrado');
        assert.ok(tramos.rows[0].termino);
    });

    test('una lectura de horometro reintentada se registra una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const cuerpo = { valor: 1234, orden_trabajo_id: ot, uuid_cliente: crypto.randomUUID() };
        const ruta = `/api/horometro/maquinaria/${datos.maquinariaId}`;
        const primera = await pedir('POST', ruta, 'mecanico', cuerpo);
        const segunda = await pedir('POST', ruta, 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.ya_registrada, true);
        const lecturas = await pool.query('SELECT id FROM lecturas_horometro WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(lecturas.rows.length, 1);
    });

    test('una OT en terreno reintentada devuelve la misma orden', async (t) => {
        if (!requiereBase(t)) return;
        const cuerpo = { maquinaria_id: datos.maquinariaId, uuid_cliente: crypto.randomUUID() };
        const primera = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        datos.ordenes.push(primera.body.id);
        const segunda = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.id, primera.body.id);
        assert.ok(primera.body.llegada_at, 'una OT abierta en terreno ya tiene su hora de llegada');
    });
});

describe('anulacion de lineas de repuesto', () => {
    test('anular devuelve el stock, deja la linea tachada y es idempotente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const linea = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            insumo_id: insumo, cantidad: 4, facturable: 'si',
        });
        assert.equal(await stockBodega(insumo), 6);

        const ruta = `/api/insumos/orden/${ot}/linea/${linea.body.id}/anular`;
        const anulada = await pedir('POST', ruta, 'administrativo');
        assert.equal(anulada.status, 200);
        assert.ok(anulada.body.anulada_at, 'queda la fecha de anulacion');
        assert.equal(anulada.body.orden_facturable, false, 'sin lineas vigentes la OT no se cobra');
        assert.equal(await stockBodega(insumo), 10);

        const otraVez = await pedir('POST', ruta, 'administrativo');
        assert.equal(otraVez.status, 200);
        assert.equal(await stockBodega(insumo), 10, 'anular dos veces no devuelve el stock dos veces');
    });

    test('el mecanico no anula lineas de una OT ajena', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno', datos.mecanicoDosId);
        const linea = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanicoDos', { descripcion: 'Correa', cantidad: 1 });
        const r = await pedir('POST', `/api/insumos/orden/${ot}/linea/${linea.body.id}/anular`, 'mecanico');
        assert.equal(r.status, 403);
    });

    test('el mecanico no anula lineas de una OT finalizada, el administrativo si', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Correa', cantidad: 1 });
        await pool.query("UPDATE ordenes_trabajo SET estado = 'finalizada' WHERE id = $1", [ot]);
        const ruta = `/api/insumos/orden/${ot}/linea/${linea.body.id}/anular`;
        assert.equal((await pedir('POST', ruta, 'mecanico')).status, 409);
        // cerrada la OT, el panel anula solo con motivo (bloque 1b)
        assert.equal((await pedir('POST', ruta, 'administrativo')).status, 400);
        assert.equal((await pedir('POST', ruta, 'administrativo', MOTIVO_VALIDO)).status, 200);
    });
});

describe('horometro de cualquier equipo', () => {
    test('el mecanico registra la lectura de un equipo que no es de ninguna orden suya', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico',
            { valor: 321, uuid_cliente: crypto.randomUUID() });
        assert.equal(r.status, 201);
        assert.equal(r.body.lectura.origen, 'movil');
        assert.equal(r.body.lectura.orden_trabajo_id, null);
    });

    test('un reintento de la lectura sin orden no la duplica', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const cuerpo = { valor: 100, uuid_cliente: crypto.randomUUID() };
        const primera = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico', cuerpo);
        const segunda = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        const filas = await pool.query('SELECT id FROM lecturas_horometro WHERE maquinaria_id = $1', [equipo.id]);
        assert.equal(filas.rows.length, 1);
    });

    test('el mecanico puede reiniciar el contador de un equipo sin tener una orden', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico',
            { valor: 500, reiniciar_contador: true });
        assert.equal(r.status, 201);
        assert.equal(r.body.contador_reiniciado, true);
    });
});

describe('despacho sin documento', () => {
    test('un despacho sin PDF asigna el equipo al cliente y queda marcado como sin documento', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const cliente = await algunCliente();

        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'despacho', cliente_id: cliente, sin_documento: true });

        assert.equal(r.status, 201);
        assert.equal(r.body.archivo_url, null);
        assert.equal(r.body.falta_documento, true);
        assert.ok(r.body.registrada_por, 'queda quien la registro');
        const maq = await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [equipo.id]);
        assert.equal(maq.rows[0].cliente_id, cliente, 'el equipo queda arrendado al cliente');
    });

    test('sin PDF y sin pedirlo expresamente se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'despacho', cliente_id: await algunCliente() });
        assert.equal(r.status, 400);
    });

    test('el mecanico no puede despachar sin documento', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'mecanico',
            { tipo: 'despacho', cliente_id: await algunCliente(), sin_documento: true });
        assert.equal(r.status, 403);
    });

    test('una recepcion sin documento libera el equipo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(cliente);
        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'recepcion', sin_documento: true });
        assert.equal(r.status, 201);
        const maq = await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [equipo.id]);
        assert.equal(maq.rows[0].cliente_id, null);
    });

    test('las guias sin documento se listan completas, sin tope', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const creada = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'despacho', cliente_id: await algunCliente(), sin_documento: true });
        assert.equal(creada.status, 201);

        const lista = await pedir('GET', '/api/maquinarias/guias/recientes?sin_documento=1', 'administrativo');
        assert.equal(lista.status, 200);
        const fila = lista.body.find((g) => g.id === creada.body.id);
        assert.ok(fila, 'aparece entre las que faltan');
        assert.equal(fila.falta_documento, true);
        assert.equal(fila.url, null);
    });

    test('adjuntar un documento a una guia que ya lo tiene, o que no existe, se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const g = await pool.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha) VALUES ($1, 'despacho', 'guias/ya-tiene.pdf', now()) RETURNING id`,
            [equipo.id]
        );
        const enviar = (id) => {
            // un formulario por envio: el cuerpo se consume al enviarlo
            const formulario = new FormData();
            formulario.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'g.pdf');
            return fetch(`${base}/api/maquinarias/guias/${id}/archivo`, {
                method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario,
            });
        };
        assert.equal((await enviar(g.rows[0].id)).status, 409);
        assert.equal((await enviar(999999999)).status, 404);
    });
});

describe('viaje del mecanico y ordenes sin asignar', () => {
    async function estadoDe(ot) {
        const r = await pool.query('SELECT estado, aceptada_at, en_camino_at, llegada_at FROM ordenes_trabajo WHERE id = $1', [ot]);
        return r.rows[0];
    }

    test('aceptar, salir y llegar fijan el estado y su hora, una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');

        const aceptada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada' });
        assert.equal(aceptada.status, 200);
        const primeraHora = (await estadoDe(ot)).aceptada_at;
        assert.ok(primeraHora, 'queda la hora de aceptacion');

        const camino = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino' });
        assert.equal(camino.status, 200);
        const llegada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno' });
        assert.equal(llegada.status, 200);

        // reintentos atrasados de la cola: no retroceden el estado ni pisan las horas
        const reintento = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada' });
        assert.equal(reintento.status, 200);
        const fila = await estadoDe(ot);
        assert.equal(fila.estado, 'en_terreno');
        assert.equal(fila.aceptada_at.getTime(), primeraHora.getTime());
        assert.ok(fila.en_camino_at && fila.llegada_at);
    });

    test('la hora del toque en el telefono se respeta y nunca queda en el futuro', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 day' WHERE id = $1", [ot]);
        const hace2h = new Date(Date.now() - 2 * 3600 * 1000);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: hace2h.toISOString() });
        const fila = await estadoDe(ot);
        assert.ok(Math.abs(fila.aceptada_at.getTime() - hace2h.getTime()) < 1000);

        const ot2 = await crearOt('asignada');
        const manana = new Date(Date.now() + 24 * 3600 * 1000);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot2}/diagnostico`, 'mecanico', { estado: 'en_camino', ocurrio_en: manana.toISOString() });
        assert.ok((await estadoDe(ot2)).en_camino_at.getTime() <= Date.now() + 1000);
    });

    test('un APK anterior puede pasar de asignada directo a en_terreno', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno' });
        assert.equal(r.status, 200);
        assert.equal((await estadoDe(ot)).estado, 'en_terreno');
    });

    test('reasignar una OT del viaje a otro tecnico la deja asignada y borra las horas del anterior', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada' });
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino' });
        const antes = await estadoDe(ot);
        assert.ok(antes.aceptada_at && antes.en_camino_at);

        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        assert.equal(r.status, 200);
        const fila = await estadoDe(ot);
        assert.equal(fila.estado, 'asignada');
        assert.equal(fila.aceptada_at, null);
        assert.equal(fila.en_camino_at, null);
    });

    test('asignar otra vez al mismo tecnico una OT en camino no la hace retroceder', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino' });
        const antes = await estadoDe(ot);

        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
        assert.equal(r.status, 200);
        const fila = await estadoDe(ot);
        assert.equal(fila.estado, 'en_camino');
        assert.equal(fila.en_camino_at.getTime(), antes.en_camino_at.getTime());
    });

    test('la hora del telefono no puede quedar antes de que existiera la orden', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const antiguo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: antiguo.toISOString() });
        const creada = (await pool.query('SELECT fecha_creacion FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0].fecha_creacion;
        assert.ok((await estadoDe(ot)).aceptada_at.getTime() >= creada.getTime());
    });

    test('un id no numerico al tomar una orden responde 400', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('PATCH', '/api/ordenes-trabajo/abc/tomar', 'mecanico');
        assert.equal(r.status, 400);
    });

    test('el mecanico ve las ordenes sin asignar y las puede tomar', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);

        const lista = await pedir('GET', '/api/ordenes-trabajo?sin_asignar=1', 'mecanico');
        assert.equal(lista.status, 200);
        assert.ok(lista.body.items.some((o) => o.id === ot), 'aparece entre las sin asignar');
        const suyas = await pedir('GET', '/api/ordenes-trabajo', 'mecanico');
        assert.ok(!suyas.body.items.some((o) => o.id === ot), 'no aparece en sus ordenes mientras no la tome');

        const tomada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico');
        assert.equal(tomada.status, 200);
        assert.equal(tomada.body.estado, 'asignada');
        assert.equal(tomada.body.mecanico_id, datos.mecanicoId);

        const reintento = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico');
        assert.equal(reintento.status, 200, 'reintentar la propia toma responde bien');
        const otro = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanicoDos');
        assert.equal(otro.status, 409, 'otro mecanico ya no puede tomarla');
    });

    test('dos mecanicos tomando la misma orden a la vez: solo uno la logra', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);
        const [a, b] = await Promise.all([
            pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico'),
            pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanicoDos'),
        ]);
        assert.deepEqual([a.status, b.status].sort(), [200, 409]);
        const r = await pool.query('SELECT mecanico_id FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.ok([datos.mecanicoId, datos.mecanicoDosId].includes(r.rows[0].mecanico_id));
    });

    test('no se puede tomar una orden que ya tiene mecanico ni una inexistente', async (t) => {
        if (!requiereBase(t)) return;
        const asignada = await crearOt('asignada', datos.mecanicoDosId);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${asignada}/tomar`, 'mecanico')).status, 409);
        assert.equal((await pedir('PATCH', '/api/ordenes-trabajo/999999999/tomar', 'mecanico')).status, 404);
    });
});

describe('ciclo de vida de la OT', () => {
    const avisosDe = async (ot, tipo) => (await pool.query(
        `SELECT id FROM notificaciones_pendientes
         WHERE (payload->>'orden_trabajo_id')::int = $1 AND payload->>'tipo' = $2`,
        [ot, tipo]
    )).rows.length;

    test('cerrar dos veces no cambia la fecha de cierre ni repite el aviso al cliente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        const cuerpo = { persona_recibe: 'Juan Perez' };
        const primera = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', cuerpo);
        const segunda = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', cuerpo);
        assert.equal(primera.status, 200);
        assert.equal(segunda.status, 200, 'el reintento responde bien');
        assert.equal(segunda.body.fecha_cierre, primera.body.fecha_cierre);
        const cliente = await pool.query('SELECT cliente_id FROM ordenes_trabajo WHERE id = $1', [ot]);
        if (cliente.rows[0].cliente_id) {
            assert.ok(await avisosDe(ot, 'ot_finalizada') <= 1, 'a lo mas un aviso de cierre');
        }
    });

    test('una OT finalizada no se reasigna ni se reabre', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        const asignar = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        assert.equal(asignar.status, 409);
        const reabrir = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno' });
        assert.equal(reabrir.status, 409);
        const estado = await pool.query('SELECT estado, mecanico_id FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.equal(estado.rows[0].estado, 'finalizada');
        assert.equal(estado.rows[0].mecanico_id, datos.mecanicoId);
    });

    test('reasignar una OT en curso cambia el tecnico sin hacerla retroceder', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        assert.equal(r.status, 200);
        assert.equal(r.body.estado, 'en_reparacion');
        assert.equal(r.body.mecanico_id, datos.mecanicoDosId);
    });

    test('el mecanico no agrega repuestos, tramos ni fotos a una OT cerrada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        assert.equal((await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Filtro', cantidad: 1 })).status, 409);
        assert.equal((await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', { inicio: new Date().toISOString() })).status, 409);
        assert.equal((await pedir('POST', `/api/ordenes-trabajo/${ot}/evidencia/confirmar`, 'mecanico', { path: `ot-${ot}/x.jpg` })).status, 409);
    });

    test('la evidencia de otra orden se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/evidencia/confirmar`, 'mecanico', { path: `ot-${ot + 1}/ajena.jpg` });
        assert.equal(r.status, 400);
    });

    test('solo se valoriza una OT finalizada, y no aparece antes en la cola del gerente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Bomba', cantidad: 1, facturable: 'si' });
        const enCurso = await pedir('GET', '/api/facturacion/pendientes', 'gerente');
        assert.ok(!enCurso.body.reparaciones_pendientes_valorizar.some((o) => o.id === ot), 'en curso no se valoriza');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1000 })).status, 409);

        await pool.query("UPDATE ordenes_trabajo SET estado = 'finalizada' WHERE id = $1", [ot]);
        const cerrada = await pedir('GET', '/api/facturacion/pendientes', 'gerente');
        assert.ok(cerrada.body.reparaciones_pendientes_valorizar.some((o) => o.id === ot));
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 0 })).status, 200);
    });
});

// ---------------------------------------------------------------------------------------------
// Cliente de la orden y costos por equipo
// ---------------------------------------------------------------------------------------------

/** Equipo propio de la prueba: las reglas no deben depender de los equipos que ya existan. */
async function crearEquipo(clienteId = null) {
    const r = await pool.query(
        `INSERT INTO maquinarias (codigo, tipo, cliente_id) VALUES ($1, 'Equipo de prueba', $2) RETURNING id, codigo`,
        [`ZZ-${crypto.randomUUID().slice(0, 8)}`, clienteId]
    );
    datos.equipos.push(r.rows[0].id);
    return r.rows[0];
}

async function algunCliente() {
    const r = await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 1');
    return r.rows[0] ? r.rows[0].id : null;
}

describe('cliente de la orden de trabajo', () => {
    test('una orden nueva toma el cliente que tiene el equipo, sin que se lo pidan', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(clienteId);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, motivo: 'prueba' });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.cliente_id, clienteId);
    });

    test('un equipo sin cliente da una orden sin cliente: es mantencion interna', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, motivo: 'prueba' });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.cliente_id, null);
    });

    test('un cliente explicito de la llamada se respeta', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, cliente_id: clienteId });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.cliente_id, clienteId);
    });

    test('la orden conserva su cliente aunque el equipo se devuelva despues', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(clienteId);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, motivo: 'prueba' });
        datos.ordenes.push(r.body.id);
        // la guia de recepcion deja el equipo sin cliente
        await pool.query('UPDATE maquinarias SET cliente_id = NULL WHERE id = $1', [equipo.id]);
        const guardada = await pool.query('SELECT cliente_id FROM ordenes_trabajo WHERE id = $1', [r.body.id]);
        assert.equal(guardada.rows[0].cliente_id, clienteId);
    });

    test('un equipo que no existe se informa como tal, no como error del servidor', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: 999999999, motivo: 'prueba' });
        assert.equal(r.status, 404);
    });

    test('sin equipo se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { motivo: 'prueba' });
        assert.equal(r.status, 400);
    });
});

describe('costos por equipo', () => {
    /** Un equipo con todo lo que entra a las cuentas: repuestos, factura, arriendo y horometro. */
    async function equipoConMovimiento() {
        const clienteId = await algunCliente();
        const equipo = await crearEquipo(clienteId);
        const ot = await crearOt('finalizada', datos.mecanicoId, equipo.id);

        // gasto: 3 x $1.000, mas una linea anulada que NO debe contar
        await pool.query(
            `INSERT INTO movimientos_insumo (orden_trabajo_id, cantidad, tipo, precio_unitario, descripcion)
             VALUES ($1, 3, 'salida', 1000, 'repuesto de prueba')`,
            [ot]
        );
        await pool.query(
            `INSERT INTO movimientos_insumo (orden_trabajo_id, cantidad, tipo, precio_unitario, descripcion, anulada_at)
             VALUES ($1, 5, 'salida', 9999, 'linea anulada de prueba', now())`,
            [ot]
        );
        // ingreso: una factura de arriendo directa al equipo
        await pool.query(`INSERT INTO facturas (folio, archivo_url, monto, maquinaria_id) VALUES ('T-COSTOS', 'x', 10000, $1)`, [equipo.id]);

        // arriendo del dia 40 al 35 hacia atras (6 dias con el despacho de la manana), y un
        // despacho fallido que no debe sumar nada
        const hace = (dias, hora) => {
            const d = new Date();
            d.setDate(d.getDate() - dias);
            d.setHours(hora, 0, 0, 0);
            return d;
        };
        const guia = (tipo, fecha, fallido = false) =>
            pool.query(
                `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, fallido, cliente_id) VALUES ($1, $2, 'x', $3, $4, $5)`,
                [equipo.id, tipo, fecha, fallido, clienteId]
            );
        await guia('despacho', hace(40, 9));
        await guia('recepcion', hace(35, 9));
        await guia('despacho', hace(20, 9), true);
        await guia('recepcion', hace(15, 9), true);

        // horometro: 100 h hace 60 dias y 160 h hace 10 dias = 60 h de uso
        await pool.query(
            `INSERT INTO lecturas_horometro (maquinaria_id, valor, origen, fecha) VALUES ($1, 100, 'panel', $2), ($1, 160, 'panel', $3)`,
            [equipo.id, hace(60, 10), hace(10, 10)]
        );
        return equipo;
    }

    const buscar = async (equipo, extra = '') => {
        const r = await pedir('GET', `/api/rentabilidad?q=${equipo.codigo}${extra}`, 'administrativo');
        assert.equal(r.status, 200);
        return r.body;
    };

    test('calcula gasto, ingreso, margen y las medidas de la industria de un equipo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await equipoConMovimiento();
        const { items } = await buscar(equipo);
        assert.equal(items.length, 1);
        const e = items[0];
        assert.equal(e.gasto, 3000, 'la linea anulada no cuenta como gasto');
        assert.equal(e.ingreso, 10000);
        assert.equal(e.margen, 7000);
        assert.equal(e.resultado, 'con_ganancia');
        assert.equal(e.gasto_sobre_ingreso, 30);
        assert.equal(e.horas_uso, 60);
        assert.equal(e.gasto_por_hora, 50);
        assert.equal(e.dias_arrendado, 6, 'las guias fallidas no suman dias');
    });

    test('un equipo sin movimiento queda sin datos en vez de inventarlos', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const { items } = await buscar(equipo);
        const e = items[0];
        assert.equal(e.resultado, 'sin_movimiento');
        assert.equal(e.gasto_sobre_ingreso, null);
        assert.equal(e.gasto_por_hora, null);
        assert.equal(e.horas_uso, null);
        assert.equal(e.dias_arrendado, 0);
    });

    test('el filtro por resultado deja solo los equipos de esa clase', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await equipoConMovimiento();
        const gana = await buscar(equipo, '&resultado=con_ganancia');
        assert.equal(gana.items.length, 1);
        const pierde = await buscar(equipo, '&resultado=a_perdida');
        assert.equal(pierde.items.length, 0);
    });

    test('el resumen de arriba no cambia al buscar un equipo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await equipoConMovimiento();
        const todos = (await pedir('GET', '/api/rentabilidad?limit=1', 'administrativo')).body;
        const uno = await buscar(equipo);
        assert.deepEqual(uno.resumen, todos.resumen);
        assert.ok(todos.resumen.gasto_total >= 3000);
        assert.ok(todos.resumen.ingreso_total >= 10000);
    });

    test('ordenar por una columna deja los vacios al final, en los dos sentidos', async (t) => {
        if (!requiereBase(t)) return;
        await equipoConMovimiento();
        for (const dir of ['asc', 'desc']) {
            const r = await pedir('GET', `/api/rentabilidad?orden=hora&dir=${dir}`, 'administrativo');
            const valores = r.body.items.map((e) => e.gasto_por_hora);
            const primerVacio = valores.indexOf(null);
            if (primerVacio !== -1) assert.ok(valores.slice(primerVacio).every((v) => v === null), `${dir}: un valor aparecio despues de un vacio`);
            const conValor = valores.filter((v) => v !== null);
            const esperado = [...conValor].sort((a, b) => (dir === 'asc' ? a - b : b - a));
            assert.deepEqual(conValor, esperado);
        }
    });

    test('un orden inventado no rompe la consulta', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', `/api/rentabilidad?orden=${encodeURIComponent("x'; DROP TABLE maquinarias; --")}`, 'administrativo');
        assert.equal(r.status, 200);
    });

    test('el mecanico no ve los costos', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', '/api/rentabilidad', 'mecanico');
        assert.equal(r.status, 403);
    });
});

describe('alta de equipos', () => {
    test('repetir un codigo se informa como un choque que se puede corregir, no como un error del servidor', async (t) => {
        if (!requiereBase(t)) return;
        const codigo = `ZZ-${crypto.randomUUID().slice(0, 8)}`;
        const primero = await pedir('POST', '/api/maquinarias', 'administrativo', { codigo, tipo: 'Equipo de prueba' });
        assert.equal(primero.status, 201);
        datos.equipos.push(primero.body.id);
        const repetido = await pedir('POST', '/api/maquinarias', 'administrativo', { codigo, tipo: 'Otro' });
        assert.equal(repetido.status, 409);
        assert.match(repetido.body.error, new RegExp(codigo));
    });

    test('sin codigo o sin tipo se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('POST', '/api/maquinarias', 'administrativo', { tipo: 'X' })).status, 400);
        assert.equal((await pedir('POST', '/api/maquinarias', 'administrativo', { codigo: 'ZZ-SINTIPO' })).status, 400);
    });

    test('solo el administrativo da de alta equipos', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/maquinarias', 'mecanico', { codigo: 'ZZ-NOPUEDE', tipo: 'X' });
        assert.equal(r.status, 403);
    });
});

// ---------------------------------------------------------------------------------------------
// Historial de la orden (ordenes_eventos, migracion 020)
// ---------------------------------------------------------------------------------------------

/** Eventos de una OT en el orden en que se registraron. */
async function eventosDe(ot) {
    const r = await pool.query('SELECT * FROM ordenes_eventos WHERE orden_trabajo_id = $1 ORDER BY id', [ot]);
    return r.rows;
}

describe('historial de la orden: un evento por cada cambio', () => {
    test('crear una OT desde el panel deja el evento de creacion con quien la creo', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: datos.maquinariaId, motivo: 'prueba de historial' });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        const eventos = await eventosDe(r.body.id);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'creacion');
        assert.equal(eventos[0].origen, 'panel');
        assert.equal(eventos[0].rol, 'administrativo');
        assert.equal(eventos[0].estado_nuevo, 'pendiente');
        assert.ok(eventos[0].usuario_id);
        assert.equal(eventos[0].aplicado, true);
        assert.equal(eventos[0].hora_dudosa, false);
    });

    test('una creacion que falla no deja evento ni OT a medias', async (t) => {
        if (!requiereBase(t)) return;
        // solo se mira lo que esta prueba habria creado, reconocible por su motivo: no depende de
        // que otras pruebas o procesos escriban a la vez
        const marcador = `creacion-fallida-${crypto.randomUUID()}`;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', {
            // un cliente que no existe rompe el INSERT (clave foranea) despues de empezar la transaccion
            maquinaria_id: datos.maquinariaId, cliente_id: 99999999, motivo: marcador,
        });
        assert.equal(r.status, 500);
        const ots = await pool.query('SELECT id FROM ordenes_trabajo WHERE motivo = $1', [marcador]);
        assert.equal(ots.rows.length, 0);
        const eventos = await pool.query(
            `SELECT count(*)::int AS n FROM ordenes_eventos e JOIN ordenes_trabajo o ON o.id = e.orden_trabajo_id WHERE o.motivo = $1`,
            [marcador]
        );
        assert.equal(eventos.rows[0].n, 0);
    });

    test('la OT que el mecanico abre en terreno deja su evento, y el reintento no lo duplica', async (t) => {
        if (!requiereBase(t)) return;
        const uuid = crypto.randomUUID();
        const cuerpo = { maquinaria_id: datos.maquinariaId, uuid_cliente: uuid };
        const primera = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        datos.ordenes.push(primera.body.id);
        const segunda = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        assert.equal(segunda.status, 200);
        const eventos = await eventosDe(primera.body.id);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'creacion');
        assert.equal(eventos[0].origen, 'terreno');
        assert.equal(eventos[0].estado_nuevo, 'en_terreno');
        assert.equal(eventos[0].uuid_cliente, uuid);
        assert.equal(eventos[0].detalle.mecanico_id, datos.mecanicoId);
    });

    test('convertir una solicitud en OT deja el evento de creacion', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(clienteId);
        const sol = await pool.query(
            `INSERT INTO solicitudes (cliente_id, maquinaria_id, descripcion) VALUES ($1, $2, 'solicitud de prueba') RETURNING id`,
            [clienteId, equipo.id]
        );
        datos.solicitudes.push(sol.rows[0].id);
        const r = await pedir('PATCH', `/api/solicitudes/${sol.rows[0].id}/convertir`, 'administrativo');
        assert.equal(r.status, 200);
        datos.ordenes.push(r.body.orden_trabajo.id);
        const eventos = await eventosDe(r.body.orden_trabajo.id);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'creacion');
        assert.equal(eventos[0].detalle.solicitud_id, sol.rows[0].id);
        // convertirla otra vez se rechaza y no agrega nada
        assert.equal((await pedir('PATCH', `/api/solicitudes/${sol.rows[0].id}/convertir`, 'administrativo')).status, 400);
        assert.equal((await eventosDe(r.body.orden_trabajo.id)).length, 1);
    });

    test('asignar deja el evento con el tecnico anterior y el nuevo; asignar al mismo no repite', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
        assert.equal(r.status, 200);
        let eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'asignacion');
        assert.equal(eventos[0].estado_anterior, 'pendiente');
        assert.equal(eventos[0].estado_nuevo, 'asignada');
        assert.equal(eventos[0].detalle.mecanico_anterior_id, null);
        assert.equal(eventos[0].detalle.mecanico_nuevo_id, datos.mecanicoId);
        assert.equal(eventos[0].origen, 'panel');

        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
        assert.equal((await eventosDe(ot)).length, 1, 'el doble clic no deja otro evento');

        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        eventos = await eventosDe(ot);
        assert.equal(eventos.length, 2);
        assert.equal(eventos[1].detalle.mecanico_anterior_id, datos.mecanicoId);
        assert.equal(eventos[1].detalle.mecanico_nuevo_id, datos.mecanicoDosId);
    });

    test('tomar una orden deja el evento de toma, y el reintento del mismo mecanico no lo repite', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico')).status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico')).status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanicoDos')).status, 409);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'toma');
        assert.equal(eventos[0].origen, 'terreno');
        assert.equal(eventos[0].estado_nuevo, 'asignada');
        assert.equal(eventos[0].detalle.mecanico_nuevo_id, datos.mecanicoId);
    });

    test('cada cambio de estado del diagnostico deja su evento, con el uuid de la tarea (body.uuid)', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const uuid = crypto.randomUUID();
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid });
        assert.equal(r.status, 200);
        const reintento = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid });
        assert.equal(reintento.status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1, 'el reintento con el mismo uuid no duplica ni da 500');
        assert.equal(eventos[0].tipo, 'cambio_estado');
        assert.equal(eventos[0].estado_anterior, 'asignada');
        assert.equal(eventos[0].estado_nuevo, 'aceptada');
        assert.equal(eventos[0].aplicado, true);
        assert.equal(eventos[0].uuid_cliente, uuid);
        assert.equal(eventos[0].origen, 'terreno');

        const siguiente = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino', uuid_cliente: crypto.randomUUID() });
        assert.equal(siguiente.status, 200);
        assert.equal((await eventosDe(ot)).length, 2);
    });

    test('un cambio de estado atrasado se registra con aplicado = false y no mueve la OT', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid: crypto.randomUUID() });
        assert.equal(r.status, 200);
        assert.equal(r.body.estado, 'en_terreno');
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].aplicado, false);
        assert.equal(eventos[0].estado_anterior, 'en_terreno');
        assert.equal(eventos[0].estado_nuevo, 'aceptada');
    });

    test('un cambio rechazado, o un diagnostico sin estado, no deja evento', async (t) => {
        if (!requiereBase(t)) return;
        const cerrada = await crearOt('finalizada');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${cerrada}/diagnostico`, 'mecanico', { estado: 'en_terreno' })).status, 409);
        const ajena = await crearOt('en_terreno', datos.mecanicoDosId);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ajena}/diagnostico`, 'mecanico', { estado: 'en_reparacion' })).status, 403);
        const sinEstado = await crearOt('en_terreno');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${sinEstado}/diagnostico`, 'mecanico', { diagnostico: 'solo texto' })).status, 200);
        assert.equal((await eventosDe(cerrada)).length, 0);
        assert.equal((await eventosDe(ajena)).length, 0);
        assert.equal((await eventosDe(sinEstado)).length, 0);
    });

    test('un uuid malformado no rompe el cambio: se registra sin idempotencia', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid: 'no-es-un-uuid' });
        assert.equal(r.status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].uuid_cliente, null);
    });

    test('la hora del telefono en el futuro o antes de crear la OT marca el evento como dudoso', async (t) => {
        if (!requiereBase(t)) return;
        const futura = await crearOt('asignada');
        const manana = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        await pedir('PATCH', `/api/ordenes-trabajo/${futura}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: manana });
        const evFutura = (await eventosDe(futura))[0];
        assert.equal(evFutura.hora_dudosa, true);
        assert.equal(new Date(evFutura.ocurrio_en).toISOString(), manana, 'el evento guarda la hora tal como vino');

        const antigua = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 hour' WHERE id = $1", [antigua]);
        await pedir('PATCH', `/api/ordenes-trabajo/${antigua}/diagnostico`, 'mecanico', {
            estado: 'aceptada', ocurrio_en: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
        });
        assert.equal((await eventosDe(antigua))[0].hora_dudosa, true);

        const normal = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '2 hours' WHERE id = $1", [normal]);
        await pedir('PATCH', `/api/ordenes-trabajo/${normal}/diagnostico`, 'mecanico', {
            estado: 'aceptada', ocurrio_en: new Date(Date.now() - 3600 * 1000).toISOString(),
        });
        assert.equal((await eventosDe(normal))[0].hora_dudosa, false);
    });

    test('finalizar deja el evento de cierre; el reintento de un cierre ya aplicado no deja otro', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { sin_persona: true });
        assert.equal(r.status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { sin_persona: true })).status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'cierre');
        assert.equal(eventos[0].estado_anterior, 'en_reparacion');
        assert.equal(eventos[0].estado_nuevo, 'finalizada');
        assert.equal(eventos[0].origen, 'terreno');
        assert.equal(new Date(eventos[0].ocurrio_en).getTime(), new Date(r.body.fecha_cierre).getTime());
    });

    test('una orden pendiente no se cierra y no deja evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { sin_persona: true })).status, 409);
        assert.equal((await eventosDe(ot)).length, 0);
    });

    test('valorizar deja el evento con el monto anterior y el nuevo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 15000 })).status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 20000 })).status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 2);
        assert.equal(eventos[0].tipo, 'valorizacion');
        assert.equal(eventos[0].rol, 'gerente');
        assert.equal(eventos[0].origen, 'panel');
        assert.equal(eventos[0].detalle.valorizacion_anterior, null);
        assert.equal(eventos[0].detalle.valorizacion_nueva, 15000);
        assert.equal(eventos[1].detalle.valorizacion_anterior, 15000);
        assert.equal(eventos[1].detalle.valorizacion_nueva, 20000);
    });

    test('una valorizacion rechazada no deja evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 100 })).status, 409);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: -5 })).status, 400);
        assert.equal((await pedir('PATCH', '/api/ordenes-trabajo/99999999/valorizacion', 'gerente', { valorizacion: 100 })).status, 404);
        assert.equal((await eventosDe(ot)).length, 0);
    });
});

describe('historial de la orden: el candado de solo insercion', () => {
    test('el trigger rechaza UPDATE, DELETE y TRUNCATE, y la clave foranea impide borrar la OT', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1 });
        await assert.rejects(
            pool.query("UPDATE ordenes_eventos SET rol = 'x' WHERE orden_trabajo_id = $1", [ot]),
            /solo insercion/
        );
        await assert.rejects(pool.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = $1', [ot]), /solo insercion/);
        await assert.rejects(pool.query('TRUNCATE ordenes_eventos'), /solo insercion/);
        await assert.rejects(pool.query('DELETE FROM ordenes_trabajo WHERE id = $1', [ot]), { code: '23503' });
        assert.equal((await eventosDe(ot)).length, 1);
    });

    test('con la via de purga activa se puede modificar y borrar, y vale solo dentro de la transaccion', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1 });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL gomaq.purga = 'on'");
            const upd = await client.query("UPDATE ordenes_eventos SET rol = 'x' WHERE orden_trabajo_id = $1", [ot]);
            assert.equal(upd.rowCount, 1);
            await client.query('ROLLBACK');
            // fuera de la transaccion la purga ya no esta activa
            await assert.rejects(client.query("UPDATE ordenes_eventos SET rol = 'x' WHERE orden_trabajo_id = $1", [ot]), /solo insercion/);
        } finally {
            client.release();
        }
        await purgarOrdenes([ot]);
        assert.equal((await eventosDe(ot)).length, 0);
        assert.equal((await pool.query('SELECT 1 FROM ordenes_trabajo WHERE id = $1', [ot])).rows.length, 0);
    });

    test('un evento con el mismo uuid y tipo no se inserta dos veces; sin uuid si se repite; tipo y origen se validan', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        const uuid = crypto.randomUUID();
        const sql = `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen, uuid_cliente)
                     VALUES ($1, $2, now(), 'sistema', $3) ON CONFLICT DO NOTHING`;
        await pool.query(sql, [ot, 'cambio_estado', uuid]);
        await pool.query(sql, [ot, 'cambio_estado', uuid]);
        await pool.query(sql, [ot, 'cierre', uuid]);
        await pool.query(sql, [ot, 'cambio_estado', null]);
        await pool.query(sql, [ot, 'cambio_estado', null]);
        assert.equal((await eventosDe(ot)).length, 4);
        await assert.rejects(pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'inventado', now(), 'sistema')", [ot]), { code: '23514' });
        await assert.rejects(pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'cierre', now(), 'otro')", [ot]), { code: '23514' });
    });
});

describe('historial de la orden: carga inicial de la migracion', () => {
    test('reconstruye los eventos de una OT existente desde sus fechas', async (t) => {
        if (!requiereBase(t)) return;
        const fs = require('node:fs');
        const path = require('node:path');
        const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/020_ordenes_eventos.sql'), 'utf8');
        const carga = sql.slice(sql.indexOf('-- Carga inicial'));
        assert.ok(carga.includes('INSERT INTO ordenes_eventos'), 'no se encontro la carga inicial en la migracion');

        const ot = await crearOt('finalizada');
        await pool.query(
            `UPDATE ordenes_trabajo SET fecha_creacion = '2026-01-01 08:00+00', aceptada_at = '2026-01-01 09:00+00',
                    en_camino_at = '2026-01-01 09:30+00', llegada_at = '2026-01-01 10:00+00', fecha_cierre = '2026-01-01 12:00+00'
             WHERE id = $1`,
            [ot]
        );
        // un APK antiguo salta de asignada a en_camino: aceptada_at queda nulo
        const saltada = await crearOt('en_camino');
        await pool.query(
            "UPDATE ordenes_trabajo SET fecha_creacion = '2026-01-02 08:00+00', en_camino_at = '2026-01-02 09:30+00' WHERE id = $1",
            [saltada]
        );
        const client = await pool.connect();
        try {
            // se corre dentro de una transaccion que se deshace: la carga toca todas las OT de la base
            await client.query('BEGIN');
            await client.query(carga);
            const r = await client.query(
                'SELECT tipo, estado_anterior, estado_nuevo, origen, usuario_id, ocurrio_en FROM ordenes_eventos WHERE orden_trabajo_id = $1 ORDER BY ocurrio_en, id',
                [ot]
            );
            const s = await client.query(
                `SELECT tipo, estado_anterior, estado_nuevo FROM ordenes_eventos WHERE orden_trabajo_id = $1 AND tipo = 'cambio_estado'`,
                [saltada]
            );
            await client.query('ROLLBACK');
            assert.deepEqual(s.rows, [{ tipo: 'cambio_estado', estado_anterior: null, estado_nuevo: 'en_camino' }],
                'sin aceptada_at no se inventa el estado anterior');
            assert.equal(r.rows[2].estado_anterior, 'aceptada');
            assert.deepEqual(r.rows.map((e) => [e.tipo, e.estado_nuevo]), [
                ['creacion', null], ['cambio_estado', 'aceptada'], ['cambio_estado', 'en_camino'],
                ['cambio_estado', 'en_terreno'], ['cierre', 'finalizada'],
            ]);
            assert.ok(r.rows.every((e) => e.origen === 'migracion' && e.usuario_id === null));
            assert.equal(r.rows[4].ocurrio_en.toISOString(), '2026-01-01T12:00:00.000Z');
        } finally {
            client.release();
        }
        assert.equal((await eventosDe(ot)).length, 0, 'la prueba no deja eventos');
    });
});

describe('historial de la orden: endpoint GET /:id/historial', () => {
    test('devuelve los eventos en el orden en que llegaron al servidor, con el nombre de quien los hizo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '3 hours' WHERE id = $1", [ot]);
        const haceUnaHora = new Date(Date.now() - 3600 * 1000).toISOString();
        const haceDosHoras = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        // llega primero lo que ocurrio despues: el historial ordena por orden de escritura (id), no por ocurrio_en
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno', ocurrio_en: haceUnaHora });
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: haceDosHoras });

        for (const rol of ['administrativo', 'gerente']) {
            const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, rol);
            assert.equal(r.status, 200);
            assert.equal(r.body.length, 2);
            assert.deepEqual(r.body.map((e) => e.estado_nuevo), ['en_terreno', 'aceptada']);
            assert.equal(r.body[1].aplicado, false, 'la aceptada llego atrasada y no movio nada');
            assert.equal(r.body[0].usuario_nombre, 'Mecanico Prueba');
            assert.ok(r.body.every((e) => e.sincronizado_tarde === true), 'ocurrieron hace horas y llegaron ahora');
        }
    });

    test('un evento registrado al momento no figura como sincronizado tarde', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 10 });
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.body.length, 1);
        assert.equal(r.body[0].sincronizado_tarde, false);
        assert.equal(r.body[0].usuario_nombre, 'Admin Prueba');
    });

    test('un id invalido responde 400 y una OT inexistente 404', async (t) => {
        if (!requiereBase(t)) return;
        for (const id of ['abc', '0', '-3', '1.5', '1e3', '99999999999999']) {
            const r = await pedir('GET', `/api/ordenes-trabajo/${id}/historial`, 'administrativo');
            assert.equal(r.status, 400, `id ${id}`);
        }
        assert.equal((await pedir('GET', '/api/ordenes-trabajo/99999999/historial', 'administrativo')).status, 404);
    });

    test('el mecanico y el cliente no ven el historial', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        assert.equal((await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'mecanico')).status, 403);
        assert.equal((await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'cliente')).status, 403);
    });
});

describe('historial de la orden: OT creada en terreno sin senal y hora dudosa', () => {
    /** Abre una OT como lo hace la app al sincronizar: nace ahora, aunque el mecanico la creo antes. */
    async function abrirEnTerreno() {
        const r = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', {
            maquinaria_id: datos.maquinariaId, uuid_cliente: crypto.randomUUID(),
        });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        return r.body.id;
    }

    test('los eventos anteriores a la fecha de creacion de una OT sincronizada no son dudosos; la creacion va primero y el resto por llegada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await abrirEnTerreno();
        const haceUnaHora = new Date(Date.now() - 3600 * 1000).toISOString();
        const haceMediaHora = new Date(Date.now() - 1800 * 1000).toISOString();
        for (const [estado, ocurrio_en] of [['en_reparacion', haceMediaHora], ['en_terreno', haceUnaHora]]) {
            const p = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado, ocurrio_en, uuid: crypto.randomUUID() });
            assert.equal(p.status, 200);
        }
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 3);
        assert.ok(eventos.every((e) => e.hora_dudosa === false), 'ninguno es dudoso');

        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.status, 200);
        assert.equal(r.body[0].tipo, 'creacion', 'la creacion va primero aunque sea la mas reciente');
        assert.deepEqual(r.body.slice(1).map((e) => e.estado_nuevo), ['en_reparacion', 'en_terreno'], 'el resto, por orden de escritura');
    });

    test('una OT que no nacio por sincronizacion sigue marcando dudoso lo anterior a su creacion', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 hour' WHERE id = $1", [ot]);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', {
            estado: 'aceptada', ocurrio_en: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
        });
        assert.equal((await eventosDe(ot))[0].hora_dudosa, true);
    });

    test('una hora en el futuro es dudosa (con 2 minutos de margen) y no altera el orden de llegada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await abrirEnTerreno();
        const manana = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_reparacion', ocurrio_en: manana, uuid: crypto.randomUUID() });
        // sin hora del telefono: la del servidor, que es posterior a la llegada del primero
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno', uuid: crypto.randomUUID() });
        const eventos = await eventosDe(ot);
        assert.equal(eventos[1].hora_dudosa, true);
        assert.equal(eventos[2].hora_dudosa, false);

        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'gerente');
        assert.deepEqual(r.body.map((e) => e.tipo === 'creacion' ? 'creacion' : e.estado_nuevo), ['creacion', 'en_reparacion', 'en_terreno'],
            'el orden es el de llegada aunque la hora del primero este en el futuro');

        // un reloj adelantado un minuto cae dentro del margen
        const unMinuto = new Date(Date.now() + 60 * 1000).toISOString();
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_reparacion', ocurrio_en: unMinuto, uuid: crypto.randomUUID() });
        assert.equal((await eventosDe(ot))[3].hora_dudosa, false);
    });

    test('con el reloj del telefono atrasado y horas fuera de orden, la cadena de estados sale coherente y en orden de llegada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '5 hours' WHERE id = $1", [ot]);
        const hace = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
        // el telefono va una hora atrasado y sus horas ni siquiera siguen el orden de los pasos
        const pasos = [['aceptada', hace(110)], ['en_camino', hace(120)], ['en_terreno', hace(115)]];
        for (const [estado, ocurrio_en] of pasos) {
            const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado, ocurrio_en, uuid: crypto.randomUUID() });
            assert.equal(r.status, 200);
        }
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.map((e) => [e.estado_anterior, e.estado_nuevo]), [
            ['asignada', 'aceptada'], ['aceptada', 'en_camino'], ['en_camino', 'en_terreno'],
        ], 'cada "de X a Y" parte de donde termino el anterior');
        assert.ok(r.body.every((e) => e.aplicado === true && e.hora_dudosa === false));
    });

    test('los eventos con la hora del servidor (creacion y cierre) no pasan por la hora dudosa', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: datos.maquinariaId });
        datos.ordenes.push(r.body.id);
        const ev = (await eventosDe(r.body.id))[0];
        assert.equal(ev.hora_dudosa, false);
        assert.equal(new Date(ev.ocurrio_en).getTime(), new Date(r.body.fecha_creacion).getTime());
    });
});

describe('historial de la orden: orden y sincronizacion tardia con datos insertados a mano', () => {
    test('un evento reconstruido por la migracion no figura como sincronizado tarde', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        // como la carga inicial de la migracion: hora historica y registrado_en = ahora
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, registrado_en, origen)
             VALUES ($1, 'cierre', now() - interval '90 days', now(), 'migracion')`,
            [ot]
        );
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, registrado_en, origen)
             VALUES ($1, 'valorizacion', now() - interval '90 days', now(), 'panel')`,
            [ot]
        );
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.status, 200);
        assert.equal(r.body.find((e) => e.origen === 'migracion').sincronizado_tarde, false);
        assert.equal(r.body.find((e) => e.origen === 'panel').sincronizado_tarde, true, 'el resto sigue la regla de los 10 minutos');
        // la limpieza de la OT (hook after) usa la via de purga
    });

    test('la creacion va primero aunque otro evento tenga un id menor', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_nuevo, ocurrio_en, origen)
             VALUES ($1, 'cambio_estado', 'en_terreno', now(), 'terreno')`,
            [ot]
        );
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_nuevo, ocurrio_en, origen)
             VALUES ($1, 'creacion', 'en_terreno', now(), 'terreno')`,
            [ot]
        );
        const eventos = await eventosDe(ot);
        assert.equal(eventos[0].tipo, 'cambio_estado', 'el cambio tiene el id menor');
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'gerente');
        assert.deepEqual(r.body.map((e) => e.tipo), ['creacion', 'cambio_estado']);
    });
});

// ---------------------------------------------------------------------------------------------
// Bloque 1b: cambios de lo facturable con motivo, bloqueo por factura y eventos en el historial
// ---------------------------------------------------------------------------------------------

/** Eventos de la OT de un tipo, en el orden en que se escribieron (id). */
async function eventosTipo(ot, tipo) {
    const r = await pool.query(
        'SELECT * FROM ordenes_eventos WHERE orden_trabajo_id = $1 AND tipo = $2 ORDER BY id', [ot, tipo]);
    return r.rows;
}

async function contarEventos(ot) {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM ordenes_eventos WHERE orden_trabajo_id = $1', [ot]);
    return r.rows[0].n;
}

/** Cierra la OT y, si se pide, la deja valorizada (como si el gerente ya la hubiera aprobado). */
async function cerrarOt(ot, valorizacion = null) {
    const gerente = await pool.query("SELECT id FROM usuarios WHERE email = 'admin@gomaq.test'");
    await pool.query(
        `UPDATE ordenes_trabajo SET estado = 'finalizada', valorizacion = $2,
                valorizacion_aprobada_por = CASE WHEN $2::numeric IS NULL THEN NULL ELSE $3::int END
         WHERE id = $1`,
        [ot, valorizacion, gerente.rows[0].id]
    );
}

/** Factura insertada directo, para probar el bloqueo sin pasar por la subida del PDF. */
async function facturarDirecto(ot, folio = 'F-1001') {
    await pool.query(
        "INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto) VALUES ($1, $2, 'facturas/prueba.pdf', 100000)",
        [ot, folio]
    );
}

async function agregarLinea(ot, cuerpo, rol = 'administrativo') {
    const r = await pedir('POST', `/api/insumos/orden/${ot}`, rol, { cantidad: 1, descripcion: 'Repuesto de prueba', ...cuerpo });
    assert.ok(r.status === 201 || r.status === 200, `no se pudo agregar la linea: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
}

const rutaLinea = (ot, linea) => `/api/insumos/orden/${ot}/linea/${linea}`;

/** Sube una factura por la ruta real; el almacenamiento esta reemplazado por un doble. */
async function subirFactura(ot, rol, campos) {
    const form = new FormData();
    for (const [k, v] of Object.entries(campos)) form.append(k, v);
    form.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'factura.pdf');
    const r = await fetch(`${base}/api/ordenes-trabajo/${ot}/factura`, {
        method: 'POST', headers: { Authorization: `Bearer ${tokens[rol]}` }, body: form,
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body: json };
}

/** OT cerrada y valorizada con dos lineas que se cobran (A y B), una que no (C) y una por decidir (D). */
async function otValorizada() {
    const ot = await crearOt();
    const a = await agregarLinea(ot, { descripcion: 'A cobrable', cantidad: 2, precio_unitario: 1000, facturable: 'si' });
    const b = await agregarLinea(ot, { descripcion: 'B cobrable', cantidad: 1, precio_unitario: 5000, facturable: 'si' });
    const c = await agregarLinea(ot, { descripcion: 'C no se cobra', cantidad: 1, precio_unitario: 800, facturable: 'no' });
    const d = await agregarLinea(ot, { descripcion: 'D por decidir', cantidad: 1, facturable: 'pendiente' });
    await cerrarOt(ot, 7000);
    return { ot, a: a.id, b: b.id, c: c.id, d: d.id };
}

async function estadoValorizacion(ot) {
    const r = await pool.query('SELECT valorizacion, valorizacion_aprobada_por, facturable FROM ordenes_trabajo WHERE id = $1', [ot]);
    return r.rows[0];
}

/**
 * Espera a que haya al menos `n` consultas bloqueadas esperando un Lock sobre la OT (SELECT ... FOR
 * UPDATE) o sobre un indice unico de eventos (INSERT INTO ordenes_eventos). Es la forma de saber que
 * una peticion ya esta esperando, sin depender de un tiempo fijo.
 */
async function esperarBloqueos(n, patron = '%FOR UPDATE%') {
    const limite = Date.now() + 10000;
    for (;;) {
        const r = await pool.query(
            `SELECT COUNT(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [patron]);
        if (r.rows[0].n >= n) return;
        assert.ok(Date.now() < limite, `no llegaron a esperar ${n} bloqueo(s)`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function pendientesDeValorizar() {
    const r = await pedir('GET', '/api/facturacion/pendientes', 'gerente');
    assert.equal(r.status, 200);
    return r.body.reparaciones_pendientes_valorizar.map((o) => o.id);
}

describe('cambios de lo facturable: motivo', () => {
    test('OT cerrada: modificar sin motivo, con codigo invalido o con texto corto da 400 y no cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        await cerrarOt(ot);
        const antes = await contarEventos(ot);

        const intentos = [
            {},
            { motivo_codigo: 'garantia' },
            { motivo: 'Cliente de hace años, no se cobra' },
            { motivo_codigo: 'porque_si', motivo: 'Cliente de hace años, no se cobra' },
            { motivo_codigo: 'otro', motivo: '          ' },
            { motivo_codigo: 'otro', motivo: 'corto' },
            { motivo_codigo: 'otro', motivo: 'a b c d e f g h i' },
        ];
        for (const motivo of intentos) {
            const r = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si', ...motivo });
            assert.equal(r.status, 400, JSON.stringify(motivo));
            assert.ok(r.body.error);
        }
        const fila = await pool.query('SELECT facturable FROM movimientos_insumo WHERE id = $1', [linea.id]);
        assert.equal(fila.rows[0].facturable, 'pendiente', 'la linea no cambio');
        assert.equal(await contarEventos(ot), antes, 'un cambio rechazado no deja evento');
    });

    test('OT cerrada con motivo valido: se aplica y el evento guarda antes, despues y motivo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { descripcion: 'Filtro', precio_unitario: 1000 });
        await cerrarOt(ot);

        const r = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', {
            facturable: 'si', motivo_codigo: 'garantia', motivo: '  Se cobra por garantía vencida  ',
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.facturable, 'si');
        assert.equal(r.body.orden_facturable, true);

        const eventos = await eventosTipo(ot, 'linea_modificada');
        assert.equal(eventos.length, 1);
        const e = eventos[0];
        assert.equal(e.origen, 'panel');
        assert.equal(e.rol, 'administrativo');
        assert.ok(e.usuario_id);
        assert.equal(e.aplicado, true);
        assert.deepEqual(e.detalle, {
            linea_id: linea.id, insumo: 'Filtro', campo: 'facturable', antes: 'pendiente', despues: 'si',
            motivo_codigo: 'garantia', motivo: 'Se cobra por garantía vencida', orden_cerrada: true,
        });
    });

    test('OT abierta: el motivo es opcional pero el cambio se registra igual', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });

        const sinMotivo = await pedir('PATCH', rutaLinea(ot, linea.id), 'gerente', { facturable: 'si' });
        assert.equal(sinMotivo.status, 200);
        const conMotivo = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', {
            facturable: 'no', motivo_codigo: 'cortesia_comercial',
        });
        assert.equal(conMotivo.status, 200);

        const eventos = await eventosTipo(ot, 'linea_modificada');
        assert.equal(eventos.length, 2);
        assert.equal(eventos[0].rol, 'gerente');
        assert.equal(eventos[0].detalle.orden_cerrada, false);
        assert.equal(eventos[0].detalle.motivo, null);
        assert.equal(eventos[0].detalle.motivo_codigo, null);
        assert.equal(eventos[1].detalle.motivo_codigo, 'cortesia_comercial');
        assert.equal(eventos[1].detalle.antes, 'si');
        assert.equal(eventos[1].detalle.despues, 'no');
    });

    test('un codigo invalido tambien se rechaza con la OT abierta', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, {});
        const r = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si', motivo_codigo: 'inventado' });
        assert.equal(r.status, 400);
    });

    test('el precio debe ser un entero en pesos mayor o igual a 0: si no, 400 sin tocar nada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const antes = await contarEventos(ot);
        for (const precio of [1500.5, '1500.5', -1, 'abc']) {
            const agregar = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { descripcion: 'X', cantidad: 1, precio_unitario: precio });
            assert.equal(agregar.status, 400, `agregar ${precio}`);
            assert.match(agregar.body.error, /entero en pesos/);
            const modificar = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { precio_unitario: precio });
            assert.equal(modificar.status, 400, `modificar ${precio}`);
        }
        assert.equal(await contarEventos(ot), antes);
        // cero y texto numerico entero si valen
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { precio_unitario: '0' })).status, 200);
        const evento = (await eventosTipo(ot, 'linea_modificada')).pop();
        assert.equal(evento.detalle.despues, 0, 'despues sale de la fila guardada, como numero');
    });

    test('varios campos en un mismo PATCH dejan un evento por campo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const r = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', {
            facturable: 'si', precio_unitario: 1500, descripcion: 'Descripción corregida',
        });
        assert.equal(r.status, 200);
        const eventos = await eventosTipo(ot, 'linea_modificada');
        assert.deepEqual(eventos.map((e) => e.detalle.campo).sort(), ['descripcion', 'facturable', 'precio_unitario']);
        const precio = eventos.find((e) => e.detalle.campo === 'precio_unitario');
        assert.equal(precio.detalle.antes, 1000);
        assert.equal(precio.detalle.despues, 1500);
    });

    test('agregar una linea a una OT cerrada: el administrativo necesita motivo y se descuenta de la bodega', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await cerrarOt(ot);
        const insumo = await crearInsumoConStock(10);

        const sin = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { insumo_id: insumo, cantidad: 2, facturable: 'si' });
        assert.equal(sin.status, 400);
        assert.equal(await stockBodega(insumo), 10, 'un rechazo no mueve stock');
        assert.equal((await eventosTipo(ot, 'linea_agregada')).length, 0);

        const con = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            insumo_id: insumo, cantidad: 2, facturable: 'si', precio_unitario: 3000, ...MOTIVO_VALIDO,
        });
        assert.equal(con.status, 201);
        assert.equal(con.body.orden_facturable, true);
        assert.equal(await stockBodega(insumo), 8);
        const eventos = await eventosTipo(ot, 'linea_agregada');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].detalle.linea_id, con.body.id);
        assert.equal(eventos[0].detalle.orden_cerrada, true);
        assert.equal(eventos[0].detalle.motivo_codigo, 'error_registro');
        assert.deepEqual(eventos[0].detalle.despues, { cantidad: 2, precio_unitario: 3000, facturable: 'si' });
        assert.equal(eventos[0].origen, 'panel');
    });

    test('anular una linea de una OT cerrada: necesita motivo y deja el evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const linea = await agregarLinea(ot, { insumo_id: insumo, cantidad: 3, facturable: 'si' });
        await cerrarOt(ot);

        const sin = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'gerente');
        assert.equal(sin.status, 400);
        assert.equal(await stockBodega(insumo), 7, 'el rechazo no devuelve stock');

        const con = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'gerente', {
            motivo_codigo: 'cliente_antiguo', motivo: 'Cliente antiguo, se decidió no cobrar',
        });
        assert.equal(con.status, 200);
        assert.ok(con.body.anulada_at);
        assert.equal(await stockBodega(insumo), 10);
        const eventos = await eventosTipo(ot, 'linea_anulada');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].rol, 'gerente');
        assert.equal(eventos[0].detalle.linea_id, linea.id);
        assert.equal(eventos[0].detalle.orden_cerrada, true);
        assert.equal(eventos[0].detalle.motivo_codigo, 'cliente_antiguo');

        // anular de nuevo responde 200 sin evento ni motivo: es el reintento de siempre
        const otra = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'gerente');
        assert.equal(otra.status, 200);
        assert.equal((await eventosTipo(ot, 'linea_anulada')).length, 1);
    });
});

describe('cambios de lo facturable: el mecanico conserva su comportamiento', () => {
    test('agrega a una OT abierta sin motivo y queda el evento con origen terreno', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const uuid = crypto.randomUUID();
        const r = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', {
            descripcion: 'Correa', cantidad: 1, facturable: 'pendiente', uuid_cliente: uuid,
        });
        assert.equal(r.status, 201);
        const eventos = await eventosTipo(ot, 'linea_agregada');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].origen, 'terreno');
        assert.equal(eventos[0].rol, 'mecanico');
        assert.equal(eventos[0].uuid_cliente, uuid);
        assert.equal(eventos[0].detalle.orden_cerrada, false);
        assert.equal(eventos[0].detalle.insumo, 'Correa');
    });

    test('anula una linea suya en OT abierta sin motivo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, {}, 'mecanico');
        const r = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'mecanico', {});
        assert.equal(r.status, 200);
        const eventos = await eventosTipo(ot, 'linea_anulada');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].origen, 'terreno');
    });

    test('no toca una OT cerrada (409, mismos mensajes) ni una ajena (403)', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, {}, 'mecanico');
        await cerrarOt(ot);
        const agregar = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'X', cantidad: 1 });
        assert.equal(agregar.status, 409);
        assert.equal(agregar.body.error, 'La orden ya está cerrada y no se puede modificar');
        const anular = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'mecanico');
        assert.equal(anular.status, 409);
        assert.equal(anular.body.error, 'La orden ya está cerrada: pide al administrativo que anule la línea');
        const ajena = await crearOt('en_terreno', datos.mecanicoDosId);
        assert.equal((await pedir('POST', `/api/insumos/orden/${ajena}`, 'mecanico', { descripcion: 'X', cantidad: 1 })).status, 403);
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea.id), 'mecanico', { facturable: 'si' })).status, 403);
        assert.equal((await eventosTipo(ot, 'linea_agregada')).length, 1, 'los rechazos no dejan eventos');
    });
});

describe('cambios de lo facturable: OT ya facturada', () => {
    test('los tres caminos responden 409 con el folio y la nota de credito, sin tocar nada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const linea = await agregarLinea(ot, { insumo_id: insumo, cantidad: 1, facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 5000);
        await facturarDirecto(ot, 'F-777');
        const eventosAntes = await contarEventos(ot);
        const stockAntes = await stockBodega(insumo);

        const agregar = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            insumo_id: insumo, cantidad: 2, facturable: 'si', ...MOTIVO_VALIDO,
        });
        const anular = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'administrativo', MOTIVO_VALIDO);
        const modificar = await pedir('PATCH', rutaLinea(ot, linea.id), 'gerente', { facturable: 'no', ...MOTIVO_VALIDO });
        for (const r of [agregar, anular, modificar]) {
            assert.equal(r.status, 409);
            assert.match(r.body.error, /factura folio F-777/);
            assert.match(r.body.error, /nota de crédito en el SII/);
        }
        assert.equal(await contarEventos(ot), eventosAntes);
        assert.equal(await stockBodega(insumo), stockAntes);
        const fila = await pool.query('SELECT facturable, anulada_at FROM movimientos_insumo WHERE id = $1', [linea.id]);
        assert.equal(fila.rows[0].facturable, 'si');
        assert.equal(fila.rows[0].anulada_at, null);
        assert.equal((await estadoValorizacion(ot)).valorizacion, '5000.00', 'la valorizacion queda como estaba');
        const lineas = await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(lineas.rows.length, 1, 'no se agrego la linea');
    });

    test('el bloqueo vale tambien sin motivo y con el mecanico en una OT abierta', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, {}, 'mecanico');
        await facturarDirecto(ot, 'F-778');
        const sinMotivo = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' });
        assert.equal(sinMotivo.status, 409, 'primero la factura, despues el motivo');
        assert.equal((await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'X', cantidad: 1 })).status, 409);
        assert.equal((await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'mecanico')).status, 409);
    });

    test('una OT sin factura no se bloquea por la factura de otra', async (t) => {
        if (!requiereBase(t)) return;
        const otFacturada = await crearOt();
        await facturarDirecto(otFacturada, 'F-779');
        const ot = await crearOt();
        const linea = await agregarLinea(ot, {});
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' })).status, 200);
    });
});

describe('cambios de lo facturable: valorizacion', () => {
    test('agregar una linea facturable anula la valorizacion y la OT vuelve a los pendientes del gerente', async (t) => {
        if (!requiereBase(t)) return;
        const { ot } = await otValorizada();
        assert.ok(!(await pendientesDeValorizar()).includes(ot), 'valorizada: no esta pendiente');

        const r = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            descripcion: 'Otra pieza', cantidad: 1, precio_unitario: 900, facturable: 'si', ...MOTIVO_VALIDO,
        });
        assert.equal(r.status, 201);
        const o = await estadoValorizacion(ot);
        assert.equal(o.valorizacion, null);
        assert.equal(o.valorizacion_aprobada_por, null);
        assert.equal(o.facturable, true);
        assert.ok((await pendientesDeValorizar()).includes(ot), 'vuelve a la lista del gerente');

        const eventos = await eventosTipo(ot, 'valorizacion');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].detalle.anulada, true);
        assert.equal(eventos[0].detalle.valorizacion_anterior, 7000);
        assert.equal(eventos[0].detalle.valorizacion_nueva, null);
        assert.equal(eventos[0].detalle.evento_causa, 'linea_agregada');
        assert.equal(eventos[0].detalle.motivo_codigo, 'error_registro');
        assert.match(eventos[0].detalle.causa, /líneas facturables/);
        assert.equal(eventos[0].origen, 'panel');
        assert.equal(eventos[0].rol, 'administrativo');
        // el evento de la valorizacion va despues del de la linea
        const linea = await eventosTipo(ot, 'linea_agregada');
        assert.ok(Number(linea[linea.length - 1].id) < Number(eventos[0].id));

        // el gerente la vuelve a aprobar
        const nueva = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 8000 });
        assert.equal(nueva.status, 200);
        assert.equal((await eventosTipo(ot, 'valorizacion')).length, 2);
    });

    test('una linea que deja de ser facturable anula la valorizacion', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, b } = await otValorizada();
        const r = await pedir('PATCH', rutaLinea(ot, b), 'administrativo', { facturable: 'no', ...MOTIVO_VALIDO });
        assert.equal(r.status, 200);
        const o = await estadoValorizacion(ot);
        assert.equal(o.valorizacion, null);
        assert.equal(o.facturable, true, 'queda la linea A');
        assert.ok((await pendientesDeValorizar()).includes(ot));
        assert.equal((await eventosTipo(ot, 'valorizacion'))[0].detalle.evento_causa, 'linea_modificada');
    });

    test('una linea por decidir que pasa a facturable anula la valorizacion', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, d } = await otValorizada();
        await pedir('PATCH', rutaLinea(ot, d), 'gerente', { facturable: 'si', precio_unitario: 400, ...MOTIVO_VALIDO });
        assert.equal((await estadoValorizacion(ot)).valorizacion, null);
    });

    test('anular una linea facturable anula la valorizacion', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, a } = await otValorizada();
        const r = await pedir('POST', `${rutaLinea(ot, a)}/anular`, 'administrativo', MOTIVO_VALIDO);
        assert.equal(r.status, 200);
        const o = await estadoValorizacion(ot);
        assert.equal(o.valorizacion, null);
        assert.ok((await pendientesDeValorizar()).includes(ot));
        assert.equal((await eventosTipo(ot, 'valorizacion'))[0].detalle.evento_causa, 'linea_anulada');
    });

    test('cambiar el precio de una linea facturable anula la valorizacion', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, a } = await otValorizada();
        await pedir('PATCH', rutaLinea(ot, a), 'administrativo', { precio_unitario: 1200, ...MOTIVO_VALIDO });
        assert.equal((await estadoValorizacion(ot)).valorizacion, null);
    });

    test('lo que no toca las lineas facturables deja la valorizacion como estaba', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, a, c, d } = await otValorizada();
        const eventosAntes = (await eventosTipo(ot, 'valorizacion')).length;

        // agregar una linea no facturable y una por decidir
        assert.equal((await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            descripcion: 'No se cobra', cantidad: 1, facturable: 'no', precio_unitario: 100, ...MOTIVO_VALIDO,
        })).status, 201);
        assert.equal((await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            descripcion: 'Por decidir', cantidad: 1, ...MOTIVO_VALIDO,
        })).status, 201);
        // cambiar el precio o la descripcion de una no facturable, y pasar de por decidir a no
        assert.equal((await pedir('PATCH', rutaLinea(ot, c), 'administrativo', { precio_unitario: 999, ...MOTIVO_VALIDO })).status, 200);
        assert.equal((await pedir('PATCH', rutaLinea(ot, d), 'administrativo', { facturable: 'no', ...MOTIVO_VALIDO })).status, 200);
        // cambiar solo la descripcion de una facturable
        assert.equal((await pedir('PATCH', rutaLinea(ot, a), 'administrativo', { descripcion: 'A con otro nombre', ...MOTIVO_VALIDO })).status, 200);
        // anular una no facturable
        assert.equal((await pedir('POST', `${rutaLinea(ot, c)}/anular`, 'administrativo', MOTIVO_VALIDO)).status, 200);

        const o = await estadoValorizacion(ot);
        assert.equal(o.valorizacion, '7000.00');
        assert.ok(o.valorizacion_aprobada_por);
        assert.equal((await eventosTipo(ot, 'valorizacion')).length, eventosAntes, 'ningun evento de valorizacion');
        assert.ok(!(await pendientesDeValorizar()).includes(ot));
    });

    test('una OT sin valorizar no deja evento de valorizacion al cambiar lineas', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 100 });
        await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'no' });
        assert.equal((await eventosTipo(ot, 'valorizacion')).length, 0);
    });

    test('el mecanico que agrega una linea facturable a una OT abierta valorizada tambien la anula', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await pool.query('UPDATE ordenes_trabajo SET valorizacion = 1000 WHERE id = $1', [ot]);
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 100 }, 'mecanico');
        assert.equal((await estadoValorizacion(ot)).valorizacion, null);
        const ev = await eventosTipo(ot, 'valorizacion');
        assert.equal(ev[0].origen, 'terreno');
    });
});

describe('cambios de lo facturable: idempotencia', () => {
    test('la misma Idempotency-Key dos veces deja un solo evento y responde 200 sin repetir', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const llave = crypto.randomUUID();

        const primera = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': llave });
        assert.equal(primera.status, 200);
        assert.equal(primera.body.ya_registrada, undefined);
        // otro cambio posterior, con otra llave
        const otra = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'no' }, { 'Idempotency-Key': crypto.randomUUID() });
        assert.equal(otra.status, 200);

        // el reintento de la primera respuesta perdida: no vuelve a poner 'si'
        const reintento = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': llave });
        assert.equal(reintento.status, 200);
        assert.equal(reintento.body.ya_registrada, true);
        assert.equal(reintento.body.facturable, 'no', 'responde el estado actual, no repite el cambio');
        const eventos = await eventosTipo(ot, 'linea_modificada');
        assert.equal(eventos.length, 2);
        assert.equal(eventos[0].uuid_cliente, llave);
    });

    test('reintentos simultaneos con la misma llave dejan un solo evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const llave = crypto.randomUUID();
        const respuestas = await Promise.all([1, 2, 3, 4].map(() =>
            pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': llave })));
        assert.ok(respuestas.every((r) => r.status === 200), JSON.stringify(respuestas.map((r) => r.status)));
        assert.equal((await eventosTipo(ot, 'linea_modificada')).length, 1);
    });

    test('una llave malformada da 400 y una usada en otra linea da 409', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const uno = await agregarLinea(ot, {});
        const dos = await agregarLinea(ot, {});
        const mala = await pedir('PATCH', rutaLinea(ot, uno.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': 'no-es-uuid' });
        assert.equal(mala.status, 400);
        const llave = crypto.randomUUID();
        assert.equal((await pedir('PATCH', rutaLinea(ot, uno.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': llave })).status, 200);
        const otraLinea = await pedir('PATCH', rutaLinea(ot, dos.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': llave });
        assert.equal(otraLinea.status, 409);
        const fila = await pool.query('SELECT facturable FROM movimientos_insumo WHERE id = $1', [dos.id]);
        assert.equal(fila.rows[0].facturable, 'pendiente');
    });

    test('con varios campos la llave queda en un solo evento y el reintento no repite ninguno', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const llave = crypto.randomUUID();
        const cuerpo = { facturable: 'si', precio_unitario: 2000 };
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', cuerpo, { 'Idempotency-Key': llave })).status, 200);
        const otra = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', cuerpo, { 'Idempotency-Key': llave });
        assert.equal(otra.status, 200);
        assert.equal(otra.body.ya_registrada, true);
        assert.equal((await eventosTipo(ot, 'linea_modificada')).length, 2);
    });

    test('el reintento de la tarea de la cola de terreno no duplica la linea ni el evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const uuid = crypto.randomUUID();
        const cuerpo = { descripcion: 'Correa', cantidad: 1, facturable: 'pendiente', uuid_cliente: uuid };
        const primera = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', cuerpo);
        const segunda = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.id, primera.body.id);
        assert.equal((await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot])).rows.length, 1);
        assert.equal((await eventosTipo(ot, 'linea_agregada')).length, 1);
    });

    test('reintentos simultaneos de la cola dejan una linea y un evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const cuerpo = { descripcion: 'Correa', cantidad: 1, uuid_cliente: crypto.randomUUID() };
        const respuestas = await Promise.all([1, 2, 3, 4].map(() => pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', cuerpo)));
        assert.ok(respuestas.every((r) => r.status === 200 || r.status === 201));
        assert.equal(respuestas.filter((r) => r.status === 201).length, 1);
        assert.equal((await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot])).rows.length, 1);
        assert.equal((await eventosTipo(ot, 'linea_agregada')).length, 1);
    });

    test('un cambio sin efecto no escribe evento ni toca la linea', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000, descripcion: 'Filtro' });
        const antes = await contarEventos(ot);
        for (const cuerpo of [{}, { facturable: 'si' }, { precio_unitario: 1000 }, { precio_unitario: '1000' }, { descripcion: 'Filtro' }, { precio_unitario: '' }]) {
            const r = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', cuerpo);
            assert.equal(r.status, 200, JSON.stringify(cuerpo));
            assert.equal(r.body.id, linea.id);
            assert.equal(r.body.orden_facturable, true);
        }
        assert.equal(await contarEventos(ot), antes);
        // y con la OT cerrada tampoco pide motivo, porque no cambia nada
        await cerrarOt(ot);
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' })).status, 200);
    });
});

describe('cambios de lo facturable: bloqueo de la OT', () => {
    test('cambios simultaneos sobre lineas distintas de la misma OT no pierden ningun evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const lineas = [];
        for (let i = 0; i < 8; i++) lineas.push(await agregarLinea(ot, { precio_unitario: 100 + i }));
        const antes = await contarEventos(ot);

        const respuestas = await Promise.all(lineas.map((l, i) =>
            i % 2 === 0
                ? pedir('PATCH', rutaLinea(ot, l.id), 'administrativo', { facturable: 'si' })
                : pedir('POST', `${rutaLinea(ot, l.id)}/anular`, 'administrativo')));
        assert.ok(respuestas.every((r) => r.status === 200), JSON.stringify(respuestas.map((r) => r.status)));
        assert.equal(await contarEventos(ot), antes + 8, 'un evento por cambio');
        const orden = await pool.query('SELECT facturable FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.equal(orden.rows[0].facturable, true);
        const vigentes = await pool.query(
            "SELECT COUNT(*)::int AS n FROM movimientos_insumo WHERE orden_trabajo_id = $1 AND anulada_at IS NULL AND facturable = 'si'", [ot]);
        assert.equal(vigentes.rows[0].n, 4);
    });

    test('dos cambios simultaneos sobre la misma linea quedan encadenados por el id del evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const precios = [1100, 1200, 1300, 1400, 1500, 1600];
        const respuestas = await Promise.all(precios.map((p) =>
            pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { precio_unitario: p })));
        assert.ok(respuestas.every((r) => r.status === 200));
        const eventos = await eventosTipo(ot, 'linea_modificada');
        assert.equal(eventos.length, precios.length);
        // cada "antes" es el "despues" del evento anterior: el orden por id es el orden real
        let esperado = 1000;
        for (const e of eventos) {
            assert.equal(e.detalle.antes, esperado);
            esperado = e.detalle.despues;
        }
        const fila = await pool.query('SELECT precio_unitario FROM movimientos_insumo WHERE id = $1', [linea.id]);
        assert.equal(Number(fila.rows[0].precio_unitario), esperado, 'la linea queda con el ultimo valor del historial');
    });

    test('agregar, modificar y anular a la vez sobre la misma OT dan todos 2xx', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const uno = await agregarLinea(ot, { facturable: 'si', precio_unitario: 100 });
        const dos = await agregarLinea(ot, { facturable: 'si', precio_unitario: 100 });
        await pool.query('UPDATE ordenes_trabajo SET valorizacion = 500 WHERE id = $1', [ot]);
        const respuestas = await Promise.all([
            pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Nueva', cantidad: 1, facturable: 'si', precio_unitario: 5 }),
            pedir('PATCH', rutaLinea(ot, uno.id), 'gerente', { precio_unitario: 150 }),
            pedir('POST', `${rutaLinea(ot, dos.id)}/anular`, 'administrativo'),
        ]);
        assert.ok(respuestas.every((r) => r.status === 200 || r.status === 201), JSON.stringify(respuestas.map((r) => r.status)));
        assert.equal((await estadoValorizacion(ot)).valorizacion, null);
        assert.equal((await eventosTipo(ot, 'valorizacion')).length, 1, 'la valorizacion se anula una sola vez');
    });
});

describe('cambios de lo facturable: factura cargada', () => {
    test('subir la factura deja el evento con folio y monto, y una segunda da 409 sin evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);

        const r = await subirFactura(ot, 'administrativo', { folio: 'F-5001', monto: '119000' });
        assert.equal(r.status, 201);
        assert.equal(r.body.folio, 'F-5001');
        const eventos = await eventosTipo(ot, 'factura_cargada');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].origen, 'panel');
        assert.equal(eventos[0].rol, 'administrativo');
        assert.ok(eventos[0].usuario_id);
        assert.deepEqual(eventos[0].detalle, { factura_id: r.body.id, folio: 'F-5001', monto: 119000 });
        assert.equal(datos.storage.subidos.some((ruta) => ruta.includes(`${ot}`)), true);

        const otra = await subirFactura(ot, 'administrativo', { folio: 'F-5002' });
        assert.equal(otra.status, 409);
        assert.equal(otra.body.error, 'Esta orden de trabajo ya tiene su factura');
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 1);
        assert.ok(datos.storage.borrados.length > 0, 'el PDF de la segunda subida se borra');

        // y ahora la OT esta bloqueada para cambios de linea
        const linea = await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        const cambio = await pedir('PATCH', rutaLinea(ot, linea.rows[0].id), 'administrativo', { facturable: 'no', ...MOTIVO_VALIDO });
        assert.equal(cambio.status, 409);
        assert.match(cambio.body.error, /factura folio F-5001/);
    });

    test('sin monto el evento lo dice con null; folio y archivo siguen siendo obligatorios', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await cerrarOt(ot, 1000);
        const r = await subirFactura(ot, 'administrativo', { folio: 'F-5003' });
        assert.equal(r.status, 201);
        assert.equal((await eventosTipo(ot, 'factura_cargada'))[0].detalle.monto, null);
        const sinFolio = await subirFactura(await crearOt(), 'administrativo', {});
        assert.equal(sinFolio.status, 400);
        assert.equal(sinFolio.body.error, 'folio y archivo (PDF) son requeridos');
    });

    test('subir la factura a una OT abierta da 409 y el mecanico sigue agregando y anulando', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 }, 'mecanico');
        const borradosAntes = datos.storage.borrados.length;
        const r = await subirFactura(ot, 'administrativo', { folio: 'F-7001', monto: '1000' });
        assert.equal(r.status, 409);
        assert.match(r.body.error, /finalizada/);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows.length, 0);
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 0);
        assert.equal(datos.storage.borrados.length, borradosAntes + 1, 'el PDF subido se borra');
        // la OT sigue sin factura: el mecanico puede seguir trabajando
        const otra = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Otra', cantidad: 1 });
        assert.equal(otra.status, 201);
        assert.equal((await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'mecanico', {})).status, 200);
    });

    test('subir la factura a una OT finalizada sin valorizacion es valido', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, null);
        assert.equal((await subirFactura(ot, 'administrativo', { folio: 'F-7002' })).status, 201);
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 1);
    });

    test('el detalle de la OT dice si tiene factura y su folio', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const sin = await pedir('GET', `/api/ordenes-trabajo/${ot}`, 'administrativo');
        assert.equal(sin.status, 200);
        assert.equal(sin.body.factura_id, null);
        assert.equal(sin.body.factura_folio, null);
        assert.equal(sin.body.id, ot);
        await facturarDirecto(ot, 'F-4242');
        const con = await pedir('GET', `/api/ordenes-trabajo/${ot}`, 'gerente');
        assert.equal(con.body.factura_folio, 'F-4242');
        assert.ok(con.body.factura_id);
        // el mecanico dueño sigue viendo su orden, con los mismos campos de siempre
        const mec = await pedir('GET', `/api/ordenes-trabajo/${ot}`, 'mecanico');
        assert.equal(mec.status, 200);
        assert.ok(Array.isArray(mec.body.tramos) && Array.isArray(mec.body.servicio_ids));
    });

    test('solo el administrativo sube facturas', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        assert.equal((await subirFactura(ot, 'gerente', { folio: 'F-5004' })).status, 403);
        assert.equal((await subirFactura(ot, 'mecanico', { folio: 'F-5004' })).status, 403);
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 0);
    });

    test('una OT que no existe da 404 y el PDF subido se borra', async (t) => {
        if (!requiereBase(t)) return;
        const maximo = await pool.query('SELECT COALESCE(MAX(id), 0) + 100000 AS id FROM ordenes_trabajo');
        const borradosAntes = datos.storage.borrados.length;
        const r = await subirFactura(maximo.rows[0].id, 'administrativo', { folio: 'F-5005' });
        assert.equal(r.status, 404);
        assert.equal(datos.storage.borrados.length, borradosAntes + 1);
    });

    test('una factura y un cambio de linea a la vez: la factura nunca queda sobre lineas distintas', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 5; vuelta++) {
            const ot = await crearOt();
            const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
            await cerrarOt(ot, 1000);
            const [cambio, factura] = await Promise.all([
                pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { precio_unitario: 2000, ...MOTIVO_VALIDO }),
                subirFactura(ot, 'administrativo', { folio: `F-60${vuelta}`, monto: '1000' }),
            ]);
            const eventoFactura = (await eventosTipo(ot, 'factura_cargada'))[0];
            const eventoCambio = (await eventosTipo(ot, 'linea_modificada'))[0];
            // la factura ya no exige valorizacion: o el cambio entra primero y la factura se sube
            // despues sobre las lineas ya cambiadas (que quedan congeladas), o la factura entra y el
            // cambio se bloquea. Nunca el cambio despues de la factura.
            if (cambio.status === 200) {
                assert.equal(factura.status, 201);
                assert.ok(eventoCambio && eventoFactura);
                assert.ok(Number(eventoCambio.id) < Number(eventoFactura.id), 'el cambio es anterior a la factura');
                const fila = await pool.query('SELECT precio_unitario FROM movimientos_insumo WHERE id = $1', [linea.id]);
                assert.equal(Number(fila.rows[0].precio_unitario), 2000);
            } else {
                assert.equal(cambio.status, 409);
                assert.equal(factura.status, 201);
                assert.equal(eventoCambio, undefined);
                const fila = await pool.query('SELECT precio_unitario FROM movimientos_insumo WHERE id = $1', [linea.id]);
                assert.equal(Number(fila.rows[0].precio_unitario), 1000, 'la linea sigue como se facturo');
                assert.ok(eventoFactura);
            }
        }
    });

    test('un cambio que esperaba el bloqueo de la OT ve la factura subida mientras tanto', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);

        // otra transaccion tiene la OT bloqueada, como la subida de una factura a medio camino
        const otra = await pool.connect();
        let cambio;
        try {
            await otra.query('BEGIN');
            await otra.query('SELECT id FROM ordenes_trabajo WHERE id = $1 FOR UPDATE', [ot]);
            cambio = pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { precio_unitario: 2000, ...MOTIVO_VALIDO });
            // se espera a que el PATCH este de verdad esperando el bloqueo (y no a un tiempo fijo)
            await esperarBloqueos(1);
            await otra.query(
                "INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto) VALUES ($1, 'F-ESPERA', 'facturas/prueba.pdf', 1000)", [ot]);
            await otra.query('COMMIT');
        } catch (err) {
            await otra.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            otra.release();
        }
        const r = await cambio;
        assert.equal(r.status, 409, 'la factura confirmada mientras esperaba tiene que bloquear el cambio');
        assert.match(r.body.error, /F-ESPERA/);
        const fila = await pool.query('SELECT precio_unitario FROM movimientos_insumo WHERE id = $1', [linea.id]);
        assert.equal(Number(fila.rows[0].precio_unitario), 1000);
        assert.equal((await eventosTipo(ot, 'linea_modificada')).length, 0);
    });

    test('la factura de un arriendo (sin OT) sigue sin pasar por el historial de ordenes', async (t) => {
        if (!requiereBase(t)) return;
        const antes = await pool.query('SELECT COUNT(*)::int AS n FROM ordenes_eventos WHERE tipo = $1', ['factura_cargada']);
        // la ruta de arriendo no toca ordenes_eventos: solo se comprueba que el contrato no cambio
        const r = await pedir('POST', '/api/facturacion/arriendo', 'administrativo', { folio: 'X' });
        assert.equal(r.status, 400);
        const despues = await pool.query('SELECT COUNT(*)::int AS n FROM ordenes_eventos WHERE tipo = $1', ['factura_cargada']);
        assert.equal(despues.rows[0].n, antes.rows[0].n);
    });
});

describe('cambios de lo facturable: respuestas que no cambian y limpieza', () => {
    test('los codigos y mensajes de siempre', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const ruta = rutaLinea(ot, linea.id);

        const agregarSinCantidad = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { descripcion: 'X' });
        assert.deepEqual([agregarSinCantidad.status, agregarSinCantidad.body.error], [400, 'Indica una cantidad mayor a 0']);
        const sinRepuesto = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { cantidad: 1 });
        assert.deepEqual([sinRepuesto.status, sinRepuesto.body.error], [400, 'Elige un repuesto del catálogo o escribe su descripción']);
        const malFact = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { cantidad: 1, descripcion: 'X', facturable: 'tal vez' });
        assert.equal(malFact.status, 400);
        const malUuid = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { cantidad: 1, descripcion: 'X', uuid_cliente: 'no' });
        assert.deepEqual([malUuid.status, malUuid.body.error], [400, 'uuid_cliente no es un UUID valido']);
        const sinInsumo = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { cantidad: 1, insumo_id: 2147483000 });
        assert.deepEqual([sinInsumo.status, sinInsumo.body.error], [404, 'Insumo no encontrado']);

        const patchMal = await pedir('PATCH', ruta, 'administrativo', { facturable: 'quizas' });
        assert.deepEqual([patchMal.status, patchMal.body.error], [400, 'facturable debe ser uno de: si, no, pendiente']);
        const patchNoExiste = await pedir('PATCH', rutaLinea(ot, 2147483000), 'administrativo', { facturable: 'si' });
        assert.deepEqual([patchNoExiste.status, patchNoExiste.body.error], [404, 'Línea no encontrada en esta orden de trabajo, o ya anulada']);
        const anularNoExiste = await pedir('POST', `${rutaLinea(ot, 2147483000)}/anular`, 'administrativo');
        assert.deepEqual([anularNoExiste.status, anularNoExiste.body.error], [404, 'Línea no encontrada en esta orden de trabajo']);
        const anularOtNoExiste = await pedir('POST', `${rutaLinea(2147483000, linea.id)}/anular`, 'administrativo');
        assert.deepEqual([anularOtNoExiste.status, anularOtNoExiste.body.error], [404, 'Orden de trabajo no encontrada']);
        const clienteNo = await pedir('PATCH', ruta, 'cliente', { facturable: 'si' });
        assert.equal(clienteNo.status, 403);

        // la respuesta del PATCH conserva la forma: la fila de la linea mas orden_facturable
        const ok = await pedir('PATCH', ruta, 'administrativo', { facturable: 'si' });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.id, linea.id);
        assert.equal(ok.body.facturable, 'si');
        assert.equal(ok.body.orden_facturable, true);
        assert.ok('precio_unitario' in ok.body && 'cantidad' in ok.body && 'anulada_at' in ok.body);

        // PATCH de una linea anulada: 404 como siempre
        await pedir('POST', `${ruta}/anular`, 'administrativo');
        const anulada = await pedir('PATCH', ruta, 'administrativo', { facturable: 'no' });
        assert.deepEqual([anulada.status, anulada.body.error], [404, 'Línea no encontrada en esta orden de trabajo, o ya anulada']);
    });

    test('la limpieza usa la via de purga: se borran la OT y todos sus eventos de linea y factura', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 100 });
        await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'no' });
        await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'administrativo');
        await cerrarOt(ot, 100);
        assert.equal((await subirFactura(ot, 'administrativo', { folio: 'F-9001' })).status, 201);
        for (const tipo of ['linea_agregada', 'linea_modificada', 'linea_anulada', 'factura_cargada']) {
            assert.equal((await eventosTipo(ot, tipo)).length, 1, tipo);
        }

        // sin la via de purga el historial no se puede borrar
        await assert.rejects(() => pool.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = $1', [ot]), /solo insercion/);

        await pool.query('DELETE FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        await pool.query('DELETE FROM facturas WHERE orden_trabajo_id = $1', [ot]);
        await purgarOrdenes([ot]);
        datos.ordenes = datos.ordenes.filter((id) => id !== ot);
        assert.equal((await pool.query('SELECT 1 FROM ordenes_trabajo WHERE id = $1', [ot])).rows.length, 0);
        assert.equal(await contarEventos(ot), 0);
    });
});

describe('anular una factura subida por error', () => {
    const rutaAnular = (ot, factura) => `/api/ordenes-trabajo/${ot}/factura/${factura}/anular`;

    /** OT cerrada y valorizada con una linea que se cobra y su factura subida por la ruta real. */
    async function otFacturada(folio) {
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        const f = await subirFactura(ot, 'administrativo', { folio, monto: '1190' });
        assert.equal(f.status, 201);
        return { ot, linea: linea.id, factura: f.body.id };
    }

    async function listasParaFacturar() {
        const r = await pedir('GET', '/api/facturacion/pendientes', 'gerente');
        return r.body.reparaciones_listas.map((o) => o.id);
    }

    test('motivo faltante, corto o invalido da 400 y la factura sigue ahi', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturada('F-8001');
        for (const cuerpo of [{}, { motivo_codigo: 'error_registro' }, { motivo: 'Se subio la factura equivocada' },
            { motivo_codigo: 'error_registro', motivo: 'corto' }, { motivo_codigo: 'inventado', motivo: 'Se subio la factura equivocada' }]) {
            const r = await pedir('POST', rutaAnular(ot, factura), 'administrativo', cuerpo);
            assert.equal(r.status, 400, JSON.stringify(cuerpo));
        }
        const mala = await pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO, { 'Idempotency-Key': 'no-es-uuid' });
        assert.equal(mala.status, 400);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [factura])).rows.length, 1);
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 1);
        assert.equal((await eventosTipo(ot, 'factura_anulada')).length, 0);
    });

    test('el mecanico y el cliente no pueden (403); una OT o factura que no existe da 404', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturada('F-8002');
        assert.equal((await pedir('POST', rutaAnular(ot, factura), 'mecanico', MOTIVO_VALIDO)).status, 403);
        assert.equal((await pedir('POST', rutaAnular(ot, factura), 'cliente', MOTIVO_VALIDO)).status, 403);
        const inexistente = await pedir('POST', rutaAnular(2147483000, factura), 'administrativo', MOTIVO_VALIDO);
        assert.deepEqual([inexistente.status, inexistente.body.error], [404, 'Orden de trabajo no encontrada']);
        const sinFactura = await pedir('POST', rutaAnular(ot, 2147483000), 'administrativo', MOTIVO_VALIDO);
        assert.deepEqual([sinFactura.status, sinFactura.body.error], [404, 'Factura no encontrada para esta orden de trabajo']);
        // la factura de otra OT tampoco se puede anular por esta
        const otra = await crearOt();
        assert.equal((await pedir('POST', rutaAnular(otra, factura), 'administrativo', MOTIVO_VALIDO)).status, 404);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [factura])).rows.length, 1);
    });

    test('anular borra la factura, deja el evento completo y levanta el bloqueo de la OT', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, linea, factura } = await otFacturada('F-8003');
        assert.ok(!(await listasParaFacturar()).includes(ot), 'facturada: no esta entre las listas para facturar');
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea), 'administrativo', { precio_unitario: 2000, ...MOTIVO_VALIDO })).status, 409);
        const borradosAntes = datos.storage.borrados.length;

        const r = await pedir('POST', rutaAnular(ot, factura), 'gerente', {
            motivo_codigo: 'error_registro', motivo: '  Se subió la factura de otra orden  ',
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.folio, 'F-8003');
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [factura])).rows.length, 0);
        assert.equal(datos.storage.borrados.length, borradosAntes, 'el PDF queda de respaldo en Supabase');

        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 1, 'la carga sigue en el historial');
        const eventos = await eventosTipo(ot, 'factura_anulada');
        assert.equal(eventos.length, 1);
        const e = eventos[0];
        assert.equal(e.origen, 'panel');
        assert.equal(e.rol, 'gerente');
        assert.ok(e.usuario_id);
        assert.equal(e.detalle.folio, 'F-8003');
        assert.equal(e.detalle.monto, 1190);
        assert.equal(e.detalle.factura_id, factura);
        assert.match(e.detalle.archivo_url, /^facturas\//);
        assert.equal(e.detalle.motivo_codigo, 'error_registro');
        assert.equal(e.detalle.motivo, 'Se subió la factura de otra orden');

        // las listas quedan coherentes: valorizada y sin factura, vuelve a estar lista para facturar
        assert.ok((await listasParaFacturar()).includes(ot));
        // y se puede subir una factura nueva
        assert.equal((await subirFactura(ot, 'administrativo', { folio: 'F-8004', monto: '1190' })).status, 201);
        assert.equal((await pool.query('SELECT folio FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows[0].folio, 'F-8004');
    });

    test('despues de anular se puede cambiar una linea otra vez', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, linea, factura } = await otFacturada('F-8005');
        assert.equal((await pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO)).status, 200);
        const r = await pedir('PATCH', rutaLinea(ot, linea), 'administrativo', { precio_unitario: 2000, ...MOTIVO_VALIDO });
        assert.equal(r.status, 200);
        const agregar = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { descripcion: 'Nueva', cantidad: 1, ...MOTIVO_VALIDO });
        assert.equal(agregar.status, 201);
        // cambiar el precio de una facturable anula la valorizacion, y la OT vuelve a pendientes de valorizar
        assert.equal((await estadoValorizacion(ot)).valorizacion, null);
        assert.ok((await pendientesDeValorizar()).includes(ot));
    });

    test('anular de nuevo da 404; con la misma Idempotency-Key da 200 sin repetir', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturada('F-8006');
        const llave = crypto.randomUUID();
        assert.equal((await pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO, { 'Idempotency-Key': llave })).status, 200);
        const otra = await pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO);
        assert.equal(otra.status, 404);
        const reintento = await pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO, { 'Idempotency-Key': llave });
        assert.equal(reintento.status, 200);
        assert.equal(reintento.body.ya_registrada, true);
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 1);
        assert.equal((await eventosTipo(ot, 'factura_anulada')).length, 1);
        // la llave usada en otra factura es un error del cliente
        const dos = await otFacturada('F-8007');
        const ajena = await pedir('POST', rutaAnular(dos.ot, dos.factura), 'administrativo', MOTIVO_VALIDO, { 'Idempotency-Key': llave });
        assert.equal(ajena.status, 409);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [dos.factura])).rows.length, 1);
    });

    test('dos anulaciones simultaneas: una gana y la otra da 404, sin 500', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturada('F-8008');
        const rs = await Promise.all([1, 2, 3].map(() => pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO)));
        assert.deepEqual(rs.map((r) => r.status).sort(), [200, 404, 404]);
        assert.equal((await eventosTipo(ot, 'factura_anulada')).length, 1);
    });

    test('con la OT bloqueada, la anulacion y un cambio de linea esperan su turno: primero la anulacion, despues el cambio', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, linea, factura } = await otFacturada('F-8500');
        const otra = await pool.connect();
        let anulacion;
        let cambio;
        try {
            await otra.query('BEGIN');
            await otra.query('SELECT id FROM ordenes_trabajo WHERE id = $1 FOR UPDATE', [ot]);
            // la anulacion llega primero y queda esperando; despues llega el cambio
            anulacion = pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO);
            await esperarBloqueos(1);
            cambio = pedir('PATCH', rutaLinea(ot, linea), 'administrativo', { precio_unitario: 3000, ...MOTIVO_VALIDO });
            await esperarBloqueos(2);
            await otra.query('COMMIT');
        } catch (err) {
            await otra.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            otra.release();
        }
        const [a, c] = await Promise.all([anulacion, cambio]);
        assert.equal(a.status, 200);
        // el cambio esperaba detras de la anulacion: cuando le toca, la factura ya no esta
        assert.equal(c.status, 200, JSON.stringify(c.body));
        const anulada = (await eventosTipo(ot, 'factura_anulada'))[0];
        const modificado = (await eventosTipo(ot, 'linea_modificada'))[0];
        assert.ok(Number(modificado.id) > Number(anulada.id), 'el historial refleja el orden real');
    });

    test('con la OT bloqueada, un cambio que llega primero deja a la anulacion esperando y la factura se anula despues', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, linea, factura } = await otFacturada('F-8501');
        const otra = await pool.connect();
        let anulacion;
        let cambio;
        try {
            await otra.query('BEGIN');
            await otra.query('SELECT id FROM ordenes_trabajo WHERE id = $1 FOR UPDATE', [ot]);
            cambio = pedir('PATCH', rutaLinea(ot, linea), 'administrativo', { precio_unitario: 3000, ...MOTIVO_VALIDO });
            await esperarBloqueos(1);
            anulacion = pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO);
            await esperarBloqueos(2);
            await otra.query('COMMIT');
        } catch (err) {
            await otra.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            otra.release();
        }
        const [c, a] = await Promise.all([cambio, anulacion]);
        // el cambio va primero y la OT todavia esta facturada: se bloquea; la anulacion pasa
        assert.equal(c.status, 409);
        assert.match(c.body.error, /factura folio F-8501/);
        assert.equal(a.status, 200);
        assert.equal((await eventosTipo(ot, 'linea_modificada')).length, 0);
        assert.equal((await eventosTipo(ot, 'factura_anulada')).length, 1);
    });

    test('la misma Idempotency-Key en dos OT a la vez: la segunda se rechaza con 409 y su factura sigue', async (t) => {
        if (!requiereBase(t)) return;
        const uno = await otFacturada('F-8600');
        const dos = await otFacturada('F-8601');
        const llave = crypto.randomUUID();
        // otra transaccion toma la llave (evento sin confirmar): la anulacion de la OT dos no la ve en su
        // busqueda previa, y su INSERT espera el indice unico hasta que esa transaccion termine
        const otra = await pool.connect();
        let respuesta;
        try {
            await otra.query('BEGIN');
            await otra.query(
                "INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen, uuid_cliente) VALUES ($1, 'factura_anulada', now(), 'panel', $2)",
                [uno.ot, llave]);
            respuesta = pedir('POST', rutaAnular(dos.ot, dos.factura), 'administrativo', MOTIVO_VALIDO, { 'Idempotency-Key': llave });
            await esperarBloqueos(1, '%INSERT INTO ordenes_eventos%');
            await otra.query('COMMIT');
        } catch (err) {
            await otra.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            otra.release();
        }
        const r = await respuesta;
        assert.equal(r.status, 409);
        assert.match(r.body.error, /Idempotency-Key/);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [dos.factura])).rows.length, 1, 'no se borro nada');
        assert.equal((await eventosTipo(dos.ot, 'factura_anulada')).length, 0);
    });

    test('un id que no es entero positivo da 400, no 500', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, linea, factura } = await otFacturada('F-8700');
        for (const malo of ['abc', '0', '-1', '1.5', '99999999999']) {
            const anularOt = await pedir('POST', rutaAnular(malo, factura), 'administrativo', MOTIVO_VALIDO);
            assert.equal(anularOt.status, 400, `orden ${malo}`);
            const anularFactura = await pedir('POST', rutaAnular(ot, malo), 'administrativo', MOTIVO_VALIDO);
            assert.equal(anularFactura.status, 400, `factura ${malo}`);
            assert.equal((await subirFactura(malo, 'administrativo', { folio: 'X' })).status, 400, `subir ${malo}`);
            assert.equal((await pedir('POST', `/api/insumos/orden/${malo}`, 'administrativo', { descripcion: 'X', cantidad: 1 })).status, 400);
            assert.equal((await pedir('PATCH', rutaLinea(malo, linea), 'administrativo', { facturable: 'no' })).status, 400);
            assert.equal((await pedir('PATCH', rutaLinea(ot, malo), 'administrativo', { facturable: 'no' })).status, 400);
            assert.equal((await pedir('POST', `${rutaLinea(malo, linea)}/anular`, 'administrativo')).status, 400);
            assert.equal((await pedir('POST', `${rutaLinea(ot, malo)}/anular`, 'administrativo')).status, 400);
        }
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [factura])).rows.length, 1);
    });

    test('la fecha de emision queda en el evento tal como se guardo, sin correrse por la zona horaria', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await cerrarOt(ot, 1000);
        const f = await subirFactura(ot, 'administrativo', { folio: 'F-8800', monto: '1190', fecha_emision: '2026-11-02' });
        assert.equal(f.status, 201);
        assert.equal((await pedir('POST', rutaAnular(ot, f.body.id), 'administrativo', MOTIVO_VALIDO)).status, 200);
        const e = (await eventosTipo(ot, 'factura_anulada'))[0];
        assert.equal(e.detalle.fecha_emision, '2026-11-02');
        // sin fecha de emision queda en null
        const g = await subirFactura(ot, 'administrativo', { folio: 'F-8801' });
        assert.equal((await pedir('POST', rutaAnular(ot, g.body.id), 'administrativo', MOTIVO_VALIDO)).status, 200);
        assert.equal((await eventosTipo(ot, 'factura_anulada'))[1].detalle.fecha_emision, null);
    });
});

describe('migracion 021: tipo de evento factura_anulada', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const archivo = path.join(__dirname, '../../db/migrations/021_evento_factura_anulada.sql');

    test('el CHECK de ordenes_eventos admite el tipo nuevo y sigue rechazando los inventados', async (t) => {
        if (!requiereBase(t)) return;
        const def = await pool.query(
            `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
             WHERE c.conrelid = 'ordenes_eventos'::regclass AND c.contype = 'c' AND c.conname = 'ordenes_eventos_tipo_check'`);
        assert.equal(def.rows.length, 1);
        assert.match(def.rows[0].def, /factura_anulada/);
        for (const tipo of ['creacion', 'factura_cargada', 'linea_anulada']) assert.match(def.rows[0].def, new RegExp(tipo));

        const ot = await crearOt();
        await pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'factura_anulada', now(), 'panel')", [ot]);
        await assert.rejects(
            () => pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'inventado', now(), 'panel')", [ot]),
            /ordenes_eventos_tipo_check/);
    });

    test('correrla otra vez no rompe nada: mismo CHECK, triggers de solo insercion e indice unico intactos', async (t) => {
        if (!requiereBase(t)) return;
        const sql = fs.readFileSync(archivo, 'utf8');
        const estado = async () => ({
            check: (await pool.query(
                `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                 WHERE conrelid = 'ordenes_eventos'::regclass AND contype = 'c' ORDER BY conname`)).rows,
            triggers: (await pool.query(
                `SELECT tgname FROM pg_trigger WHERE tgrelid = 'ordenes_eventos'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows,
            indices: (await pool.query(
                `SELECT indexname FROM pg_indexes WHERE tablename = 'ordenes_eventos' ORDER BY indexname`)).rows,
            eventos: (await pool.query('SELECT COUNT(*)::int AS n FROM ordenes_eventos')).rows[0].n,
        });
        const antes = await estado();
        for (let i = 0; i < 2; i++) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                throw err;
            } finally {
                client.release();
            }
        }
        assert.deepEqual(await estado(), antes);
        assert.deepEqual(antes.check.map((c) => c.conname), ['ordenes_eventos_origen_check', 'ordenes_eventos_tipo_check']);
        assert.deepEqual(antes.triggers.map((x) => x.tgname), ['ordenes_eventos_sin_cambios', 'ordenes_eventos_sin_truncate']);
        assert.ok(antes.indices.some((x) => x.indexname === 'uq_ordenes_eventos_uuid_tipo'));
        // el candado de solo insercion sigue en pie
        const ot = await crearOt();
        await pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'toma', now(), 'panel')", [ot]);
        await assert.rejects(() => pool.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = $1', [ot]), /solo insercion/);
    });
});

describe('bloque 2a: configuracion de cobro, inicio de cobro y arriendos en curso', () => {
    const { inicioCobroDia } = require('../src/utils/diasArriendo');
    const DEFAULTS_CONFIG = { dia_facturacion: 5, hora_corte_despacho: 13, incluir_dia_recepcion: true, corte_cierra_periodo: true };

    /** Deja la configuracion como esta en la migracion, sin rastro de quien la toco. */
    async function restaurarConfiguracion() {
        for (const [clave, valor] of Object.entries(DEFAULTS_CONFIG)) {
            await pool.query(
                `INSERT INTO configuracion (clave, valor) VALUES ($1, $2::jsonb)
                 ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = NULL`, [clave, JSON.stringify(valor)]);
        }
    }

    /** Despacho por la ruta real, sin documento, con la hora dada (ISO con offset). */
    async function despachar(equipoId, clienteId, fechaHora) {
        const formulario = new FormData();
        formulario.append('tipo', 'despacho');
        formulario.append('sin_documento', 'true');
        formulario.append('cliente_id', String(clienteId));
        if (fechaHora) formulario.append('fecha_hora', fechaHora);
        const r = await fetch(`${base}/api/maquinarias/${equipoId}/guias`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario,
        });
        return { status: r.status, body: await r.json() };
    }

    const inicioDe = async (guiaId) =>
        (await pool.query('SELECT inicio_cobro::text AS d FROM guias WHERE id = $1', [guiaId])).rows[0].d;

    test('la migracion deja la configuracion por defecto', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', '/api/facturacion/configuracion', 'administrativo');
        assert.equal(r.status, 200);
        assert.equal(r.body.dia_facturacion, 5);
        assert.equal(r.body.hora_corte_despacho, 13);
        assert.equal(r.body.incluir_dia_recepcion, true);
    });

    test('permisos: administrativo ve y no edita, gerente edita, mecanico y cliente no entran', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'gerente')).status, 200);
        assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'administrativo', { dia_facturacion: 6 })).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'mecanico')).status, 403);
        assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'mecanico', { dia_facturacion: 6 })).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos-en-curso', 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos-en-curso', 'cliente')).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).status, 200);
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'administrativo')).body.dia_facturacion, 5);
    });

    test('un PUT invalido da 400 y no cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        for (const cuerpo of [{ dia_facturacion: 29 }, { dia_facturacion: '5' }, { inventada: 1 }, {}, { hora_corte_despacho: 24 },
            { constructor: 1 }, { toString: true },
            { dia_facturacion: 7, hora_corte_despacho: 99 }]) {
            const r = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', cuerpo);
            assert.equal(r.status, 400, JSON.stringify(cuerpo));
        }
        // un cuerpo con `__proto__` propio (JSON.parse lo crea como clave normal) tambien se rechaza sin tumbar el servidor
        const proto = await fetch(`${base}/api/facturacion/configuracion`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.gerente}` },
            body: '{"__proto__":1}',
        });
        assert.equal(proto.status, 400);
        const r = await pedir('GET', '/api/facturacion/configuracion', 'gerente');
        assert.equal(r.body.dia_facturacion, 5, 'el PUT a medias no dejo nada guardado');
        assert.equal(r.body.hora_corte_despacho, 13);
    });

    test('el CHECK de la tabla rechaza valores fuera de rango aunque se salte la API', async (t) => {
        if (!requiereBase(t)) return;
        await assert.rejects(() => pool.query("UPDATE configuracion SET valor = '29' WHERE clave = 'dia_facturacion'"), /configuracion_valor_valido/);
        await assert.rejects(() => pool.query("UPDATE configuracion SET valor = '\"13\"' WHERE clave = 'hora_corte_despacho'"), /configuracion_valor_valido/);
        await assert.rejects(() => pool.query("UPDATE configuracion SET valor = '1' WHERE clave = 'incluir_dia_recepcion'"), /configuracion_valor_valido/);
    });

    test('el despacho guarda su inicio de cobro: 12:59 cuenta el dia, 13:00 el siguiente', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const antes = await despachar(equipo.id, cliente, '2026-03-10T12:59:00-03:00');
        assert.equal(antes.status, 201);
        assert.equal(await inicioDe(antes.body.id), '2026-03-10');
        const otro = await crearEquipo(null);
        const despues = await despachar(otro.id, cliente, '2026-03-10T13:00:00-03:00');
        assert.equal(await inicioDe(despues.body.id), '2026-03-11');
    });

    test('gomaq_inicio_cobro (SQL) coincide con inicioCobroDia (JS)', async (t) => {
        if (!requiereBase(t)) return;
        const instantes = [
            '2026-03-05T02:00:00Z', '2026-03-10T12:59:00-03:00', '2026-03-10T13:00:00-03:00', '2026-12-31T14:00:00-03:00',
            '2028-02-28T14:00:00-03:00', '2026-04-04T23:30:00-03:00', '2026-09-06T00:30:00-04:00', '2026-09-06T12:59:00-03:00',
            '2026-06-15T09:00:00-04:00', '2026-01-01T00:00:00Z',
        ];
        for (const hora of [0, 9, 13, 23]) {
            for (const instante of instantes) {
                const r = await pool.query('SELECT gomaq_inicio_cobro($1::timestamptz, $2)::text AS d', [instante, hora]);
                assert.equal(r.rows[0].d, inicioCobroDia(instante, hora), `${instante} con corte ${hora}`);
            }
        }
    });

    test('un INSERT directo (version anterior del servidor) tambien queda con inicio de cobro', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const g = await pool.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha) VALUES ($1, 'despacho', 'x', '2026-03-10T14:00:00-03:00') RETURNING id`,
            [equipo.id]);
        assert.equal(await inicioDe(g.rows[0].id), '2026-03-11');
        const r = await pool.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha) VALUES ($1, 'recepcion', 'x', now()) RETURNING inicio_cobro`, [equipo.id]);
        assert.equal(r.rows[0].inicio_cobro, null, 'una recepcion no tiene inicio de cobro');
    });

    test('cambiar la hora de corte afecta a los despachos nuevos y no reescribe los viejos', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const viejo = await despachar((await crearEquipo(null)).id, cliente, '2026-03-10T10:00:00-03:00');
        assert.equal(await inicioDe(viejo.body.id), '2026-03-10');
        try {
            const put = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { hora_corte_despacho: 9 });
            assert.equal(put.status, 200);
            assert.equal(put.body.hora_corte_despacho, 9);
            const nuevo = await despachar((await crearEquipo(null)).id, cliente, '2026-03-10T10:00:00-03:00');
            assert.equal(await inicioDe(nuevo.body.id), '2026-03-11', 'el despacho nuevo usa el corte nuevo');
            assert.equal(await inicioDe(viejo.body.id), '2026-03-10', 'el viejo conserva el suyo');
            const leida = await pedir('GET', '/api/facturacion/configuracion', 'administrativo');
            assert.equal(leida.body.hora_corte_despacho, 9);
            assert.ok(leida.body.actualizado_por, 'dice quien la cambio');
            assert.ok(leida.body.actualizado_at);
        } finally {
            await restaurarConfiguracion();
        }
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'gerente')).body.hora_corte_despacho, 13);
    });

    test('arriendos en curso: aparece con el cliente de la guia, cuenta desde su inicio y desaparece al recepcionar', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await despachar(equipo.id, cliente, '2026-01-02T09:00:00-03:00');
        const buscar = async () => (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).body
            .arriendos.find((a) => a.maquinaria_id === equipo.id);
        const fila = await buscar();
        assert.ok(fila, 'el equipo despachado aparece');
        assert.equal(fila.cliente_id, cliente);
        assert.equal(fila.guia_despacho_id, d.body.id);
        assert.equal(fila.inicio_cobro, '2026-01-02');
        assert.equal(fila.desde, '2026-01-02');
        assert.ok(fila.dias > 30);
        assert.ok(fila.periodos_sin_facturar >= 1 && fila.aviso === true);
        assert.match(fila.proximo_corte, /^\d{4}-\d{2}-05$/);
        // la recepcion cierra el arriendo
        const formulario = new FormData();
        formulario.append('tipo', 'recepcion');
        formulario.append('sin_documento', 'true');
        const rec = await fetch(`${base}/api/maquinarias/${equipo.id}/guias`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario });
        assert.equal(rec.status, 201);
        assert.equal(await buscar(), undefined, 'ya no esta en curso');
    });

    test('arriendos en curso: sin guia, con despacho fallido y con dos despachos seguidos', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const buscar = async (id) => (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'gerente')).body
            .arriendos.filter((a) => a.maquinaria_id === id);
        // cliente cargado directo en el equipo, sin ninguna guia: no aparece
        const directo = await crearEquipo(cliente);
        assert.equal((await buscar(directo.id)).length, 0);
        // despacho fallido: no cuenta
        const fallido = await crearEquipo(null);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, fallido, cliente_id) VALUES ($1, 'despacho', 'x', now(), true, $2)`, [fallido.id, cliente]);
        assert.equal((await buscar(fallido.id)).length, 0);
        // dos despachos sin recepcion entre ellos (no deberia pasar): el primero se cierra solo y el
        // segundo, a otro cliente, es el unico arriendo en curso del equipo
        const doble = await crearEquipo(null);
        const otroCliente = (await pool.query('SELECT id FROM clientes WHERE id <> $1 ORDER BY id LIMIT 1', [cliente])).rows[0];
        const g1 = await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-02-01T09:00:00-03:00', $2) RETURNING id`, [doble.id, cliente]);
        const g2 = await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-02-10T09:00:00-03:00', $2) RETURNING id`, [doble.id, otroCliente ? otroCliente.id : cliente]);
        const filas = await buscar(doble.id);
        assert.equal(filas.length, 1);
        assert.equal(filas[0].guia_despacho_id, g2.rows[0].id);
        assert.equal(filas[0].inicio_cobro, '2026-02-10');
        const pendiente = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos
            .find((a) => a.guia_despacho_id === g1.rows[0].id);
        assert.ok(pendiente, 'el primero queda pendiente de facturar');
        assert.equal(pendiente.falta_recepcion, true);
        assert.equal(pendiente.guia_recepcion_id, null);
    });

    test('arriendos en curso: recepcion y despacho a la misma hora se ordenan por id', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const hora = '2026-02-01T09:00:00-03:00';
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', $2, $3)`, [equipo.id, hora, cliente]);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'recepcion', 'x', $2, $3)`, [equipo.id, hora, cliente]);
        const cerrado = (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'gerente')).body.arriendos;
        assert.equal(cerrado.filter((a) => a.maquinaria_id === equipo.id).length, 0, 'recepcion posterior por id: cerrado');
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', $2, $3)`, [equipo.id, hora, cliente]);
        const abierto = (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'gerente')).body.arriendos;
        assert.equal(abierto.filter((a) => a.maquinaria_id === equipo.id).length, 1, 'despacho posterior por id: abierto de nuevo');
    });

    test('el dia de recepcion configurable cambia los dias que lista /pendientes', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-03-01T09:00:00-03:00', $2)`, [equipo.id, cliente]);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'recepcion', 'x', '2026-03-05T10:00:00-03:00', $2)`, [equipo.id, cliente]);
        const dias = async () => (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body
            .arriendos.find((a) => a.maquinaria_id === equipo.id).dias;
        assert.equal(await dias(), 5);
        try {
            assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { incluir_dia_recepcion: false })).status, 200);
            assert.equal(await dias(), 4);
        } finally {
            await restaurarConfiguracion();
        }
        assert.equal(await dias(), 5);
    });

    test('el endpoint viejo de dias de arriendo se retiro', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', `/api/maquinarias/${datos.maquinariaId}/dias-arriendo`, 'administrativo');
        assert.equal(r.status, 404);
    });

    test('la migracion 022 se puede correr otra vez sin romper nada', async (t) => {
        if (!requiereBase(t)) return;
        const sql = require('fs').readFileSync(require('path').join(__dirname, '../../db/migrations/022_configuracion_inicio_cobro.sql'), 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('COMMIT');
        } finally {
            client.release();
        }
        const r = await pedir('GET', '/api/facturacion/configuracion', 'gerente');
        assert.equal(r.body.dia_facturacion, 5);
        const trig = await pool.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'guias_inicio_cobro'");
        assert.equal(trig.rows[0].n, 1);
    });
});

describe('bloque 2b (parte 1): la factura guarda despacho, periodo y cliente', () => {
    const SQL_023 = () => require('fs').readFileSync(
        require('path').join(__dirname, '../../db/migrations/023_facturas_periodo.sql'), 'utf8');

    const guia = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;

    /** Inserta una factura de arriendo como lo hacia el servidor anterior: solo con la recepcion. */
    const facturaAntigua = async (equipoId, recepcionId, folio) => (await pool.query(
        `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url, monto) VALUES ($1, $2, $3, 'x', 1000) RETURNING *`,
        [equipoId, recepcionId, folio])).rows[0];

    const fila = async (id) => (await pool.query(
        `SELECT guia_despacho_id, to_char(periodo_desde, 'YYYY-MM-DD') AS desde, to_char(periodo_hasta, 'YYYY-MM-DD') AS hasta, cliente_id
         FROM facturas WHERE id = $1`, [id])).rows[0];

    test('una factura de arriendo insertada como el servidor anterior recibe despacho, periodo y cliente', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
        const f = await facturaAntigua(equipo.id, r, 'T-2301');
        const datosFila = await fila(f.id);
        assert.equal(datosFila.guia_despacho_id, d);
        assert.equal(datosFila.desde, '2026-03-01');
        assert.equal(datosFila.hasta, '2026-03-05');
        assert.equal(datosFila.cliente_id, cliente);
    });

    test('arriendo de 0 dias: recibe el despacho pero no periodo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T15:00:00-03:00', cliente); // cobra desde el 2
        const r = await guia(equipo.id, 'recepcion', '2026-03-01T17:00:00-03:00', cliente);
        const datosFila = await fila((await facturaAntigua(equipo.id, r, 'T-2302')).id);
        assert.equal(datosFila.guia_despacho_id, d);
        assert.equal(datosFila.desde, null);
        assert.equal(datosFila.hasta, null);
    });

    test('con el dia de recepcion apagado el periodo termina el dia anterior', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
        try {
            await pool.query("UPDATE configuracion SET valor = 'false' WHERE clave = 'incluir_dia_recepcion'");
            assert.equal((await fila((await facturaAntigua(equipo.id, r, 'T-2303')).id)).hasta, '2026-03-04');
        } finally {
            await pool.query("UPDATE configuracion SET valor = 'true', actualizado_por = NULL WHERE clave = 'incluir_dia_recepcion'");
        }
    });

    test('dos recepciones del mismo despacho: la segunda factura se inserta sin despacho y sin error', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r1 = await guia(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
        const r2 = await guia(equipo.id, 'recepcion', '2026-03-06T10:00:00-03:00', cliente);
        const f1 = await fila((await facturaAntigua(equipo.id, r1, 'T-2304')).id);
        const f2 = await fila((await facturaAntigua(equipo.id, r2, 'T-2305')).id);
        assert.equal(f1.guia_despacho_id, d);
        assert.equal(f2.guia_despacho_id, null, 'el despacho ya tiene factura');
        assert.equal(f2.cliente_id, cliente, 'el cliente si se completa');
    });

    test('recepcion sin despacho anterior: factura sin despacho y con el cliente de la recepcion', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
        const datosFila = await fila((await facturaAntigua(equipo.id, r, 'T-2306')).id);
        assert.equal(datosFila.guia_despacho_id, null);
        assert.equal(datosFila.cliente_id, cliente);
    });

    test('una factura de reparacion toma el cliente de la OT', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await facturarDirecto(ot, 'T-2307');
        const r = await pool.query(
            `SELECT f.cliente_id, ot.cliente_id AS cliente_ot FROM facturas f JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
             WHERE f.orden_trabajo_id = $1`, [ot]);
        assert.equal(r.rows[0].cliente_id, r.rows[0].cliente_ot);
    });

    test('el indice unico impide dos facturas del mismo periodo de un despacho', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const insertar = (folio) => pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, archivo_url)
             VALUES ($1, $2, '2026-03-01', '2026-03-05', $3, 'x')`, [equipo.id, d, folio]);
        await insertar('T-2308');
        await assert.rejects(() => insertar('T-2309'), /facturas_despacho_periodo_unico/);
        // otro periodo del mismo despacho si
        await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, archivo_url)
             VALUES ($1, $2, '2026-03-06', '2026-04-05', 'T-2310', 'x')`, [equipo.id, d]);
    });

    test('correr la migracion 023 otra vez rellena lo que falte y no rompe nada', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
        const f = await facturaAntigua(equipo.id, r, 'T-2311');
        // se simula una factura anterior a la migracion
        await pool.query('UPDATE facturas SET guia_despacho_id = NULL, periodo_desde = NULL, periodo_hasta = NULL, cliente_id = NULL WHERE id = $1', [f.id]);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SQL_023());
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        const datosFila = await fila(f.id);
        assert.equal(datosFila.guia_despacho_id, d);
        assert.equal(datosFila.desde, '2026-03-01');
        assert.equal(datosFila.hasta, '2026-03-05');
        assert.equal(datosFila.cliente_id, cliente);
        const trig = await pool.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'facturas_completar'");
        assert.equal(trig.rows[0].n, 1);
    });

    test('valorizar una OT ya facturada da 409 y no cambia el monto', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        await facturarDirecto(ot, 'T-2312');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 5000 });
        assert.equal(r.status, 409);
        assert.match(r.body.error, /facturada/);
        const v = await pool.query('SELECT valorizacion FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.equal(Number(v.rows[0].valorizacion), 1000);
    });

    test('autorizar el envio usa el cliente de la propia factura', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await pool.query("SELECT id, email FROM clientes WHERE email IS NOT NULL ORDER BY id LIMIT 1");
        if (cliente.rows.length === 0) return t.skip('no hay un cliente con correo en la semilla');
        const equipo = await crearEquipo(null);
        const f = (await pool.query(
            `INSERT INTO facturas (maquinaria_id, folio, archivo_url, cliente_id) VALUES ($1, 'T-2313', 'x', $2) RETURNING id`,
            [equipo.id, cliente.rows[0].id])).rows[0];
        const marca = new Date();
        const r = await pedir('POST', `/api/facturacion/${f.id}/autorizar-envio`, 'administrativo', {});
        assert.equal(r.status, 200);
        const n = await pool.query(
            `SELECT id, destinatario FROM notificaciones_pendientes WHERE created_at >= $1 AND payload->>'folio' = 'T-2313'`, [marca]);
        try {
            assert.equal(n.rows.length, 1);
            assert.equal(n.rows[0].destinatario, cliente.rows[0].email);
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [n.rows.map((x) => x.id)]);
        }
    });
});

describe('bloque 2b (parte 1): correcciones de la revision experta', () => {
    const SQL_023 = () => require('fs').readFileSync(
        require('path').join(__dirname, '../../db/migrations/023_facturas_periodo.sql'), 'utf8');
    const guia = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;

    test('una OT facturada sin valorizar no queda en los pendientes de valorizar', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, null);
        assert.ok((await pendientesDeValorizar()).includes(ot), 'antes de facturar, pendiente');
        assert.equal((await subirFactura(ot, 'administrativo', { folio: 'T-2401' })).status, 201);
        assert.ok(!(await pendientesDeValorizar()).includes(ot), 'facturada: ya no esta pendiente');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1000 });
        assert.equal(r.status, 409);
    });

    test('el relleno da el despacho a la recepcion mas antigua, aunque otra se haya facturado antes', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r1 = await guia(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
        const r2 = await guia(equipo.id, 'recepcion', '2026-03-08T10:00:00-03:00', cliente);
        // la posterior se factura primero (id menor)
        const f2 = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2402', 'x') RETURNING id`, [equipo.id, r2])).rows[0].id;
        const f1 = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2403', 'x') RETURNING id`, [equipo.id, r1])).rows[0].id;
        await pool.query('UPDATE facturas SET guia_despacho_id = NULL, periodo_desde = NULL, periodo_hasta = NULL WHERE id = ANY($1)', [[f1, f2]]);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SQL_023());
            await client.query('COMMIT');
        } finally {
            client.release();
        }
        const r = await pool.query(
            `SELECT id, guia_despacho_id, to_char(periodo_hasta, 'YYYY-MM-DD') AS hasta FROM facturas WHERE id = ANY($1)`, [[f1, f2]]);
        const por = Object.fromEntries(r.rows.map((x) => [x.id, x]));
        assert.equal(por[f1].guia_despacho_id, d, 'la recepcion mas antigua se queda con el despacho');
        assert.equal(por[f1].hasta, '2026-03-05');
        assert.equal(por[f2].guia_despacho_id, null);
    });

    test('el relleno usa la regla historica aunque la configuracion cambie despues', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
        const f = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2404', 'x') RETURNING id`, [equipo.id, r])).rows[0].id;
        await pool.query('UPDATE facturas SET guia_despacho_id = NULL, periodo_desde = NULL, periodo_hasta = NULL WHERE id = $1', [f]);
        try {
            await pool.query("UPDATE configuracion SET valor = 'false' WHERE clave = 'incluir_dia_recepcion'");
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(SQL_023());
                await client.query('COMMIT');
            } finally {
                client.release();
            }
        } finally {
            await pool.query("UPDATE configuracion SET valor = 'true', actualizado_por = NULL WHERE clave = 'incluir_dia_recepcion'");
        }
        const fila = (await pool.query(`SELECT to_char(periodo_hasta, 'YYYY-MM-DD') AS hasta FROM facturas WHERE id = $1`, [f])).rows[0];
        assert.equal(fila.hasta, '2026-03-05');
    });

    test('la factura de una guia que no es recepcion no recibe despacho ni periodo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const f = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2405', 'x') RETURNING guia_despacho_id, periodo_desde`, [equipo.id, d])).rows[0];
        assert.equal(f.guia_despacho_id, null);
        assert.equal(f.periodo_desde, null);
    });

    test('dos facturas simultaneas del mismo despacho no dan un error de unicidad', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        for (let vuelta = 0; vuelta < 5; vuelta++) {
            const equipo = await crearEquipo(null);
            await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
            const r1 = await guia(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
            const r2 = await guia(equipo.id, 'recepcion', '2026-03-06T10:00:00-03:00', cliente);
            const insertar = (r, folio) => pool.query(
                `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, $3, 'x') RETURNING id`, [equipo.id, r, folio]);
            const resultados = await Promise.allSettled([insertar(r1, `T-25${vuelta}1`), insertar(r2, `T-25${vuelta}2`)]);
            assert.deepEqual(resultados.map((x) => x.status), ['fulfilled', 'fulfilled'], JSON.stringify(resultados.map((x) => x.reason && x.reason.message)));
        }
    });
});

describe('bloque 2b (parte 2): facturas de arriendo por periodo', () => {
    const DEFECTO = { dia_facturacion: 5, hora_corte_despacho: 13, incluir_dia_recepcion: true, corte_cierra_periodo: true };

    async function restaurar() {
        for (const [clave, valor] of Object.entries(DEFECTO)) {
            await pool.query(
                `INSERT INTO configuracion (clave, valor) VALUES ($1, $2::jsonb)
                 ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = NULL`, [clave, JSON.stringify(valor)]);
        }
    }

    const guiaSql = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;

    /** Un arriendo ya terminado: despacho y recepcion con las fechas dadas. */
    async function arriendo(despacho, recepcion, clienteId) {
        const cliente = clienteId || await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guiaSql(equipo.id, 'despacho', despacho, cliente);
        const r = recepcion ? await guiaSql(equipo.id, 'recepcion', recepcion, cliente) : null;
        return { equipo, d, r, cliente };
    }

    const propuesta = async (d, rol = 'administrativo') => pedir('GET', `/api/facturacion/arriendos/${d}/propuesta`, rol);

    async function facturar(campos, rol = 'administrativo') {
        const formulario = new FormData();
        for (const [k, v] of Object.entries(campos)) if (v !== undefined && v !== null) formulario.append(k, String(v));
        formulario.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'f.pdf');
        const r = await fetch(`${base}/api/facturacion/arriendo`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens[rol]}` }, body: formulario });
        let body = null;
        try { body = await r.json(); } catch (_) { /* sin cuerpo */ }
        return { status: r.status, body };
    }

    test('propuesta: del inicio de cobro al primer corte, con las opciones hasta el fin', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T10:00:00-03:00');
        const r = await propuesta(d);
        assert.equal(r.status, 200);
        assert.equal(r.body.desde, '2026-08-01');
        assert.equal(r.body.hasta_sugerido, '2026-08-05');
        assert.deepEqual(r.body.opciones_hasta, ['2026-08-05', '2026-09-05', '2026-10-05', '2026-10-20']);
        assert.equal(r.body.dias, 5);
        assert.equal(r.body.es_final, false);
        assert.equal(r.body.en_curso, false);
        assert.equal((await propuesta(d, 'gerente')).status, 200);
        assert.equal((await propuesta(d, 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos/99999999/propuesta', 'administrativo')).status, 404);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos/abc/propuesta', 'administrativo')).status, 404);
    });

    test('facturar por periodos encadenados hasta el final, sin huecos', async (t) => {
        if (!requiereBase(t)) return;
        const { d, r: recep, cliente } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T10:00:00-03:00');
        const ids = [];
        for (const [desde, hasta] of [['2026-08-01', '2026-08-05'], ['2026-08-06', '2026-09-05'], ['2026-09-06', '2026-10-05'], ['2026-10-06', '2026-10-20']]) {
            const p = await propuesta(d);
            assert.equal(p.body.desde, desde);
            const f = await facturar({ guia_despacho_id: d, periodo_desde: desde, periodo_hasta: hasta, folio: `P-${desde}`, monto: 1000 });
            assert.equal(f.status, 201, JSON.stringify(f.body));
            assert.equal(f.body.cliente_id, cliente);
            ids.push(f.body.id);
            if (hasta === '2026-10-20') {
                assert.equal(f.body.guia_recepcion_id, recep, 'la factura final se ata a la recepcion');
            } else {
                assert.equal(f.body.guia_recepcion_id, null);
            }
        }
        const fin = await propuesta(d);
        assert.equal(fin.body.nada_que_facturar, true);
        assert.equal(fin.body.facturado_completo, true);
        const otra = await facturar({ guia_despacho_id: d, periodo_desde: '2026-10-21', periodo_hasta: '2026-10-21', folio: 'P-extra' });
        assert.equal(otra.status, 409);
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos;
        assert.equal(pend.find((a) => a.guia_despacho_id === d), undefined, 'facturado completo no esta pendiente');
    });

    test('un periodo parcial deja el resto pendiente en /pendientes', async (t) => {
        if (!requiereBase(t)) return;
        const { d, r: recep } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T10:00:00-03:00');
        const f = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05', folio: 'PP-1' });
        assert.equal(f.status, 201);
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos.find((a) => a.guia_despacho_id === d);
        assert.ok(pend);
        assert.equal(pend.desde, '2026-08-06');
        assert.equal(pend.hasta_sugerido, '2026-09-05');
        assert.equal(pend.guia_recepcion_id, recep);
        assert.equal(pend.dias, 76);
    });

    test('periodo con hueco, solape o fin invalido se rechaza y no sube el PDF', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T10:00:00-03:00');
        const subidos = datos.storage.subidos.length;
        const hueco = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-03', periodo_hasta: '2026-08-05', folio: 'H-1' });
        assert.equal(hueco.status, 409);
        assert.equal(hueco.body.codigo, 'periodo_desactualizado');
        assert.equal(hueco.body.propuesta.desde, '2026-08-01', 'devuelve la propuesta actual');
        const invalido = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-07', folio: 'H-2' });
        assert.equal(invalido.status, 400);
        const pasado = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-10-21', folio: 'H-3' });
        assert.equal(pasado.status, 400);
        const mal = await facturar({ guia_despacho_id: d, periodo_desde: 'ayer', periodo_hasta: '2026-08-05', folio: 'H-4' });
        assert.equal(mal.status, 400);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE guia_despacho_id = $1', [d])).rows.length, 0);
        assert.ok(datos.storage.borrados.length >= datos.storage.subidos.length - subidos, 'los PDF subidos se borran');
        // solape: tras facturar el primero, repetir el mismo periodo es desactualizado
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05', folio: 'H-5' })).status, 201);
        const repetido = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05', folio: 'H-6' });
        assert.equal(repetido.status, 409);
    });

    test('dos facturas simultaneas del mismo periodo: una entra y la otra se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T10:00:00-03:00');
        const campos = { guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05' };
        const [a, b] = await Promise.all([facturar({ ...campos, folio: 'C-1' }), facturar({ ...campos, folio: 'C-2' })]);
        assert.deepEqual([a.status, b.status].sort(), [201, 409]);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE guia_despacho_id = $1', [d])).rows.length, 1);
    });

    test('compatibilidad: solo con guia_recepcion_id factura todo hasta el fin (panel antiguo)', async (t) => {
        if (!requiereBase(t)) return;
        const { d, r } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-04T10:00:00-03:00');
        const f = await facturar({ guia_recepcion_id: r, folio: 'L-1', monto: 500 });
        assert.equal(f.status, 201, JSON.stringify(f.body));
        assert.equal(f.body.guia_despacho_id, d);
        assert.equal(f.body.guia_recepcion_id, r);
        assert.equal(String(f.body.periodo_desde).slice(0, 10) >= '2026-02-28', true);
        const otra = await facturar({ guia_recepcion_id: r, folio: 'L-2' });
        assert.equal(otra.status, 409);
        assert.match(otra.body.error, /ya tiene su factura/);
        assert.equal((await facturar({ guia_recepcion_id: 99999999, folio: 'L-3' })).status, 404);
        assert.equal((await facturar({ folio: 'L-4' })).status, 400);
    });

    test('un arriendo en curso solo se factura hasta un corte ya vencido', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-01-02T09:00:00-03:00', null);
        const p = await propuesta(d);
        assert.equal(p.body.en_curso, true);
        assert.equal(p.body.desde, '2026-01-02');
        assert.equal(p.body.hasta_sugerido, '2026-01-05');
        assert.equal(p.body.es_final, false);
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-01-02', periodo_hasta: '2026-01-05', folio: 'E-1' })).status, 201);
        const siguiente = await propuesta(d);
        assert.equal(siguiente.body.desde, '2026-01-06');
        // en curso no se puede cerrar con el panel antiguo (no hay recepcion)
        const enCurso = (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).body.arriendos.find((a) => a.guia_despacho_id === d);
        assert.equal(enCurso.facturado_hasta, '2026-01-05');
        assert.equal(enCurso.desde, '2026-01-06');
    });

    test('despacho de otro cliente sin recepcion en medio: el primero se cierra y cada uno factura al suyo', async (t) => {
        if (!requiereBase(t)) return;
        const c1 = await algunCliente();
        const otro = (await pool.query('SELECT id FROM clientes WHERE id <> $1 ORDER BY id LIMIT 1', [c1])).rows[0];
        const equipo = await crearEquipo(null);
        const d1 = await guiaSql(equipo.id, 'despacho', '2026-02-01T09:00:00-03:00', c1);
        const d2 = await guiaSql(equipo.id, 'despacho', '2026-02-10T11:00:00-03:00', otro ? otro.id : c1);
        const p1 = await propuesta(d1);
        assert.equal(p1.body.falta_recepcion, true);
        assert.equal(p1.body.en_curso, false);
        assert.equal(p1.body.fin, '2026-02-10', 'cierra el dia del segundo despacho');
        assert.equal(p1.body.cliente_id, c1);
        const p2 = await propuesta(d2);
        assert.equal(p2.body.en_curso, true);
        assert.equal(p2.body.desde, '2026-02-10');
        assert.equal(p2.body.cliente_id, otro ? otro.id : c1);
    });

    test('despacho a las 12:59 y 13:00 en el mismo dia que vuelve otro equipo: cada uno cuenta su dia', async (t) => {
        if (!requiereBase(t)) return;
        const a = await arriendo('2026-03-10T12:59:00-03:00', '2026-03-12T10:00:00-03:00');
        const b = await arriendo('2026-03-10T13:00:00-03:00', '2026-03-12T10:00:00-03:00');
        assert.equal((await propuesta(a.d)).body.desde, '2026-03-10');
        assert.equal((await propuesta(b.d)).body.desde, '2026-03-11');
    });

    test('devolucion el mismo dia, ya pasado el corte: 0 dias, no queda pendiente', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-03-10T15:00:00-03:00', '2026-03-10T17:00:00-03:00');
        const p = await propuesta(d);
        assert.equal(p.body.nada_que_facturar, true);
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos;
        assert.equal(pend.find((x) => x.guia_despacho_id === d), undefined);
    });

    test('monto de la factura de arriendo: solo enteros de pesos, 400 antes de subir el PDF', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-05T10:00:00-03:00');
        const subidosAntes = datos.storage.subidos.length;
        for (const monto of ['249.900', '249,9', '-1000', '1e3', '12.5', 'abc', '1 000']) {
            const r = await facturar({ guia_despacho_id: d, periodo_desde: '2026-03-01', periodo_hasta: '2026-03-05', folio: 'M-1', monto });
            assert.equal(r.status, 400, `monto ${monto}`);
        }
        assert.equal(datos.storage.subidos.length, subidosAntes, 'no se subio ningun PDF');
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE guia_despacho_id = $1', [d])).rows.length, 0);
        const ok = await facturar({ guia_despacho_id: d, periodo_desde: '2026-03-01', periodo_hasta: '2026-03-05', folio: 'M-2', monto: '249900' });
        assert.equal(ok.status, 201);
        assert.equal(Number(ok.body.monto), 249900);
    });

    test('con el dia de recepcion apagado el arriendo termina el dia anterior', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-10-10T09:00:00-03:00', '2026-10-20T10:00:00-03:00');
        try {
            assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { incluir_dia_recepcion: false })).status, 200);
            const p = await propuesta(d);
            assert.equal(p.body.fin, '2026-10-19');
            assert.deepEqual(p.body.opciones_hasta, ['2026-10-19']);
        } finally {
            await restaurar();
        }
        assert.equal((await propuesta(d)).body.fin, '2026-10-20');
    });

    test('si el corte no cierra el periodo, el periodo termina el dia anterior al corte', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T10:00:00-03:00');
        try {
            const put = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { corte_cierra_periodo: false });
            assert.equal(put.status, 200);
            assert.equal(put.body.corte_cierra_periodo, false);
            const p = await propuesta(d);
            assert.deepEqual(p.body.opciones_hasta, ['2026-08-04', '2026-09-04', '2026-10-04', '2026-10-20']);
            assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'administrativo')).body.corte_cierra_periodo, false);
            assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { corte_cierra_periodo: 'no' })).status, 400);
        } finally {
            await restaurar();
        }
        assert.equal((await propuesta(d)).body.opciones_hasta[0], '2026-08-05');
    });

    test('recepcion retroactiva anterior a lo ya facturado: se avisa y no admite otra factura', async (t) => {
        if (!requiereBase(t)) return;
        const { equipo, d, cliente } = await arriendo('2026-08-01T09:00:00-03:00', null);
        // en curso se puede facturar de una vez hasta cualquier corte vencido
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-09-05', folio: 'R-1' })).status, 201);
        // la recepcion se registra despues, con fecha anterior a lo facturado
        await guiaSql(equipo.id, 'recepcion', '2026-08-20T10:00:00-03:00', cliente);
        const p = await propuesta(d);
        assert.equal(p.body.facturado_de_mas, true);
        assert.equal(p.body.nada_que_facturar, true);
        // sigue visible en pendientes, con la marca, para que se emita la nota de credito
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos;
        const item = pend.find((x) => x.guia_despacho_id === d);
        assert.ok(item, 'el arriendo facturado de mas sigue visible');
        assert.equal(item.facturado_de_mas, true);
        assert.equal(item.facturado_hasta, '2026-09-05');
        assert.equal(item.dias, 0);
        // y no admite otra factura
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-09-06', periodo_hasta: '2026-09-10', folio: 'R-2' })).status, 409);
    });

    test('/pendientes con recepciones repetidas ya no duplica el arriendo', async (t) => {
        if (!requiereBase(t)) return;
        const { equipo, d, cliente } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-05T10:00:00-03:00');
        await guiaSql(equipo.id, 'recepcion', '2026-03-06T10:00:00-03:00', cliente); // recepcion repetida (huerfana)
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos.filter((a) => a.guia_despacho_id === d);
        assert.equal(pend.length, 1);
    });

    test('valorizar y facturar una OT no se mezclan con los arriendos (campos nuevos en /pendientes)', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-05T10:00:00-03:00');
        const fila = (await pedir('GET', '/api/facturacion/pendientes', 'gerente')).body.arriendos.find((a) => a.guia_despacho_id === d);
        for (const campo of ['guia_recepcion_id', 'maquinaria_codigo', 'cliente_nombre', 'fecha_despacho', 'fecha_recepcion', 'dias', 'desde', 'hasta_sugerido', 'es_final']) {
            assert.ok(campo in fila, `falta ${campo}`);
        }
        assert.equal(fila.dias, 5);
    });
});

describe('bloque 3: estado del equipo derivado de las ordenes, cierre con estado y origen comercial', () => {
    const estadoDe = async (equipoId) => (await pool.query('SELECT estado, estado_origen FROM maquinarias WHERE id = $1', [equipoId])).rows[0];
    const diagnostico = (ot, cuerpo, rol = 'mecanico') => pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, rol, cuerpo);
    const finalizar = (ot, cuerpo = {}, rol = 'mecanico') => pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, rol, { sin_persona: true, ...cuerpo });
    const fijarEstado = (equipoId, estado, origen) =>
        pool.query('UPDATE maquinarias SET estado = $2, estado_origen = $3 WHERE id = $1', [equipoId, estado, origen]);
    /** OT asignada al mecanico sobre un equipo propio de la prueba. */
    const otDeEquipo = async (equipoId, estado = 'asignada') => crearOt(estado, datos.mecanicoId, equipoId);

    test('llegar a terreno por diagnostico deja el equipo en mantencion por la orden', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: null });
        assert.equal((await diagnostico(ot, { estado: 'aceptada' })).status, 200);
        assert.equal((await estadoDe(equipo.id)).estado, 'operativa', 'aceptar no toca el equipo');
        assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'ot' });
    });

    test('pasar de terreno a reparacion no repite la entrada: un operativa puesto a mano se respeta', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
        await fijarEstado(equipo.id, 'operativa', 'panel');
        assert.equal((await diagnostico(ot, { estado: 'en_reparacion' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'panel' });
        assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'panel' });
    });

    test('un en_mantencion o fuera_de_servicio puestos a mano no se tocan al llegar a terreno', async (t) => {
        if (!requiereBase(t)) return;
        for (const estado of ['en_mantencion', 'fuera_de_servicio']) {
            const equipo = await crearEquipo(null);
            await fijarEstado(equipo.id, estado, 'panel');
            const ot = await otDeEquipo(equipo.id);
            assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
            assert.deepEqual(await estadoDe(equipo.id), { estado, estado_origen: 'panel' });
        }
    });

    test('una OT creada en terreno (/en-terreno) deja el equipo en mantencion', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', { maquinaria_id: equipo.id, uuid_cliente: crypto.randomUUID() });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'ot' });
    });

    test('cierre sin estado_equipo (APK antiguo): vuelve a operativa si la mantencion la puso la orden', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        assert.equal((await finalizar(ot)).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'ot' });
    });

    test('cierre sin estado_equipo nunca pisa un fuera_de_servicio ni un en_mantencion del panel', async (t) => {
        if (!requiereBase(t)) return;
        for (const estado of ['fuera_de_servicio', 'en_mantencion']) {
            const equipo = await crearEquipo(null);
            const ot = await otDeEquipo(equipo.id);
            await diagnostico(ot, { estado: 'en_terreno' });
            await fijarEstado(equipo.id, estado, 'panel');
            assert.equal((await finalizar(ot)).status, 200);
            assert.deepEqual(await estadoDe(equipo.id), { estado, estado_origen: 'panel' });
        }
    });

    test('cierre con estado_equipo = operativa deja el equipo operativo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        assert.equal((await finalizar(ot, { estado_equipo: 'operativa' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'mecanico' });
    });

    test('cierre con estado_equipo = operativa no levanta un en_mantencion puesto a mano', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        await fijarEstado(equipo.id, 'en_mantencion', 'panel');
        assert.equal((await finalizar(ot, { estado_equipo: 'operativa' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'panel' });
    });

    test('cierre con fuera_de_servicio se aplica siempre, aunque el panel haya puesto otro estado o haya otra OT abierta', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        const otra = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        await diagnostico(otra, { estado: 'en_terreno' });
        await fijarEstado(equipo.id, 'operativa', 'panel');
        assert.equal((await finalizar(ot, { estado_equipo: 'fuera_de_servicio' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'fuera_de_servicio', estado_origen: 'mecanico' });
    });

    test('dos OT del mismo equipo: la primera en cerrarse lo deja en mantencion y la segunda operativo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const a = await otDeEquipo(equipo.id);
        const b = await otDeEquipo(equipo.id);
        await diagnostico(a, { estado: 'en_terreno' });
        await diagnostico(b, { estado: 'en_reparacion' });
        assert.equal((await estadoDe(equipo.id)).estado, 'en_mantencion');
        assert.equal((await finalizar(a, { estado_equipo: 'operativa' })).status, 200);
        assert.equal((await estadoDe(equipo.id)).estado, 'en_mantencion', 'queda otra OT abierta');
        assert.equal((await finalizar(b, { estado_equipo: 'operativa' })).status, 200);
        assert.equal((await estadoDe(equipo.id)).estado, 'operativa');
    });

    test('dos cierres simultaneos del mismo equipo no lo dejan pegado en mantencion', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 5; vuelta++) {
            const equipo = await crearEquipo(null);
            const a = await otDeEquipo(equipo.id);
            const b = await otDeEquipo(equipo.id);
            await diagnostico(a, { estado: 'en_terreno' });
            await diagnostico(b, { estado: 'en_terreno' });
            const [ra, rb] = await Promise.all([
                finalizar(a, { estado_equipo: 'operativa' }),
                finalizar(b, { estado_equipo: 'operativa' }),
            ]);
            assert.deepEqual([ra.status, rb.status], [200, 200]);
            assert.equal((await estadoDe(equipo.id)).estado, 'operativa', `vuelta ${vuelta}`);
        }
    });

    test('el cierre deja el estado del equipo en el historial y el reintento no lo repite ni cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        const uuid = crypto.randomUUID();
        const primera = await finalizar(ot, { estado_equipo: 'fuera_de_servicio', uuid });
        assert.equal(primera.status, 200);
        // el panel recibe el equipo de vuelta y lo deja operativo a mano; el reintento no lo pisa
        await fijarEstado(equipo.id, 'operativa', 'panel');
        const segunda = await finalizar(ot, { estado_equipo: 'fuera_de_servicio', uuid });
        assert.equal(segunda.status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'panel' });
        const cierres = await eventosTipo(ot, 'cierre');
        assert.equal(cierres.length, 1);
        assert.deepEqual(
            [cierres[0].detalle.estado_equipo_pedido, cierres[0].detalle.estado_equipo_anterior, cierres[0].detalle.estado_equipo_nuevo],
            ['fuera_de_servicio', 'en_mantencion', 'fuera_de_servicio']);
    });

    test('estado_equipo invalido da 400 y la OT sigue abierta', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        for (const invalido of ['en_mantencion', 'OPERATIVA', 'roto', 1, true]) {
            const r = await finalizar(ot, { estado_equipo: invalido });
            assert.equal(r.status, 400, JSON.stringify(invalido));
        }
        assert.equal((await pool.query('SELECT estado FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0].estado, 'en_terreno');
        assert.equal((await estadoDe(equipo.id)).estado, 'en_mantencion');
    });

    test('ocurrio_en del cierre: se respeta, no puede ser futuro ni anterior a la creacion', async (t) => {
        if (!requiereBase(t)) return;
        const cerrarCon = async (ocurrio) => {
            const equipo = await crearEquipo(null);
            const ot = await otDeEquipo(equipo.id);
            await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 day' WHERE id = $1", [ot]);
            await diagnostico(ot, { estado: 'en_terreno' });
            const r = await finalizar(ot, { ocurrio_en: ocurrio });
            assert.equal(r.status, 200);
            const fila = (await pool.query('SELECT fecha_cierre, fecha_creacion FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0];
            return { fila, evento: (await eventosTipo(ot, 'cierre'))[0] };
        };
        const hace = new Date(Date.now() - 60 * 1000);
        const valido = await cerrarCon(hace.toISOString());
        assert.ok(Math.abs(new Date(valido.fila.fecha_cierre) - hace) < 1000, 'usa la hora del telefono');
        assert.ok(valido.evento.ocurrio_en);
        const futuro = await cerrarCon(new Date(Date.now() + 3600 * 1000).toISOString());
        assert.ok(new Date(futuro.fila.fecha_cierre) <= Date.now() + 2000, 'nunca en el futuro (la hora pedida era 1 h adelante)');
        const antiguo = await cerrarCon('2001-01-01T00:00:00Z');
        assert.ok(new Date(antiguo.fila.fecha_cierre) >= new Date(antiguo.fila.fecha_creacion), 'no antes de la creacion');
        const basura = await cerrarCon('no-es-fecha');
        assert.ok(Math.abs(new Date(basura.fila.fecha_cierre) - new Date()) < 5000, 'invalida: hora del servidor');
    });

    test('PATCH /maquinarias/:id/estado deja quien lo fijo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        assert.equal((await pedir('PATCH', `/api/maquinarias/${equipo.id}/estado`, 'administrativo', { estado: 'fuera_de_servicio' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'fuera_de_servicio', estado_origen: 'panel' });
        assert.equal((await pedir('PATCH', `/api/maquinarias/${equipo.id}/estado`, 'mecanico', { estado: 'operativa' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'mecanico' });
    });

    test('origen de la OT: externo si el cliente tiene ejecutivo, directo si no, en las tres rutas', async (t) => {
        if (!requiereBase(t)) return;
        const ejecutivo = (await pool.query('SELECT id FROM ejecutivos ORDER BY id LIMIT 1')).rows[0];
        const cliente = await algunCliente();
        if (!ejecutivo || !cliente) return t.skip('la semilla no trae ejecutivos o clientes');
        const original = (await pool.query('SELECT ejecutivo_id FROM clientes WHERE id = $1', [cliente])).rows[0].ejecutivo_id;
        const origenDe = async (ot) => (await pool.query('SELECT origen FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0].origen;
        try {
            for (const [ejecutivoId, esperado] of [[ejecutivo.id, 'externo'], [null, 'directo']]) {
                await pool.query('UPDATE clientes SET ejecutivo_id = $2 WHERE id = $1', [cliente, ejecutivoId]);
                // panel: POST /, aunque el body diga otra cosa
                const eq1 = await crearEquipo(cliente);
                const panel = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: eq1.id, origen: ejecutivoId ? 'directo' : 'externo' });
                assert.equal(panel.status, 201);
                datos.ordenes.push(panel.body.id);
                assert.equal(await origenDe(panel.body.id), esperado, 'panel');
                // terreno: /en-terreno
                const eq2 = await crearEquipo(cliente);
                const terreno = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', { maquinaria_id: eq2.id, uuid_cliente: crypto.randomUUID() });
                assert.equal(terreno.status, 201);
                datos.ordenes.push(terreno.body.id);
                assert.equal(await origenDe(terreno.body.id), esperado, 'terreno');
            }
        } finally {
            await pool.query('UPDATE clientes SET ejecutivo_id = $2 WHERE id = $1', [cliente, original]);
        }
    });

    test('un equipo sin cliente da una OT de origen directo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.origen, 'directo');
    });

    test('la migracion 024 rellena el estado de los equipos con una orden abierta y se puede repetir', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        await otDeEquipo(equipo.id, 'en_terreno');
        // un equipo con orden abierta que sigue operativo (como estaba antes de la migracion)
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: null });
        const sql = require('fs').readFileSync(require('path').join(__dirname, '../../db/migrations/024_estado_equipo_origen.sql'), 'utf8');
        for (let i = 0; i < 2; i++) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('COMMIT');
            } finally {
                client.release();
            }
        }
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'ot' });
    });
});
